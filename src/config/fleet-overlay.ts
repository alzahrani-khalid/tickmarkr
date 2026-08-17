// Fleet-overlay mutation, serialization, and diff rendering for the `tickmarkr fleet` write path.
import { isMap, isScalar, isSeq, parseDocument, stringify, visit } from "yaml";
import { type FleetEditable, type MapEntry, type RoutingMode, type Tier, universeCovers } from "./config.js";

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

export type FleetOverlayWrite = {
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
  universe?: { adapter: string; models: string[] }[];
};

// The minimal routing.allow form for an exclusion-set membership write: whole adapter ids for
// fully-in adapters, adapter:model keys for partially-in ones, nothing for fully-out ones.
// `excluded` false ⇔ the whole universe is in fleet ⇒ the allow block is removed, not written.
function allowFormFromExclusions(
  universe: { adapter: string; models: string[] }[],
  edited: FleetEditable,
): { adapters: string[]; models: string[]; excluded: boolean } {
  if (!universe.length) {
    throw new Error(
      "fleet write: universe is empty — no classified models to compute routing.allow from; classify models in `tickmarkr fleet` first",
    );
  }
  const denyAdapters = new Set(edited.denyAdapters);
  const denyModels = new Set(edited.denyModels);
  const adapters: string[] = [];
  const models: string[] = [];
  let excluded = false;
  for (const row of universe) {
    if (denyAdapters.has(row.adapter)) {
      excluded = true;
      continue;
    }
    const inFleet = row.models.filter((m) => !denyModels.has(`${row.adapter}:${m}`));
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
  universe: { adapter: string; models: string[] }[],
  entries: string[],
): string[] {
  return sortedUnique(entries.filter((entry) => !universeCovers(universe, entry)));
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
  if (isScalar(existing)) existing.value = value;
  else doc.setIn(path, doc.createNode(value));
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
    doc.setIn(path, tombstone);
    return;
  }
  if (!isSeq(existing)) {
    doc.setIn(path, doc.createNode(values));
    return;
  }
  const available = [...existing.items];
  existing.items = values.map((value) => {
    const at = available.findIndex((item) => isScalar(item) && String(item.value) === value);
    if (at >= 0) return available.splice(at, 1)[0];
    return doc.createNode(value);
  });
}

function deleteEmptyMap(doc: OverlayDocument, path: OverlayPath): void {
  const node = doc.getIn(path, true);
  if (isMap(node) && node.items.length === 0) doc.deleteIn(path);
}

/** Apply only fields fleet authored to the parsed YAML document. Untouched nodes retain their
 * keys, ordering, scalar style, and comments; fresh provenance is written directly on its tier node. */
