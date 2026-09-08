import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { dispatch } from "../src/cli/index.js";
import { status } from "../src/cli/commands/status.js";
import { report } from "../src/cli/commands/report.js";
import { resume } from "../src/cli/commands/resume.js";
import { ui } from "../src/cli/commands/ui.js";
import { saveGraph } from "../src/graph/graph.js";
import { Journal } from "../src/run/journal.js";
import { readOperatorState } from "../src/run/operator-state.js";
import { applyDecisionKey, decisionConfirmLines, decisionReceiptLines, deriveRunDecisions, executeDecision, initialDecisionSession, previewDecision, withDecisionPreview } from "../src/tui/cockpit/decision-actions.js";
import { complete, graph, partial, resumed } from "./fixtures/operator-state/fixture.js";

const repoRoot = join(import.meta.dirname, "..");
const readmeFile = join(repoRoot, "README.md");
const quickstartFile = join(repoRoot, "docs", "operator-quickstart.md");

describe("README steering documentation", () => {
  test("the readme names all three routing modes", () => {
    const readme = readFileSync(readmeFile, "utf8");
    expect(readme).toMatch(/partner-led/);
    expect(readme).toMatch(/risk-based/);
    expect(readme).toMatch(/staff-led/);
  });

  test("the readme documents the review prefer list", () => {
    const readme = readFileSync(readmeFile, "utf8");
    expect(readme).toMatch(/review\.prefer/);
    expect(readme).toMatch(/review\s+prefer/i);
  });

  test("the readme documents the consult prefer list", () => {
    const readme = readFileSync(readmeFile, "utf8");
    expect(readme).toMatch(/consult\.prefer/);
    expect(readme).toMatch(/consult\s+prefer/i);
  });

  test("the readme documents the supersedes rerun flag", () => {
    const readme = readFileSync(readmeFile, "utf8");
    expect(readme).toMatch(/--supersedes/);
  });

  test("the retired operator quickstart doc is absent", () => {
    expect(existsSync(quickstartFile)).toBe(false);
  });

  test("the readme states that consult prefer entries require an adapter colon model form", () => {
    const readme = readFileSync(readmeFile, "utf8");
    // Look for text that says consult prefer requires adapter:model
    expect(readme).toMatch(/consult.*prefer.*adapter:model/is);
  });

  test("the readme states that review prefer entries may name a bare adapter", () => {
    const readme = readFileSync(readmeFile, "utf8");
    // Look for text that says review prefer may name a bare adapter
    expect(readme).toMatch(/review.*prefer.*bare\s+adapter/is);
  });

  test("the readme names the fleet candidate picker", () => {
    const readme = readFileSync(readmeFile, "utf8");
    expect(readme).toMatch(/candidate\s+picker/i);
  });

  test("the readme fleet section documents the two-pane browser and its write key", () => {
    const readme = readFileSync(readmeFile, "utf8");
    // v1.92: the six-step wizard was replaced by the fleet browser — the README must name the
    // surface (views + rail) and the diff-confirm write path instead of counting steps.
    expect(readme).toMatch(/fleet browser/i);
    expect(readme).toMatch(/All models.*Shapes.*Steering/s);
    expect(readme).toMatch(/`w`.*diff|diff.*`w`/is);
    expect(readme).not.toMatch(/six\s+steps/i);
  });
});

