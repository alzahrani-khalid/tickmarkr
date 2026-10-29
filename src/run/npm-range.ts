/*
 * Loose range grammar adapted from node-semver 7.8.5 (internal/re.js,
 * classes/range.js, classes/semver.js and internal/identifiers.js).
 * Copyright (c) Isaac Z. Schlueter and Contributors (ISC).
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
 * IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

const digits = "\\d{1,256}";
const nonnumeric = "\\d{0,256}[a-zA-Z-][a-zA-Z0-9-]{0,250}";
const identifier = `(?:${nonnumeric}|${digits})`;
const prerelease = `(?:-?(${identifier}(?:\\.${identifier})*))`;
const buildIdentifier = "[a-zA-Z0-9-]{1,250}";
const build = `(?:\\+(${buildIdentifier}(?:\\.${buildIdentifier})*))`;
const versionPlain = `[v=\\s]*(${digits})\\.(${digits})\\.(${digits})${prerelease}?${build}?`;
const versionPattern = new RegExp(`^${versionPlain}$`);
const xIdentifier = `${digits}|x|X|\\*`;
const xPlain = `[v=\\s]*(${xIdentifier})(?:\\.(${xIdentifier})(?:\\.(${xIdentifier})${prerelease}?${build}?)?)?`;
const operator = "((?:<|>)?=?)";
const xPattern = new RegExp(`^${operator}\\s?${xPlain}$`);
const caretPattern = new RegExp(`^\\^${xPlain}$`);
const tildePattern = new RegExp(`^~>?${xPlain}$`);
const comparatorPattern = new RegExp(`^${operator}\\s?(${versionPlain})$|^$`);
const hyphenPattern = new RegExp(`^\\s?(${xPlain})\\s-\\s(${xPlain})\\s?$`);
// Comparator whitespace trimming uses the strict x grammar, like upstream,
// even though the eventual comparator and version parsing are loose.
const strictNumber = "(?:0|[1-9]\\d{0,256})";
const strictIdentifier = `(?:${nonnumeric}|${strictNumber})`;
const strictPre = `(?:-(${strictIdentifier}(?:\\.${strictIdentifier})*))`;
const strictX = `${strictNumber}|x|X|\\*`;
const strictXPlain = `[v=\\s]*(${strictX})(?:\\.(${strictX})(?:\\.(${strictX})${strictPre}?${build}?)?)?`;
const comparatorTrim = new RegExp(`(\\s?)${operator}\\s?(${versionPlain}|${strictXPlain})`, "g");
const buildStrip = /\+[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*/g;

interface Version {
  release: number[];
  pre: Array<string | number>;
}
interface Comparator {
  op: string;
  version?: Version;
}

function parseVersion(value: string): Version | undefined {
  if (value.length > 256) return undefined;
  const match = versionPattern.exec(value.trim());
  if (!match) return undefined;
  const release = match.slice(1, 4).map(Number);
  if (release.some((part) => !Number.isSafeInteger(part))) return undefined;
  const pre = match[4] ? match[4].split(".").map((id) =>
    /^[0-9]+$/.test(id) && Number(id) < Number.MAX_SAFE_INTEGER ? Number(id) : id) : [];
  return { release, pre };
}

// npm's identifiers.js classifies by digits, including numeric identifiers too
// large to be stored as numbers. Numeric/text ordering must not use typeof.
function compareIdentifier(a: string | number, b: string | number): number {
  const aNumeric = /^[0-9]+$/.test(String(a));
  const bNumeric = /^[0-9]+$/.test(String(b));
  if (aNumeric && bNumeric) {
    const left = Number(a), right = Number(b);
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a.release[i] !== b.release[i]) return a.release[i] < b.release[i] ? -1 : 1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const result = compareIdentifier(a.pre[i], b.pre[i]);
    if (result) return result;
  }
  return 0;
}

const isX = (id: string | undefined): boolean => !id || /^[xX*]$/.test(id);

function expandCompatible(comp: string, caret: boolean): string {
  const match = (caret ? caretPattern : tildePattern).exec(comp);
  if (!match) return comp;
  const [, major, minor, patch, pre] = match;
  if (isX(major)) return "";
  if (isX(minor)) return `>=${major}.0.0 <${+major + 1}.0.0-0`;
  const lower = `${major}.${minor}.${isX(patch) ? "0" : patch}${!isX(patch) && pre ? `-${pre}` : ""}`;
  let upper: string;
  if (!caret || major === "0" && isX(patch)) upper = `${major}.${+minor + 1}.0`;
  else if (major !== "0") upper = `${+major + 1}.0.0`;
  else if (minor !== "0") upper = `${major}.${+minor + 1}.0`;
  else upper = `${major}.${minor}.${+patch + 1}`;
  return `>=${lower} <${upper}-0`;
}

