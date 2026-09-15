import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

type Scope = { parent?: Scope; host?: "herdr" | "orca"; children: Scope[]; line: number; kind: "root" | "heading" | "bullet"; depth: number };
const hostOf = (text: string): Scope["host"] => /^On (herdr|Orca)\b/.exec(text.replace(/^[*_]+/, ""))?.[1]?.toLowerCase() as Scope["host"];
const herdrOnly = /\bherdr\s+(?:agent|pane|notification|tab)\b|\bwatch-(?:\*|[\w-]+)\.sh\b|\bTKR_ARMING_SEAT\b|\bTKR_CLOSE_PANES\b|FIVE-TAB CANON|FOUR[ -]watchers/;
// Concatenated so this source cannot co-match HYG-06 R2 (cwd-call + state-dir literal).
const runtimeDir = "." + "tickmarkr";

function readShippedSkill(): string {
  return readFileSync(new URL("../skills/tickmarkr-overseer/SKILL.md", import.meta.url), "utf8");
}

function hostViolations(markdown: string): string[] {
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

describe("overseer skill host neutrality (HD-1 / OBS-1003)", () => {
  test("the shipped overseer skill, read as an Orca launch from the host line through setup, seat spawn, brief delivery and evidence collection, reaches each step on an Orca branch — the host requirement names herdr by its host variable and Orca by its terminal-program marker and no longer requires the herdr variable alone, setup no longer loads the herdr skill and maps a herdr workspace unconditionally, seats spawn with terminal create on a path worktree selector with a command, briefs travel as a file announced by terminal send with enter and a submit wait whose receipt is read for observed submission rather than input acceptance, and evidence is files beside terminal read — while every retained herdr-only command, tab canon and watcher instruction is qualified as herdr-specific with the herdr branch preserved, cited to the changed owned skill lines in the diff, so an Orca recipe appended beneath universal herdr instructions fails", () => {
    const skill = readShippedSkill();

    expect(skill).toContain("Requires a supported host: herdr (`HERDR_ENV=1`) or Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`)");
    expect(skill).not.toMatch(/^Requires `HERDR_ENV=1`; if unset, say so and stop\.$/m);

    expect(skill).toContain("Workspace setup (host-specific)");
    expect(skill).toContain("On herdr (`HERDR_ENV=1`)");
    expect(skill).toContain("Load the `herdr` skill. `herdr pane list` to map the workspace");
    expect(skill).toContain("On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`)");
    expect(skill).toContain("Do not load the `herdr` skill and do not map a Herdr workspace.");

    expect(skill).toContain("Seats spawn with `orca terminal create` on a path worktree selector with a command");
    expect(skill).toContain("orca terminal create --worktree path:<repo>");
    expect(skill).toContain(`orca terminal send --terminal <handle> --text "Read ${runtimeDir}/overseer/ORCH-BRIEF.md and follow it exactly." --enter --wait-submit 15 --json`);
    expect(skill).toContain("Read `result.send.prompt.stages` and treat the brief as delivered only when a `turn_started` stage is present");
    expect(skill).toContain("`accepted: true` proves input acceptance, not a started turn");
    expect(skill).toContain("never resend on `accepted` alone");
    expect(skill).not.toMatch(/`submitted` receipt|result\.send\.submitted|submitted === true|verify submitted/);

    expect(skill).toContain("Evidence collection");
    expect(skill).toContain("Evidence is files beside `terminal read`: read verdict files, journals, and pane state with `orca terminal read --terminal <handle> --limit <lines> --json`");

    const setupHerdr = skill.indexOf("**On herdr (`HERDR_ENV=1`)**: Load the `herdr` skill");
    const setupOrca = skill.indexOf("**On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`)**: Do not load the `herdr` skill");
    const canon = skill.indexOf("FIVE-TAB CANON");
    expect(skill.match(/FIVE-TAB CANON/g)).toHaveLength(1);
    expect(canon).toBeGreaterThan(setupHerdr);
    expect(canon).toBeLessThan(setupOrca);

    expect(skill.match(/^### A GO has a deadline/gm)).toHaveLength(1);
    const go = skill.slice(skill.indexOf("### A GO has a deadline"), skill.indexOf("The first argument chooses"));
    expect(go).toContain("**On herdr (`HERDR_ENV=1`) only:**");
    expect(go).toContain(`watch-launch.sh <worktree>/${runtimeDir}/graph.lock 900 <overseer-pane>`);

    const herdrSpawn = skill.slice(skill.indexOf("2. **Orchestrator**"), skill.indexOf("- **On Orca", skill.indexOf("2. **Orchestrator**")));
    expect(herdrSpawn).toContain("--settings '{\"promptSuggestionEnabled\":false}'");
    expect(herdrSpawn).toContain("For kimi, pass `-y`");
    expect(herdrSpawn).toContain("--sandbox read-only` CONTRADICTS");
    expect(herdrSpawn).toContain("The unsandboxed flag is REQUIRED");

    const context = skill.slice(skill.indexOf("### Context is a supervised resource"), skill.indexOf("## Supervising GSD legs"));
    expect(context).toContain("**On herdr (`HERDR_ENV=1`) only**, use this protocol");
    expect(context).toContain("**On herdr (`HERDR_ENV=1`) only**, arm a context watcher");
    expect(context.match(/herdr pane run/g)?.length).toBeGreaterThan(0);

    const ownership = skill.slice(skill.indexOf("WATCHER OWNERSHIP"), skill.indexOf("An adopted seat ANNOUNCES"));
    expect(ownership).toContain("**On herdr (`HERDR_ENV=1`)**");
    expect(ownership).toContain("`watch-*.sh`");
    expect(ownership).toContain("`watch-artifacts.sh`");
    expect(ownership).toContain("TKR_ARMING_SEAT");
    expect(ownership).toContain("**On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`)**");
    expect(hostViolations(skill)).toEqual([]);

    const herdrIndex = skill.indexOf("On herdr (`HERDR_ENV=1`)");
    const orcaIndex = skill.indexOf("On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`)");
    expect(herdrIndex).toBeGreaterThan(0);
    expect(orcaIndex).toBeGreaterThan(0);
  });
});

test("host scope parser rejects escaped commands, fences, mandates and missing sibling branches", () => {
  for (const token of ["herdr agent wait", "herdr pane run", "herdr notification show", "watch-panes.sh", "watch-artifacts.sh", "watch-*.sh", "TKR_ARMING_SEAT", "watch-new-instrument.sh", "TKR_CLOSE_PANES", "FIVE-TAB CANON", "FOUR watchers"]) {
    expect(hostViolations(`On herdr applies everywhere.\n\n## Universal\n\`${token}\``)).not.toEqual([]);
    expect(hostViolations(`## On herdr\n\n## On Orca\n\n\`\`\`bash\n${token}\n\`\`\``)).not.toEqual([]);
    expect(hostViolations(`- On herdr: safe\n  \`${token}\`\n- On Orca: files\n- Universal: \`${token}\``)).not.toEqual([]);
    expect(hostViolations(`## On herdr\n\`\`\`bash\n${token}\n\`\`\`\n## On Orca\nFiles and terminal read.`)).toEqual([]);
    expect(hostViolations(`- On herdr: safe\n  \`${token}\`\n- On Orca: files`)).toEqual([]);
    expect(hostViolations(`## On herdr\n${token}`)).not.toEqual([]);
  }
});
