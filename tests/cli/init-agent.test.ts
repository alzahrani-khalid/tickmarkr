import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as registry from "../../src/adapters/registry.js";
import { init } from "../../src/cli/commands/init.js";
import { makeRepo } from "../helpers/tmprepo.js";
import { skillCorpus, skillReading } from "../helpers/skill-reading.js";

const ROOT = join(import.meta.dirname, "../..");
const skill = (name: string) => readFileSync(join(ROOT, "skills", name, "SKILL.md"));
const runInit = (repo: string, ...args: string[]) =>
  init(["--global-dir", mkdtempSync(join(tmpdir(), "tickmarkr-init-global-")), ...args], repo);

const agentDocsSection = (repo: string, doc = "AGENTS.md") => {
  const text = readFileSync(join(repo, doc), "utf8");
  const begin = text.indexOf("<!-- tickmarkr:agent-docs begin -->");
  const end = text.indexOf("<!-- tickmarkr:agent-docs end -->");
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return text.slice(begin, end + "<!-- tickmarkr:agent-docs end -->".length);
};

// Queue row 241 (D-2141; D-2152): pin the retired block's bytes at their new owners.
const SEAT = "In a multi-tier session, the tiers clear each other at 50% context or more, after writing a handoff. A new spec or run is a mission boundary: write the handoff and clear before taking the next mission. Copy this duty into every brief and handoff. On a single-tier plain host, write your handoff and ask the operator to clear the session.";
const GREEN = "A run is green only when ALL of these hold: the run-end event exists in the journal and is not fatal, tip verify is not \"failed\", the run-end summary's `failed`, `human`, `blocked` and `pending` buckets are every one of them empty, AND the owed checks in CURRENT `tickmarkr status <runId>` are outstanding empty AND known (`outstanding 0`; `outstanding unknown` is never empty). The shorter \"run-end plus tip verify\" form is NOT sufficient: a run ending `done=[T1,T3,T4] human=[T2] tipVerify=passed` is a closed PARTIAL run — three of four delivered, one parked — and calling it green is how a park becomes invisible. Empty execution buckets are not sufficient either (D-660): a run ending with every execution bucket empty and `tipVerify=passed` after an operator waived one review still owes that accepted-risk review check — status reads `outstanding 1 (T7 review)`, and `tickmarkr run` and `resume` exit 0 on execution alone — so it is execution complete, not green. Read the debt from CURRENT status, never from the run-end record: a `tickmarkr verify --record <runId>` discharge that lands after run-end moves current status to `outstanding 0` while the historical run-end row still carries 1, and only then is that run green; a legacy waiver without a recorded obligation reads `outstanding unknown` and is never green. A fatal run-end is never green either: the crash record (`fatal: true`) names its phase and error, every task it left running or gated sits in `pending` or `blocked`, and even with every bucket empty status and report lead with the crash and read `outstanding unknown` until the run is resumed; from then on the resumed engagement owns the debt. Never report green to the operator, tab titles, or records until every clause holds; when one does not, name the bucket that is not empty, the outstanding checks, or the unknown debt.";
const READBACK = "Confirm delivery by reading the TARGET composer afterward; if the sent text still sits unsubmitted after ~15 s, retry the Enter only when that composer read shows the staged text and no permission prompt or numbered choice holds focus — an Enter sent onto an active prompt approves it or picks a choice instead of submitting the message (OBS-1119). Under that guard, send-keys enter to that pane once and read again (OBS-975); when a prompt or choice holds focus instead, resolve it first and re-read before retrying. Never report \"relayed\" without read-back.";
const SPEC = "**Spec-authoring law ships in the spec template** that `tickmarkr init` writes: the hard bounds and which\n  direction each moves, what makes a criterion real, and why an absence or a source-text grep is never a\n  criterion. Read it before authoring or repairing acceptance items.";
const VERIFY = "- `tickmarkr verify --base <ref>` — run the gate battery standalone against merge-base(base, HEAD)..HEAD: no daemon, no retries, one fail-closed verdict (`--criteria <file>` or `--task <id>` adds the semantic gates; `--no-review` for deterministic-only)";
const PREFLIGHT = "Before `tickmarkr compile` or `tickmarkr run`, run `tickmarkr version --check` and stop on a non-zero exit.";
const SHORT_GREEN = "A run is green only when run-end is not fatal, every bucket but done is empty, tip verify did not fail and current `tickmarkr status` reads outstanding 0; the loop skill holds the full rule.";
const ROUTING = "Drive runs through the `tickmarkr-loop` skill (one spec) or the `tickmarkr-auto` skill (several specs); they carry the role check, the live-run check, verified handoffs and the green rule. Supervise a run with the `tickmarkr-overseer` skill.";
const MEMORY = "Before starting, on every host including a plain one (herdr, Orca or neither), read and follow the PROJECT MEMORY duty under [the `tickmarkr-overseer` skill's Setup](../tickmarkr-overseer/SKILL.md#setup).";
const GATES = "- **The gates are the product.** Seven, defined in `src/graph/schema.ts`:\n  `build test lint evidence scope acceptance review`. **That is DECLARATION order, not execution order.**\n  The cheap checks run first and stop at their first red: `build`, `lint`, then `evidence` and `scope`.\n  A fresh or semantic-repair candidate then runs `acceptance` ‖ `review` CONCURRENTLY (`run-gates.ts`,\n  *\"judge ‖ review\"*) before any test payload: a decisive semantic red ends the round with zero diagnostic\n  or full test-gate runs (a required acceptance oracle still executes); otherwise ONE full verification job\n  follows, with no selected screen. Only an attributed behavioral test-red repair may buy one diagnostic\n  first — every required failing file plus conservatively selected tests reaching the diff — admitted only\n  on comparable harness timing with ratio <= 0.15 AND estimated cost <= 60000 ms; its behavioral red stops\n  the round before semantics, otherwise semantics precede the full job. Disabled, unsupported, over-cap or\n  unknown-cost selection skips the diagnostic instead of running a full suite before semantics, and a\n  killed diagnostic is never green. A seatless or no-verdict review lets acceptance finish and publish and\n  the full job run in-round, and stays unsatisfied until review-only recovery; a seatless acceptance\n  cancels its sibling, records the unrun test (`testOwed`) and every enabled gate still owed (an unrecorded\n  review included), cannot merge and parks infra; an actual cancellation or throw awaits cleanup and leaves\n  no mergeable partial set. Test-only verification and an explicit full recheck keep their full scope with\n  no invented semantics and no diagnostic. Nothing merges until the FULL suite has passed on the exact\n  merge-candidate commit; an exact full green answers only after identity, environment, cleanliness and\n  current complete-manifest checks. The first five are MANDATORY; only `acceptance` and\n  `review` may be omitted per task. Implementations are in `src/gates/` — `baseline.ts` (build/test/lint,\n  diffed against a recorded baseline so pre-existing failures are forgiven), `evidence.ts`, `scope.ts`,\n  `acceptance.ts` (its judge reads the DIFF and every criterion must cite a changed hunk), `review.ts`\n  (cross-vendor). `run-gates.ts` drives them. **A declared gate is not a passed gate, and a gate that\n  returned zero findings is not the same as a gate that ran.**";
const MIXED = "**And `skills/` (canonical) versus `.claude/skills/` (installed) is a MIXED tree — symlinks for some\nfiles, independent copies for others — so a blanket rule in EITHER direction is wrong** (OBS-809). It\ncuts both ways: for a **shared inode**, an edit in `skills/` reaches into the running process; for a\n**copy**, a fix in `skills/` does **not** reach the running watcher at all, so a repaired watcher keeps\nrunning the old bytes while the tree says it is fixed. Sync both trees or `skills-single-source.test.ts`\nreds.\n\n⚠ **PROBE IT WITH `readlink` AND `stat -L`. NEVER BARE `stat -f %i`: on macOS that reports the SYMLINK'S\nOWN inode, not its target's**, so every symlink reads as a separate file. Measured 2026-08-31 — one seat\nprobed **one** file that way, got differing inodes, and wrote *\"they are all copies, editing them cannot\ncorrupt the running watchers\"* into a seat brief as a blanket rule; following it would have silently\nkilled the watcher then handing a milestone's spec to its orchestrator. A second seat's first pass\nreturned **seven** false *\"separate file\"* verdicts before it re-probed.\n\n```bash\n# Identity, correctly. It must compare the TWO TREES: pointed at either one alone it renders nothing,\n# because the canonical files are all real files and the links live on the installed side.\ncd <repo>\nfor f in $(cd skills && find . -type f -o -type l | sed 's|^\\./||' | sort); do\n  a=\"skills/$f\"; b=\".claude/skills/$f\"\n  [ -e \"$b\" ] || { printf '%-52s CANON-ONLY\\n' \"$f\"; continue; }\n  ia=$(stat -L -f %i \"$a\"); ib=$(stat -L -f %i \"$b\")   # -L: resolve, or symlinks read as separate files\n  [ \"$ia\" = \"$ib\" ] \\\n    && printf '%-52s SHARED INODE %s  -> mv-replace ONLY; a live reader is on these bytes\\n' \"$f\" \"$ia\" \\\n    || printf '%-52s copies (%s/%s)  -> a fix in skills/ does NOT reach the running copy\\n' \"$f\" \"$ia\" \"$ib\"\ndone\n```\n\n**Two failures worth separating, and the second is the durable one:** *a probe that cannot render the\nevidence cannot fail* — rule 11 aimed at your own instrument; and **a narrow verified fact was generalised\nto a population it was never sampled over.** One file checked, seven ruled on. **The generalisation ran in\nthe REASSURING direction, which is worse than the alarming one: an alarming overclaim gets challenged, a\nreassuring one gets acted on.**";