export function renderFleetOverlayWrite(priorBytes: string, write: FleetOverlayWrite): string {
  const doc = parseDocument(priorBytes);
  if (doc.errors.length) throw doc.errors[0];

  const { initial, edited } = write;
  const denyChanged =
    sortedUnique(initial.denyAdapters).join() !== sortedUnique(edited.denyAdapters).join()
    || sortedUnique(initial.denyModels).join() !== sortedUnique(edited.denyModels).join();
  if (denyChanged) {
    if (write.universe) {
      // Membership write: the allow form IS the fleet; deny adapters/models scopes are tombstoned
      // so a lower layer can never re-exclude behind the operator's back (workers untouched).
      const form = allowFormFromExclusions(write.universe, edited);
      if (form.excluded) {
        const allowNode = doc.getIn(["routing", "allow"], true);
        if (allowNode !== undefined && !isMap(allowNode)) doc.deleteIn(["routing", "allow"]);
        // deleteIn throws on an empty document — only delete keys that exist.
        if (form.adapters.length) {
          setStringSequencePreservingComments(doc, ["routing", "allow", "adapters"], form.adapters);
        } else if (doc.getIn(["routing", "allow", "adapters"]) !== undefined) {
          doc.deleteIn(["routing", "allow", "adapters"]);
        }
        if (form.models.length) {
          setStringSequencePreservingComments(doc, ["routing", "allow", "models"], form.models);
        } else if (doc.getIn(["routing", "allow", "models"]) !== undefined) {
          doc.deleteIn(["routing", "allow", "models"]);
        }
        // Whole fleet out: allow stays present but empty — fail-closed, nothing admitted.
        if (doc.getIn(["routing", "allow"]) === undefined) {
          doc.setIn(["routing", "allow"], doc.createNode({}));
        }
      } else if (doc.getIn(["routing", "allow"]) !== undefined) {
        // Whole fleet in: no restriction to express — the allow block goes away entirely.
        doc.deleteIn(["routing", "allow"]);
      }
      // Residuals stay in deny; covered scopes are tombstoned so a lower layer can never
      // re-exclude behind the operator's back (workers untouched).
      const residualAdapters = residualDeny(write.universe, edited.denyAdapters);
      const residualModels = residualDeny(write.universe, edited.denyModels);
      setStringSequencePreservingComments(
        doc,
        ["routing", "deny", "adapters"],
        residualAdapters.length ? residualAdapters : null,
      );
      setStringSequencePreservingComments(
        doc,
        ["routing", "deny", "models"],
        residualModels.length ? residualModels : null,
      );
    } else {
      setStringSequencePreservingComments(
        doc,
        ["routing", "deny", "adapters"],
        edited.denyAdapters.length ? sortedUnique(edited.denyAdapters) : null,
      );
      setStringSequencePreservingComments(
        doc,
        ["routing", "deny", "models"],
        edited.denyModels.length ? sortedUnique(edited.denyModels) : null,
      );
    }
  }

  for (const shape of new Set([...Object.keys(initial.map), ...Object.keys(edited.map)])) {
    const before = initial.map[shape];
    const after = edited.map[shape];
    if (JSON.stringify(before?.pin) !== JSON.stringify(after?.pin)) {
      if (after?.pin === undefined) doc.deleteIn(["routing", "map", shape, "pin"]);
      else doc.setIn(["routing", "map", shape, "pin"], doc.createNode(after.pin));
    }
    if (JSON.stringify(before?.pool) !== JSON.stringify(after?.pool)) {
      const path = ["routing", "map", shape, "pool"];
      if (after?.pool === undefined) {
        // pool: null tombstone — masks a lower-layer pool instead of inheriting it again.
        setStringSequencePreservingComments(doc, path, null);
      } else {
        const existing = doc.getIn(path, true);
        if (existing !== undefined && !isMap(existing)) doc.deleteIn(path);
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
        doc.deleteIn(["routing", "map", shape, "prefer"]);
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
      if (after?.escalate === undefined) doc.deleteIn(["routing", "map", shape, "escalate"]);
      else setScalarPreservingComment(doc, ["routing", "map", shape, "escalate"], after.escalate);
    }
  }

  for (const shape of new Set([...Object.keys(initial.floors), ...Object.keys(edited.floors)])) {
    if (initial.floors[shape] === edited.floors[shape]) continue;
    const tier = edited.floors[shape];
    if (tier === undefined) doc.deleteIn(["routing", "floors", shape]);
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
        doc.deleteIn([key, "prefer"]);
        deleteEmptyMap(doc, [key]);
      } else {
        setStringSequencePreservingComments(doc, [key, "prefer"], after);
      }
    }
  }

  // OBS-505: fleet's two-space note style (`tier: mid  # note`) applies to INLINE comments only.
  // The previous commentString prefixed " #" onto EVERY comment line, so block comments — the
  // whole init scaffold at column 0, and indented operator essays — each gained a stray leading
  // space, turning a one-key write into a whole-file diff on the one confirmation surface an
  // operator reviews. commentString has no position context, but this writer owns the document:
  // scalar-trailing single-line comments (the only inline form fleet emits) are marked with a
  // private-use sentinel (the FIRST_TOUCH envelope precedent above), everything else renders
  // byte-identical to yaml's own stringifyComment.
  visit(doc, (_key, node) => {
    if (isScalar(node) && typeof node.comment === "string" && !node.comment.includes("\n")) {
      node.comment = `${INLINE_COMMENT_SENTINEL}${node.comment}`;
    }
  });
  return doc.toString({
    commentString: (comment) => comment.startsWith(INLINE_COMMENT_SENTINEL)
      ? ` #${comment.slice(1)}`
      : comment.replace(/^(?!$)(?: $)?/gm, "#"),
    // OBS-518: yaml's default pads flow collections (`[kimi]` → `[ kimi ]`), churning untouched
    // lines on the one confirmation surface an operator reviews. Hand-written overlays use the
    // unpadded form; emit it.
    flowCollectionPadding: false,
  });
}

/** Build the repo overlay fragment fleet would write for edits since session start. */
export function fleetRepoOverlayFromDelta(
  initial: FleetEditable,
  edited: FleetEditable,
  existingRepo: Record<string, unknown> = {},
  firstTouches: Readonly<Record<string, FleetFirstTouch>> = {},
  universe?: { adapter: string; models: string[] }[],
): Record<string, unknown> {
  if (fleetEditableEquals(initial, edited)) return {};
  const out = structuredClone(existingRepo) as Record<string, unknown>;
  const routing = { ...(out.routing as Record<string, unknown> | undefined) };
  let routingTouched = false;
  const denyChanged =
    sortedUnique(initial.denyAdapters).join() !== sortedUnique(edited.denyAdapters).join()
    || sortedUnique(initial.denyModels).join() !== sortedUnique(edited.denyModels).join();
  if (denyChanged) {
    if (universe) {
      const form = allowFormFromExclusions(universe, edited);
      if (form.excluded) {
        routing.allow = {
          ...(form.adapters.length ? { adapters: form.adapters } : {}),
          ...(form.models.length ? { models: form.models } : {}),
        };
      } else delete routing.allow;
      const residualAdapters = residualDeny(universe, edited.denyAdapters);
      const residualModels = residualDeny(universe, edited.denyModels);
      routing.deny = {
        ...(routing.deny as Record<string, unknown> | undefined),
        adapters: residualAdapters.length ? residualAdapters : null,
        models: residualModels.length ? residualModels : null,
      };
    } else {
      routing.deny = {
        adapters: edited.denyAdapters.length ? edited.denyAdapters : null,
        models: edited.denyModels.length ? edited.denyModels : null,
      };
    }
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
