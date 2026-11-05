import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type Scope = { parent?: Scope; host?: "herdr" | "orca" | "app" | "plain"; children: Scope[]; line: number; kind: "root" | "heading" | "bullet"; depth: number; content?: number; marker?: string };
// Queue row 340; D-2180: "On the Herdr app" opens the app scope (HC pair, no classic marker); "On a plain host"
// is an explicit scope too, so a plain scope nested under an app scope overrides it instead of inheriting app.
export const hostOf = (text: string): Scope["host"] => {
  const bare = text.replace(/^[*_]+/, "");
  if (/^On the Herdr app\b/.test(bare)) return "app";
  if (/^On a plain host\b/.test(bare)) return "plain";
  return /^On (herdr|Orca)\b/.exec(bare)?.[1]?.toLowerCase() as Scope["host"];
};
export const herdrOnly = /\bherdr\s+(?:agent|pane|notification|tab)\b|\bwatch-(?!artifacts\.sh\b)(?:\*|[\w-]+)\.sh\b|\bTKR_ARMING_SEAT\b|\bTKR_CLOSE_PANES\b|FIVE-TAB CANON|FOUR[ -]watchers/;
/** An hc subcommand (the Herdr app CLI); legal only inside an On the Herdr app scope. The executable may be bare,
 * quoted, backslash-escaped or path-qualified (`"hc"`, `'/usr/local/bin/hc'`, `\hc`), and the subcommand quoted. */
export const hcOnly = /(?<![\w.$-])[\\"']?(?:[\w.~-]*\/)*hc["']?\s+["']?(?:run|ls|get|label|kill|keep|read|send|keys|wait|rm|server)\b/;