const skillSection = (text: string, heading: string) => {
  const marker = `## ${heading}\n\n`;
  expect(text).toContain(marker);
  return text.split(marker)[1].split("\n## ")[0];
};

afterEach(() => vi.restoreAllMocks());

describe("tickmarkr init --agent skills location (T3)", () => {
  test("installs under .agents/skills/ when the repo has no .claude/skills/", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });

    await runInit(repo, "--agent", "--docs");

    expect(readFileSync(join(repo, ".agents/skills/tickmarkr-loop/SKILL.md"))).toEqual(skill("tickmarkr-loop"));
    expect(readFileSync(join(repo, ".agents/skills/tickmarkr-auto/SKILL.md"))).toEqual(skill("tickmarkr-auto"));
    expect(existsSync(join(repo, ".claude"))).toBe(false);
  });

});

describe("consumer preflight and seat hygiene (queue rows 210, 221; D-2118)", () => {
  test("test: the installed loop and auto skills each carry the role check, the standalone verify command, the whole-version and graph-lock preflight, the seat hygiene duty, the herdr handoff read-back with its staged-text and no-prompt Enter guard, the green rule with its fatal run-end clause, the spec-template pointer and, on herdr, on Orca and on a plain host alike, the pointer to the overseer's project memory duty, so a diet that leaves a rule the block gave up in neither skill or unread on one host fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "CLAUDE.md": "App instructions\n", "package.json": '{"name":"consumer-app","version":"99.0.0"}' });
    await runInit(repo, "--agent", "--docs");
    const copies: Record<string, string[]> = {};
    for (const root of [".agents/skills", ".claude/skills"]) {
      for (const name of ["tickmarkr-loop", "tickmarkr-auto"]) {
        const installed = readFileSync(join(repo, root, name, "SKILL.md"), "utf8");
        const role = skillSection(installed, "Two-tier by default — role check before the loop");
        for (const label of ["**Orchestrator:**", "**Supervisor with a live orchestrator:**", "**Primary session without an orchestrator:**"]) expect(role).toContain(label);
        expect(role).toContain(SEAT);
        const preflight = skillSection(installed, "Binary preflight (before compile or run)");
        expect(preflight).toContain("Run `tickmarkr version --check` and **stop immediately on a non-zero exit**");
        expect(preflight).toContain("agree on the entire version");
        expect(preflight).toContain("binary `2.1.0` vs repo `2.1.1`");
        expect(preflight).toContain("never the app's manifest version");
        expect(preflight).toContain("tickmarkr init --agent --force");
        expect(preflight).toContain(".tickmarkr/graph.lock");
        expect(preflight).toContain("kill -0 <pid>");
        expect(preflight.indexOf(".tickmarkr/graph.lock")).toBeLessThan(preflight.indexOf("machine-wide process pattern"));
        expect(preflight).toContain("candidate's own working directory");
        expect(preflight).toContain("whose cwd is **this repository root**");
        expect(preflight).toContain(SPEC);
        // Read each host's actual scope, rather than accepting a pointer hidden in a herdr bullet.
        for (const host of ["herdr", "orca", "plain"] as const) {
          expect(skillSection(skillReading(installed, host), "Binary preflight (before compile or run)")).toContain(MEMORY);
        }
        const handoffs = skillSection(installed, "Verified handoffs (agent-to-agent messaging)");
        expect(handoffs).toContain(READBACK);
        expect(handoffs).toContain("never use bare send-text");
        expect(handoffs).toContain('`herdr pane run <pane> "<message>"`');
        expect(handoffs).toContain('`herdr notification show "<message>"`');
        expect(handoffs).toContain("cross-session message tool, confirmed by the peer's reply");
        expect(handoffs).toContain("turn_started");
        const steps = skillSection(installed, name === "tickmarkr-loop" ? "The loop" : "Per-spec loop");
        const verify = steps.split("5. **Verify and consolidate**")[1].split("6. **Record**")[0];
        expect(verify).toContain(GREEN);
        expect(verify).toContain(VERIFY);
        for (const command of ["tickmarkr compile", "tickmarkr plan", "tickmarkr run", "tickmarkr status <runId>", "tickmarkr resume <runId>", "tickmarkr approve <runId> <taskId>", "tickmarkr report <runId> --md"]) expect(installed).toContain(command);
        copies[name] = [role, preflight, handoffs, skillSection(installed, "Stand-down (mission end and retirement)")];
      }
      expect(copies["tickmarkr-loop"]).toEqual(copies["tickmarkr-auto"]);
    }
    const overseer = readFileSync(join(repo, ".agents/skills/tickmarkr-overseer/SKILL.md"), "utf8");
    expect(skillSection(overseer, "Setup")).toContain("**Read your host's PROJECT MEMORY before starting.**");
  });

  test("test: the installed loop and auto skills' preflights run the version check and stop on non-zero while keeping the whole-version sentence, and every installed skill defines its seat-label placeholder as the mission or run outside the tickmarkr source repository, no label still naming the version, so a consumer seat named by binary version fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    await runInit(repo, "--agent", "--docs");
    for (const name of ["tickmarkr-loop", "tickmarkr-auto", "tickmarkr-overseer"]) {
      const installed = skillCorpus(join(repo, ".agents/skills", name));
      expect(installed).toContain("`<label>` means the version only in the tickmarkr source repository (`package.json` named `tickmarkr`); elsewhere it means the mission or run, never the installed binary version.");
      expect(installed.match(/`<label>` means/g)).toHaveLength(1);
      expect(installed).toContain("ORCH · <label>");
      expect(installed).toContain("OVERSEER · <label>");
      expect(installed).not.toContain("<version>");
      if (name === "tickmarkr-overseer") continue;
      const preflight = installed.split("## Binary preflight (before compile or run)")[1].split("### No run may be live")[0];
      expect(preflight).toContain("Run `tickmarkr version --check` and **stop immediately on a non-zero exit**");
      expect(preflight).toContain("Only in the tickmarkr source repository (`package.json` named `tickmarkr`)");
      expect(preflight).toContain("If the binary and repository do not **agree on the entire version** (including the patch; e.g. binary `2.1.0` vs repo `2.1.1`), **stop immediately**");
      expect(preflight).toContain("never the app's manifest version");
      expect(preflight).not.toContain("Read the `version` field from the repository's `package.json`");
    }
  });

  test("test: the installed driving skills' role checks carry the Seat hygiene duty where tiers clear each other at half context or more, a new spec or run is a mission boundary, every brief and handoff carries the duty and a single-tier plain host asks the operator, and the installed overseer brief list opens with it, so guidance without the duty fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    await runInit(repo, "--agent", "--docs");
    for (const name of ["tickmarkr-loop", "tickmarkr-auto"]) {
      expect(skillSection(skillCorpus(join(repo, ".agents/skills", name)), "Two-tier by default — role check before the loop")).toContain(SEAT);
    }
    const installed = skillCorpus(join(repo, ".agents/skills/tickmarkr-overseer"));
    const brief = installed.split("The brief MUST contain: ")[1].split("\n")[0];
    expect(brief.startsWith("**Seat hygiene — ")).toBe(true);
    expect(brief).toContain("tiers clear each other at 50% context or more after writing a handoff");
    expect(brief).toContain("new spec or run is a mission boundary");
    expect(brief).toContain("copy this duty into every brief and handoff");
    expect(brief).toContain("single-tier plain host write your handoff and ask the operator to clear the session");
    expect(brief.indexOf("Seat hygiene")).toBeLessThan(brief.indexOf("then the mission"));
  });
});

