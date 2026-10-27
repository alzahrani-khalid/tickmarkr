import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as registry from "../../src/adapters/registry.js";
import { agentSkillEvidence, docsDrift, init, installedAgentGuidance, skillDrift } from "../../src/cli/commands/init.js";
import { version } from "../../src/cli/commands/version.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const ROOT = join(import.meta.dirname, "../..");
const SKILLS = ["tickmarkr-auto", "tickmarkr-loop", "tickmarkr-overseer"];
const CODEX_NOTE = "agent skills for codex: .agents/skills (AGENTS.md)";
const claudeNote = (reason: string) => `agent skills for claude: .claude/skills (CLAUDE.md) — ${reason}`;
const hostNotes = (out: string) => out.split("\n").filter(line => line.startsWith("agent skills for "));

beforeEach(() => {
  vi.spyOn(registry, "allAdapters").mockReturnValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function consumer(files: Record<string, string> = { "keep.txt": "consumer\n" }) {
  const repo = makeRepo(files);
  // Exercise init's real cached-discovery path without probing the machine's agent CLIs.
  registry.writeDoctor(repo, { fake: { installed: true, authed: true, models: [] } });
  return repo;
}

const runInit = (repo: string, env: NodeJS.ProcessEnv, extra: string[] = []) =>
  init(["--agent", "--docs", "--yes", "--global-dir", join(repo, ".test-global"), ...extra], repo, { env });

function filesUnder(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory() ? filesUnder(root, join(prefix, entry.name)) : [join(prefix, entry.name)]);
}

const bytesUnder = (root: string) => Object.fromEntries(filesUnder(root).map(file => [file, readFileSync(join(root, file)).toString("base64")]));

function expectHostSkills(repo: string, host: ".agents" | ".claude") {
  const dir = join(repo, host, "skills");
  expect(readdirSync(dir).sort()).toEqual(SKILLS);
  for (const skill of SKILLS) expect(bytesUnder(join(dir, skill))).toEqual(bytesUnder(join(ROOT, "skills", skill)));
}

function executablePath(mode = 0o755) {
  const dir = makeTestTempDir("claude-path-");
  const called = join(dir, "called");
  writeFileSync(join(dir, "claude"), `#!/bin/sh\nprintf called > '${called}'\nexit 1\n`);
  chmodSync(join(dir, "claude"), mode);
  return { dir, called };
}

test("test: init with the agent flag in a fresh repository whose environment sets the Claude Code entrypoint installs the three skills under the Claude skills directory and the guidance block in CLAUDE.md and notes the reason, while the same repository without it installs codex alone, so an init waiting for an existing claude directory fails", async () => {
  for (const entrypoint of [undefined, "cli"]) {
    const repo = consumer();
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    const out = await runInit(repo, { CLAUDE_CODE_ENTRYPOINT: entrypoint });
    expectHostSkills(repo, ".agents");
    const guidance = readFileSync(join(repo, "AGENTS.md"), "utf8");
    expect(guidance).toContain("<!-- tickmarkr:agent-docs begin -->");
    expect(guidance).toContain("<!-- tickmarkr:agent-docs end -->");
    if (entrypoint) {
      expectHostSkills(repo, ".claude");
      expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe(guidance);
      expect(hostNotes(out)).toEqual([CODEX_NOTE, claudeNote("CLAUDE_CODE_ENTRYPOINT set")]);
    } else {
      expect(existsSync(join(repo, ".claude"))).toBe(false);
      expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);
      expect(hostNotes(out)).toEqual([CODEX_NOTE]);
    }
  }

  // Production callers omit InitIO.env and inherit the process environment.
  const repo = consumer();
  vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "cli");
  const out = await init(["--agent", "--docs", "--yes", "--global-dir", join(repo, ".test-global")], repo);
  expectHostSkills(repo, ".claude");
  expect(hostNotes(out)).toEqual([CODEX_NOTE, claudeNote("CLAUDE_CODE_ENTRYPOINT set")]);
});

