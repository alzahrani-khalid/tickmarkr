// Queue row 339; D-2181 D6: closing a waived check that was fixed later is taught by the loop green rule, the
// overseer waive-debt paragraph and the README, read through both skill trees and every host's scoped reading.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { skillDirReading, skillDirViolations } from "./helpers/skill-reading.js";

const HOSTS = ["herdr", "orca", "app", "plain"] as const;
// The installed twins are private: the public export excludes .claude, so the .claude/skills tree is read, and its
// bytes compared, only where it exists — the same guard as tests/skills-single-source.test.ts and
// tests/skills-herdr-app.test.ts. The canonical skills/ tree is asserted in every context (row 339; D-2185 add.32).
const installedRoot = fileURLToPath(new URL("../.claude/skills", import.meta.url));
const TREES: string[] = ["skills"];
if (existsSync(installedRoot)) TREES.push(".claude/skills");
const SKILLS = ["loop", "overseer"] as const;
const skillDir = (tree: string, skill: string) => fileURLToPath(new URL(`../${tree}/tickmarkr-${skill}`, import.meta.url));
const flat = (text: string) => text.replace(/\s+/g, " ");

/** The four recipe steps, in order, then the scope-red and closure clauses every surface must carry. */
const RECIPE = [
  "create a branch at the owed head with `git switch -c <branch> <owed head>`",
  "commit the in-scope fix there",
  "run `tickmarkr verify --record <runId> --task <T> --base <owed base> --supersede <check> --author <who wrote the fix>` on that branch",
  "then merge that branch into the integration branch",
];
const CLAUSES = [
  "queue row 339; D-2181",
  "The fixing HEAD must contain the owed range",
  "green independent battery",
  "later integration merges carries their files and is scope-red by design",
  "`outstanding 0`",
  "a broader or non-containing hand fix",
  "never widen the task's files",
];

/** Assert the recipe and clauses sit inside [from, to) of the reading; returns that slice. */
function assertRecipe(reading: string, from: string, to: string, label: string): string {
  const text = flat(reading);
  const start = text.indexOf(from), end = text.indexOf(to, start + 1);
  expect(start, `${label}: ${from}`).toBeGreaterThanOrEqual(0);
  expect(end, `${label}: ${to}`).toBeGreaterThan(start);
  const span = text.slice(start, end);
  let at = -1;
  for (const step of RECIPE) {
    const next = span.toLowerCase().indexOf(step.toLowerCase(), at + 1);
    expect(next, `${label}: recipe step in order: ${step}`).toBeGreaterThan(at);
    at = next;
  }
  for (const clause of CLAUSES) expect(span.toLowerCase(), `${label}: ${clause}`).toContain(clause.toLowerCase());
  expect(span, `${label}: the waive never closes debt`).toMatch(/never by the waive itself or an unverified fix|the waive itself never closes the debt and neither does an unverified fix/);
  return span;
}

const GREEN_RULE = [
  "A run is green only when ALL of these hold: the run-end event exists in the journal and is not fatal, tip verify is not \"failed\"",
  "AND the owed checks in CURRENT `tickmarkr status <runId>` are outstanding empty AND known (`outstanding 0`; `outstanding unknown` is never empty)",
  "Read the debt from CURRENT status, never from the run-end record: a `tickmarkr verify --record <runId>` discharge that lands after run-end moves current status to `outstanding 0`",
  "a legacy waiver without a recorded obligation reads `outstanding unknown` and is never green",
  "A fatal run-end is never green either",
  "Never report green to the operator, tab titles, or records until every clause holds",
];

describe("later-fix supersede guidance (queue row 339; D-2181 D6)", () => {
  test("both loop skill trees teach the owed head branch fix verify merge recipe under the unchanged green rule", () => {
    for (const tree of TREES) for (const host of HOSTS) {
      const label = `${tree} loop ${host}`;
      const reading = flat(skillDirReading(skillDir(tree, "loop"), host));
      for (const clause of GREEN_RULE) expect(reading, `${label}: ${clause}`).toContain(clause);
      // The recipe follows the unchanged green rule inside the same verify-and-consolidate step, before the
      // integration-branch sign-off sentence, and ordinary discharge stays documented beside it.
      const span = assertRecipe(reading, "Never report green to the operator", "Tickmarkr consolidates accepted task work", label);
      expect(span, `${label}: closure read from current status`).toContain("a historical run-end row never closes it");
      expect(span, `${label}: ordinary discharge kept`).toContain("Ordinary `tickmarkr verify --record <runId>` discharge of the original work is unchanged");
    }
    // Control: the checker is an instance of what it catches — a reading that lets the waive close debt fails.
    const reading = flat(skillDirReading(skillDir("skills", "loop"), "plain"));
    const mutant = reading.replace("never by the waive itself or an unverified fix", "by the waive");
    expect(() => assertRecipe(mutant, "Never report green to the operator", "Tickmarkr consolidates accepted task work", "mutant")).toThrow();
    const reordered = reading.replace("then merge that branch into the integration branch", "").replace("create a branch at the owed head", "then merge that branch into the integration branch; create a branch at the owed head");
    expect(() => assertRecipe(reordered, "Never report green to the operator", "Tickmarkr consolidates accepted task work", "reordered")).toThrow();
  });

  test("both overseer skill trees teach the owed head branch fix verify merge recipe through every host scoped reading while preserving executed waiver evidence", () => {
    const evidence = [
      "A waive is funded by EXECUTED evidence, never by a static read.",
      "Only an executed read backs a waive.",
      "The waive keeps its park and gate binding and its debt: CURRENT `tickmarkr status <runId>` reads `outstanding 1 (T2 review)` until `tickmarkr verify --record <runId>` discharges it.",
      "OOB: executed — `<reproduction>` at <task-head-sha>: exit 0, log <path>",
      "funds no waive: the ruling is uphold or recheck.",
    ];
    for (const tree of TREES) {
      expect(skillDirViolations(skillDir(tree, "overseer")), `${tree} overseer host law`).toEqual([]);
      for (const host of HOSTS) {
        const label = `${tree} overseer ${host}`;
        const reading = flat(skillDirReading(skillDir(tree, "overseer"), host));
        for (const line of evidence) expect(reading, `${label}: ${line}`).toContain(line);
        // Inside the waive-debt paragraph: after the executed-evidence law, before the record example.
        assertRecipe(reading, "A waive is funded by EXECUTED evidence", "Record example:", label);
      }
    }
  });

  test("the user reference teaches the owed head branch fix verify merge recipe beside ordinary discharge while the touched skill trees remain byte identical", () => {
    const readme = flat(readFileSync(new URL("../README.md", import.meta.url), "utf8"));
    const discharge = "That run completes only when `tickmarkr verify --record <runId>` discharges the check and CURRENT status reads `outstanding 0`";
    expect(readme).toContain(discharge);
    expect(readme).toContain("Historical GATES RAN does not establish current completion.");
    const span = assertRecipe(readme, discharge, "The CLI twin for the same decision is", "README");
    expect(span).toContain("`--author` is required on this path and names who wrote the fix");
    expect(span).toContain("superseded rather than discharged");
    if (existsSync(installedRoot)) {
      for (const skill of SKILLS) {
        const [canonical, installed] = TREES.map((tree) => readFileSync(`${skillDir(tree, skill)}/SKILL.md`));
        expect(installed!.equals(canonical!), `${skill}: skills/ and .claude/skills/ SKILL.md bytes`).toBe(true);
      }
    }
  });
});
