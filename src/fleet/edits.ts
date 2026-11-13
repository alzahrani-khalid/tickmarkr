// The fleet screen's one write path. A yes becomes edits { layer, path, value }; edits are applied
// to the YAML text of their layer the way a careful hand would, so comments and order survive.
import { isAlias, isMap, isScalar, isSeq, parse, parseDocument, stringify } from "yaml";
import { DEFAULT_CONFIG, DENY_SCOPES, loadConfigWithMode, ROUTING_MODES } from "../config/config.js";
import { materializeAliases, overlayDocBytes, refuseMerge, releaseAnchors } from "../config/fleet-overlay.js";
import { SHAPES, TIERS } from "../graph/schema.js";

export type Layer = "repo" | "user";
type Document = ReturnType<typeof parseDocument>;
/** `value: undefined` removes the key; `null` writes the overlay tombstone. */
export interface Edit { layer: Layer; path: string[]; value: unknown; label: string }
export interface Texts { userText: string; repoText: string }

const valueAt = (obj: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>((cur, seg) => (cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined), obj);
/**
 * Several yes answers may touch the same list, map or pool. Each is applied as what it adds and
 * removes against the current config, at every depth, so one answer never undoes another. Only
 * answers at one identical layer and path combine; any other overlap is refused by applyEdits.
 */
export function combineEdits(cfg: unknown, all: readonly Edit[]): Edit[] {
  const out = new Map<string, Edit>();
  for (const e of all) {
    const id = `${e.layer}|${e.path.join("\u0000")}`;
    const prev = out.get(id);
    out.set(id, prev ? { ...e, value: combine(e.path, valueAt(cfg, e.path), prev.value, e.value), label: `${prev.label}; ${e.label}` } : e);
  }
  return [...out.values()];
}

/** Two answers at one path, against the value they were both given on: lists by what each adds and removes, maps key by key. */
function combine(path: readonly string[], base: unknown, a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) {
    const was = Array.isArray(base) ? base : [];
    return [...a.filter((x) => b.includes(x) || !was.includes(x)), ...b.filter((x) => !was.includes(x) && !a.includes(x))];
  }
  if (!isObj(a) || !isObj(b)) return b;
  // pin, pool and prefer stay one slot: an answer naming one drops the other answer's others
  const kept = isSlot(path) && SLOT.some((k) => k in b) ? Object.fromEntries(Object.entries(a).filter(([k]) => !(SLOT as readonly string[]).includes(k) || k in b)) : a;
  const value: Record<string, unknown> = { ...kept };
  for (const [k, v] of Object.entries(b)) value[k] = k in kept ? combine([...path, k], isObj(base) ? base[k] : undefined, kept[k], v) : v;
  return value;
}