test("test: init with the agent flag treats an executable named claude in a directory of its search path as the Claude host, while an empty entrypoint value, a non-executable file and a directory named claude do not, so a detection by name alone or through a login shell fails", async () => {
  const positive = [0o100, 0o010, 0o001].map(mode => ({ repo: consumer(), ...executablePath(mode) }));
  const nonExecutable = executablePath(0o644);
  const directory = makeTestTempDir("claude-directory-");
  mkdirSync(join(directory, "claude"));
  const empty = makeTestTempDir("claude-empty-");
  const negative = [undefined, empty, nonExecutable.dir, directory].map(PATH => ({ repo: consumer(), PATH }));
  vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "");
  vi.stubEnv("PATH", empty);
  for (const fixture of positive) {
    // Only the injected PATH holds claude. No executable or shell needs to be run.
    const out = await runInit(fixture.repo, { CLAUDE_CODE_ENTRYPOINT: "", PATH: [empty, fixture.dir].join(delimiter) });
    expectHostSkills(fixture.repo, ".claude");
    expect(hostNotes(out)).toEqual([CODEX_NOTE, claudeNote("claude on PATH")]);
    expect(existsSync(fixture.called)).toBe(false);
  }
  // An ambient executable and entrypoint must not leak into InitIO.env.
  vi.stubEnv("PATH", positive[0].dir);
  vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "ambient");
  for (const fixture of negative) {
    const out = await runInit(fixture.repo, { CLAUDE_CODE_ENTRYPOINT: "", PATH: fixture.PATH });
    expectHostSkills(fixture.repo, ".agents");
    expect(existsSync(join(fixture.repo, ".claude"))).toBe(false);
    expect(existsSync(join(fixture.repo, "CLAUDE.md"))).toBe(false);
    expect(hostNotes(out)).toEqual([CODEX_NOTE]);
  }
  expect(existsSync(nonExecutable.called)).toBe(false);
});

test("test: the agent skill notes name every host that received skills with its directory and guidance file, codex always and claude with the first reason that holds, so a note naming a host that got nothing or hiding one that did fails", async () => {
  const bin = executablePath();
  const cases: { files: Record<string, string>; env: NodeJS.ProcessEnv; reason?: string }[] = [
    { files: { ".claude/keep.txt": "keep\n", "CLAUDE.md": "human\n" }, env: { CLAUDE_CODE_ENTRYPOINT: "cli", PATH: bin.dir }, reason: "CLAUDE_CODE_ENTRYPOINT set" },
    { files: { ".claude/keep.txt": "keep\n", "CLAUDE.md": "human\n" }, env: { PATH: bin.dir }, reason: "claude on PATH" },
    { files: { ".claude/keep.txt": "keep\n", "CLAUDE.md": "human\n" }, env: {}, reason: "existing .claude" },
    { files: { "CLAUDE.md": "human\n" }, env: {}, reason: "existing CLAUDE.md" },
    { files: { "keep.txt": "consumer\n" }, env: {}, reason: undefined },
  ];
  for (const item of cases) {
    const repo = consumer(item.files);
    const out = await runInit(repo, item.env);
    expectHostSkills(repo, ".agents");
    if (item.reason) {
      expectHostSkills(repo, ".claude");
      expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toContain("human\n");
    } else expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect(hostNotes(out)).toEqual([CODEX_NOTE, ...(item.reason ? [claudeNote(item.reason)] : [])]);
  }

  const blocked = consumer();
  const external = makeTestTempDir("claude-linked-host-");
  symlinkSync(external, join(blocked, ".claude"));
  const out = await runInit(blocked, { CLAUDE_CODE_ENTRYPOINT: "cli" });
  expect(readdirSync(external)).toEqual([]);
  expect(hostNotes(out)).toEqual([CODEX_NOTE]);
  expect(out).toContain(`kept ${join(blocked, ".claude")} (symbolic link)`);

  const plain = consumer();
  const noInstall = await init(["--yes", "--global-dir", join(plain, ".test-global")], plain, { env: { CLAUDE_CODE_ENTRYPOINT: "cli", PATH: bin.dir } });
  expect(hostNotes(noInstall)).toEqual([]);
  expect(existsSync(join(plain, ".agents"))).toBe(false);
  expect(existsSync(join(plain, ".claude"))).toBe(false);
});

