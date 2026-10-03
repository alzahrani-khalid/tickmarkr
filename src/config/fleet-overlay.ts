// Fleet-overlay mutation, serialization, and diff rendering for the `tickmarkr fleet` write path.
import { type Alias, type Node as YamlNode, isAlias, isCollection, isMap, isNode, isScalar, isSeq, parseDocument, stringify, visit } from "yaml";
import { ConfigError, DENY_SCOPES, type DenyScope, type FleetEditable, type FleetUniverseRow, type LowerLayerModelOverrides, type MapEntry, type RoutingMode, type Tier, universeCovers, universeEntryMatches } from "./config.js";

// OBS-1099 add.1: the writer ranges over the schema-derived scopes. The flat (all-seats) scopes
// take part in the membership/allow-form write; every nested scope (routing.deny.workers.*) is a
// literal deny list written on its own. ponytail: "flat" = directly under routing.deny. Read
// lazily: config.ts imports this module, so the enumeration is not initialized at load time.
const flatDenyScopes = () => DENY_SCOPES.filter((scope) => scope.path.length === 3);
const nestedDenyScopes = () => DENY_SCOPES.filter((scope) => scope.path.length > 3);
const listsOf = (write: FleetOverlayWrite, scope: DenyScope): [string[], string[]] =>
  [write.initial[scope.key] ?? [], write.edited[scope.key] ?? []];

/** Fleet-owned overlay keys — the only config surface `tickmarkr fleet` may write. */
export const FLEET_OVERLAY_KEYS = ["routing", "tiers"] as const;