function expandX(comp: string): string {
  const match = xPattern.exec(comp);
  if (!match) return comp;
  let [, op, major, minor, patch] = match;
  // A concrete component after a wildcard is invalid for an x range.
  if (isX(major) && !isX(minor) || isX(minor) && patch && !isX(patch)) return comp;
  const xMajor = isX(major), xMinor = xMajor || isX(minor), xPatch = xMinor || isX(patch);
  if (op === "=" && xPatch) op = "";
  if (xMajor) return op === ">" || op === "<" ? "<0.0.0-0" : "*";
  if (op && xPatch) {
    if (xMinor) minor = "0";
    patch = "0";
    if (op === ">" || op === "<=") {
      if (xMinor) major = String(+major + 1);
      else minor = String(+minor + 1);
      op = op === ">" ? ">=" : "<";
    }
    return `${op}${major}.${minor}.${patch}${op === "<" ? "-0" : ""}`;
  }
  if (xMinor) return `>=${major}.0.0 <${+major + 1}.0.0-0`;
  if (xPatch) return `>=${major}.${minor}.0 <${major}.${+minor + 1}.0-0`;
  return comp;
}

function expandHyphen(range: string): string {
  return range.replace(hyphenPattern, (_all, from: string, major: string, minor: string, patch: string,
    _pre: string, _build: string, to: string, toMajor: string, toMinor: string, toPatch: string, toPre: string) => {
    const lower = isX(major) ? "" : isX(minor) ? `>=${major}.0.0`
      : isX(patch) ? `>=${major}.${minor}.0` : `>=${from}`;
    const upper = isX(toMajor) ? "" : isX(toMinor) ? `<${+toMajor + 1}.0.0-0`
      : isX(toPatch) ? `<${toMajor}.${+toMinor + 1}.0-0`
        : toPre ? `<=${toMajor}.${toMinor}.${toPatch}-${toPre}` : `<=${to}`;
    return `${lower} ${upper}`.trim();
  });
}

const isNull = (comp: Comparator): boolean => comp.op === "<" && !!comp.version &&
  comp.version.release.every((part) => part === 0) && comp.version.pre.length === 1 && comp.version.pre[0] === 0;

function parseSet(range: string): Comparator[] {
  range = expandHyphen(range.replace(buildStrip, ""))
    .replace(comparatorTrim, "$1$2$3")
    .replace(/(\s?)~>?\s/g, "$1~")
    .replace(/(\s?)\^\s/g, "$1^");
  const expanded = range.split(" ").map((comp) => {
    comp = expandCompatible(comp, true);
    comp = comp.split(/\s+/).map((part) => expandCompatible(part, false)).join(" ");
    comp = comp.split(/\s+/).map(expandX).join(" ");
    return comp.trim().replace(/(<|>)?=?\s?\*/, "");
  }).join(" ").split(/\s+/);
  const parsed: Comparator[] = [];
  for (let comp of expanded) {
    comp = comp.trim().replace(/^>=\s?0\.0\.0$/, "");
    const match = comparatorPattern.exec(comp);
    // Loose ranges discard invalid tokens, but not invalid numeric versions.
    if (!match) continue;
    const op = !match[1] || match[1] === "=" ? "" : match[1];
    const version = match[2] ? parseVersion(match[2]) : undefined;
    if (match[2] && !version) throw new Error("Invalid range version");
    parsed.push({ op, version });
  }
  const comparators = new Map<string, Comparator>();
  for (const comparator of parsed) {
    const { op, version } = comparator;
    if (isNull(comparator)) return [comparator];
    comparators.set(version ? `${op}${version.release.join(".")}-${version.pre.join(".")}` : "", comparator);
  }
  if (comparators.size > 1) comparators.delete("");
  return [...comparators.values()];
}

function satisfiesSet(set: Comparator[], locked: Version): boolean {
  for (const { op, version } of set) {
    if (!version) continue;
    const order = compare(locked, version);
    if (op === ">" ? order <= 0 : op === ">=" ? order < 0 : op === "<" ? order >= 0 : op === "<=" ? order > 0 : order !== 0) return false;
  }
  return !locked.pre.length || set.some(({ version }) => version && version.pre.length &&
    version.release.every((part, i) => part === locked.release[i]));
}

/**
 * Mirror npm 11's @npmcli/arborist/lib/dep-valid.js:67-89 and
 * npm-package-arg/lib/npa.js:461-471, without a semver dependency.
 * https://github.com/npm/node-semver/tree/v7.8.5
 * Range unions normalize like classes/range.js:59-65 BEFORE prerelease
 * admission; identifier order follows internal/identifiers.js:9-19.
 * Aliases call this with their own range (an omitted range means '*').
 * Residual: tags keep any version lock here, preserving provisioning's existing
 * behavior; npm also requires its resolved source to be a registry tarball.
 */
export function npmLockKeeps(spec: string, locked: string): boolean {
  const version = parseVersion(locked);
  if (!version) return false;
  spec = spec.trim();
  if (spec === "*") return true;
  let sets: Comparator[][] = [];
  try {
    sets = spec.replace(/\s+/g, " ").split("||").map((range) => parseSet(range.trim())).filter((set) => set.length);
  } catch { /* A syntactically valid comparator can still exceed version limits. */ }
  if (!sets.length) {
    try { return encodeURIComponent(spec) === spec; }
    catch { return false; }
  }
  if (sets.length > 1) {
    const first = sets[0];
    sets = sets.filter((set) => !isNull(set[0]));
    if (!sets.length) sets = [first];
    const unrestricted = sets.find((set) => set.length === 1 && !set[0].version);
    if (unrestricted) sets = [unrestricted];
  }
  return sets.some((set) => satisfiesSet(set, version));
}