test("test: a second init with the agent flag under the entrypoint keeps the current Claude skills and writes nothing, and a symbolically linked guidance file is kept under the new triggers, so a trigger that rewrites current skills or writes through a link fails", async () => {
  const repo = consumer();
  const env = { CLAUDE_CODE_ENTRYPOINT: "cli" };
  await runInit(repo, env);
  const paths = [".agents", ".claude"].flatMap(host => filesUnder(join(repo, host)).map(file => join(repo, host, file)))
    .concat([join(repo, "AGENTS.md"), join(repo, "CLAUDE.md")]);
  // Backdate the measured files so even a byte-identical rewrite changes the evidence.
  for (const path of paths) utimesSync(path, new Date(0), new Date(0));
  const snapshot = () => paths.map(path => ({ path, bytes: readFileSync(path), stat: lstatSync(path, { bigint: true }) }));
  const before = snapshot();
  const out = await runInit(repo, env);
  // Reading may change atime; mtime, ctime and inode establish that no write occurred.
  expect(snapshot().map(({ path, bytes, stat }) => [path, bytes, stat.mtimeNs, stat.ctimeNs, stat.ino]))
    .toEqual(before.map(({ path, bytes, stat }) => [path, bytes, stat.mtimeNs, stat.ctimeNs, stat.ino]));
  for (const skill of SKILLS) expect(out).toContain(`kept current ${join(repo, ".claude/skills", skill, "SKILL.md")}`);
  expect(out).not.toMatch(/^(?:wrote|overwrote|appended|refreshed) /m);
  expect(hostNotes(out)).toEqual([CODEX_NOTE, claudeNote("CLAUDE_CODE_ENTRYPOINT set")]);

  const bin = executablePath();
  for (const trigger of [{ CLAUDE_CODE_ENTRYPOINT: "cli" }, { PATH: bin.dir }]) {
    for (const dangling of [false, true]) {
      const linked = consumer();
      const target = join(makeTestTempDir("claude-linked-doc-"), "guidance.md");
      if (!dangling) writeFileSync(target, "external guidance\n");
      symlinkSync(target, join(linked, "CLAUDE.md"));
      const targetBefore = dangling ? undefined : readFileSync(target);
      const linkedOut = await runInit(linked, trigger, ["--force"]);
      expect(lstatSync(join(linked, "CLAUDE.md")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(linked, "CLAUDE.md"))).toBe(target);
      if (dangling) expect(existsSync(target)).toBe(false);
      else expect(readFileSync(target)).toEqual(targetBefore);
      expectHostSkills(linked, ".claude");
      expect(linkedOut).toContain(`kept ${join(linked, "CLAUDE.md")} (symbolic link)`);
    }
  }
});

test("test: a repository holding only the codex install reads current to the version check and to doctor's skill evidence under an environment with the entrypoint set and claude on the search path, so a reader that now demands Claude skills fails", async () => {
  const repo = consumer();
  await runInit(repo, {});
  expect(existsSync(join(repo, ".claude"))).toBe(false);
  const evidenceBefore = agentSkillEvidence(repo);
  const guidanceBefore = installedAgentGuidance(repo);
  expect(evidenceBefore.skills).toHaveLength(3);
  expect(evidenceBefore.skills.every(skill => skill.current && skill.removable)).toBe(true);
  const bin = executablePath();
  vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "cli");
  vi.stubEnv("PATH", bin.dir);
  // Evidence and both drift readers retain the existing repository-only host rule.
  expect(agentSkillEvidence(repo)).toEqual(evidenceBefore);
  expect(installedAgentGuidance(repo)).toEqual(guidanceBefore);
  expect(skillDrift(repo)).toEqual([]);
  expect(docsDrift(repo)).toEqual([]);
  expect(await version(["--check"], undefined, repo)).toContain("installed guidance matches");
  expect(existsSync(join(repo, ".claude"))).toBe(false);
  expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);

  // Currency is still measured: a changed codex skill must fail the very same check.
  const skill = join(repo, ".agents/skills/tickmarkr-loop/SKILL.md");
  writeFileSync(skill, readFileSync(skill, "utf8") + "\nconsumer change\n");
  expect(skillDrift(repo)).toEqual([expect.objectContaining({ skill: "tickmarkr-loop", modified: ["SKILL.md"] })]);
  await expect(version(["--check"], undefined, repo)).rejects.toThrow("modified .agents/skills/tickmarkr-loop/SKILL.md");
});
