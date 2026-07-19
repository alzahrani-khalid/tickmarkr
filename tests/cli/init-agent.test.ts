import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
});
