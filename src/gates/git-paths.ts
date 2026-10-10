/**
 * Queue row 71b: git's path quoting, decoded once for every patch-text parser (acceptance's citable changed lines,
 * the artifact manifest's section paths). git C-quotes a path holding a byte >= 0x80 (unless core.quotePath=false),
 * a control character, a double quote or a backslash — `"docs/caf\303\251.md"` — with the escapes \a \b \t \n \v \f
 * \r \" \\ and \ooo octal BYTES, so a non-ASCII name arrives as its UTF-8 bytes. JSON.parse is not this grammar: it
 * has no octal escapes and returned `caf\303\251` with literal backslashes.
 */
const ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** A path exactly as git printed it, quoted or not, decoded to the name on disk. Unquoted input is returned as is. */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const chars = Array.from(raw.slice(1, -1)); // code points, so a non-ASCII character is pushed whole
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch !== "\\") { bytes.push(...Buffer.from(ch, "utf8")); continue; }
    const octal = /^[0-7]{1,3}/.exec(chars.slice(i + 1, i + 4).join(""))?.[0];
    if (octal) { bytes.push(parseInt(octal, 8) & 0xff); i += octal.length; continue; }
    const escape = chars[i + 1];
    if (escape !== undefined && escape in ESCAPES) { bytes.push(ESCAPES[escape]!); i++; continue; }
    bytes.push(92); // a backslash git never writes alone: kept literally
  }
  return Buffer.from(bytes).toString("utf8");
}

const NAMED: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(ESCAPES).map(([name, code]) => [code, name]));

/**
 * Queue rows 128/129: the inverse of unquoteGitPath, for a name tickmarkr writes back into patch text it parses again.
 * A name holding a control character, U+2028/U+2029, a double quote or a backslash is C-quoted (those characters
 * escaped, every other character kept), so no name can end a line; any other name is returned as is.
 */
export function quoteGitPath(path: string): string {
  if (!/[\x00-\x1f\x7f"\\\u2028\u2029]/.test(path)) return path;
  let quoted = "";
  for (const ch of path) {
    const code = ch.codePointAt(0)!;
    if (NAMED[code] !== undefined) quoted += `\\${NAMED[code]}`;
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
      quoted += [...Buffer.from(ch, "utf8")].map((byte) => `\\${byte.toString(8).padStart(3, "0")}`).join("");
    } else quoted += ch;
  }
  return `"${quoted}"`;
}

/**
 * One side of a `--- ` / `+++ ` line, after its four-character marker: null for /dev/null, else the path without its
 * a/ or b/ prefix. git ends a side holding a space with ONE tab (quoted or not, measured on git 2.54) — exactly that tab
 * is dropped, never trimmed, so a name that begins or ends with a space survives.
 */
export function diffSidePath(raw: string): string | null {
  const value = unquoteGitPath(raw.endsWith("\t") ? raw.slice(0, -1) : raw);
  if (value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
}

/** The one path a header side pair names — `a/<X>` and `b/<X>`, the same non-empty X — or none (D-1608: one rule). */
function samePath(left: string, right: string): string[] {
  return left.startsWith("a/") && right.startsWith("b/") && left.length > 2 && left.slice(2) === right.slice(2) ? [left.slice(2)] : [];
}

/**
 * The paths a `diff --git <a> <b>` header names, for a section with no ---/+++ or rename lines (a mode-only change, a
 * binary or an empty file). git writes such a header for ONE path, twice: `a/<X> b/<X>`. Each grammar only splits the
 * header into its two sides, and both answer through the same samePath rule (D-1608), so they cannot disagree: an
 * unquoted header splits where git apply's git_header_name does — the ` ` before `b/` at the midpoint, whitespace kept, so
 * a name that ends in (or is) a space survives (D-1604); a quoted one must be two complete quoted strings joined by
 * exactly one space, matched end to end, each unquoted with its prefix kept (D-1607). Anything else is unresolvable: []
 * (the artifact manifest then keeps the section as logic, rendered and charged — over-charged, never hidden).
 */
export function gitHeaderPaths(header: string): string[] {
  if (!header.includes('"')) {
    const half = (header.length - 5) / 2;
    return Number.isInteger(half) && half > 0 && header[2 + half] === " "
      ? samePath(header.slice(0, 2 + half), header.slice(3 + half)) : [];
  }
  const quoted = /^("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*")$/.exec(header);
  return quoted ? samePath(unquoteGitPath(quoted[1]!), unquoteGitPath(quoted[2]!)) : [];
}