type Row = { text: string; line: number; scope: Scope; code: boolean; heading: boolean; flags: string[]; para: boolean; quoted: boolean };
type Command = { text: string; line: number; scope: Scope };
const inherited = (node: Scope | undefined): Scope["host"] => node && (node.host ?? inherited(node.parent));
/** Any container prefix: indentation, list markers and blockquote markers, repeated. */
const container = /^(?:\s*(?:(?:[-+*]|\d+[.)])\s+|>\s?))*\s*/;
const item = /^( *)([-+*]|\d{1,9}[.)])(?:( +)(\S.*)|[ \t]*)$/;
/** Block starts that end a paragraph's containers: ATX heading, fence, blockquote. */
const blockStart = /^(?:#{1,6}(?:[ \t]|$)|`{3,}[^`]*$|~{3,}|>)/;
/** CommonMark raw HTML block starts: kinds 1-6 (may interrupt a paragraph) and kind 7 (a lone complete tag). */
const htmlBlock = /^(?:<(?:script|pre|style|textarea)(?:\s|>|$)|<!--|<\?|<![A-Za-z]|<!\[CDATA\[|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$))/i;
const htmlTag = /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/;
const normal = (marker: string) => marker.replace(/\d+/, "1");
const underline = /^(?:=+|-+)\s*$/;
const expandTabs = (line: string) => [...line].reduce((out, ch) => out + (ch === "\t" ? " ".repeat(4 - (out.length % 4)) : ch), "");
/** A list marker that may open a list beside paragraph text (CommonMark: a bullet, or an ordered 1). */
const interrupts = (marker: string) => /^[-+*]$|^0*1[.)]$/.test(marker);

/**
 * Walk the scope tree once (both guards and skillReading share it): every physical line with its innermost heading or
 * bullet scope; code = a fence line. Queue row 340; D-2180 (park 1697 and the review after it) — a WHITELIST that fails closed:
 * - only a column-0 ATX heading opens a heading scope, running to the next column-0 heading of the same or higher
 *   level; any other heading naming a host (indented, behind a list or blockquote marker, setext) is never a scope and
 *   is flagged, and so is any other heading outside every list item;
 * - a list item at most three columns right of its container opens a bullet scope only in the canonical form (one
 *   marker, one to four spaces, then text naming a host); any other container shape naming a host is flagged;
 * - a bullet runs while lines stand at or right of its content column; a line left of it ends the bullet, the fence it
 *   holds included (an implicit fence end), except paragraph text directly below paragraph text: that lazy
 *   continuation stays in every open container, as CommonMark's reference parsers read it; a raw HTML block (which
 *   swallows the headings after it) is flagged;
 * - a fence opens at most three columns right of its container and closes on a bare marker, never one with an info
 *   string or one indented four columns past its container.
 */
function scopedRows(markdown: string): { root: Scope; rows: Row[] } {
  const root: Scope = { children: [], line: 0, kind: "root", depth: -1 };
  const headings: Scope[] = [root];
  const bullets: Scope[] = [];
  const rows: Row[] = [];
  const lines = markdown.split("\n");
  let fence: { marker: string; content: number } | undefined;
  const frontmatter = lines[0] === "---" ? lines.indexOf("---", 1) : -1; // metadata, never a heading or scope
  const current = () => bullets.at(-1) ?? headings.at(-1)!;
  const add = (parent: Scope, kind: Scope["kind"], depth: number, text: string | undefined, line: number, extra: Partial<Scope> = {}) => {
    const node: Scope = { parent, kind, depth, host: text === undefined ? undefined : hostOf(text), line, children: [], ...extra };
    parent.children.push(node);
    return node;
  };
  for (const [index, text] of lines.entries()) {
    const line = expandTabs(text), trimmed = line.trimStart(), n = line.length - trimmed.length;
    const prev = rows.at(-1);
    const push = (code: boolean, heading: boolean, flags: string[] = [], para = false, quoted = false) => rows.push({ text, line: index + 1, scope: current(), code, heading, flags, para, quoted });
    if (index <= frontmatter) { push(true, false); continue; }
    if (fence && trimmed && n < fence.content) fence = undefined; // left of the fence's container: both end here
    if (fence) {
      const close = /^(`{3,}|~{3,})\s*$/.exec(trimmed)?.[1];
      push(true, false);
      if (close && n - fence.content <= 3 && close[0] === fence.marker[0] && close.length >= fence.marker.length) fence = undefined;
      continue;
    }
    const heading = /^(#{1,6})[ \t]+(.+)$/.exec(text);
    if (heading) {
      bullets.length = 0;
      while (headings.at(-1)!.depth >= heading[1]!.length) headings.pop();
      headings.push(add(headings.at(-1)!, "heading", heading[1]!.length, heading[2]!, index + 1));
      push(false, true);
      continue;
    }
    const flags: string[] = [];
    let listed: RegExpExecArray | null = null, isItem = false, lazy = false, para = false, quoted = false;
    let opener: string | undefined, fenceAt = 0;
    if (trimmed) {
      let keep = bullets.length;
      while (keep && bullets[keep - 1]!.content! > n) keep--;
      const prefix = container.exec(line)![0], bare = line.slice(prefix.length);
      quoted = prefix.includes(">");
      // A container this line leaves (a list item left of its content column, a blockquote without its marker)
      // lifts CommonMark's paragraph-interruption limits, as the reference parsers do.
      const rel = n - (bullets[keep - 1]?.content ?? 0), after = !!prev?.para, unmatched = keep < bullets.length || !!prev?.quoted && !quoted;
      const breaks = rel <= 3 && /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(trimmed);
      const setextLine = after && !unmatched && rel <= 3 && underline.test(trimmed);
      const html = rel <= 3 && (htmlBlock.test(bare) || htmlTag.test(bare) && !(after && !unmatched));
      listed = !breaks && rel <= 3 ? item.exec(line) : null;
      // Lazy continuation: paragraph text directly below paragraph text stays in every open container; any block start
      // (list item, ATX heading, fence, blockquote, thematic break, raw HTML) ends the containers it stands left of.
      if (after && listed) lazy = !unmatched && !(listed[4] !== undefined && interrupts(listed[2]!));
      else if (after) lazy = rel > 3 || !breaks && !html && !blockStart.test(trimmed);
      if (lazy) listed = null;
      else bullets.length = keep;
      if (html) flags.push(`raw HTML block: ${text.trim()}`);
      isItem = !!listed;
      const atx = /^#{1,6}[ \t]+(.+)$/.exec(bare)?.[1];
      const canonical = isItem && listed![4] !== undefined && /^ *(?:[-+*]|\d{1,9}[.)]) {1,4}$/.test(prefix);
      if (isItem) {
        const [, , marker, spaces, rest] = listed!;
        const content = n + marker!.length + (rest === undefined || spaces!.length > 4 ? 1 : spaces!.length);
        bullets.push(add(bullets.at(-1) ?? headings.at(-1)!, "bullet", n, canonical ? rest : undefined, index + 1, { content, marker: normal(marker!) }));
      }
      // A fence may open on a list-item line (inside that item) or at most three columns right of its container.
      const body = isItem ? trimmed.replace(/^(?:(?:[-+*]|\d+[.)])\s+)+/, "") : trimmed;
      opener = lazy ? undefined : /^(`{3,})[^`]*$|^(~{3,})/.exec(body)?.slice(1).find(Boolean);
      fenceAt = isItem ? line.length - body.length : bullets.at(-1)?.content ?? 0;
      if (!isItem && n - fenceAt > 3) opener = undefined;
      // Paragraph text may be continued lazily; indented code, headings, breaks, setext underlines and fences may not.
      para = lazy || !(opener || breaks || setextLine || html || n - fenceAt > 3 && !after || blockStart.test(bare) || !bare.trim());
      const setext = para && underline.test((lines[index + 1] ?? "").replace(/^[\s>]*/, ""));
      if (atx && hostOf(atx) || setext && hostOf(bare)) flags.push(`non-canonical host heading: ${text.trim()}`);
      else if ((atx && n <= 3 || setext) && !bullets.length && !isItem) flags.push(`non-canonical heading: ${text.trim()}`);
      else if (hostOf(bare) && /[-+*>]|\d[.)]/.test(prefix) && !canonical) flags.push(`non-canonical host scope: ${text.trim()}`);
    }
    push(!!opener, false, flags, para, quoted);
    if (opener) fence = { marker: opener, content: fenceAt };
  }
  return { root, rows };
}

/**
 * Queue row 340; D-2180 add.25: the guards match LOGICAL commands, not physical lines — every physical line, plus each
 * run of non-blank lines read as one string (container prefixes — indentation and blockquote markers — and a trailing
 * backslash dropped, line breaks as spaces), so a backslash continuation, an inline span wrapped across lines or a
 * quoted command reads whole whatever container holds it. A match a line break splits keeps the scope and source line
 * where it starts.
 */
function commandsOf(rows: Row[], pattern: RegExp): Command[] {
  const found: Command[] = rows.filter(({ text }) => pattern.test(text)).map(({ text, line, scope }) => ({ text, line, scope }));
  const global = new RegExp(pattern.source, "g");
  for (let start = 0, end = 0; start < rows.length; start = end + 1) {
    for (end = start; end < rows.length && rows[end]!.text.trim();) end++;
    const run = rows.slice(start, end), bodies = run.map(({ text }) => text.replace(/^[\s>]*/, "").replace(/\\\s*$/, ""));
    const starts = bodies.map((_, i) => bodies.slice(0, i).reduce((sum, body) => sum + body.length + 1, 0));
    const rowAt = (offset: number) => starts.findLastIndex((at) => at <= offset);
    for (const match of bodies.join(" ").matchAll(global)) {
      const first = rowAt(match.index), last = rowAt(match.index + match[0].length - 1);
      if (first !== last) found.push({ line: run[first]!.line, scope: run[first]!.scope, text: bodies.slice(first, last + 1).join(" ") });
    }
  }
  return found;
}

export function hostViolations(markdown: string): string[] {
  const { root, rows } = scopedRows(markdown);
  const violations: string[] = rows.flatMap(({ flags, line }) => flags.map((flag) => `line ${line}: ${flag}`));
  for (const { text, line, scope } of commandsOf(rows, herdrOnly)) if (inherited(scope) !== "herdr") violations.push(`line ${line}: ${text.trimStart()}`);
  for (const { text, line, scope } of commandsOf(rows, hcOnly)) if (inherited(scope) !== "app") violations.push(`line ${line}: hc outside the app scope: ${text.trimStart()}`);
  const siblings = (node: Scope) => {
    for (const [i, child] of node.children.entries()) {
      if (child.host === "herdr" && inherited(node) !== "herdr") {
        const adjacent = [node.children[i - 1], node.children[i + 1]];
        if (!adjacent.some((other) => other?.kind === child.kind && other.host === "orca")) {
          violations.push(`line ${child.line}: On herdr scope has no adjacent On Orca sibling`);
        }
      }
      siblings(child);
    }
  };
  siblings(root);
  return violations;
}

/** Read universal scopes and this host's scopes, including headings, nested bullets and fences (the guards' walk). */
export function skillReading(markdown: string, host: "herdr" | "orca" | "app" | "plain"): string {
  return scopedRows(markdown).rows.filter(({ scope }) => [undefined, host].includes(inherited(scope))).map(({ text }) => text).join("\n");
}

/** Only direct markdown references belong to a skill; each file starts a fresh scope tree. */
function skillFiles(dir: string): string[] {
  const references = join(dir, "references");
  return ["SKILL.md", ...(existsSync(references) ? readdirSync(references).filter(name => name.endsWith(".md") && statSync(join(references, name)).isFile())
    .sort().map(name => join("references", name)) : [])];
}

export function skillCorpus(dir: string): string {
  return skillFiles(dir).map(file => readFileSync(join(dir, file), "utf8")).join("\n");
}

export function skillDirViolations(dir: string): string[] {
  return skillFiles(dir).flatMap(file => hostViolations(readFileSync(join(dir, file), "utf8"))
    .map(finding => `${file}: ${finding}`));
}

export function skillDirReading(dir: string, host: "herdr" | "orca" | "app" | "plain"): string {
  return skillFiles(dir).map(file => skillReading(readFileSync(join(dir, file), "utf8"), host)).join("\n");
}

const orcaCommand = /(?<![\w-])orca\s+(?:terminal|worktree)\s+[a-z]/;
const closedList = [
  /the daemon-placed board is the live surface/,
  /treat that as a daemon\/run liveness fault/,
  /interactive TUI[^.]*never headless/i,
  /say so and stop/,
  /foreground\s+`?until\s+grep/i,
  /at most every twenty minutes/i,
];

/** Sweep one file's plain-host reading; routing and required plain scope live in SKILL.md. */
export function plainLineFindings(markdown: string): string[] {
  const lines = skillReading(markdown, "plain").split("\n");
  const { rows } = scopedRows(markdown);
  // A non-canonical scope or heading and a raw HTML block are reported wherever they stand.
  const findings: string[] = rows.flatMap(({ flags }) => flags);
  // The same logical commands as hostViolations, kept when they start in a universal or plain scope.
  for (const [label, pattern] of [["herdr-only token", herdrOnly], ["Orca command", orcaCommand], ["hc command", hcOnly]] as const) {
    for (const { text, scope } of commandsOf(rows, pattern)) if ([undefined, "plain"].includes(inherited(scope))) findings.push(`${label}: ${text.trim()}`);
  }
  // Mandates can wrap within a file, but never across files.
  const reading = lines.join("\n").replace(/\s+/g, " ");
  for (const mandate of closedList) {
    const hit = mandate.exec(reading);
    if (hit) findings.push(`plain-host-impossible mandate: ${hit[0]}`);
  }
  return findings;
}