/** A refusal: the layer whose file it names and the first path that would have changed. Nothing is written. */
export class EditRefused extends Error {
  constructor(readonly layer: Layer, readonly path: readonly string[], why: string) {
    super(`${layer === "repo" ? "the repository's config" : "the user config"}: ${why}`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const copy = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);
const isSlot = (path: readonly string[]) => path.length === 3 && path[0] === "routing" && path[1] === "map";
// pin, pool and prefer are one declaration per shape: an edit that names one replaces the others; one that names none keeps them
const SLOT = ["pin", "pool", "prefer"] as const;
/** The keys the lower layers may hold at `at`: a superset of what they merge to there, which is all a mask needs. */
const lowerKeys = (lower: readonly unknown[], at: readonly string[]): string[] =>
  [...new Set(lower.flatMap((l) => { const v = valueAt(l, at); return isObj(v) ? Object.keys(v) : []; }))];
// a null at tiers.<adapter>.vendor declares a multi-vendor CLI; it is no tombstone, so it is never written as a mask
const masks = (path: readonly string[]) => !(path.length === 3 && path[0] === "tiers" && path[2] === "vendor");

/**
 * What an edit means, on plain data (a JSON copy of a parsed layer, so no anchor is shared): the one
 * rule both the expectation and the document writer below follow. A map is edited key by key (pin,
 * pool and prefer of a shape are one slot); a list or scalar replaces; `undefined` removes the key.
 * A null (the overlay's tombstone) on the path is lifted, and every key it masked off the path is
 * written as a null of its own, so lifting it for one leaf never brings back the rest.
 */
function applyData(root: unknown, e: Edit, lower: readonly unknown[]): unknown {
  const top: Record<string, unknown> = isObj(root) ? root : {};
  const at = (path: readonly string[]): unknown => valueAt(top, path);
  const put = (path: readonly string[], v: unknown) => {
    let o = top;
    for (const seg of path.slice(0, -1)) o = (isObj(o[seg]) ? o[seg] : (o[seg] = {})) as Record<string, unknown>;
    o[path[path.length - 1]] = v;
  };
  const { path, value } = e;
  if (value === undefined) {
    const parent = at(path.slice(0, -1));
    if (isObj(parent)) delete parent[path[path.length - 1]];
    return top;
  }
  let lifted = false;
  for (let depth = 1; depth <= path.length; depth++) {
    const node = at(path.slice(0, depth));
    if (node === undefined) break;
    if (isObj(node)) continue;
    if (depth === path.length && !isObj(value)) break;
    if (depth < path.length) put(path.slice(0, depth), {});
    for (let d = depth; d < path.length; d++) for (const k of lowerKeys(lower, path.slice(0, d))) if (k !== path[d] && masks([...path.slice(0, d), k])) put([...path.slice(0, d), k], null);
    lifted = true;
    break;
  }
  const assign = (p: readonly string[], v: unknown): void => {
    const cur = at(p);
    if (isObj(v) && isObj(cur)) {
      if (isSlot(p) && SLOT.some((k) => k in v)) for (const k of SLOT) if (!(k in v)) delete cur[k];
      for (const [k, x] of Object.entries(v)) assign([...p, k], x);
    } else put(p, copy(v));
  };
  assign(path, value);
  const maskUnder = (p: readonly string[], v: unknown): void => {
    if (!isObj(v)) return;
    for (const k of lowerKeys(lower, p)) if (k in v) maskUnder([...p, k], v[k]); else if (masks([...p, k])) put([...p, k], null);
  };
  if (lifted) maskUnder(path, value);
  return top;
}

/** The first path where two values differ; a null, an absent key and an empty map are the same; lists compare in order. */
function firstDiff(a: unknown, b: unknown, at: readonly string[] = []): string[] | null {
  const empty = (v: unknown) => v === null || v === undefined || (isObj(v) && Object.values(v).every(empty));
  if (empty(a) && empty(b)) return null;
  if (isObj(a) && isObj(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) { const d = firstDiff(a[k], b[k], [...at, k]); if (d) return d; }
    return null;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], [...at, String(i)]); if (d) return d; }
    return null;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? null : [...at];
}

const lineOf = (text: string, offset: number | undefined) => (offset === undefined ? "?" : String(text.slice(0, offset).split("\n").length));

function assign(doc: Document, text: string, e: Edit, path: string[], value: unknown): void {
  // An alias here is edited as its own copy: the keys and comments it resolved to stay, and the
  // anchor it named is untouched.
  if (isAlias(doc.getIn(path, true))) materializeAliases(doc, [...path, ""]);
  const node = doc.getIn(path, true);
  if (Array.isArray(value) && isSeq(node)) {
    // Every item that stays keeps its own node, so a comment written above it goes where it goes.
    // That is only provable for plain scalars, pairwise different: an alias item, a nested
    // collection or two equal entries is refused, not rebuilt by value (RULING-T5 rule 3).
    const values = node.items.map((i) => (isScalar(i) && !isAlias(i) ? i.value : undefined));
    if (values.some((v) => v === undefined || v === null || typeof v === "object") || new Set(values).size !== values.length) {
      throw new EditRefused(e.layer, e.path, `${path.join(".")} (line ${lineOf(text, node.range?.[0])}) holds an alias, a nested item or two equal entries — Fleet rewrites only a list of different plain values; edit it by hand, then save again`);
    }
    const have = new Map(node.items.map((i) => [(i as { value: unknown }).value, i]));
    const used = new Set<unknown>();
    node.items = value.map((v) => { const kept = used.has(v) ? undefined : have.get(v); used.add(v); return kept ?? doc.createNode(v); });
    return;
  }
  if (isObj(value) && isMap(node)) {
    // A map is edited key by key: a key the edit does not name is not the edit's to remove. The one
    // exception is the loader's own rule: pin, pool and prefer are one declaration per shape.
    if (isSlot(path) && SLOT.some((k) => k in value)) for (const k of SLOT) if (!(k in value)) node.delete(k);
    for (const [k, v] of Object.entries(value)) assign(doc, text, e, [...path, k], v);
    return;
  }
  doc.setIn(path, doc.createNode(value));
}