describe("tickmarkr init --agent supervision skill mandates (SK-1)", () => {
  test("test: the overseer skill a fresh tickmarkr init installs states that on any restart the overseer re-announces its pane id to every live seat and re-arms every watcher with it, that briefs take the address from the handoff and never hardcode it, and that orchestrator artifacts live inside the orchestrator's sandbox root, so an installed skill that lets a seat keep a pre-restart pane id fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    await runInit(repo, "--agent", "--docs");
    const installed = skillCorpus(join(repo, ".agents/skills/tickmarkr-overseer"));

    expect(installed).toMatch(/ANY restart[\s\S]*re-announce[\s\S]*every live seat[\s\S]*re-arm[\s\S]*every watcher/);
    expect(installed).toMatch(/(?:must never keep|never keep) a pre-restart overseer pane id/);
    expect(installed).toMatch(/address from the handoff file/);
    expect(installed).toMatch(/never hardcode a pane id/);
    expect(installed).toMatch(/run log, handoff, and plan[\s\S]*inside its sandbox root/);
    expect(installed).toMatch(/overseer reads them from there/);
  });

  test("test: the installed overseer skill states that after agent start the seat waits for the model banner, sends the brief with pane run and reads the transcript back for its first words before any deadline is armed, and its orchestrator brief tells a seat whose sandbox denies writes under .git to report and stop so the overseer launches the daemon, so an installed skill that arms a deadline on an unread brief fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    await runInit(repo, "--agent", "--docs");
    const installed = skillCorpus(join(repo, ".agents/skills/tickmarkr-overseer"));

    expect(installed).toMatch(/agent start[\s\S]*wait for and read the model banner[\s\S]*brief with `pane run`[\s\S]*read the transcript back[\s\S]*first words[\s\S]*before.*deadline/);
    expect(installed).toMatch(/brief absent from the transcript was not sent/);
    expect(installed).toMatch(/sandbox denies writes under `\.git`[\s\S]*report.*overseer[\s\S]*stop/);
    expect(installed).toMatch(/overseer launches the daemon itself/);
    expect(installed).toMatch(/daemon host is never sandboxed/);
  });

  test("test: the installed overseer skill requires the effort flag and a banner read on every claude seat, full suite logs for inventories and no checkout in a clone while its suite runs, and every mention of agent prompt in it sits inside a sentence forbidding it as mission delivery, so an installed skill carrying a delivery mention outside a forbid fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    await runInit(repo, "--agent", "--docs");
    const installed = skillCorpus(join(repo, ".agents/skills/tickmarkr-overseer"));

    expect(installed).toMatch(/Every Claude[\s\S]*--effort high[\s\S]*banner read/);
    expect(installed).toMatch(/Inventories retain the \*\*full suite log\*\*/);
    expect(installed).toMatch(/no one runs `git checkout` in a clone while that clone's suite is running/);
    for (const line of installed.split("\n")) {
      if (line.includes("agent prompt")) expect(line).toMatch(/never use|forbid/i);
    }
  });

  test("test: the skills a fresh tickmarkr init installs each state in their run-watch guidance that a watch ending the seat's turn is no watch, name a blocking journal consumer re-armed at most every twenty minutes, and forbid a Monitor-only wake, so an installed skill whose watch guidance permits a turn-ending watch fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    await runInit(repo, "--agent", "--docs");

    for (const name of ["tickmarkr-overseer", "tickmarkr-auto", "tickmarkr-loop"]) {
      const installed = skillCorpus(join(repo, ".agents/skills", name));
      expect(installed).toMatch(/watch ending the seat's turn is no watch/);
      expect(installed).toMatch(/blocking journal consumer/);
      expect(installed).toMatch(/re-arm(?:ed|ing)? (?:it )?at most every twenty minutes/);
      expect(installed).toMatch(/(?:Never )?rely on a `Monitor`-only wake/);
    }
  });

  test("test: the installed overseer skill names pane run with read-back as the only verified mission delivery to claude and grok seats, the grok model flag, and an in-worktree verdict path for a codex reviewer under workspace-write, so an installed overseer skill that still names agent prompt as a delivery fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    await runInit(repo, "--agent", "--docs");
    const installed = skillCorpus(join(repo, ".agents/skills/tickmarkr-overseer"));

    expect(installed).toMatch(/pane run[\s\S]*read(?:ing)? the pane back/);
    expect(installed).toMatch(/Claude or Grok seat/);
    expect(installed).toMatch(/never use `agent prompt`/);
    expect(installed).toContain("Build the launch command from the returned `adapter` and `model`");
    expect(installed).toContain("herdr agent start <seat> --kind grok --pane <pane> -- -m <picked-model>");
    expect(installed).toMatch(/Codex reviewer under[\s\S]*workspace-write[\s\S]*in-worktree verdict path/);
  });
});