test("Changed README and canonical skill prose walk the recorded partial-human-park case through Run confirmation, append receipt and explicit resume, then take a non-TTY reader to preserved status/report output and default-watch plain fallback using delivered flags. Review cites changed prose against actual command behavior. A deferred view advertised as shipped, approval described as dispatch or a help example mutating state fails.", async () => {
  // These are the shipped instructions being reviewed, not private design/capture dependencies.
  const docs = [readmeFile, join(repoRoot, "skills/tickmarkr-loop/SKILL.md")];
  for (const file of docs) {
    const prose = readFileSync(file, "utf8");
    for (const phrase of ["1 Home, 4 Run, 5 Evidence", "Fleet/Bootstrap and Plan/Health", "follow-ons",
      "1/3 merged", "T2", "T3", "PARTIAL", "before dispatch", "Only `y`", "Enter never confirms",
      "task-approved", "approved; resume required", "tickmarkr resume <runId>",
      "--watch --plain", "--decision-events", "--jsonl", "--view run", "--view evidence",
      "tickmarkr ui --setup <runId>", "report <runId> --md", "tickmarkr eval --help",
      "tickmarkr unlock --help", "tickmarkr profile reset --help"]) {
      expect(prose.replace(/\s+/g, " "), `${file}: ${phrase}`).toContain(phrase);
    }
    expect(prose).toMatch(/approval records permission/i);
    expect(prose).toMatch(/CURRENT TIP (?:is )?PENDING/);
    expect(prose).not.toMatch(/Approving records.*proceeds to merge/);
  }

  const root = mkdtempSync(join(tmpdir(), "tickmarkr-docs-walkthrough-"));
  const runId = "run-docs-partial";
  try {
    saveGraph(root, graph);
    const journal = Journal.create(root, runId);
    // The state-fold fixture omits routing fields; printed status expects the recorded assignment.
    const appendRecorded = (event: (typeof partial)[number]) => journal.append(event.event, event.taskId, {
      ...event.data,
      ...(event.event === "task-dispatch" ? { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" } } : {}),
    });
    for (const event of partial) appendRecorded(event);
    const read = () => readOperatorState({ events: journal.read(), graph });
    expect(read()).toMatchObject({ lifecycle: "PARTIAL", green: false, merged: 1, planned: 3,
      currentTip: "passed", buckets: { human: ["T2"], blocked: ["T3"] } });
    const selected = deriveRunDecisions(journal, graph).find(d => d.taskId === "T2")!;
    expect(selected).toMatchObject({ verbs: ["approve"], blocks: ["T3"], attempts: 0 });
    const before = journal.read();
    const menu = applyDecisionKey(initialDecisionSession(), { input: "a", key: {} }, selected);
    const picked = applyDecisionKey(menu.session, { input: "", key: { return: true } }, selected);
    expect(picked.open).toEqual({ verb: "approve", taskId: "T2" });
    const command = { ...picked.open!, reason: "ready to proceed" };
    const result = previewDecision(command, { cwd: root, runId, by: "operator" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.refusal);
    const confirm = decisionConfirmLines(result.preview).join("\n");
    expect(confirm).toContain(`tickmarkr approve ${runId} T2 --by operator --reason "ready to proceed"`);
    expect(confirm).toContain("#L5 human-gate");
    expect(confirm).toContain("recorded, not dispatched; resume required");
    const session = withDecisionPreview(picked.session, result);
    expect(applyDecisionKey(session, { input: "", key: { return: true } }, selected).confirm).toBeUndefined();
    for (const event of [{ input: "n", key: {} }, { input: "", key: { escape: true } }]) {
      expect(applyDecisionKey(session, event, selected).session.confirming).toBeNull();
    }
    expect(journal.read()).toEqual(before); // navigation, preview, Enter and cancel did not write
    const confirmed = applyDecisionKey(session, { input: "y", key: {} }, selected).confirm!;
    const receipt = await executeDecision(confirmed, { cwd: root }); // authoritative approve + read-back
    expect(receipt).toMatchObject({ ok: true, appended: { line: 8, event: {
      event: "task-approved", taskId: "T2", data: { by: "operator", reason: "ready to proceed" },
    } } });
    const receiptText = decisionReceiptLines(receipt).join("\n");
    expect(receiptText).toContain("#L8 task-approved T2");
    expect(receiptText).toContain(`tickmarkr resume ${runId}`);
    expect(receiptText).toContain("permission recorded, no work dispatched, nothing green");
    expect(read()).toMatchObject({ green: false, label: "approved; resume required", merged: 1 });
    expect(journal.read().filter(e => e.event === "task-dispatch")).toEqual(before.filter(e => e.event === "task-dispatch"));
    expect((await executeDecision(confirmed, { cwd: root })).ok).toBe(false); // no double append
    expect(journal.read()).toHaveLength(8);

    // A real resume preflight refusal must leave permission outstanding, without dispatching.
    const configPath = join(root, ".tickmarkr/config.yaml");
    writeFileSync(configPath, "routing:\n  deny:\n    adapters: [cursor-agent, codex]\n  map:\n    implement:\n      prefer: [cursor-agent, codex]\n");
    await expect(resume([runId], root)).rejects.toThrow(/deny∩prefer/);
    expect(journal.read()).toHaveLength(8);
    expect(read().label).toBe("approved; resume required");
    rmSync(configPath);

    // Replay the exported recorded resume/complete transitions; never start a model-backed run.
    for (const event of resumed.slice(partial.length + 1)) appendRecorded(event);
    expect(read()).toMatchObject({ currentTip: "pending", green: false, merged: 1, planned: 3 });
    for (const event of complete.slice(resumed.length)) appendRecorded(event);
    expect(read()).toMatchObject({ green: true, lifecycle: "COMPLETE", merged: 3, planned: 3,
      buckets: { failed: [], human: [], blocked: [], pending: [] } });

    const oneLine = await status([runId, "--oneline"], root);
    expect(oneLine).toContain(runId);
    const printed = await status([runId], root);
    expect(printed).toContain("T2");
    const observationTime = Date.now();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    try {
      // Unbounded watch uses the real default entry branch. End at its first sleep; finally
      // disarms the observer and its timer. No process survives the test, and no UI is imported.
      const stopped = new Error("first watch frame read");
      const follow = async (plain: boolean) => {
        stdout.mockClear();
        await expect(status([runId, "--watch", ...(plain ? ["--plain"] : [])], root, {
          now: () => observationTime, sleep: async () => { throw stopped; },
        })).rejects.toBe(stopped);
        return stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
      };
      const defaultWatch = await follow(false);
      expect(defaultWatch).toContain(runId);
      expect(defaultWatch).not.toContain("\x1b[?1049h");
      expect(await follow(true)).toBe(defaultWatch);
      const watchOptions = { iterations: 1, now: () => observationTime };
      const events = await status([runId, "--watch", "--events"], root, watchOptions);
      expect(events.split("\n").filter(Boolean).map(line => JSON.parse(line)).length).toBeGreaterThan(0);
      for (const alias of ["--jsonl", "--decision-events"]) {
        expect(await status([runId, "--watch", alias], root, watchOptions)).toBe(events);
      }
    } finally {
      stdout.mockRestore();
      if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY); else delete process.stdin.isTTY;
      if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY); else delete process.stdout.isTTY;
    }
    const filesBefore = readdirSync(root, { recursive: true }).sort();
    expect(await report([runId], root)).toContain(runId);
    const md = await report([runId, "--md"], root);
    expect(md).toContain(runId);
    expect(md).toContain("#");
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(filesBefore); // Markdown is stdout
    expect(await ui([runId], { input: { isTTY: false } as NodeJS.ReadStream,
      output: { isTTY: false } as NodeJS.WriteStream }, root)).toMatchObject({ code: 1, out: expect.stringContaining("status --watch") });

    // Exercise the dispatcher, including dangerous-looking nested help, before real handlers.
    for (const [cmd, args] of [["ui", ["--help"]], ["eval", ["--help"]],
      ["unlock", ["--help"]], ["profile", ["reset", "--help"]]] as const) {
      let invoked = 0;
      const handlers = { [cmd]: async () => { invoked++; throw new Error("help invoked an action"); } };
      const help = await dispatch(cmd, [...args], handlers);
      expect(help).toMatchObject({ code: 0, out: expect.stringContaining(`usage: tickmarkr ${cmd}`) });
      expect(help.out).toContain("Show help without running the command.");
      expect(invoked).toBe(0);
      expect((await dispatch(cmd, ["--", "--help"], handlers)).code).toBe(1);
      expect(invoked).toBe(1); // literal data reaches dispatch; help before -- does not
    }
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(filesBefore);
    expect(journal.read().filter(e => e.event === "task-approved")).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
