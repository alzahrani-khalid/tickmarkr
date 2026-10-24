import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { skillReading } from "./helpers/skill-reading.js";

const skills = ["overseer", "loop", "auto"].map(name => ({ name, markdown: readFileSync(new URL(`../skills/tickmarkr-${name}/SKILL.md`, import.meta.url), "utf8") }));
const teardown = (text: string, host: "orca" | "herdr") => {
  const reading = skillReading(text, host);
  const start = reading.indexOf("## Mission-end teardown");
  const end = reading.indexOf("\n## ", start + 3);
  return start < 0 ? "" : reading.slice(start, end < 0 ? undefined : end);
};

// Queue row 240; D-2138 add.1 R3, add.4: read the recipe a host can actually reach, not a
// command hidden in the other host's scope. Wrong recipes must fail the same reader.
function closeFindings(text: string, host: "orca" | "herdr"): string[] {
  const t = teardown(text, host), out: string[] = [];
  const required = host === "orca" ? [
    "Before every close, first match the spawn record against the live tab title and checkout",
    "orca terminal list --include-visual-layouts --json",
    "spawn record's address is the leaf handle", "live TAB title", "layout\n  worktree and terminal row",
    "orca terminal close --terminal <handle> --json", "with the recorded handle",
    "result.close.handle", "equal to that handle", "live-terminal refusal",
    "error.code:runtime_error", "error.message:tab_not_found",
    "handle absent from `orca terminal list --json` AND its owned tab absent",
    "orca terminal list --include-visual-layouts --json` after its final terminal closes",
    "same\n  runtime as the pre-close listing",
  ] : [
    "Before every close, first match the spawn record against the live tab title and checkout",
    "herdr pane list", "recorded address equals `pane_id`", "recorded title equals `label`",
    "recorded checkout equals `cwd`", "herdr pane close <pane>", "recorded address",
    "Prove the pane absent", "herdr tab close <tab>", "recorded tab id", "prove the tab absent from `herdr tab list`",
  ];
  for (const phrase of required) if (!t.includes(phrase)) out.push(phrase);
  if (host === "orca" && /herdr (pane|tab) (list|close)/.test(t)) out.push("escaped herdr recipe");
  return out;
}

test("test: an Orca reading of each shipped skill, following every universal scope and every scope headed On Orca, reaches a mission-end teardown that first matches the seat's spawn record against the live tab title and checkout, then closes it by its recorded handle with the terminal close command and proves the close by a receipt naming that handle or the documented refusal for a live terminal, by the handle's absence from the terminal list and by its owned tab's absence from the visual layout, and a herdr reading reaches the pane close and tab close commands behind the same ownership check, so a supervisor told to close a seat with no command, no ownership check or no tab proof fails", () => {
  for (const { name, markdown } of skills) {
    expect(closeFindings(markdown, "orca"), name).toEqual([]);
    expect(closeFindings(markdown, "herdr"), name).toEqual([]);
    for (const host of ["orca", "herdr"] as const) {
      const command = host === "orca" ? "orca terminal close --terminal <handle> --json" : "herdr pane close <pane>";
      for (const [remove, replace] of [[command, "close this seat"],
        ["Before every close, first match the spawn record against the live tab title and checkout", "Close on its bare address"],
        [host === "orca" ? "AND its owned tab absent" : "prove the tab absent from `herdr tab list`", ""]]) {
        const wrong = markdown.replaceAll(remove, replace);
        expect(wrong, `${name} mutant`).not.toBe(markdown);
        expect(closeFindings(wrong, host), `${name}: ${remove}`).not.toEqual([]);
      }
    }
    const t = teardown(markdown, "orca");
    expect(t.indexOf("Before every close")).toBeLessThan(t.indexOf("orca terminal close --terminal"));
    expect(t.indexOf("orca terminal close --terminal")).toBeLessThan(t.indexOf("handle absent from"));
  }
});

function retirementFindings(markdown: string, host: "orca" | "herdr", driver: boolean): string[] {
  const t = teardown(markdown, host), out = closeFindings(markdown, host);
  for (const phrase of [
    "The spawner closes the seat it created", "artifact and terminal marker are on disk", "stand-down is read back",
    "no\nnext mission is named", "next mission named and a `/clear` at the mission boundary",
    "Keep the latest settled consult round only while the mission continues", "same close or reuse rule",
    "ORCH's artifact is the execution record", "<!-- tickmarkr:orch-end <runId> -->",
    "supervisor reads exactly that record and that run's marker", "host", "address", "title", "checkout", "mission",
    "spawn ledger", "one `key=value` per line", "pids/<seat>.stood-down", "mission=<mission>",
    "rewrite the ledger's `mission`", "delete the old stood-down file BEFORE", "require its mission to equal the ledger's current mission",
    "A mismatch closes nothing", "Never close a tab you did not create", "recycled handle", "operator's terminal",
    "seat matched by title alone", "own launching terminal", "read-only re-resolution by title and checkout",
    "never close the replacement by title", "never rewrite ownership from a title-only match",
  ]) if (!t.includes(phrase)) out.push(phrase);
  if (driver) {
    const reading = skillReading(markdown, host);
    const start = reading.indexOf("## Stand-down (mission end and retirement)");
    const stand = reading.slice(start, reading.indexOf("\n## ", start + 3));
    for (const phrase of ["Append its named terminal marker BEFORE the record commit", `printf '\\n<!-- tickmarkr:orch-end %s -->\\n' "<runId>" >> "<execution-record>"`, "Verify the final line is `<!-- tickmarkr:orch-end <runId> -->`", "then commit that record", "After that stand-down, write", "supervisor reads back the stand-down and exactly that execution record's end marker"]) {
      if (!stand.includes(phrase)) out.push(phrase);
    }
  }
  return out;
}

test("test: every host reading of that teardown closes a seat only once its artifact and terminal marker are on disk, its stand-down is read back and no next mission is named for it, keeps a reused seat only with its next mission named and a clear at the boundary, keeps the latest settled consult round while the mission continues and applies the same close or reuse rule to it at mission end, re-resolves a mismatched or stale Orca handle by title only to read, and never closes a tab it did not create, a recycled handle now showing an operator's terminal, a seat matched by title alone or its own launching terminal, while the loop and auto stand-down sections append the named end marker to the execution record before its commit and their supervisor closes the retired orchestrator at its recorded address with the named command only once exactly that record carries that marker, so a teardown keyed on titles, on a bare handle, on a done signal or on a marker nothing writes fails", () => {
  for (const { name, markdown } of skills) for (const host of ["orca", "herdr"] as const) {
    const driver = name !== "overseer";
    expect(retirementFindings(markdown, host, driver), `${name}/${host}`).toEqual([]);
    for (const remove of ["artifact and terminal marker are on disk", "stand-down is read back",
      "next mission named and a `/clear` at the mission boundary", "only while the mission continues",
      "read-only re-resolution by title and checkout", "Never close a tab you did not create",
      "recycled handle", "seat matched by title alone", "own launching terminal",
      "require its mission to equal the ledger's current mission", "<!-- tickmarkr:orch-end <runId> -->"]) {
      expect(retirementFindings(markdown.replaceAll(remove, "missing"), host, driver), `${name}/${host}: ${remove}`).not.toEqual([]);
    }
    if (driver) {
      expect(retirementFindings(markdown.replace("printf '\\n<!-- tickmarkr:orch-end %s -->\\n'", "echo done"), host, true), "marker nothing writes").not.toEqual([]);
      expect(retirementFindings(markdown.replace("BEFORE the record commit", "AFTER the record commit"), host, true), "marker after commit").not.toEqual([]);
    }
  }
});
