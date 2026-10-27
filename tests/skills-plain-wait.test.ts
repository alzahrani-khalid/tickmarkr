// Queue rows 262 and 265a (D-2163): read the shipped instructions through the plain-host route.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { skillReading } from "./helpers/skill-reading.js";

const SKILLS = ["loop", "auto", "overseer"] as const;
const PLAIN = "On a plain host (neither herdr nor Orca)";
const INSTALL = "claude plugin install tickmarkr --marketplace alzahrani-khalid/tickmarkr";
const LEGACY_WATCHER = '  `n=$(wc -l < <journal>); until tail -n +$((n + 1)) <journal> | grep -qE \'"event":"(run-end|task-human|task-failed|consult-verdict)"\' || ! kill -0 <pid>; do sleep 20; done`';
const readSkill = (name: string) => readFileSync(new URL(`../skills/tickmarkr-${name}/SKILL.md`, import.meta.url), "utf8");
const readme = () => readFileSync(new URL("../README.md", import.meta.url), "utf8");

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const end = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, end < 0 ? undefined : end);
}

function assertWait(markdown: string): void {
  const reading = skillReading(markdown, "plain");
  const scope = section(reading, PLAIN);
  const wait = scope.match(/^- \*\*Run-end and parks[\s\S]*?(?=^- |$\n## )/m)?.[0] ?? "";
  expect(wait).toContain("`tickmarkr wait <runId>`");
  expect(wait).toContain("Start the wait as a background task whose exit wakes this session");
  expect(wait).toContain("never a foreground wait past");
  expect(wait).toContain("ten-minute tool cap");
  for (const [code, cause] of [[0, "run end"], [3, "park"], [4, "failed task"], [5, "daemon death"], [6, "timeout"]] as const) {
    expect(wait).toContain(`${code} = ${cause}`);
  }
  expect(wait).toContain("Re-arm with `tickmarkr wait <runId> --after <line>`");
  expect(wait).toContain("`<line>` is the journal line reported by the waiter");
  expect(wait).toContain("CURRENT `tickmarkr status <runId>` first, then re-arm");
  expect(scope).not.toMatch(/\bMonitor\b/);
  expect(reading).not.toMatch(/n=\$\(wc -l|until\s+(?:tail|grep)\b/);
  expect(scope).toContain("status --watch --plain");
  expect(scope).toContain("Reviews and judges run headless");
}

test("test: a plain-host reading of each of the three shipped skills finds the background wait started as tickmarkr wait with the run id, each exit code's cause and the re-arm after a journal line, and finds no hand-typed journal loop and no Monitor wake, so a skill still teaching the until loop fails", () => {
  for (const name of SKILLS) {
    const markdown = readSkill(name);
    assertWait(markdown);
    const watcher = section(markdown, PLAIN).split("\n").find(line => line.startsWith("  `tickmarkr wait <runId>`"))!;
    const mutants = [
      markdown.replace(watcher, LEGACY_WATCHER),
      markdown.replace(watcher, "  Use `Monitor` to wake this session."),
      markdown.replace(watcher, "") + `\n## On herdr\n${watcher}\n## On Orca\n${watcher}\n`,
      markdown.replaceAll("background task", "foreground task"),
      markdown.replaceAll("tickmarkr wait <runId>", "tickmarkr wait <pid>"),
      markdown.replace("--after <line>", "--after 0"),
      ...["0 = run end", "3 = park", "4 = failed task", "5 = daemon death", "6 = timeout"]
        .map(cause => markdown.replace(cause, "cause omitted")),
    ];
    for (const mutant of mutants) {
      expect(mutant, name).not.toBe(markdown);
      expect(() => assertWait(mutant), name).toThrow();
    }
  }
});

function assertPlugin(text: string): void {
  const prose = text.replace(/\s+/g, " ");
  expect(prose).toContain(`\`${INSTALL}\``);
  expect(prose).toContain("Claude Desktop");
  expect(prose).toMatch(/Plugins → Add marketplace \(`alzahrani-khalid\/tickmarkr`\) → Add plugin \(`tickmarkr`\)/);
  expect(prose).toContain("`/tickmarkr-board` pane");
  expect(prose).toContain("session-start waiter");
}

function assertReadme(markdown: string): void {
  const scope = section(markdown, "Claude Code and Claude Desktop");
  assertPlugin(scope);
  const prose = scope.replace(/\s+/g, " ");
  expect(prose).toContain("Enabling the plugin runs `tickmarkr wait --timeout 23h` as a background task at every session start and resume");
  expect(prose).toContain("loads the board module (`hooks/board/register.tsx`); both execute with the user's permissions");
  expect(prose).toContain("`skills/` stays the single source for the plugin and installed skills");
}

test("test: each shipped skill's plain-host section and the README name the plugin install command with the public marketplace and the Claude Desktop path, and the README section states that the plugin runs the wait command at session start and loads the board with the user's permissions, so a release hiding that execution fails", () => {
  for (const name of SKILLS) {
    const markdown = readSkill(name);
    assertPlugin(section(skillReading(markdown, "plain"), PLAIN));
    for (const text of [INSTALL, "Add marketplace", "Add plugin", "/tickmarkr-board", "session-start waiter"]) {
      const mutant = markdown.replace(text, "OMITTED");
      expect(() => assertPlugin(section(skillReading(mutant, "plain"), PLAIN)), `${name}: ${text}`).toThrow();
    }
  }
  const markdown = readme();
  assertReadme(markdown);
  const scope = section(markdown, "Claude Code and Claude Desktop");
  for (const text of [INSTALL, "Add marketplace", "Add plugin", "/tickmarkr-board", "session-start waiter",
    "tickmarkr wait --timeout 23h", "every session start", "and resume", "loads the board module", "both execute with the user's\npermissions", "single source"]) {
    const mutant = markdown.replace(scope, scope.replace(text, "OMITTED"));
    expect(mutant, text).not.toBe(markdown);
    expect(() => assertReadme(mutant), text).toThrow();
  }
});

test("Cite the replaced watcher line in each of the three plain-host sections, versus a diff that edits an On herdr or On Orca scope", () => {
  // BASE watcher lines: loop:52, auto:63, overseer:157. Hash the whole original file with only
  // that line masked; removing the new plugin bullet must restore every other byte, including
  // both host scopes, preflight, the green rule and the general blocking-consumer guidance.
  const baseline = {
    loop: "b4c1209a87cf38df8aa8f6a8a2a073ebffc9f982a3ca6459dff54e5ad456b7fa",
    auto: "ffbbe2567b02018a00f38b31ad27c53c2d85ade4301c0ed04c62a5d22143a925",
    overseer: "48923fc6926df8582dba0e170d6e6da6db9f840d673dfdc70c5496846973b58b",
  };
  for (const name of SKILLS) {
    const markdown = readSkill(name);
    const scope = section(markdown, PLAIN);
    const watcher = scope.split("\n").filter(line => line.startsWith("  `tickmarkr wait <runId>`"));
    expect(watcher, name).toHaveLength(1);
    expect(scope).not.toContain(LEGACY_WATCHER);
    const plugin = scope.match(/^- \*\*Optional Claude plugin:\*\*[^\n]*\n(?:  [^\n]*\n)*/gm) ?? [];
    expect(plugin, name).toHaveLength(1);
    assertPlugin(plugin[0]);
    const unchanged = markdown.replace(watcher[0], "  <PLAIN_HOST_WAITER>").replace(plugin[0], "");
    expect(createHash("sha256").update(unchanged).digest("hex"), name).toBe(baseline[name]);
  }
});