const mask = (doc: Document, path: readonly string[]): void => { if (masks(path)) doc.setIn(path, null); };
/** Under a lifted tombstone, every lower key the edited map does not name stays masked, at every depth. */
function maskUnder(doc: Document, at: readonly string[], value: unknown, lower: readonly unknown[]): void {
  if (!isObj(value)) return;
  for (const k of lowerKeys(lower, at)) if (k in value) maskUnder(doc, [...at, k], value[k], lower); else mask(doc, [...at, k]);
}
/** The tombstone lift of `applyData`, on the document. Returns whether one was lifted. */
function liftTombstone(doc: Document, path: readonly string[], value: unknown, lower: readonly unknown[]): boolean {
  for (let depth = 1; depth <= path.length; depth++) {
    const node = doc.getIn(path.slice(0, depth), true);
    if (node === undefined) return false;
    if (isMap(node)) continue;
    if (depth === path.length && !isObj(value)) return false;
    if (depth < path.length) doc.setIn(path.slice(0, depth), doc.createNode({}));
    for (let d = depth; d < path.length; d++) for (const k of lowerKeys(lower, path.slice(0, d))) if (k !== path[d]) mask(doc, [...path.slice(0, d), k]);
    return true;
  }
  return false;
}

/** Exactly the data it was: an edit that changes nothing, decided before the document is touched. */
const unchanged = (before: unknown, after: unknown) => JSON.stringify(after) === JSON.stringify(isObj(before) ? before : {});
const PRIVATE_USE = /[-]/;
const parsed = (text: string): unknown => copy(parse(text) as unknown) ?? null;
const lowerOf = (layer: Layer, below: string): unknown[] => {
  let user: unknown = null;
  if (layer === "repo") try { user = parse(below); } catch { /* an unreadable user layer masks nothing more */ }
  return [DEFAULT_CONFIG, user];
};

/**
 * One layer's text with its edits applied. `below` is the user layer's text when the edits are the
 * repo layer's: with the defaults, it is what a tombstone in this layer masks. Throws an EditRefused
 * for a merge key on an edited path, a list it cannot rewrite item by item, or a text that would
 * carry the serialiser's private marker. The proof of the result is `applyEdits`'.
 */
export function applyLayer(text: string, edits: readonly Edit[], below = ""): string {
  if (!edits.length) return text;
  refuseUnmade(edits);
  const doc = parseDocument(text);
  let changed = false;
  for (const e of edits) {
    const lower = lowerOf(e.layer, below);
    // An edit that changes nothing touches nothing, not even an alias: decided on data, by the one rule.
    const cur = copy(doc.toJS() as unknown) ?? null;
    if (unchanged(cur, applyData(copy(cur), e, lower))) continue;
    // a merge key on the path: the 2.24.0 writer's own check and words (RULING-T5 rule 2)
    try { refuseMerge(doc, text, e.path); } catch (err) { throw new EditRefused(e.layer, e.path, (err as Error).message); }
    changed = true;
    // One that does change never reaches another part of the file through a YAML alias: an alias on
    // its path becomes its own copy, and an anchor it is about to change is released.
    materializeAliases(doc, [...e.path, ""]);
    releaseAnchors(doc, e.path);
    if (e.value === undefined) { doc.deleteIn(e.path); continue; }
    const lifted = liftTombstone(doc, e.path, e.value, lower);
    assign(doc, text, e, e.path, e.value);
    if (lifted) maskUnder(doc, e.path, e.value, lower);
  }
  // nothing changed: the file as it was, not a reserialised copy of it
  if (!changed) return text;
  // the overlay writer's own serialiser: a line the edits did not touch keeps its bytes
  const out = overlayDocBytes(doc, text);
  if (PRIVATE_USE.test(out) && !PRIVATE_USE.test(text)) throw new EditRefused(edits[0].layer, edits[0].path, `${edits[0].path.join(".")} would be written with the writer's private marker — edit it by hand, then save again`);
  return out;
}