describe("tickmarkr init --agent multi-host install (T10)", () => {
  test("test: init --agent --force in a consumer repository whose committed scaffold skill copy differs from the package copy overwrites it and prints a note naming the file as tracked so the refresh is reviewable while the same repository without --force keeps the copy and prints the skipped note whereas an install that refuses the committed copy or overwrites it silently fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const stalePath = ".agents/skills/tickmarkr-loop/SKILL.md";
    const fixture = { [stalePath]: "committed stale copy\n" };

    const kept = makeRepo(fixture);
    const keptOut = await runInit(kept, "--agent");
    expect(readFileSync(join(kept, stalePath), "utf8")).toBe("committed stale copy\n");
    expect(keptOut).toContain(`skipped existing tracked ${join(kept, stalePath)}`);

    const forced = makeRepo(fixture);
    const forcedOut = await runInit(forced, "--agent", "--force");
    expect(readFileSync(join(forced, stalePath))).toEqual(skill("tickmarkr-loop"));
    expect(forcedOut).toContain(`overwrote tracked ${join(forced, stalePath)}`);
  });

  test("test: every install writes the driving skills into the codex discoverable project skill directory regardless of what else exists in the repository", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const fresh = makeRepo({ "keep.txt": "x" });
    const claudeRepo = makeRepo({ ".claude/skills/existing/SKILL.md": "consumer skill\n" });

    await runInit(fresh, "--agent", "--docs");
    await runInit(claudeRepo, "--agent", "--docs");

    for (const repo of [fresh, claudeRepo]) {
      expect(readFileSync(join(repo, ".agents/skills/tickmarkr-loop/SKILL.md"))).toEqual(skill("tickmarkr-loop"));
      expect(readFileSync(join(repo, ".agents/skills/tickmarkr-auto/SKILL.md"))).toEqual(skill("tickmarkr-auto"));
      expect(readFileSync(join(repo, ".agents/skills/tickmarkr-overseer/SKILL.md"))).toEqual(skill("tickmarkr-overseer"));
    }
  });

  test("test: an install additionally writes the driving skills into the claude directory when that directory already exists in the repository", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ ".claude/skills/existing/SKILL.md": "consumer skill\n" });

    await runInit(repo, "--agent", "--docs");

    expect(readFileSync(join(repo, ".claude/skills/tickmarkr-loop/SKILL.md"))).toEqual(skill("tickmarkr-loop"));
    expect(readFileSync(join(repo, ".claude/skills/tickmarkr-auto/SKILL.md"))).toEqual(skill("tickmarkr-auto"));
    expect(readFileSync(join(repo, ".agents/skills/tickmarkr-loop/SKILL.md"))).toEqual(skill("tickmarkr-loop"));
    expect(readFileSync(join(repo, ".claude/skills/existing/SKILL.md"), "utf8")).toBe("consumer skill\n");
  });

  test("test: the codex discoverable directory receives codex repository guidance and the claude directory receives claude repository guidance when both are written", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ ".claude/skills/existing/SKILL.md": "consumer skill\n" });

    await runInit(repo, "--agent", "--docs");

    expect(existsSync(join(repo, ".agents/skills/tickmarkr-loop/SKILL.md"))).toBe(true);
    expect(existsSync(join(repo, ".claude/skills/tickmarkr-loop/SKILL.md"))).toBe(true);
    expect(agentDocsSection(repo, "AGENTS.md")).toMatch(/Never run two tickmarkr runs/);
    expect(agentDocsSection(repo, "CLAUDE.md")).toMatch(/Never run two tickmarkr runs/);
  });

  test("test: the existing per-location overwrite confirmation and force behavior and existing consumer owned content survive independently at each installed location", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const fixture = {
      ".claude/skills/tickmarkr-loop/SKILL.md": "claude consumer loop\n",
      ".agents/skills/tickmarkr-auto/SKILL.md": "codex consumer auto\n",
      "CLAUDE.md": "consumer docs\n",
    };

    const kept = makeRepo(fixture);
    const out = await runInit(kept, "--agent");
    expect(readFileSync(join(kept, ".claude/skills/tickmarkr-loop/SKILL.md"), "utf8")).toBe("claude consumer loop\n");
    expect(readFileSync(join(kept, ".agents/skills/tickmarkr-auto/SKILL.md"), "utf8")).toBe("codex consumer auto\n");
    expect(readFileSync(join(kept, ".agents/skills/tickmarkr-loop/SKILL.md"))).toEqual(skill("tickmarkr-loop"));
    expect(readFileSync(join(kept, ".claude/skills/tickmarkr-auto/SKILL.md"))).toEqual(skill("tickmarkr-auto"));
    expect(out).toMatch(/skipped existing .*\.claude\/skills\/tickmarkr-loop\/SKILL\.md.*--force/);
    expect(out).toMatch(/skipped existing .*\.agents\/skills\/tickmarkr-auto\/SKILL\.md.*--force/);
    expect(readFileSync(join(kept, "CLAUDE.md"), "utf8")).toBe("consumer docs\n");

    const forced = makeRepo(fixture);
    await runInit(forced, "--agent", "--force");
    expect(readFileSync(join(forced, ".claude/skills/tickmarkr-loop/SKILL.md"))).toEqual(skill("tickmarkr-loop"));
    expect(readFileSync(join(forced, ".agents/skills/tickmarkr-auto/SKILL.md"))).toEqual(skill("tickmarkr-auto"));
  });

  test("test: the overseer skill installs alongside the loop and auto skills at every location the driving skills are written", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ ".claude/skills/existing/SKILL.md": "consumer skill\n" });

    await runInit(repo, "--agent", "--docs");

    for (const root of [".agents/skills", ".claude/skills"]) {
      expect(readFileSync(join(repo, root, "tickmarkr-overseer/SKILL.md"))).toEqual(skill("tickmarkr-overseer"));
      expect(existsSync(join(repo, root, "tickmarkr-loop/SKILL.md"))).toBe(true);
      expect(existsSync(join(repo, root, "tickmarkr-auto/SKILL.md"))).toBe(true);
      expect(existsSync(join(repo, root, "tickmarkr-overseer/scripts/watch-panes.sh"))).toBe(true);
    }
  });
});

