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

test("replaying the recorded Orca screen read receipts exited beside ok true versus running against the changed seat liveness procedure declares the first dead plus the second live from result.terminal.status rather than the envelope ok, citing the changed skill lines", () => {
  const skill = readShippedSkill();
  expect(skill).toMatch(/key liveness on `result\.terminal\.status === "running"` — never on the envelope's own `ok`/);
  expect(skill).toMatch(/a closed seat's read still returns that same `ok: true` with `result\.terminal\.status: "exited"`/);
  expect(skill).toContain("a matcher keyed on `ok` reads that exited seat as alive and never fires (OBS-1087)");
  expect(skill).toMatch(/Treat `result\.terminal\.status !== "running"`, `terminal_handle_stale`, or a missing terminal as seat death/);
});

test("the read-first procedure on both hosts appends one opened line per cited file to an append-only log under .tickmarkr/overseer and names that log as the record a later handoff is measured against, citing the changed lines", () => {
  const skill = readShippedSkill();
  // Universal law (CITE-IS-NOT-READ), the herdr handoff protocol, and the Orca instruments each cite the log.
  expect(skill.match(/\.tickmarkr\/overseer\/opened-files\.log/g)?.length).toBeGreaterThanOrEqual(3);
  expect(skill).toMatch(/On BOTH hosts, log the open:\*\*\s*\n\s*append one line, `opened <path>`, to the append-only log `\.tickmarkr\/overseer\/opened-files\.log`/);
  expect(skill).toMatch(/is the record a later handoff is measured against: a claimed read with no matching line here did not\s*\n\s*happen\./);
  expect(skill).toContain("Nothing else records which cited files a successor actually opened after a clear (OBS-1102)");
  expect(skill).toMatch(/Log every open per CITE-IS-NOT-READ:\*\* the moment the returning seat opens `<handoff>` or\s*\n\s*`<brief>`/);
  expect(skill).toMatch(/On both hosts this log — not the\s*\n\s*transcript — is the record a later handoff is measured against \(OBS-1102\)/);
  expect(skill).toContain("log the open per CITE-IS-NOT-READ (`opened <path>` appended to `.tickmarkr/overseer/opened-files.log`)");
});

test("the beat recipe arms through the explicit new-arm and loop verbs and names the legacy wrapper loop as the unsafe form that re-armed after a stand-down, citing the changed lines", () => {
  const skill = readShippedSkill();
  expect(skill).toContain("it arms through two explicit verbs, `--new-arm` and `--loop` —\nnever a bare invocation");
  expect(skill).toContain("cd <repo> && tickmarkr beat overseer --seat <overseer-agent-or-pane> --loop");
  expect(skill).not.toMatch(/while :; do tickmarkr beat overseer --seat <overseer-agent-or-pane>; sleep 10; done/);
  expect(skill).toMatch(/The legacy wrapper loop, `while :; do tickmarkr beat overseer --seat <pane>; sleep 10; done`, is the\s*\nUNSAFE form and must not be used\./);
  expect(skill).toMatch(/it is the shape that re-armed a recorded stand-down \(OBS-583, OBS-1088\)/);
  expect(skill).toContain("`--new-arm` and `--loop` are the only verbs that acknowledge a stand-down; a bare beat, wrapped in");
  expect(skill).toContain("**STAND DOWN THE BEAT THROUGH `--stand-down`, THEN VERIFY THE `--loop` EXITS.** The shipped loop");
  expect(skill).toContain("observes the recorded marker and exits within one interval; it does not re-arm after the stand-down.");

  const watchContext = readFileSync(new URL("../skills/tickmarkr-overseer/scripts/watch-context.sh", import.meta.url), "utf8");
  expect(watchContext).toContain('[ "$armed" -eq 0 ] && new_arm="--new-arm"');
  expect(watchContext).toContain('tickmarkr beat "$TIER" --seat "$SEAT" $new_arm');
  expect(watchContext).toMatch(/The skill's beat recipe\s*\n# names that bare-call shape the unsafe legacy form/);
});

test("D-265: the pre-arm beat sweep matches the legacy wrapper — the pgrep pattern never regains a --loop qualifier, because a --loop self-retires on a new arm and the wrapper is the writer that survives it", () => {
  const skill = readShippedSkill();
  expect(skill).toContain('(`pgrep -f "tickmarkr beat <tier>"`, **read twice and intersected**');
  expect(skill).toContain("**The PRIMARY target is the legacy\n  `while … tickmarkr beat <tier>` wrapper**");
  expect(skill).not.toMatch(/pgrep -f "tickmarkr beat <tier>[^"]*--loop/);
});

test("the overseer skill's briefing recipe states the staged-text-and-no-prompt guard, resolve-first path, and post-Enter read-back, citing the changed skill lines", () => {
  const skill = readShippedSkill();

  // skills/tickmarkr-overseer/SKILL.md:826-833 (OBS-1119): the herdr "Verified send protocol" no
  // longer fires `send-keys Enter` blind after the sleep — it reads back first and only retries the
  // Enter when that read-back shows the staged text with no prompt/choice holding focus.
  const protocolStart = skill.indexOf("- **Verified send protocol**:");
  const protocol = skill.slice(
    protocolStart,
    skill.indexOf("- **On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`)**: Briefs travel as a file", protocolStart),
  );
  expect(protocol).toContain(
    "Send `send-keys Enter` only when that read-back shows the staged text on the\n    composer and no permission prompt or numbered choice holds focus",
  );
  expect(protocol).toContain(
    "an Enter sent onto an active prompt\n    approves it or picks a choice instead of submitting the brief (OBS-1119)",
  );
  expect(protocol).toContain("When a prompt or choice holds\n    focus instead, resolve it first, then re-read before retrying");
  expect(protocol).not.toMatch(/sleep 2–3s → send-keys Enter → read back/);

  // The pre-Enter read only proves Enter was safe to send; restore a SEPARATE post-Enter read that
  // confirms the brief actually went through before reporting "briefed" (material review finding).
  expect(protocol).toContain(
    "After a submitted Enter, read back once\n    more and confirm the composer is empty or the agent shows `working`",
  );
  expect(protocol).toContain(
    "the pre-Enter read only proved\n    Enter was safe to send, not that the brief was submitted",
  );
  expect(protocol).toContain('Never report "briefed" without\n    both read-backs.');
});

test("replaying D-307-pre, a codex exec from an agent shell blocked on reading additional input from stdin, against the changed skill rule closes stdin, citing the changed lines", () => {
  const skill = readShippedSkill();
  const rule = skill.slice(
    skill.indexOf("**Every one-shot `codex exec` from an agent shell closes stdin (D-307-pre).**"),
    skill.indexOf("4. **Gate every exec lane"),
  );
  // skills/tickmarkr-overseer/SKILL.md — the one-shot codex exec rule (D-307-pre / OBS-1134).
  expect(rule.length).toBeGreaterThan(0);
  expect(rule).toContain("closes stdin");
  // The incident is historical. Present-tense "never closes stdin" contradicts the mandatory close.
  expect(rule).toContain("the seat's ad-hoc one-shot\n   did not close stdin");
  expect(rule).not.toMatch(/never closes stdin/);
  expect(rule).not.toMatch(/still closes stdin/);
  expect(rule).toMatch(/blocks on reading\s+additional input from stdin/);
  expect(rule).toContain("Reading additional input from stdin…");
  expect(rule).toContain("`codex exec … < /dev/null`");
});

test("replaying D-302 add.3's orphaned home-wide recursive glob against the changed skill rule forbids the glob by name and binds the seat's background tasks to its life, citing the changed lines", () => {
  const skill = readShippedSkill();
  const rule = skill.slice(
    skill.indexOf("**A seat's background tasks are bound to the seat's life (D-302 add.3).**"),
    skill.indexOf("**And EVERY process-table probe"),
  );
  // skills/tickmarkr-overseer/SKILL.md — rule 11 lifetime (D-302 add.3 / OBS-1135).
  expect(rule.length).toBeGreaterThan(0);
  expect(rule).toContain("bound to the seat's life");
  expect(rule).toContain("dies with the seat");
  expect(rule).toContain("reparented to pid 1");
  expect(rule).toContain("Forbid the home-wide recursive glob by name");
  expect(rule).toContain("glob.glob('~/**/.tickmarkr/runs/*/journal.jsonl', recursive=True)");
});

test("the liveness-reads bullet covers both the loop arm and the legacy wrapper forms, citing the changed lines", () => {
  const skill = readShippedSkill();
  const bulletStart = skill.indexOf("- **Split the liveness reads.**");
  const bullet = skill.slice(bulletStart, skill.indexOf("- **At every adopt", bulletStart));
  // skills/tickmarkr-overseer/SKILL.md — the liveness-reads bullet (OBS-1136).
  expect(bullet).toMatch(/tier's liveness is read from beat freshness/);
  expect(bullet).toMatch(/loop's liveness is read from the live process payload/);
  expect(bullet).toContain("the loop arm");
  expect(bullet).toContain("`tickmarkr beat <tier> --seat <seat> --loop`");
  expect(bullet).toContain("the legacy wrapper");
  expect(bullet).toContain("`while :; do tickmarkr beat <tier> --seat <seat>; sleep 10; done`");
  expect(bullet).toMatch(/Neither liveness claim is read from a recorded pid/);
});

test("replaying D-265 (4) against the changed beat section finds the stand-down command entering the repository root and the pre-arm pgrep probe reconciled with the recorded-pid ownership rule, citing the changed lines", () => {
  const skill = readShippedSkill();
  const beat = skill.slice(
    skill.indexOf("**Arm your OWN tier first"),
    skill.indexOf("Arm the bundled watcher as its OWN Bash call"),
  );
  // skills/tickmarkr-overseer/SKILL.md — beat arm, stand-down, and the pre-arm probe (D-265 (4)).
  expect(beat).toContain("cd <repo> && tickmarkr beat overseer --seat <overseer-agent-or-pane> --loop");
  expect(beat).toContain("cd <repo> && tickmarkr beat overseer --seat <overseer-agent-or-pane> --stand-down");
  expect(beat).toContain('(`pgrep -f "tickmarkr beat <tier>"`, **read twice and intersected**');
  expect(beat).toContain("**Reconcile this probe with the recorded-pid ownership rule.**");
  expect(beat).toMatch(/retires watchers this seat\s+armed by the exact recorded pid/);
  expect(beat).toMatch(/never uses `pkill -f`, `pgrep -f`, or an argv pattern/);
  expect(beat).toMatch(/A stop is kill-by-pid of an unowned\s+survivor after the two reads\./);
  expect(beat).not.toMatch(/pgrep -f "tickmarkr beat <tier>[^"]*--loop/);
});