const isPrefix = (a: readonly string[], b: readonly string[]) => a.length <= b.length && a.every((s, i) => s === b[i]);
/**
 * Two answers that can reach one leaf other than at one identical layer and path (one path under
 * another, on one layer or two; or one path on both layers) are refused: the write path cannot prove
 * what they mean together (RULING-T5 rule 1, D-2187 add.222).
 */
function refuseOverlap(edits: readonly Edit[]): void {
  for (const a of edits) for (const b of edits) {
    if (a === b || a.path.length > b.path.length || (a.layer === b.layer && a.path.length === b.path.length)) continue;
    if (!isPrefix(a.path, b.path)) continue;
    throw new EditRefused(b.layer, b.path, `two answers both change ${b.path.join(".")} — answer one, save, then answer the other`);
  }
}

/**
 * The leaves the answers name: each path plus the keys of its map value, recursively. An empty map
 * names nothing, and a name is a leaf, never a prefix for a subtree (D-2187 add.229): the one whole
 * subtree an answer names is a slot it replaces (pin, pool or prefer of a shape), which goes whole.
 */
function named(edits: readonly Edit[]): { leaves: string[][]; whole: string[][] } {
  const leaves: string[][] = [], whole: string[][] = [];
  const walk = (p: string[], v: unknown): void => {
    if (!isObj(v)) { leaves.push(p); return; }
    if (isSlot(p) && SLOT.some((k) => k in v)) for (const k of SLOT) if (!(k in v)) whole.push([...p, k]);
    for (const [k, x] of Object.entries(v)) walk([...p, k], x);
  };
  for (const e of edits) walk(e.path, e.value);
  return { leaves, whole };
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && isPrefix(a, b);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const exactly = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => isObj(v) && Object.keys(v).length === keys.length && keys.every((k) => k in v);
const among = (list: readonly unknown[], v: unknown) => list.includes(v);
const LIST_PATHS: readonly string[][] = [["review", "prefer"], ["consult", "prefer"], ["routing", "allow", "models"], ...DENY_SCOPES.map((sc) => [...sc.path])];
// the pool modes the schema allows (src/config/config.ts, the pool's mode enum)
const POOL_MODES = ["any", "ordered"] as const;
/**
 * Whether an edit is one of the eight the screen's producers emit (D-2187 add.229). The write path's
 * input is closed: any other edit is refused by name before a document is parsed, so no reading of
 * what an unlisted edit "means" is ever needed.
 */
function fleetMakes(e: Edit): boolean {
  const { path, value: v } = e;
  if (e.layer !== "repo" && e.layer !== "user") return false;
  if (!Array.isArray(path) || !path.every((s) => typeof s === "string" && s !== "")) return false;
  const [a, b, c, , f] = path;
  if (path.length === 1 && a === "judge") return exactly(v, ["adapter", "model"]) && typeof v.adapter === "string" && typeof v.model === "string";
  if (path.length === 3 && a === "routing" && b === "map" && among(SHAPES, c)) {
    return exactly(v, ["pool"]) && exactly(v.pool, ["mode", "channels"]) && among(POOL_MODES, v.pool.mode) && isStrings(v.pool.channels);
  }
  if (LIST_PATHS.some((l) => same(l, path))) return isStrings(v);
  if (same(["routing", "mode"], path)) return among(ROUTING_MODES, v);
  if (path.length === 3 && a === "routing" && b === "floors" && among(SHAPES, c)) return v === undefined || among(TIERS, v);
  if (path.length === 4 && a === "tiers" && c === "models") return among(TIERS, v);
  if (path.length === 5 && a === "tiers" && c === "modelOverrides" && f === "vendor") return typeof v === "string";
  return false;
}
function refuseUnmade(edits: readonly Edit[]): void {
  for (const e of edits) if (!fleetMakes(e)) {
    const path = Array.isArray(e.path) ? e.path.map(String) : [];
    throw new EditRefused(e.layer === "user" ? "user" : "repo", path, `fleet does not make this edit (${path.join(".") || "no path"}) — edit it by hand, then save again`);
  }
}

type Loaded = ReturnType<typeof loadConfigWithMode>;
/** The first leaf that differs between two loaded configs and no answer names; the loader's derived values are not changes. */
function strayLeaf(a: Loaded, b: Loaded, edits: readonly Edit[]): string[] | null {
  const ok = named(edits);
  const moded = (shape: string) => [a, b].some((l) => (l.mode.provenance[shape] ?? "").startsWith("mode"));
  const partner = [a, b].some((l) => l.mode.mode === "partner-led");
  const derived = (p: readonly string[]) =>
    (p.length === 3 && p[0] === "routing" && p[1] === "floors" && moded(p[2])) ||
    (partner && p.length === 3 && p[0] === "routing" && p[1] === "explore" && p[2] === "mode");
  const empty = (v: unknown) => v === null || v === undefined || (isObj(v) && Object.values(v).every(empty));
  const walk = (x: unknown, y: unknown, p: string[]): string[] | null => {
    if (empty(x) && empty(y)) return null;
    if (isObj(x) || isObj(y)) {
      const mx = isObj(x) ? x : empty(x) ? {} : null, my = isObj(y) ? y : empty(y) ? {} : null;
      if (mx && my) {
        for (const k of [...new Set([...Object.keys(mx), ...Object.keys(my)])].sort()) { const d = walk(mx[k], my[k], [...p, k]); if (d) return d; }
        return null;
      }
    }
    if (JSON.stringify(x) === JSON.stringify(y) || derived(p) || ok.leaves.some((n) => same(n, p)) || ok.whole.some((n) => isPrefix(n, p))) return null;
    return p;
  };
  return walk(copy(a.cfg), copy(b.cfg), []);
}

/**
 * The fleet screen's one write: candidate texts, returned only when they prove themselves
 * (RULING-T5 rule 1). Both must load by the product's loader, and the loaded config must be exactly
 * what the edits mean, applied to JSON copies of the two layers: the edited paths change as the
 * edits say and nothing else does. Anything else throws an EditRefused naming the layer and the
 * first path that would have changed. An edit that changes nothing returns the texts as they were.
 * Two answers that overlap other than at one identical layer and path are refused before anything is
 * built, and the loaded config before and after may differ only at leaves the answers name.
 */
export function applyEdits(texts: Texts, answers: readonly Edit[]): Texts & { touched: Layer[] } {
  // Answers that touch one list are combined against the config they were given on, before anything
  // is expected or written: applied one after another, a later answer would undo an earlier one.
  // the input is closed: an edit no screen code produces is refused before any document is parsed
  refuseUnmade(answers);
  let original: unknown = {};
  try { original = loadConfigWithMode("/", { userOverlayText: texts.userText, repoOverlayText: texts.repoText }).cfg; } catch { /* refused below: the saved file would not load */ }
  const edits = combineEdits(original, answers);
  refuseOverlap(edits);
  const of = (layer: Layer) => edits.filter((e) => e.layer === layer);
  const first = (layer: Layer) => of(layer)[0]?.path ?? [];
  const before: Record<Layer, unknown> = { user: null, repo: null };
  for (const layer of ["user", "repo"] as const) {
    try { before[layer] = parsed(layer === "user" ? texts.userText : texts.repoText); } catch (err) { throw new EditRefused(layer, first(layer), (err as Error).message); }
  }
  // the expectation: what the edits mean, each on its own layer, in order
  const expected = { ...before };
  for (const e of edits) expected[e.layer] = applyData(copy(expected[e.layer]), e, e.layer === "repo" ? [DEFAULT_CONFIG, expected.user] : [DEFAULT_CONFIG]);
  if ((["user", "repo"] as const).every((l) => !of(l).length || unchanged(before[l], expected[l]))) {
    return { ...texts, touched: [] };
  }
  const userText = applyLayer(texts.userText, of("user"));
  const repoText = applyLayer(texts.repoText, of("repo"), userText);
  const out = { userText, repoText };
  const layerOf = (): Layer => {
    for (const layer of ["user", "repo"] as const) {
      try { if (firstDiff(parsed(out[`${layer}Text`]), expected[layer])) return layer; } catch { return layer; }
    }
    return of("repo").length ? "repo" : "user";
  };
  const load = (u: string, r: string) => loadConfigWithMode("/", { userOverlayText: u, repoOverlayText: r }).cfg;
  let got: unknown, want: unknown;
  try { got = load(userText, repoText); } catch (err) {
    const layer = layerOf();
    throw new EditRefused(layer, first(layer), `the saved file would not load: ${(err as Error).message}`);
  }
  try { want = load(isObj(expected.user) ? stringify(expected.user) : "", isObj(expected.repo) ? stringify(expected.repo) : ""); } catch (err) {
    const layer = layerOf();
    throw new EditRefused(layer, first(layer), `the change would not load: ${(err as Error).message}`);
  }
  const diff = firstDiff(copy(got), copy(want));
  if (diff) {
    const layer = layerOf();
    throw new EditRefused(layer, diff, `${diff.join(".")} would change in a way the answer does not say — edit it by hand, then save again`);
  }
  // Rule 1(b) on the loaded config itself, not through applyData (which shares the writer's rule and
  // would agree with its mistakes): every leaf that differs is one the answers name.
  const stray = strayLeaf(loadConfigWithMode("/", { userOverlayText: texts.userText, repoOverlayText: texts.repoText }), loadConfigWithMode("/", { userOverlayText: userText, repoOverlayText: repoText }), edits);
  if (stray) {
    const layer = layerOf();
    throw new EditRefused(layer, stray, `${stray.join(".")} would change though no answer names it — edit it by hand, then save again`);
  }
  return { ...out, touched: (["repo", "user"] as const).filter((l) => out[`${l}Text`] !== texts[`${l}Text`]) };
}

export interface DiffLine { op: " " | "+" | "-" | "…"; text: string; line: number }
/** The lines a save changes in the file as it is on disk, with two lines of context. */
export function layerDiff(before: string, after: string, context = 2): { lines: DiffLine[]; added: number; removed: number } {
  // the lines of a file, not its text cut at newlines: an empty file has none, and a final newline ends the last line
  const linesOf = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
  const a = linesOf(before), b = linesOf(after);
  const n = a.length, m = b.length;
  // ponytail: an n×m table, two bytes a cell — a 600-line overlay is under a megabyte. Myers O(nd) if a config ever runs to thousands of lines.
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: DiffLine[] = [];
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ op: " ", text: a[i], line: i + 1 }); i++; j++; }
    // a replaced line reads as a diff does: what goes, then what comes
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) { ops.push({ op: "-", text: a[i], line: i + 1 }); i++; }
    else { ops.push({ op: "+", text: b[j], line: j + 1 }); j++; }
  }
  const keep = new Set<number>();
  ops.forEach((o, k) => { if (o.op !== " ") for (let d = -context; d <= context; d++) keep.add(k + d); });
  const lines: DiffLine[] = [];
  let last = -2;
  ops.forEach((o, k) => {
    if (!keep.has(k)) return;
    if (k !== last + 1 && lines.length) lines.push({ op: "…", text: "", line: 0 });
    lines.push(o);
    last = k;
  });
  return { lines, added: ops.filter((o) => o.op === "+").length, removed: ops.filter((o) => o.op === "-").length };
}