describe("tickmarkr init --agent portable docs (T3)", () => {
  test("test: an agent init into a scratch consumer writes a guidance block whose only headings are the tickmarkr title and Invariants and whose bullets are the five invariants, the version check stop, the one-line green rule and the routing line naming the loop, auto and overseer skills with no slash and no claude path, so a block still carrying a command crib, role check, live-run check, handoff mechanics, seat hygiene or orientation fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "AGENTS.md": "# Repo agents\n", "CLAUDE.md": "# Consumer instructions\n" });
    await runInit(repo, "--agent", "--docs");
    const block = agentDocsSection(repo);
    const bullets = [
      "Never run two tickmarkr runs in the same repository concurrently.",
      "Never let tickmarkr merge work to main; new runs consolidate on `tickmarkr/<runId>`.",
      "Do not edit compiled graphs to force outcomes; fix source specs and recompile.",
      "Gates verify commits, diffs, acceptance criteria, and reviews independently — never trust a worker's completion claim.",
      "Treat missing or unparseable machine results and verdicts as failures.",
      PREFLIGHT, SHORT_GREEN, ROUTING,
    ];
    expect(block).toBe([
      "<!-- tickmarkr:agent-docs begin -->", "## tickmarkr", "",
      "tickmarkr compiles repository specs into isolated, independently verified agent work.", "",
      "### Invariants", "", ...bullets.map(line => `- ${line}`), "<!-- tickmarkr:agent-docs end -->",
    ].join("\n"));
    expect(block.match(/^#+ .+$/gm)).toEqual(["## tickmarkr", "### Invariants"]);
    expect(block.match(/^- /gm)).toHaveLength(8);
    expect(block).not.toMatch(/\.claude|(?:^|[\s`(])\/(?:tickmarkr|tkr)[\w-]*/m);
    expect(agentDocsSection(repo, "CLAUDE.md")).toBe(block);
  });

  test("a repo that already has the agent-docs block still receives corrections to it under --force", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    // A repo whose block is STALE, with human-authored prose on both sides of it that must survive.
    const stale = "# consumer notes\n\nkeep me above\n\n"
      + "<!-- tickmarkr:agent-docs begin -->\n## tickmarkr\n\nancient guidance\n"
      + "<!-- tickmarkr:agent-docs end -->\n\nkeep me below\n";
    const repo = makeRepo({ "AGENTS.md": stale });

    const kept = await runInit(repo, "--agent", "--docs");

    // Without --force the block is preserved, and the note must NAME the lever, or nobody learns it exists.
    expect(agentDocsSection(repo)).toMatch(/ancient guidance/);
    expect(kept).toMatch(/--force to refresh/);

    await runInit(repo, "--agent", "--docs", "--force");

    const section = agentDocsSection(repo);
    expect(section).not.toMatch(/ancient guidance/);
    expect(section).toMatch(/Never run two tickmarkr runs/);
    // canonical guidance is only useful if a stale copy can be corrected in place
    expect(section).toContain(ROUTING);
    // ...without collateral damage to the parts a human wrote
    const text = readFileSync(join(repo, "AGENTS.md"), "utf8");
    expect(text).toMatch(/keep me above/);
    expect(text).toMatch(/keep me below/);
    expect(text.match(/tickmarkr:agent-docs begin/g)).toHaveLength(1);
  });

  test("the installed driving skills keep the staged-text-and-no-prompt Enter guard and guarded retry verbatim", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    await runInit(repo, "--agent", "--docs");
    for (const name of ["tickmarkr-loop", "tickmarkr-auto"]) {
      const handoffs = skillSection(skillCorpus(join(repo, ".agents/skills", name)), "Verified handoffs (agent-to-agent messaging)");
      expect(handoffs).toContain(READBACK);
      expect(handoffs).toContain("staged text and no permission prompt or numbered choice holds focus");
      expect(handoffs).toContain("(OBS-1119)");
      expect(handoffs).toContain("Under that guard, send-keys enter to that pane once and read again (OBS-975)");
      expect(handoffs).toContain("resolve it first and re-read before retrying");
    }
  });
});

describe("tickmarkr init --agent preflight authority (T3)", () => {
  test("test: each installed driving skill leads its live-run check with this repository's own graph lock so a tickmarkr run executing elsewhere does not read as live here while scaffolded text checking a machine-wide process pattern fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });

    await runInit(repo, "--agent", "--docs");

    for (const name of ["tickmarkr-loop", "tickmarkr-auto"]) {
      const preflight = skillSection(skillCorpus(join(repo, ".agents/skills", name)), "Binary preflight (before compile or run)");
      const lock = preflight.indexOf(".tickmarkr/graph.lock");
      const machineWideProbe = preflight.indexOf("machine-wide process pattern");
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(machineWideProbe).toBeGreaterThan(lock);
      expect(preflight).toMatch(/Read its recorded holder pid/);
      expect(preflight).toContain("kill -0 <pid>");
      expect(preflight).toMatch(/lawful run in another repository/);
      expect(preflight).toMatch(/probing shell's own argv/);
      expect(preflight).toMatch(/resolve every\s+candidate's own working directory/);
      expect(preflight).toContain("whose cwd is **this repository root**");
      expect(preflight).not.toContain('pgrep -f "tickmarkr (run|resume)"` must be empty');
    }
  });

  test("test: each installed driving skill requires binary and repository to agree on the entire version so a binary trailing by one patch stops the loop while scaffolded text comparing only major and minor fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });

    await runInit(repo, "--agent", "--docs");

    for (const name of ["tickmarkr-loop", "tickmarkr-auto"]) {
      const preflight = skillSection(skillCorpus(join(repo, ".agents/skills", name)), "Binary preflight (before compile or run)");
      expect(preflight).toContain("agree on the entire version");
      expect(preflight).toContain("binary `2.1.0` vs repo `2.1.1`");
      expect(preflight).toContain("**stop immediately**");
      expect(preflight).not.toMatch(/older on major\.minor/);
    }
  });

  test("both driving skills carrying their own version preflight state the same whole-version stop rule so a patch-level gap stops them while a skill still telling the operator to stop only when the binary is older on major and minor fails", () => {
    const wholeVersionRule = "If the binary and repository do not **agree on the entire version** "
      + "(including the patch; e.g. binary `2.1.0` vs repo `2.1.1`), **stop immediately**";

    for (const name of ["tickmarkr-auto", "tickmarkr-loop"]) {
      const text = skillCorpus(join(ROOT, "skills", name));
      expect(text).toContain(wholeVersionRule);
      expect(text).not.toMatch(/older on major\.minor/);
    }
  });

  test("test: every guidance file at this repository root carries the rendered block byte for byte while this repository's own guidance above the markers carries the gate execution order and the skills mixed-tree law, so a stale root block or a source-repo rule deleted with the block fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    await runInit(repo, "--agent", "--docs");
    const scaffolded = agentDocsSection(repo);
    // Public exports deliberately omit repository guidance; keep that contract explicit.
    if (!existsSync(join(ROOT, "scripts/export-public.sh"))) {
      for (const doc of ["CLAUDE.md", "AGENTS.md"]) expect(existsSync(join(ROOT, doc))).toBe(false);
      return;
    }
    const present = ["CLAUDE.md", "AGENTS.md"].filter(doc => existsSync(join(ROOT, doc)));
    expect(present).toContain("CLAUDE.md");
    for (const doc of present) expect(agentDocsSection(ROOT, doc), doc).toBe(scaffolded);
    const ownGuidancePath = join(ROOT, "CLAUDE.md");
    // This file is absent from the exported tree; source-repo presence remains required above.
    if (existsSync(ownGuidancePath)) {
      const guidance = readFileSync(ownGuidancePath, "utf8");
      const ownGuidance = guidance.split("<!-- tickmarkr:agent-docs begin -->")[0];
      expect(ownGuidance).toContain(GATES);
      expect(ownGuidance).toContain(MIXED);
      expect(ownGuidance).toContain("**Editing `src/gates/`, `src/compile/` or `src/graph/`?**");
      expect(guidance).not.toContain("These same bytes");
    }
    expect(scaffolded).not.toContain("src/");
  });
});

// OBS-373: a script was added to the shipped overseer skill after repos had installed it. Every check
// keyed on SKILL.md EXISTING, so those repos reported "installed" while the script their own SKILL.md
// tells them to run was absent — and `init` said nothing, on any path. These pin currency, not presence.
describe("tickmarkr init — an installed skill is current, not merely present (OBS-373)", () => {
  const overseerDir = ".agents/skills/tickmarkr-overseer";
  const currentSkill = readFileSync(join(ROOT, "skills/tickmarkr-overseer/SKILL.md"), "utf8");
  const currentWatcher = readFileSync(join(ROOT, "skills/tickmarkr-overseer/scripts/watch-panes.sh"), "utf8");

  test("test: an install whose SKILL.md is current but whose shipped script is absent is reported stale by name on a plain init", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    // The exact shape that shipped: the mandating SKILL.md is byte-current, one script it names is gone.
    const repo = makeRepo({
      [`${overseerDir}/SKILL.md`]: currentSkill,
      [`${overseerDir}/scripts/watch-panes.sh`]: currentWatcher,
    });

    const out = await runInit(repo);

    expect(out).toMatch(/stale .*tickmarkr-overseer\/SKILL\.md/);
    // Order-independent on purpose: the missing list is derived and sorted, so a shipped file added
    // later (seat-send.sh, 2026-08-18) lands mid-list — a `missing <first-file>` substring pin broke
    // on exactly the event this suite exists to report. Pin both: the original incident's file and
    // the newest shipped one, each named on the missing line.
    expect(out).toMatch(/missing [^\n]*scripts\/watch-artifacts\.sh/);
    expect(out).toMatch(/missing [^\n]*scripts\/seat-send\.sh/);
    expect(out).toContain("tickmarkr init --agent --force");
  });

  test("test: a byte-identical install is reported current, and the same repo reports stale the moment one shipped file is removed", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    await runInit(repo, "--agent", "--docs");

    const clean = await runInit(repo, "--agent");

    expect(clean).toMatch(/kept current .*tickmarkr-overseer\/SKILL\.md/);
    expect(clean).not.toMatch(/stale .*tickmarkr-overseer/);
    expect(clean).not.toMatch(/skipped existing .*tickmarkr-overseer/);

    // Both directions in one body ON PURPOSE. Asserting only the clean half passes just as happily when
    // the detector is blind — measured: with skillDrift stubbed to return nothing, the clean half stayed
    // green while every other test here went red. A control that cannot fail is not one.
    rmSync(join(repo, overseerDir, "scripts/watch-artifacts.sh"));

    expect(await runInit(repo)).toContain("missing scripts/watch-artifacts.sh");
  });

  test("test: a missing shipped file and a modified one are distinguished rather than both reported as stale", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({
      [`${overseerDir}/SKILL.md`]: `${currentSkill}\nlocally appended line\n`,
      [`${overseerDir}/scripts/watch-panes.sh`]: currentWatcher,
    });

    const out = await runInit(repo);

    expect(out).toMatch(/missing [^\n]*scripts\/watch-artifacts\.sh/);
    expect(out).toContain("modified SKILL.md");
  });

  test("test: --force refreshes a stale install and the next init reports it current, proven by the drift note disappearing", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({
      [`${overseerDir}/SKILL.md`]: currentSkill,
      [`${overseerDir}/scripts/watch-panes.sh`]: currentWatcher,
    });

    expect(await runInit(repo)).toMatch(/missing [^\n]*scripts\/watch-artifacts\.sh/);
    await runInit(repo, "--agent", "--force");

    expect(readFileSync(join(repo, overseerDir, "scripts/watch-artifacts.sh"))).toEqual(
      readFileSync(join(ROOT, "skills/tickmarkr-overseer/scripts/watch-artifacts.sh")),
    );
    expect(await runInit(repo)).not.toMatch(/stale .*tickmarkr-overseer/);
  });
});