function fleetSubset(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of FLEET_OVERLAY_KEYS) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function sortedUnique(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

type FleetOverlayWriteFields = {
  initial: FleetEditable;
  edited: FleetEditable;
  mode?: RoutingMode;
  // config.judge is one adapter+model seat by schema (never a prefer chain; failover is runtime),
  // so a changed judge writes two scalars — set only when it differs from the resolved config.
  judge?: { adapter: string; model: string };
  steering?: {
    initial: { review?: string[]; consult?: string[] };
    edited: { review?: string[]; consult?: string[] };
  };
  // v1.92 fleet membership: the discovered universe (classified models only). Present ⇒ changed
  // exclusion sets write the minimal routing.allow membership form and tombstone the deny
  // adapters/models scopes; absent ⇒ the legacy deny-array write, byte-identical to before.
  universe?: FleetUniverseRow[];
  // T8: routing.map as the layers BELOW the written overlay resolve it. A changed slot left with no
  // declaration over a lower pin writes a raw `pin: null` tombstone (the pool:null precedent) —
  // deepMerge prunes it before schema validation, so Auto masks the inherited pin instead of
  // revealing it, and MapEntry itself never carries null. Absent ⇒ a cleared pin is deleted.
  lowerMap?: Record<string, MapEntry>;
  // T10: the effective routing.allow before the write — an authored entry the universe does not cover
  // (an unserved or unprobed channel) is admitted on purpose and rides the regenerated form verbatim.
  preservedAllow?: { adapters?: string[]; models?: string[] };
  // T10: the routing.allow a layer below the destination declares — "whole fleet in" masks it with
  // `allow: null`, and an empty generated leaf masks that layer's own leaf with `null`, instead of
  // deleting the key and resurrecting the lower restriction.
  lowerAllow?: { adapters?: string[]; models?: string[] };
};

// OBS-1188: only a write whose editables provably carry no efforts keeps the pre-effort contract.
type EffortFree = FleetEditable & { efforts?: undefined };

export type FleetOverlayWrite = FleetOverlayWriteFields & (
  // OBS-1182: tiers.<adapter>.modelOverrides as the layers BELOW the repo overlay (defaults +
  // global) resolve them, so clearing an effort masks an inherited one instead of revealing it.
  // OBS-1188: an effort write cannot be built without them — no blind guess stands in.
  | { lowerOverrides: LowerLayerModelOverrides }
  | { initial: EffortFree; edited: EffortFree; lowerOverrides?: undefined }
);

// The minimal routing.allow form for an exclusion-set membership write: whole adapter ids for
// fully-in adapters, adapter:model keys for partially-in ones, nothing for fully-out ones.
// `excluded` false ⇔ the whole universe is in fleet ⇒ the allow block is removed, not written.
function allowFormFromExclusions(
  universe: FleetUniverseRow[],
  edited: FleetEditable,
): { adapters: string[]; models: string[]; excluded: boolean } {
  if (!universe.length) {
    throw new Error(
      "fleet write: universe is empty — no classified models to compute routing.allow from; classify models in `tickmarkr fleet` first",
    );
  }
  // LEG2-T3 round 2 finding 1: every staged entry excludes what it NAMES — a bare model id every
  // adapter serving it, an identity its alias — never only an adapter id or an adapter:model key.
  // OBS-1046: the staged allow complement is a reason of its own, beside the authored deny lists.
  const entries = [...flatDenyScopes().flatMap((scope) => edited[scope.key] ?? []), ...(edited.allowOut ?? [])];
  const adapters: string[] = [];
  const models: string[] = [];
  let excluded = false;
  for (const row of universe) {
    if (entries.includes(row.adapter)) {
      excluded = true;
      continue;
    }
    const inFleet = row.models.filter((m) => !entries.some((entry) => universeEntryMatches(row, m, entry)));
    if (inFleet.length === row.models.length) {
      adapters.push(row.adapter);
    } else {
      excluded = true;
      models.push(...inFleet.map((m) => `${row.adapter}:${m}`));
    }
  }
  return { adapters: sortedUnique(adapters), models: sortedUnique(models), excluded };
}

// OBS-517: deny entries the discovered universe cannot express through the allow form — the probe
// dropped their channel (failed auth, rate limit, retired sku) so the allow complement never names
// them. They must be written back into routing.deny verbatim (deny beats allow at routing time),
// or a transient probe failure permanently erases a deliberate operator exclusion.
function residualDeny(
  universe: FleetUniverseRow[],
  entries: string[],
): string[] {
  return sortedUnique(entries.filter((entry) => !universeCovers(universe, entry)));
}

// LEG2-T3 round 2 finding 2: the flat deny list a membership write leaves behind. Every entry the
// repo overlay authored in THIS list that is still staged stays verbatim, in its authored order and
// with its comments — one cleared reason never takes an independent one with it, and an untouched
// list keeps its node. A staged entry the allow form cannot express as a membership key (outside the
// probe universe, or a bare-model/identity spelling) is written verbatim too; canonical keys the
// session added ride the allow form alone.
// T10 (D-973): read as the loader reads these bytes (readYaml parses with yaml's defaults, as toJS does
// here) — aliases at the leaf, its items and every ancestor resolve, and `<<` merges only in a document
// whose YAML version merges — so an aliased list's entries are authored entries too.
function authoredEntries(doc: OverlayDocument, path: OverlayPath): string[] {
  const value = path.reduce<unknown>((node, key) =>
    (node !== null && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), doc.toJS());
  return Array.isArray(value) ? value.flatMap((item) => (item === null || typeof item !== "object" ? [String(item)] : [])) : [];
}

function flatDenyAfterWrite(
  doc: OverlayDocument,
  path: OverlayPath,
  after: string[],
  universe: FleetUniverseRow[],
): string[] {
  const authored = authoredEntries(doc, path);
  const canonical = (entry: string) => universe.some((row) =>
    entry === row.adapter || row.models.some((m) => entry === `${row.adapter}:${m}`));
  const kept = authored.filter((entry) => after.includes(entry));
  const verbatim = sortedUnique(after.filter((entry) => !kept.includes(entry)
    && (!universeCovers(universe, entry) || !canonical(entry))));
  return [...new Set([...kept, ...verbatim])];
}

export type FleetFirstTouch = { vendor: string; channel: "sub" | "api" };

// fleet.ts deliberately remains the sole overlay builder and writer. Its established classification
// seam copies only `tier` and `note` into FleetEditable, so first-touch entry metadata rides inside a
// private provenance envelope until this module writes the YAML. The envelope never reaches disk.
const FIRST_TOUCH_OPEN = "\uE000tickmarkr-fleet-first-touch:";
const FIRST_TOUCH_CLOSE = "\uE001";
// OBS-505: marks a scalar-trailing single-line comment for the two-space inline note style at
// stringify time; applied and consumed inside renderFleetOverlayWrite, never written to disk.
const INLINE_COMMENT_SENTINEL = "\uE002";

export function fleetFirstTouchProvenance(note: string, firstTouch: FleetFirstTouch): string {
  return `${FIRST_TOUCH_OPEN}${encodeURIComponent(firstTouch.vendor)}:${firstTouch.channel}${FIRST_TOUCH_CLOSE}${note}`;
}

function unpackFleetProvenance(provenance?: string): { provenance?: string; firstTouch?: FleetFirstTouch } {
  if (!provenance?.startsWith(FIRST_TOUCH_OPEN)) return { provenance };
  const close = provenance.indexOf(FIRST_TOUCH_CLOSE, FIRST_TOUCH_OPEN.length);
  if (close === -1) return { provenance };
  const metadata = provenance.slice(FIRST_TOUCH_OPEN.length, close);
  const colon = metadata.lastIndexOf(":");
  if (colon === -1) return { provenance };
  const channel = metadata.slice(colon + 1);
  if (channel !== "sub" && channel !== "api") return { provenance };
  try {
    return {
      provenance: provenance.slice(close + FIRST_TOUCH_CLOSE.length),
      firstTouch: { vendor: decodeURIComponent(metadata.slice(0, colon)), channel },
    };
  } catch {
    return { provenance };
  }
}

type OverlayDocument = ReturnType<typeof parseDocument>;
type OverlayPath = readonly string[];

function setScalarPreservingComment(
  doc: OverlayDocument,
  path: OverlayPath,
  value: string | boolean | null,
  authoredComment?: string,
): void {
  const existing = doc.getIn(path, true);
  if (isScalar(existing)) {
    releaseAnchors(doc, path);
    existing.value = value;
  } else setAt(doc, path, doc.createNode(value));
  if (authoredComment !== undefined) {
    const written = doc.getIn(path, true);
    if (isScalar(written)) written.comment = ` ${authoredComment}`;
  }
}

function setStringSequencePreservingComments(
  doc: OverlayDocument,
  path: OverlayPath,
  values: string[] | null,
): void {
  const existing = doc.getIn(path, true);
  if (values === null) {
    const tombstone = doc.createNode(null);
    if (isScalar(tombstone) && existing && typeof existing === "object") {
      // A block sequence's key-line note is stored as commentBefore; on a scalar it must be
      // inline comment content or YAML expands `key: null` into a nested null value.
      const comments: string[] = [];
      if ("commentBefore" in existing && typeof existing.commentBefore === "string") {
        comments.push(existing.commentBefore);
      }
      if ("comment" in existing && typeof existing.comment === "string") {
        comments.push(existing.comment);
      }
      if (comments.length) tombstone.comment = comments.join("\n");
    }
    setAt(doc, path, tombstone);
    return;
  }
  if (!isSeq(existing)) {
    setAt(doc, path, doc.createNode(values));
    return;
  }
  // T10 owed review F2: an unchanged list is not edited, so its anchor and every alias keep their bytes
  if (existing.items.length === values.length && existing.items.every((item, at) => isScalar(item) && String(item.value) === values[at])) return;
  releaseAnchors(doc, path); // an anchored list is edited in place: its other aliases keep the original
  const available = [...existing.items];
  existing.items = values.map((value) => {
    const at = available.findIndex((item) => isScalar(item) && String(item.value) === value);
    if (at >= 0) return available.splice(at, 1)[0];
    return doc.createNode(value);
  });
}

// OBS-533: yaml's setIn/deleteIn throw on any non-collection intermediate ("Expected YAML
// collection at spec. Remaining path: pin"), and a v1.1 null tombstone (`spec:` under
// routing.map) is exactly that scalar — deepMerge prunes it before schema validation, so the
// overlay loads clean and the first fleet write under the tombstoned key crashed the TUI.
// Total forms: a delete treats the masked subtree as absent (the operator's tombstone already
// denies it, and survives untouched); a set clears the scalar and rebuilds what fleet owns —
// the routing.allow precedent below.
// T8 repair: an alias is no tombstone — `spec: *empty` resolves to a mapping. Each alias on the path
// is replaced by an un-anchored copy of its target, so what it resolves to decides, and a write under
// it never edits the anchored node its other aliases share.
function materializeAliases(doc: OverlayDocument, path: OverlayPath): void {
  for (let depth = 1; depth < path.length; depth++) {
    const node = doc.getIn(path.slice(0, depth), true);
    if (!isAlias(node)) continue;
    const target = node.resolve(doc);
    if (target === undefined) return;
    doc.setIn(path.slice(0, depth), detachedCopy(doc, node, target, new Set()));
  }
}

// T10 (D-973): a write mutates every ancestor on its path and edits or replaces the leaf with all it
// holds; any of those nodes may be an anchor other aliases share. Each such alias first becomes a
// detached copy of what it resolved to, so the write never changes another consumer's value nor
// leaves its alias dangling.
function releaseAnchors(doc: OverlayDocument, path: OverlayPath): void {
  const held = new Set<YamlNode>();
  for (let depth = 1; depth <= path.length; depth++) {
    const node = doc.getIn(path.slice(0, depth), true);
    if (!isNode(node)) break;
    for (const inner of depth < path.length ? [node] : nodesOf(node)) {
      if (!isAlias(inner) && inner.anchor) held.add(inner);
    }
  }
  if (!held.size) return;
  visit(doc, {
    Alias: (_key, alias) => {
      const target = alias.resolve(doc) as YamlNode | undefined;
      return target !== undefined && held.has(target) ? detachedCopy(doc, alias, target, new Set()) : undefined;
    },
  });
}

const nodesOf = (root: YamlNode): YamlNode[] => {
  const out: YamlNode[] = [];
  visit(root, (_key, node) => {
    if (isNode(node)) out.push(node);
  });
  return out;
};

// D-821: a copy carries NO anchor (a nested `&empty` would rebind `plan: *empty` and every later
// alias to the edited copy), and each inner alias must still name what it named in the original —
// one whose anchor is redefined before `at` is replaced by a detached copy of its original target.
function detachedCopy(doc: OverlayDocument, at: Alias, target: YamlNode, expanding: Set<YamlNode>): YamlNode {
  if (expanding.has(target)) throw new Error(`fleet cannot detach the recursive YAML alias *${at.source}`);
  const visible = new Map<string, YamlNode>();
  visit(doc, (_key, node) => {
    if (node === at) return visit.BREAK;
    if (isNode(node) && !isAlias(node) && node.anchor) visible.set(node.anchor, node);
  });
  const copy = target.clone() as YamlNode;
  const originals = nodesOf(target);
  const replace = new Map<YamlNode, YamlNode>();
  nodesOf(copy).forEach((node, index) => {
    if (!isAlias(node)) {
      node.anchor = undefined;
      return;
    }
    const resolved = (originals[index] as Alias).resolve(doc) as YamlNode | undefined;
    if (resolved !== undefined && visible.get(node.source) !== resolved) {
      replace.set(node, detachedCopy(doc, at, resolved, new Set([...expanding, target])));
    }
  });
  if (!replace.size) return copy;
  visit(copy, (_key, node) => (isNode(node) ? replace.get(node) : undefined));
  return copy;
}

function underScalar(doc: OverlayDocument, path: OverlayPath): boolean {
  for (let depth = 1; depth < path.length; depth++) {
    const node = doc.getIn(path.slice(0, depth), true);
    if (node === undefined) return false;
    if (!isMap(node)) return true;
  }
  return false;
}

function deleteAt(doc: OverlayDocument, path: OverlayPath): void {
  materializeAliases(doc, path); // an aliased mapping is no tombstone: Auto under `spec: *pinned` deletes the pin
  for (let depth = 1; depth < path.length; depth++) {
    if (!isMap(doc.getIn(path.slice(0, depth), true))) return;
  }
  // deleteIn throws on an empty document — only delete keys that exist.
  if (doc.getIn(path) === undefined) return;
  releaseAnchors(doc, path);
  doc.deleteIn(path);
}

function setAt(doc: OverlayDocument, path: OverlayPath, value: unknown): void {
  materializeAliases(doc, path); // edit a copy of an aliased mapping, never drop what it resolved to
  releaseAnchors(doc, path);
  for (let depth = 1; depth < path.length; depth++) {
    const node = doc.getIn(path.slice(0, depth), true);
    if (node === undefined) break;
    if (!isMap(node)) {
      const prefix = path.slice(0, depth);
      doc.deleteIn(prefix);
      // T10: a null mask over membership lists stays a mask for every deny leaf — and the routing.allow
      // block — this write does not set, so materializing one leaf never resurrects a lower layer's
      // other deny lists or its allow form (judge/review/consult reach)
      if (isScalar(node) && node.value === null) {
        const under = (inner: readonly string[], outer: readonly string[]) => outer.every((key, at) => inner[at] === key);
        for (const masked of [...DENY_SCOPES.map((scope) => scope.path), ["routing", "allow"]]) {
          if (under(masked, prefix) && !under(masked, path) && !under(path, masked)) doc.setIn(masked, doc.createNode(null));
        }
      }
      break;
    }
  }
  doc.setIn(path, value);
}

// T10 (D-987): Fleet writes through no YAML merge key — a membership write whose edited path (the edited
// leaf or any map above it) takes keys through `<<` is refused, fail-closed, so nothing is published.
function refuseMerge(doc: OverlayDocument, priorBytes: string, path: OverlayPath): void {
  let node: unknown = doc.contents;
  for (let depth = 0; depth <= path.length && isMap(node); depth++) {
    const merge = node.items.find((item) => isScalar(item.key) && typeof item.key.value === "symbol");
    if (merge) {
      const range = isNode(merge.value) ? merge.value.range : undefined;
      const shape = range ? priorBytes.slice(range[0], range[1]).trim().replace(/\s+/g, " ") : "…";
      throw new ConfigError(`${path.join(".")} takes keys through the YAML merge key \`<<: ${shape}\` in ${path.slice(0, depth).join(".") || "the document root"} — Fleet does not write through merge keys; inline the merged keys there by hand, then save again`);
    }
    node = depth < path.length ? node.get(path[depth], true) : undefined;
    if (isAlias(node)) node = node.resolve(doc);
  }
}

function deleteEmptyMap(doc: OverlayDocument, path: OverlayPath): void {
  const node = doc.getIn(path, true);
  if (isMap(node) && node.items.length === 0) deleteAt(doc, path);
}

/** Apply only fields fleet authored to the parsed YAML document. Untouched nodes retain their
 * keys, ordering, scalar style, and comments; fresh provenance is written directly on its tier node. */
export function renderFleetOverlayWrite(priorBytes: string, write: FleetOverlayWrite): string {
  const doc = parseDocument(priorBytes);
  if (doc.errors.length) throw doc.errors[0];

  const { initial, edited } = write;
  // OBS-1046: each flat scope (and the allow complement) is compared on its own — a scope the
  // session never edited keeps its node byte for byte, whatever its sibling did.
  const changed = (before: string[] = [], after: string[] = []) =>
    sortedUnique(before).join() !== sortedUnique(after).join();
  const FLAT_DENY_SCOPES = flatDenyScopes();
  const flatChanged = new Map(FLAT_DENY_SCOPES.map((scope) => [scope.key, changed(...listsOf(write, scope))]));
  if ([...flatChanged.values()].some(Boolean) || changed(initial.allowOut, edited.allowOut)) {
    if (write.universe) {
      refuseMerge(doc, priorBytes, ["routing", "allow"]);
      // Membership write: the allow form IS the fleet; deny adapters/models scopes are tombstoned
      // so a lower layer can never re-exclude behind the operator's back (workers untouched).
      const form = allowFormFromExclusions(write.universe, edited);
      const universe = write.universe;
      const known = (entry: string) => universe.some((row) =>
        entry === row.adapter || row.models.some((m) => universeEntryMatches(row, m, entry)));
      const retainedAll: string[] = [];
      for (const leaf of ["adapters", "models"] as const) {
        const retained = [...(write.preservedAllow?.[leaf] ?? []), ...authoredEntries(doc, ["routing", "allow", leaf])]
          .filter((entry) => !known(entry));
        if (!retained.length) continue;
        retainedAll.push(...retained);
        form[leaf] = sortedUnique([...form[leaf], ...retained]);
        form.excluded = true;
      }
      // T10 review: a retained allow entry admits a channel the allow form cannot see, so a staged flat
      // deny covering it stays in deny verbatim — folded into the allow form alone, the retained entry
      // would re-admit what the operator just excluded (rail out · all over an unprobed fake:U).
      // Either allow leaf admits a bare model (routing matches both leaves alike), so coverage never
      // depends on which leaf retained the entry.
      // ponytail: a bare retained entry's adapter is unknown, so any discovered adapter id covers it;
      // an identity alias of an unprobed channel is unknowable and is matched by spelling only.
      const coversRetained = (entry: string) => retainedAll.some((kept) => {
        const colon = kept.indexOf(":");
        if (colon !== -1) {
          const model = kept.slice(colon + 1);
          return universeEntryMatches({ adapter: kept.slice(0, colon), models: [model] }, model, entry);
        }
        return entry === kept || universe.some((row) => row.adapter === entry);
      });
      if (form.excluded) {
        const allowNode = doc.getIn(["routing", "allow"], true);
        if (allowNode !== undefined && !isMap(allowNode)) deleteAt(doc, ["routing", "allow"]);
        for (const leaf of ["adapters", "models"] as const) {
          const path = ["routing", "allow", leaf];
          if (form[leaf].length) setStringSequencePreservingComments(doc, path, form[leaf]);
          else if (write.lowerAllow?.[leaf] != null) setStringSequencePreservingComments(doc, path, null);
          else deleteAt(doc, path);
        }
        // Whole fleet out: allow stays present but empty — fail-closed, nothing admitted.
        if (doc.getIn(["routing", "allow"]) === undefined) {
          setAt(doc, ["routing", "allow"], doc.createNode({}));
        }
      } else {
        // Whole fleet in: no restriction to express — the allow block goes away entirely, or is
        // masked when a lower layer's allow would otherwise come back (T10 A/B resurrection).
        if (write.lowerAllow) setAt(doc, ["routing", "allow"], doc.createNode(null));
        else deleteAt(doc, ["routing", "allow"]);
      }
      // Authored and non-canonical entries stay in deny (LEG2-T3 finding 4, round 2 finding 2).
      // OBS-1046: only an EDITED scope is rewritten, and only when its bytes must change — an
      // addition the allow form carries leaves the list (an explicit `[]` included) untouched; a
      // scope the press CLEARED down to nothing is tombstoned so a lower layer can never
      // re-exclude behind the operator's back (workers untouched).
      // LEG2-T3 finding 4: an authored entry the edit admits (staged nowhere any more) must go
      // even from a scope whose own set did not change, or the admitted channel stays excluded
      // behind the preserved bytes.
      const stagedAfter = new Set([...FLAT_DENY_SCOPES.flatMap((scope) => edited[scope.key] ?? []), ...(edited.allowOut ?? [])]);
      const admitted = [...FLAT_DENY_SCOPES.flatMap((scope) => initial[scope.key] ?? []), ...(initial.allowOut ?? [])]
        .filter((entry) => !stagedAfter.has(entry));
      for (const scope of FLAT_DENY_SCOPES) {
        const [before, after] = listsOf(write, scope);
        const touched = flatChanged.get(scope.key);
        const path = scope.path;
        const authored = authoredEntries(doc, path);
        const stale = authored.some((entry) => admitted.includes(entry));
        if (!touched && !stale) continue;
        refuseMerge(doc, priorBytes, path);
        const remaining = [...new Set([...flatDenyAfterWrite(doc, path, after, write.universe), ...after.filter(coversRetained)])];
        if (remaining.length) {
          if (remaining.join("\n") !== authored.join("\n")) setStringSequencePreservingComments(doc, path, remaining);
        } else if (stale || before.some((entry) => !after.includes(entry))) {
          setStringSequencePreservingComments(doc, path, null);
        }
      }
    } else {
      for (const scope of FLAT_DENY_SCOPES) {
        if (!flatChanged.get(scope.key)) continue;
        refuseMerge(doc, priorBytes, scope.path);
        const after = edited[scope.key] ?? [];
        setStringSequencePreservingComments(doc, scope.path, after.length ? sortedUnique(after) : null);
      }
    }
  }

  // OBS-994/FL-1: routing.deny.workers is a literal deny list, never a universe-derived
  // membership scope — it never routes through the allow-complement dance above, in either
  // branch. Same tombstone/comment-preserving rules as the flat scopes. Each nested scope
  // mutates independently — an untouched sibling must not be rewritten (a `null` tombstone over
  // an absent/untouched sibling would mask a lower layer's own workers scope).
  for (const scope of nestedDenyScopes()) {
    const [before, after] = listsOf(write, scope);
    if (!changed(before, after)) continue;
    refuseMerge(doc, priorBytes, scope.path);
    setStringSequencePreservingComments(doc, scope.path, after.length ? sortedUnique(after) : null);
  }

  for (const shape of new Set([...Object.keys(initial.map), ...Object.keys(edited.map)])) {
    const before = initial.map[shape];
    const after = edited.map[shape];
    const pinPath = ["routing", "map", shape, "pin"];
    const declares = after?.pin !== undefined || after?.pool !== undefined || after?.prefer !== undefined;
    if (!declares && write.lowerMap?.[shape]?.pin !== undefined && JSON.stringify(before) !== JSON.stringify(after)) {
      // pin: null tombstone — masks the lower-layer pin; a scalar tombstone above it already masks the entry
      materializeAliases(doc, pinPath);
      if (!underScalar(doc, pinPath)) setScalarPreservingComment(doc, pinPath, null);
    } else if (JSON.stringify(before?.pin) !== JSON.stringify(after?.pin)) {
      if (after?.pin === undefined) deleteAt(doc, pinPath);
      else setAt(doc, pinPath, doc.createNode(after.pin));
    }
    if (JSON.stringify(before?.pool) !== JSON.stringify(after?.pool)) {
      const path = ["routing", "map", shape, "pool"];
      if (after?.pool === undefined) {
        // pool: null tombstone — masks a lower-layer pool instead of inheriting it again.
        setStringSequencePreservingComments(doc, path, null);
      } else {
        setScalarPreservingComment(doc, [...path, "mode"], after.pool.mode);
        // Channel order is semantic (ordered walks it; any breaks ties by it) — dedupe, never sort.
        setStringSequencePreservingComments(doc, [...path, "channels"], [...new Set(after.pool.channels)]);
      }
    }
    if (JSON.stringify(before?.prefer) !== JSON.stringify(after?.prefer)) {
      if (after?.prefer === undefined && (after?.pool !== undefined || after?.pin !== undefined)) {
        // the pin/pool declaration owns the whole slot at merge (deepMerge drops the lower
        // layer's pin/pool/prefer atomically) — an [] mask here would re-declare prefer BESIDE
        // the pool in one document and fail the exclusivity refine; delete the key instead
        deleteAt(doc, ["routing", "map", shape, "prefer"]);
      } else {
        // Clearing a resolved list with no replacing declaration must mask the lower layer
        // with [], not delete the key and inherit it again.
        setStringSequencePreservingComments(
          doc,
          ["routing", "map", shape, "prefer"],
          after?.prefer ?? [],
        );
      }
    }
    if (before?.escalate !== after?.escalate) {
      if (after?.escalate === undefined) deleteAt(doc, ["routing", "map", shape, "escalate"]);
      else setScalarPreservingComment(doc, ["routing", "map", shape, "escalate"], after.escalate);
    }
  }

  for (const shape of new Set([...Object.keys(initial.floors), ...Object.keys(edited.floors)])) {
    if (initial.floors[shape] === edited.floors[shape]) continue;
    const tier = edited.floors[shape];
    if (tier === undefined) deleteAt(doc, ["routing", "floors", shape]);
    else setScalarPreservingComment(doc, ["routing", "floors", shape], tier);
  }

  for (const adapter of new Set([...Object.keys(initial.tiers), ...Object.keys(edited.tiers)])) {
    const beforeModels = initial.tiers[adapter] ?? {};
    const afterModels = edited.tiers[adapter] ?? {};
    let firstTouch: FleetFirstTouch | undefined;
    for (const model of new Set([...Object.keys(beforeModels), ...Object.keys(afterModels)])) {
      const before = beforeModels[model];
      const after = afterModels[model];
      if (JSON.stringify(before) === JSON.stringify(after) || after === null || after === undefined) continue;
      firstTouch ??= unpackFleetProvenance(after.provenance).firstTouch;
    }
    const ft = firstTouch;
    if (ft) {
      if (doc.getIn(["tiers", adapter, "vendor"]) === undefined) {
        setScalarPreservingComment(doc, ["tiers", adapter, "vendor"], ft.vendor);
      }
      if (doc.getIn(["tiers", adapter, "channel"]) === undefined) {
        setScalarPreservingComment(doc, ["tiers", adapter, "channel"], ft.channel);
      }
    }
    for (const model of new Set([...Object.keys(beforeModels), ...Object.keys(afterModels)])) {
      const before = beforeModels[model];
      const after = afterModels[model];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const path = ["tiers", adapter, "models", model];
      if (after === null || after === undefined) setScalarPreservingComment(doc, path, null);
      else setScalarPreservingComment(doc, path, after.tier, unpackFleetProvenance(after.provenance).provenance);
    }
  }

  // OBS-1182: effort lands in tiers.<adapter>.modelOverrides.<model>.effort — the scalar tier and
  // every sibling override key (vendor, channel) keep their bytes.
  const efforts = (e: FleetEditable) => e.efforts ?? {};
  for (const adapter of new Set([...Object.keys(efforts(initial)), ...Object.keys(efforts(edited))])) {
    for (const model of new Set([...Object.keys(efforts(initial)[adapter] ?? {}), ...Object.keys(efforts(edited)[adapter] ?? {})])) {
      const after = efforts(edited)[adapter]?.[model];
      if (efforts(initial)[adapter]?.[model] === after) continue;
      // OBS-1188: the type already demands lower state here; this refuses a cast/JS caller before the
      // bytes are returned, so a blind effort write never reaches disk.
      const lowerAll = write.lowerOverrides;
      if (!lowerAll) {
        throw new Error(`fleet write: the effort edit on ${adapter}:${model} needs the lower config layers' model overrides — refusing to write it blind`);
      }
      const override = ["tiers", adapter, "modelOverrides", model];
      if (after !== undefined) {
        // Setting beneath a tombstone (the override, or modelOverrides above it) lifts it, and
        // deepMerge would restore what it masked: re-mask each lower-layer key it covered — sibling
        // models, then this override's own keys.
        // ponytail: tiers.<adapter> itself tombstoned is unreachable here — its models, and so a tier, are masked too.
        const tombstoned = (depth: number) => {
          const node = doc.getIn(override.slice(0, depth), true);
          return node !== undefined && !isMap(node);
        };
        const lowerModels = lowerAll[adapter] ?? {};
        const remask: string[][] = [];
        if (tombstoned(3)) for (const other of Object.keys(lowerModels)) if (other !== model) remask.push([...override.slice(0, 3), other]);
        if (tombstoned(3) || tombstoned(4)) {
          for (const key of Object.keys(lowerModels[model] ?? {})) if (key !== "effort") remask.push([...override, key]);
        }
        setScalarPreservingComment(doc, [...override, "effort"], after);
        for (const path of remask) setScalarPreservingComment(doc, path, null);
        continue;
      }
      // Clearing means no effort in the MERGED config: drop the repo key, then mask an effort the
      // lower layers still declare.
      deleteAt(doc, [...override, "effort"]);
      const lower = lowerAll[adapter]?.[model];
      const maskEffort = lower?.effort !== undefined;
      const repoNode = doc.getIn(override, true);
      const { effort: _masked, ...rest } = { ...lower, ...(isMap(repoNode) ? repoNode.toJSON() as object : {}) };
      if (Object.values(rest).some((v) => v !== null && v !== undefined)) {
        if (maskEffort) setScalarPreservingComment(doc, [...override, "effort"], null);
      } else if (maskEffort || (isMap(repoNode) && repoNode.items.length > 0)) {
        // Tombstone-only siblings must still suppress lower metadata when effort is cleared,
        // even without inherited effort. Their merged {} would fail the nonempty refinement.
        setScalarPreservingComment(doc, override, null);
      }
      for (const depth of [4, 3, 2, 1]) deleteEmptyMap(doc, override.slice(0, depth));
    }
  }

  if (write.mode !== undefined) {
    setScalarPreservingComment(doc, ["routing", "mode"], write.mode);
  }
  if (write.judge) {
    setScalarPreservingComment(doc, ["judge", "adapter"], write.judge.adapter);
    setScalarPreservingComment(doc, ["judge", "model"], write.judge.model);
  }

  if (write.steering) {
    for (const key of ["review", "consult"] as const) {
      const before = write.steering.initial[key];
      const after = write.steering.edited[key];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      if (after === undefined) {
        deleteAt(doc, [key, "prefer"]);
        deleteEmptyMap(doc, [key]);
      } else {
        setStringSequencePreservingComments(doc, [key, "prefer"], after);
      }
    }
  }

  // Every mutation no-oped against an empty or comment-only overlay (contents stays null;
  // deleteAt never creates content): return the prior bytes verbatim — stringifying a null
  // document would write a literal `null` line into the file.
  if (doc.contents === null) return priorBytes;

  // OBS-505: fleet's two-space note style (`tier: mid  # note`) applies to INLINE comments only.
  // The previous commentString prefixed " #" onto EVERY comment line, so block comments — the
  // whole init scaffold at column 0, and indented operator essays — each gained a stray leading
  // space, turning a one-key write into a whole-file diff on the one confirmation surface an
  // operator reviews. commentString has no position context, but this writer owns the document:
  // scalar-trailing single-line comments (the only inline form fleet emits) are marked with a
  // private-use sentinel (the FIRST_TOUCH envelope precedent above), everything else renders
  // byte-identical to yaml's own stringifyComment. OBS-1046: a scalar parsed from the prior bytes
  // keeps the exact whitespace it had before its hash sign (yaml itself emits one space, so the
  // sentinel carries the rest); only a comment fleet authored gets the two-space style.
  // T10 (D-936): a flow collection's trailing note (`[codex]  # c`) is inline too, so it keeps its gap.
  visit(doc, (_key, node) => {
    if ((isScalar(node) || (isCollection(node) && node.flow)) && typeof node.comment === "string" && !node.comment.includes("\n")) {
      const tail = node.range ? priorBytes.slice(node.range[1], node.range[2]) : "";
      const gap = /^([ \t]+)#/.exec(tail)?.[1] ?? "  ";
      node.comment = `${INLINE_COMMENT_SENTINEL}${gap.slice(1)}#${node.comment}`;
    }
  });
  return doc.toString({
    commentString: (comment) => comment.startsWith(INLINE_COMMENT_SENTINEL)
      ? comment.slice(1)
      : comment.replace(/^(?!$)(?: $)?/gm, "#"),
    // OBS-518: yaml's default pads flow collections (`[kimi]` → `[ kimi ]`), churning untouched
    // lines on the one confirmation surface an operator reviews. Hand-written overlays use the
    // unpadded form; emit it.
    flowCollectionPadding: false,
  });
}

/** T10: the 1-based line of the key that holds `path` in these overlay bytes — the path's own key, the
 * key whose `null` masks it from above, or a `<<` merge key on it (D-987: the write there refuses) — else
 * undefined (the overlay neither declares nor masks it). */
export function overlayHoldingLine(bytes: string, path: readonly string[]): number | undefined {
  const doc = parseDocument(bytes);
  if (doc.errors.length) return undefined;
  const lineOf = (offset: number) => bytes.slice(0, offset).split("\n").length;
  let node: unknown = doc.contents;
  let line: number | undefined;
  for (const key of path) {
    if (isAlias(node)) node = node.resolve(doc);
    if (line !== undefined && isScalar(node) && node.value === null) return line; // a mask at or above
    if (!isMap(node)) return undefined;
    const merge = node.items.find((item) => isScalar(item.key) && typeof item.key.value === "symbol");
    const pair = merge ?? node.items.find((item) => isScalar(item.key) && String(item.key.value) === key);
    if (!pair || !isScalar(pair.key) || !pair.key.range) return undefined;
    line = lineOf(pair.key.range[0]);
    if (merge) return line;
    node = pair.value;
  }
  return line;
}

/** T10: does `path` hold a mapping in these overlay bytes — neither absent nor a `null` mask? */
export function overlayHoldsMap(bytes: string, path: readonly string[]): boolean {
  const doc = parseDocument(bytes);
  return !doc.errors.length && isMap(doc.getIn(path, true));
}

/** Build the repo overlay fragment fleet would write for edits since session start. */
export function fleetRepoOverlayFromDelta(
  initial: FleetEditable,
  edited: FleetEditable,
  existingRepo: Record<string, unknown> = {},
  firstTouches: Readonly<Record<string, FleetFirstTouch>> = {},
  universe?: FleetUniverseRow[],
): Record<string, unknown> {
  if (fleetEditableEquals(initial, edited)) return {};
  const out = structuredClone(existingRepo) as Record<string, unknown>;
  const routing = { ...(out.routing as Record<string, unknown> | undefined) };
  let routingTouched = false;
  // OBS-1099 add.1: the flat scopes (routing.deny.<leaf>) and the allow complement are one
  // membership write; a list or its tombstone lands at every flat scope the enumeration names
  const changedAt = (scope: DenyScope) =>
    sortedUnique(initial[scope.key] ?? []).join() !== sortedUnique(edited[scope.key] ?? []).join();
  const listOrTombstone = (entries: string[]) => entries.length ? entries : null;
  const denyChanged = flatDenyScopes().some(changedAt)
    || sortedUnique(initial.allowOut ?? []).join() !== sortedUnique(edited.allowOut ?? []).join();
  if (denyChanged) {
    if (universe) {
      const form = allowFormFromExclusions(universe, edited);
      if (form.excluded) {
        routing.allow = {
          ...(form.adapters.length ? { adapters: form.adapters } : {}),
          ...(form.models.length ? { models: form.models } : {}),
        };
      } else delete routing.allow;
      routing.deny = {
        ...(routing.deny as Record<string, unknown> | undefined),
        ...Object.fromEntries(flatDenyScopes().map((scope) =>
          [scope.path[scope.path.length - 1], listOrTombstone(residualDeny(universe, edited[scope.key] ?? []))])),
      };
    } else {
      routing.deny = Object.fromEntries(flatDenyScopes().map((scope) =>
        [scope.path[scope.path.length - 1], listOrTombstone(edited[scope.key] ?? [])]));
    }
    routingTouched = true;
  }

  // OBS-994/FL-1: a nested scope (routing.deny.workers.*) is a literal list, independent of the
  // universe/allow dance above. Each sub-path is included only when it actually changed — an
  // untouched sibling must not be rewritten as a `null` tombstone over whatever the existing repo
  // overlay already held.
  for (const scope of nestedDenyScopes().filter(changedAt)) {
    let cur = (routing.deny = { ...(routing.deny as Record<string, unknown> | undefined) });
    for (const segment of scope.path.slice(2, -1)) cur = (cur[segment] = { ...(cur[segment] as Record<string, unknown> | undefined) });
    cur[scope.path[scope.path.length - 1]] = listOrTombstone(edited[scope.key] ?? []);
    routingTouched = true;
  }
  // pool widened to accept the null tombstone; MapEntry itself never carries null in memory.
  const mapDelta: Record<string, Omit<MapEntry, "pool"> & { pool?: MapEntry["pool"] | null }> = {};
  for (const shape of new Set([...Object.keys(initial.map), ...Object.keys(edited.map)])) {
    if (JSON.stringify(initial.map[shape]) !== JSON.stringify(edited.map[shape])) {
      const next: (typeof mapDelta)[string] = { ...edited.map[shape] };
      if (
        initial.map[shape]?.prefer !== undefined && edited.map[shape]?.prefer === undefined
        && edited.map[shape]?.pool === undefined && edited.map[shape]?.pin === undefined
      ) {
        next.prefer = [];
      }
      // pool: null tombstone — a removed pool must mask the lower layer, never inherit it again.
      if (initial.map[shape]?.pool !== undefined && edited.map[shape]?.pool === undefined) {
        next.pool = null;
      }
      mapDelta[shape] = next;
    }
  }
  if (Object.keys(mapDelta).length) {
    routing.map = { ...(routing.map as Record<string, MapEntry> | undefined), ...mapDelta };
    routingTouched = true;
  }
  const floorDelta: Record<string, Tier> = {};
  for (const shape of new Set([...Object.keys(initial.floors), ...Object.keys(edited.floors)])) {
    if (initial.floors[shape] !== edited.floors[shape]) floorDelta[shape] = edited.floors[shape];
  }
  if (Object.keys(floorDelta).length) {
    routing.floors = { ...(routing.floors as Record<string, Tier> | undefined), ...floorDelta };
    routingTouched = true;
  }
  if (routingTouched) out.routing = routing;
  type TierOverlayEntry = Record<string, unknown> & { models?: Record<string, Tier | null> };
  const tiersOut: Record<string, TierOverlayEntry> = {
    ...(out.tiers as Record<string, TierOverlayEntry> | undefined),
  };
  let tiersTouched = false;
  const adapters = new Set([...Object.keys(initial.tiers), ...Object.keys(edited.tiers)]);
  for (const adapter of adapters) {
    const models = new Set([
      ...Object.keys(initial.tiers[adapter] ?? {}),
      ...Object.keys(edited.tiers[adapter] ?? {}),
    ]);
    const modelDelta: Record<string, Tier | null> = {};
    for (const model of models) {
      const a = initial.tiers[adapter]?.[model];
      const b = edited.tiers[adapter]?.[model];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        modelDelta[model] = b === null || b === undefined ? null : b.tier;
      }
    }
    if (Object.keys(modelDelta).length) {
      const existingEntry = tiersOut[adapter] ?? {};
      const firstTouch = firstTouches[adapter];
      // Spread the whole entry rather than a known-key projection: vendor/channel/windows and sibling
      // keys introduced by newer schemas all survive. A genuinely new entry receives only facts the
      // adapter/operator declared; channel is never inferred from the binary.
      tiersOut[adapter] = {
        ...existingEntry,
        ...(existingEntry.vendor === undefined && firstTouch ? { vendor: firstTouch.vendor } : {}),
        ...(existingEntry.channel === undefined && firstTouch ? { channel: firstTouch.channel } : {}),
        models: { ...existingEntry.models, ...modelDelta },
      };
      tiersTouched = true;
    }
  }
  if (tiersTouched) out.tiers = tiersOut;
  return out;
}

