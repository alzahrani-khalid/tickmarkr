import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as registry from "../../src/adapters/registry.js";
import { init } from "../../src/cli/commands/init.js";
import { makeRepo } from "../helpers/tmprepo.js";

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

const versionPreflight = (agentDocs: string) => {
  const begin = agentDocs.indexOf("### Version preflight");
  const end = agentDocs.indexOf("### Tip-verify-before-green", begin);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return agentDocs.slice(begin, end);
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

describe("tickmarkr init --agent multi-host install (T10)", () => {
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
  test("emits the invariants, command crib, role check, tip-verify, version preflight, and handoff rule", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "AGENTS.md": "# Repo agents\n" });

    await runInit(repo, "--agent", "--docs");

    const section = agentDocsSection(repo);
    expect(section).toMatch(/Never run two tickmarkr runs/);
    expect(section).toMatch(/Never let tickmarkr merge work to main/);
    expect(section).toMatch(/Do not edit compiled graphs/);
    expect(section).toMatch(/never trust a worker's completion claim/i);
    expect(section).toMatch(/Treat missing or unparseable/);
    expect(section).toMatch(/tickmarkr compile <spec>/);
    expect(section).toMatch(/tickmarkr plan/);
    expect(section).toMatch(/tickmarkr run/);
    expect(section).toMatch(/tickmarkr status <runId>/);
    expect(section).toMatch(/tickmarkr resume <runId>/);
    expect(section).toMatch(/tickmarkr approve <runId> <taskId>/);
    expect(section).toMatch(/tickmarkr report <runId> --md/);
    expect(section).toMatch(/Role check/);
    expect(section).toMatch(/Orchestrator:/);
    expect(section).toMatch(/Supervisor with a live orchestrator/);
    expect(section).toMatch(/Version preflight/);
    expect(section).toMatch(/tickmarkr version/);
    expect(section).toMatch(/Tip-verify-before-green/);
    expect(section).toMatch(/tip verify is not "failed"/);
    expect(section).toMatch(/Verified handoffs/);
    expect(section).toMatch(/never use bare send-text/);
    expect(section).toMatch(/herdr pane run/);
    expect(section).not.toMatch(/\/tickmarkr-loop/);
    expect(section).not.toMatch(/\.claude/);
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
    expect(section).toMatch(/Orient before you act/);
    // ...without collateral damage to the parts a human wrote
    const text = readFileSync(join(repo, "AGENTS.md"), "utf8");
    expect(text).toMatch(/keep me above/);
    expect(text).toMatch(/keep me below/);
    expect(text.match(/tickmarkr:agent-docs begin/g)).toHaveLength(1);
  });
});

describe("tickmarkr init --agent preflight authority (T3)", () => {
  test("test: the scaffolded agent-docs block leads its live-run check with this repository's own graph lock so a tickmarkr run executing elsewhere does not read as live here while scaffolded text checking a machine-wide process pattern fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });

    await runInit(repo, "--agent", "--docs");

    const preflight = versionPreflight(agentDocsSection(repo));
    const lock = preflight.indexOf(".tickmarkr/graph.lock");
    const machineWideProbe = preflight.indexOf("machine-wide process pattern");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(machineWideProbe).toBeGreaterThan(lock);
    expect(preflight).toMatch(/read its holder pid/);
    expect(preflight).toContain("kill -0 <pid>");
    expect(preflight).toMatch(/lawful run in another repository/);
    expect(preflight).toMatch(/probing shell's own argv/);
    expect(preflight).toMatch(/resolve every candidate's own cwd/);
    expect(preflight).toMatch(/whose cwd is this repository root/);
    expect(preflight).not.toContain('pgrep -f "tickmarkr (run|resume)"` must be empty');
  });

  test("test: the scaffolded agent-docs block requires binary and repository to agree on the entire version so a binary trailing by one patch stops the loop while scaffolded text comparing only major and minor fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });

    await runInit(repo, "--agent", "--docs");

    const preflight = versionPreflight(agentDocsSection(repo));
    expect(preflight).toMatch(/versions differ anywhere \(major, minor, or patch\)/);
    expect(preflight).toMatch(/must agree on the entire version/);
    expect(preflight).toMatch(/binary `2\.1\.0` versus repository `2\.1\.1` is a stop/);
    expect(preflight).not.toMatch(/older on major\.minor/);
  });

  test("both driving skills carrying their own version preflight state the same whole-version stop rule so a patch-level gap stops them while a skill still telling the operator to stop only when the binary is older on major and minor fails", () => {
    const wholeVersionRule = "If the binary and repository do not **agree on the entire version** "
      + "(including the patch; e.g. binary `2.1.0` vs repo `2.1.1`), **stop immediately**";

    for (const name of ["tickmarkr-auto", "tickmarkr-loop"]) {
      const text = skill(name).toString("utf8");
      expect(text).toContain(wholeVersionRule);
      expect(text).not.toMatch(/older on major\.minor/);
    }
  });

  test("this repository's own rendered guidance files carry both the repository-scoped live-run check and the whole-version stop rule while a change fixing only the scaffold a new repository would receive fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    await runInit(repo, "--agent", "--docs");
    const scaffolded = agentDocsSection(repo);

    for (const doc of ["CLAUDE.md"]) {
      const rendered = agentDocsSection(ROOT, doc);
      expect(rendered).toBe(scaffolded);
      const preflight = versionPreflight(rendered);
      expect(preflight.indexOf(".tickmarkr/graph.lock"))
        .toBeLessThan(preflight.indexOf("machine-wide process pattern"));
      expect(preflight).toMatch(/resolve every candidate's own cwd/);
      expect(preflight).toMatch(/must agree on the entire version/);
      expect(preflight).toMatch(/binary `2\.1\.0` versus repository `2\.1\.1` is a stop/);
      expect(preflight).not.toMatch(/older on major\.minor/);
    }
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
