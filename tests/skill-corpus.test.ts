import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { hostViolations, plainLineFindings, skillCorpus, skillDirReading, skillDirViolations, skillReading } from "./helpers/skill-reading.js";

// Filesystems often sort readdir themselves; force a different order to prove the reader sorts.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readdirSync: vi.fn(fs.readdirSync) };
});

const ROOT = join(import.meta.dirname, "..");
const scratchDirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-skill-corpus-"));
  scratchDirs.push(dir);
  return dir;
};
const put = (dir: string, file: string, text: string) => writeFileSync(join(dir, file), text);
afterEach(() => {
  vi.mocked(readdirSync).mockReset();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function markdownFiles(dir: string): string[] {
  const references = join(dir, "references");
  return ["SKILL.md", ...(existsSync(references) ? readdirSync(references).filter(name => name.endsWith(".md") && statSync(join(references, name)).isFile())
    .sort().map(name => join("references", name)) : [])];
}

function plainFindings(dir: string): string[] {
  return markdownFiles(dir).flatMap(file => plainLineFindings(readFileSync(join(dir, file), "utf8"))
    .map(finding => `${file}: ${finding}`));
}

test("test: the skill corpus of a directory reads its skill file first and then every markdown file directly under its references folder in name order, skips a non-markdown file and a nested folder there, and reads a directory with no references folder as its skill file alone, so a reader that drops a reference or reads them in directory order fails", () => {
  const dir = scratch();
  put(dir, "SKILL.md", "skill bytes\n");
  expect(skillCorpus(dir)).toBe("skill bytes\n");
  mkdirSync(join(dir, "references", "nested.md"), { recursive: true });
  // Create in reverse name order; assert the exact bytes, including the joining newline.
  put(dir, "references/z-last.md", "last bytes");
  put(dir, "references/a-first.md", "first bytes\n");
  put(dir, "references/m-middle.md", "middle bytes");
  put(dir, "references/ignored.txt", "not markdown");
  put(dir, "references/nested.md/hidden.md", "not direct");
  const unordered = readdirSync(join(dir, "references")).sort().reverse();
  vi.mocked(readdirSync).mockReturnValueOnce(unordered as unknown as ReturnType<typeof readdirSync>);
  expect(skillCorpus(dir)).toBe("skill bytes\n\nfirst bytes\n\nmiddle bytes\nlast bytes");
});

test("test: the host law swept over a skill directory reports a herdr command under a universal heading of a reference file by that file even when the skill file ends inside an On herdr scope, and accepts the same command under an On herdr heading of the reference with an adjacent On Orca sibling, so a sweep of the skill file alone or one that carries the skill file's last scope into a reference fails", () => {
  const dir = scratch();
  put(dir, "SKILL.md", "## On Orca\nFiles.\n## On herdr\nherdr pane list");
  mkdirSync(join(dir, "references"));
  put(dir, "references/escaped.md", "### Universal\nherdr pane run <pane>");
  expect(hostViolations(readFileSync(join(dir, "SKILL.md"), "utf8"))).toEqual([]);
  // A lower-level universal heading would inherit the previous file's host if concatenated.
  expect(hostViolations(skillCorpus(dir))).toEqual([]);
  expect(skillDirViolations(dir)).toEqual(["references/escaped.md: line 2: herdr pane run <pane>"]);
  put(dir, "references/escaped.md", "## On herdr\nherdr pane run <pane>\n## On Orca\nFiles.");
  expect(skillDirViolations(dir)).toEqual([]);
  put(dir, "references/escaped.md", "## On herdr\nherdr pane run <pane>");
  expect(skillDirViolations(dir)).toEqual(["references/escaped.md: line 1: On herdr scope has no adjacent On Orca sibling"]);
});

test("test: a host reading of a skill directory reads each file under its own scopes, so a reference whose opening lines are universal is read on herdr, on Orca and on a plain host although the skill file ends inside an On Orca scope, while an On herdr scope of that reference is skipped on Orca, so a reading of the concatenated files fails", () => {
  const dir = scratch();
  put(dir, "SKILL.md", "Universal skill.\n## On herdr\nHerdr skill.\n## On Orca\nOrca skill.");
  mkdirSync(join(dir, "references"));
  put(dir, "references/reading.md", "Universal opening.\n## On herdr\nherdr pane list\n## On Orca\nOrca reference.");
  for (const host of ["herdr", "orca", "plain"] as const) {
    const reading = skillDirReading(dir, host);
    expect(reading, host).toContain("Universal opening.");
    expect(reading.includes("herdr pane list"), host).toBe(host === "herdr");
    expect(reading.includes("Orca skill."), host).toBe(host === "orca");
  }
  expect(skillReading(skillCorpus(dir), "plain")).not.toContain("Universal opening.");
  expect(skillReading(skillCorpus(dir), "herdr")).not.toContain("Universal opening.");
});

/** The release's closed move table, with both ends kept inside the section being moved. */
const moves = [
  ["pane-mechanics.md", "## Pane mechanics that bite\n", "## Supervision watcher\n"],
  ["watchers.md", "## Supervision watcher\n", "## Mission-end teardown"],
  ["specialist-pipeline.md", "## Specialist pipeline rules\n", "## Non-negotiable rules\n"],
  ["security-briefing.md", "## Briefing a seat to audit a security-shaped check", "## Evidence discipline"],
  ["evidence-discipline.md", "**Rot**\n", undefined],
  ["release-proof.md", "#### The release criterion, and the two clauses", "### Context is a supervised resource"],
  ["context-supervision.md", "### Context is a supervised resource", "### A GO has a deadline"],
] as const;

function movedOverseer(): { dir: string; original: string } {
  const dir = scratch();
  cpSync(join(ROOT, "skills/tickmarkr-overseer"), dir, { recursive: true, dereference: true });
  const original = skillCorpus(dir);
  mkdirSync(join(dir, "references"), { recursive: true });
  let skill = readFileSync(join(dir, "SKILL.md"), "utf8");
  for (const [file, start, end] of moves) {
    const from = skill.indexOf(start);
    if (from < 0) {
      // Once the release ships the split, the same test still checks its actual references.
      expect(readFileSync(join(dir, "references", file), "utf8"), file).toContain(start);
      continue;
    }
    const to = end === undefined ? skill.length : skill.indexOf(end, from + start.length);
    expect(to, file).toBeGreaterThan(from);
    const moved = skill.slice(from, to);
    put(dir, `references/${file}`, moved);
    skill = skill.slice(0, from) + skill.slice(to);
    expect(readFileSync(join(dir, `references/${file}`), "utf8"), file).toBe(moved);
  }
  put(dir, "SKILL.md", skill);
  return { dir, original };
}

test("test: every file of each shipped skill directory and of each installed claude copy passes the herdr host law and the plain-host line sweep on its own, and a scratch copy of the overseer directory with each planned section moved verbatim into a reference keeps every original line in its corpus and passes both, while the same copy with a herdr command moved under a universal heading of a reference fails, so a split the sweeps cannot see fails", () => {
  for (const name of ["overseer", "loop", "auto"]) {
    const canonical = join(ROOT, "skills", `tickmarkr-${name}`);
    const installed = join(ROOT, ".claude/skills", `tickmarkr-${name}`);
    const dirs = [canonical];
    // The installed claude copy is absent from the exported tree; skip it by existence.
    if (existsSync(installed)) dirs.push(installed);
    for (const dir of dirs) {
      expect(skillDirViolations(dir), dir).toEqual([]);
      expect(plainFindings(dir), dir).toEqual([]);
    }
  }
  const { dir, original } = movedOverseer();
  const corpus = skillCorpus(dir);
  const counts = (text: string) => {
    const result = new Map<string, number>();
    for (const line of text.split("\n")) result.set(line, (result.get(line) ?? 0) + 1);
    return result;
  };
  const after = counts(corpus);
  for (const [line, count] of counts(original)) expect(after.get(line), line).toBeGreaterThanOrEqual(count);
  for (const [, start] of moves) expect(corpus).toContain(start);
  expect(skillDirViolations(dir)).toEqual([]);
  expect(plainFindings(dir)).toEqual([]);

  // Move the command out of its herdr scope into a universal reference, preserving its bytes.
  const owner = markdownFiles(dir).find(file => readFileSync(join(dir, file), "utf8").includes("`herdr pane list`"));
  expect(owner).toBeDefined();
  const source = readFileSync(join(dir, owner!), "utf8");
  put(dir, owner!, source.replace("`herdr pane list`", "the pane inventory"));
  put(dir, "references/universal-escape.md", "## Universal\n`herdr pane list`\n");
  expect(skillDirViolations(dir)).toContain("references/universal-escape.md: line 2: `herdr pane list`");
  expect(plainFindings(dir)).toContain("references/universal-escape.md: herdr-only token: `herdr pane list`");
});

test("the plain-host per-file sweep keeps every token and closed mandate check, including wrapped mandates", () => {
  for (const text of ["herdr agent wait", "orca terminal read --terminal <handle>",
    "the daemon-placed board is the live surface", "treat that as a daemon/run liveness fault",
    "interactive TUI, never headless", "say so and stop", "foreground `until\ngrep", "at most every\ntwenty minutes"]) {
    expect(plainLineFindings(text), text).not.toEqual([]);
    expect(plainLineFindings(`## On herdr\n${text}\n## On Orca\n${text}`), text).toEqual([]);
  }
  const dir = scratch();
  put(dir, "SKILL.md", "at most every");
  mkdirSync(join(dir, "references"));
  put(dir, "references/opening.md", "twenty minutes");
  expect(plainFindings(dir)).toEqual([]); // no impossible mandate assembled across files
  expect(plainLineFindings(skillCorpus(dir))).not.toEqual([]);
});

test("a skill directory reads installed markdown file symlinks and ignores a directory symlink in references", () => {
  const dir = scratch();
  put(dir, "SKILL.md", "skill");
  put(dir, "source.md", "Universal reference.");
  mkdirSync(join(dir, "references"));
  mkdirSync(join(dir, "nested"));
  put(dir, "nested/hidden.md", "ignored");
  symlinkSync("../source.md", join(dir, "references/installed.md"));
  symlinkSync("../nested", join(dir, "references/nested.md"), "dir");
  expect(skillCorpus(dir)).toBe("skill\nUniversal reference.");
  expect(skillDirViolations(dir)).toEqual([]);
  expect(plainFindings(dir)).toEqual([]);
});
