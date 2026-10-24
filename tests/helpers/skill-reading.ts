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