export function repoOverlayYaml(
  overlay: Record<string, unknown>,
): string {
  if (!Object.keys(overlay).length) return "";
  const fleet = fleetSubset(overlay);
  const fleetBody = serializeFleetOverlay(fleet);
  const rest = { ...overlay };
  for (const k of FLEET_OVERLAY_KEYS) delete rest[k];
  if (!Object.keys(rest).length) return fleetBody;
  const head = stringify(rest).trimEnd();
  return fleetBody ? `${head}\n${fleetBody}` : `${head}\n`;
}

export function serializeFleetOverlay(
  overlay: Record<string, unknown>,
): string {
  if (!Object.keys(overlay).length) return "";
  const lines: string[] = [];
  // OBS-75: never glue stringify() output onto a key line — wrap the key into the object and
  // re-indent the whole emitted block, so sequences/nested maps nest correctly and null
  // tombstones/empty collections survive the serialize→parse round-trip.
  const block = (obj: Record<string, unknown>, pad: string): string[] =>
    stringify(obj).trimEnd().split("\n").map((l) => `${pad}${l}`);
  const denySeq = (key: "adapters" | "models", v: string[] | null | undefined): string[] => {
    if (v === undefined) return [];
    if (v === null || !v.length) return block({ [key]: v }, "    ");
    const out = [`    ${key}:`];
    for (const item of v) {
      const emitted = stringify([item]).trimEnd().split("\n");
      out.push(...emitted.map((l) => `      ${l}`));
    }
    return out;
  };
  const routing = overlay.routing as Record<string, unknown> | undefined;
  if (routing) {
    lines.push("routing:");
    const deny = routing.deny as { adapters?: string[] | null; models?: string[] | null } | undefined;
    if (deny && (deny.adapters !== undefined || deny.models !== undefined)) {
      lines.push("  deny:");
      lines.push(...denySeq("adapters", deny.adapters));
      lines.push(...denySeq("models", deny.models));
    }
    if (routing.map) lines.push(...block({ map: routing.map as Record<string, MapEntry> }, "  "));
    if (routing.floors) lines.push(...block({ floors: routing.floors as Record<string, unknown> }, "  "));
  }
  const tiers = overlay.tiers as Record<string, unknown> | undefined;
  if (tiers && Object.keys(tiers).length) {
    lines.push("tiers:");
    for (const [adapter, entry] of Object.entries(tiers)) {
      lines.push(...block({ [adapter]: entry }, "  "));
    }
  }
  return `${lines.join("\n")}\n`;
}

export function unifiedYamlDiff(before: string, after: string, label = "config overlay"): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  // v1.60 T3: shortest-edit (LCS) matching. The old scan resynced greedily on the first mismatched
  // line, so one inserted line could cascade into a whole-file remove/re-add hunk on the one
  // confirmation surface an operator reviews before a write.
  // ponytail: O(n·m) table — overlays are tens of lines; Myers O(nd) if files ever grow.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const header = [`--- ${label} (current)`, `+++ ${label} (proposed)`];
  const hunks: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    const del: string[] = [];
    const add: string[] = [];
    while ((i < a.length || j < b.length) && !(i < a.length && j < b.length && a[i] === b[j])) {
      if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) del.push(`-${a[i++]}`);
      else add.push(`+${b[j++]}`);
    }
    hunks.push("@@", ...del, ...add);
  }
  return `${header.join("\n")}\n${hunks.join("\n")}\n`;
}

export function fleetEditableEquals(a: FleetEditable, b: FleetEditable): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
