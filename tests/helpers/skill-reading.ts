import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type Scope = { parent?: Scope; host?: "herdr" | "orca"; children: Scope[]; line: number; kind: "root" | "heading" | "bullet"; depth: number };
export const hostOf = (text: string): Scope["host"] => /^On (herdr|Orca)\b/.exec(text.replace(/^[*_]+/, ""))?.[1]?.toLowerCase() as Scope["host"];
export const herdrOnly = /\bherdr\s+(?:agent|pane|notification|tab)\b|\bwatch-(?!artifacts\.sh\b)(?:\*|[\w-]+)\.sh\b|\bTKR_ARMING_SEAT\b|\bTKR_CLOSE_PANES\b|FIVE-TAB CANON|FOUR[ -]watchers/;


export function hostViolations(markdown: string): string[] {
  const root: Scope = { children: [], line: 0, kind: "root", depth: -1 };
  const headings: Scope[] = [root];
  const bullets: Scope[] = [];
  const violations: string[] = [];
  let fence: string | undefined;
  const inherited = (node: Scope | undefined): Scope["host"] => node && (node.host ?? inherited(node.parent));
  const add = (parent: Scope, kind: Scope["kind"], depth: number, text: string, line: number) => {
    const node: Scope = { parent, kind, depth, host: hostOf(text), line, children: [] };
    parent.children.push(node);
    return node;
  };
  for (const [index, line] of markdown.split("\n").entries()) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    if (!fence) {
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      const bullet = /^(\s*)(?:[-+*]|\d+[.)])\s+(.+)$/.exec(line);
      if (heading) {
        bullets.length = 0;
        while (headings.at(-1)!.depth >= heading[1].length) headings.pop();
        headings.push(add(headings.at(-1)!, "heading", heading[1].length, heading[2], index + 1));
      } else if (bullet) {
        while (bullets.length && bullets.at(-1)!.depth >= indent) bullets.pop();
        bullets.push(add(bullets.at(-1) ?? headings.at(-1)!, "bullet", indent, bullet[2], index + 1));
      } else if (trimmed) {
        while (bullets.length && indent <= bullets.at(-1)!.depth) bullets.pop();
      }
    }
    const scope = bullets.at(-1) ?? headings.at(-1)!;
    if (herdrOnly.test(line) && inherited(scope) !== "herdr") violations.push(`line ${index + 1}: ${trimmed}`);
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (marker && (!fence || marker[0] === fence[0] && marker.length >= fence.length)) fence = fence ? undefined : marker;
  }
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

/** Read universal scopes and this host's scopes, including headings, nested bullets and fences. */
export function skillReading(markdown: string, host: "herdr" | "orca" | "plain"): string {
  type Node = { parent?: Node; host?: string; depth: number };
  const headings: Node[] = [{ depth: -1 }], bullets: Node[] = [];
  const inherited = (n: Node | undefined): string | undefined => n && (n.host ?? inherited(n.parent));
  const result: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const trimmed = line.trimStart(), indent = line.length - trimmed.length;
    const hostOfLine = (text: string) => /^On a plain host\b/.test(text.replace(/^[*_]+/, "")) ? "plain" : hostOf(text);
    if (!fence) {
      const heading = /^(#{1,6})\s+(.+)$/.exec(line), bullet = /^(\s*)(?:[-+*]|\d+[.)])\s+(.+)$/.exec(line);
      if (heading) {
        bullets.length = 0;
        while (headings.at(-1)!.depth >= heading[1].length) headings.pop();
        headings.push({ parent: headings.at(-1), depth: heading[1].length, host: hostOfLine(heading[2]) });
      } else if (bullet) {
        while (bullets.length && bullets.at(-1)!.depth >= indent) bullets.pop();
        bullets.push({ parent: bullets.at(-1) ?? headings.at(-1), depth: indent, host: hostOfLine(bullet[2]) });
      } else if (trimmed) {
        while (bullets.length && indent <= bullets.at(-1)!.depth) bullets.pop();
      }
    }
    const current = inherited(bullets.at(-1) ?? headings.at(-1));
    if (current === undefined || current === host) result.push(line);
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (marker && (!fence || marker[0] === fence[0] && marker.length >= fence.length)) fence = fence ? undefined : marker;
  }
  return result.join("\n");
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

export function skillDirReading(dir: string, host: "herdr" | "orca" | "plain"): string {
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
  const findings: string[] = [];
  for (const line of lines) {
    if (herdrOnly.test(line)) findings.push(`herdr-only token: ${line.trim()}`);
    if (orcaCommand.test(line)) findings.push(`Orca command: ${line.trim()}`);
  }
  // Mandates can wrap within a file, but never across files.
  const reading = lines.join("\n").replace(/\s+/g, " ");
  for (const mandate of closedList) {
    const hit = mandate.exec(reading);
    if (hit) findings.push(`plain-host-impossible mandate: ${hit[0]}`);
  }
  return findings;
}
