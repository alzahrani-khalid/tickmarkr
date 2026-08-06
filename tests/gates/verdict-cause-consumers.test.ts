import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import {
  buildTaskPrompt,
  NO_TRAILER_SUMMARY,
  UNPARSEABLE_TRAILER_SUMMARY,
} from "../../src/adapters/prompt.js";
import { DEFAULT_CONFIG, type TickmarkrConfig } from "../../src/config/config.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import { acceptanceGate } from "../../src/gates/acceptance.js";
import { classifyVerdictCause } from "../../src/gates/verdict-cause.js";
import { validateGraph } from "../../src/graph/schema.js";
import * as consultModule from "../../src/run/consult.js";
import { consult, type Dossier } from "../../src/run/consult.js";
import { makeRepo } from "../helpers/tmprepo.js";

const classifierControl = vi.hoisted(() => ({
  forcedCause: undefined as "empty-output" | "no-verdict" | "malformed-verdict" | undefined,
}));

vi.mock("../../src/gates/verdict-cause.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/gates/verdict-cause.js")>();
  return {
    ...actual,
    classifyVerdictCause: vi.fn((raw: string, nonce: string, discriminator: "approve" | "pass" | "ok" | "action") =>
      classifierControl.forcedCause ?? actual.classifyVerdictCause(raw, nonce, discriminator)),
  };
});

const task = validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{
    id: "T1", title: "verdict causes", goal: "separate silence from malformed answers",
    shape: "implement", complexity: 3, files: ["src/work.ts"], acceptance: ["works"],
  }],
}).tasks[0];

const dossier: Dossier = {
  taskId: "T1",
  trigger: "gate-fail",
  journalTail: "[]",
  transcript: "worker output",
  diff: "diff",
  gates: [],
};

class VerdictPane implements ExecutorDriver {
  id = "verdict-pane";
  interactive = false;
  private nonce = "";

  constructor(private readonly output: (nonce: string) => string) {}

  async slot(cwd: string, name: string): Promise<Slot> { return { id: name, name, cwd }; }
  async run(): Promise<void> {}
  async waitOutput(_slot: Slot, pattern: string): Promise<boolean> {
    this.nonce = /TICKMARKR_EXIT_([0-9a-f]+):/.exec(pattern)?.[1] ?? "";
    return true;
  }
  async waitAgentStatus(): Promise<boolean> { return true; }
  async status(): Promise<"unknown"> { return "unknown"; }
  async read(): Promise<string> { return this.output(this.nonce); }
  async notify(): Promise<void> {}
  async close(): Promise<void> {}
  async worktree(): Promise<string> { return ""; }
}

class PromptCapturingFake extends FakeAdapter {
  readonly prompts: string[] = [];

  override headlessCommand(promptFile: string, model: string): string {
    this.prompts.push(readFileSync(promptFile, "utf8"));
    return super.headlessCommand(promptFile, model);
  }
}

function fake(): PromptCapturingFake {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-verdict-consumers-"));
  const script = join(dir, "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {} }));
  return new PromptCapturingFake(script);
}

function repoWithCommit(): { repo: string; base: string } {
  const repo = makeRepo({ "src/work.ts": "export const value = 1;\n" });
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "src/work.ts"), "export const value = 2;\n");
  execSync("git add -A && git commit -m work --no-gpg-sign", { cwd: repo });
  return { repo, base };
}

function consultSetup(output: (nonce: string) => string): {
  cfg: TickmarkrConfig;
  adapter: PromptCapturingFake;
  driver: ExecutorDriver;
  runDir: string;
} {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.visibility.llm = "pane";
  cfg.consult = { adapter: "fake", model: "fake-1", stallMinutes: 15 };
  return {
    cfg,
    adapter: fake(),
    driver: new VerdictPane(output),
    runDir: mkdtempSync(join(tmpdir(), "tickmarkr-verdict-consult-")),
  };
}

async function judge(output: (nonce: string) => string) {
  const { repo, base } = repoWithCommit();
  const adapter = fake();
  const result = await acceptanceGate(task, repo, base, { adapter, model: "fake-1" }, {
    driver: new VerdictPane(output),
    name: "judge-cause",
  });
  return { result, prompt: adapter.prompts.at(-1) ?? "" };
}

async function runConsult(output: (nonce: string) => string) {
  const setup = consultSetup(output);
  const result = await consult(dossier, setup.cfg, [setup.adapter], setup.driver, "/tmp", setup.runDir);
  return { result, prompt: setup.adapter.prompts.at(-1) ?? "" };
}

async function parseWorkerThroughSharedClassifier(raw: string, nonce: string) {
  // FakeAdapter imports prompt.ts during static test collection. Reload the worker boundary only after
  // the verdict-cause mock is registered so this proves the production module import, not an injected seam.
  vi.resetModules();
  const promptModule = await import("../../src/adapters/prompt.js");
  const verdictCauseModule = await import("../../src/gates/verdict-cause.js");
  return {
    result: promptModule.parseWorkerResult(raw, nonce),
    classify: vi.mocked(verdictCauseModule.classifyVerdictCause),
  };
}

afterEach(() => {
  classifierControl.forcedCause = undefined;
  vi.mocked(classifyVerdictCause).mockClear();
});

describe("verdict-cause consumers", () => {
  test("one shared classifier serves every boundary, proven member by member over the closed set of callers — a judge caller whose prompt requests the pass key, a consult caller whose prompt requests the action key, and a worker-trailer caller whose prompt requests the ok key — each returning the classifier's cause rather than a locally computed verdict, and each witness built from the key that boundary's own prompt asks for rather than from a key the fixture chose", async () => {
    const judgeRun = await judge((nonce) => `{"nonce":"${nonce}","pass":false, definitely-not-json`);
    expect(judgeRun.prompt).toContain('"pass": true|false');
    expect(judgeRun.result.meta?.cause).toBe("malformed-verdict");

    const consultRun = await runConsult((nonce) => `{"nonce":"${nonce}","action":"retry", definitely-not-json`);
    expect(consultRun.prompt).toContain('"action": "retry" | "reroute" | "decompose" | "human"');
    const parseConsultVerdict = (consultModule as typeof consultModule & {
      parseConsultVerdict?: (raw: string, nonce: string) => { verdict: unknown; cause?: string };
    }).parseConsultVerdict;
    expect(parseConsultVerdict).toBeTypeOf("function");
    expect(parseConsultVerdict!(`{"nonce":"c011ca11","action":"retry", broken`, "c011ca11").cause)
      .toBe("malformed-verdict");

    const workerPrompt = buildTaskPrompt(task, "", "a11ce209");
    expect(workerPrompt).toContain('{"ok":true|false');
    const workerRun = await parseWorkerThroughSharedClassifier(
      'TICKMARKR_RESULT_a11ce209 {"pass":false, broken',
      "a11ce209",
    );
    expect(workerRun.result.cause).toBe("malformed-verdict");
    expect(workerRun.classify).toHaveBeenCalledWith(
      expect.stringContaining('"ok":false,'),
      "a11ce209",
      "ok",
    );

    expect(vi.mocked(classifyVerdictCause).mock.calls.map((call) => call[2]))
      .toEqual(expect.arrayContaining(["pass", "action"]));
  });

  test("no boundary re-implements the rule, proven by each caller failing when the shared classifier is stubbed to a different cause", async () => {
    classifierControl.forcedCause = "no-verdict";

    const judgeRun = await judge((nonce) => `{"nonce":"${nonce}","pass":false, broken`);
    expect(judgeRun.result.meta?.cause).toBe("no-verdict");
    expect(judgeRun.result.details).toMatch(/judge dispatch failed/i);

    const consultResult = consultModule.parseConsultVerdict(
      '{"nonce":"c011ca11","action":"retry", broken',
      "c011ca11",
    );
    expect(consultResult.verdict).toBeNull();
    expect(consultResult.cause).toBe("no-verdict");
    const consultRun = await runConsult((nonce) => `{"nonce":"${nonce}","action":"retry", broken`);
    expect(consultRun.result).toEqual({
      action: "human",
      notes: "consult verdict unparseable — failing safe to human",
    });

    const workerRun = await parseWorkerThroughSharedClassifier(
      'TICKMARKR_RESULT_a11ce209 {"ok":false, broken',
      "a11ce209",
    );
    expect(workerRun.result.cause).toBe("no-verdict");
    expect(workerRun.result.summary).toBe(NO_TRAILER_SUMMARY);

    const workerWithoutToken = await parseWorkerThroughSharedClassifier(
      "the worker's actual output bytes",
      "a11ce209",
    );
    expect(workerWithoutToken.classify).toHaveBeenCalledWith(
      "the worker's actual output bytes",
      "a11ce209",
      "ok",
    );
  });

  test("a malformed answer returns the exact fail-closed result each boundary returns today, pinned per boundary rather than described as a policy, proven member by member over the closed set of boundaries — a judge fixture returning pass false with meta.unparseable, a consult fixture returning null, and a worker-trailer fixture returning its UNPARSEABLE-trailer sentinel rather than its absent-token sentinel, which are two deliberately different constants", async () => {
    const judgeRun = await judge((nonce) => `{"nonce":"${nonce}","pass":false, broken`);
    expect(judgeRun.result.pass).toBe(false);
    expect(judgeRun.result.meta?.unparseable).toBe(true);
    expect(judgeRun.result.details).toContain("judge output unparseable — failing closed");

    const parseConsultVerdict = (consultModule as typeof consultModule & {
      parseConsultVerdict?: (raw: string, nonce: string) => { verdict: unknown; cause?: string };
    }).parseConsultVerdict;
    expect(parseConsultVerdict).toBeTypeOf("function");
    const consultResult = parseConsultVerdict!(
      '{"nonce":"c011ca11","action":"retry", broken',
      "c011ca11",
    );
    expect(consultResult.verdict).toBeNull();
    expect(consultResult.cause).toBe("malformed-verdict");
    const consultRun = await runConsult((nonce) => `{"nonce":"${nonce}","action":"retry", broken`);
    expect(consultRun.result).toEqual({
      action: "human",
      notes: "consult verdict unparseable — failing safe to human",
    });

    const worker = (await parseWorkerThroughSharedClassifier(
      'TICKMARKR_RESULT_a11ce209 {"ok":false, broken',
      "a11ce209",
    )).result;
    expect(worker.ok).toBe(false);
    expect(worker.summary).toBe(UNPARSEABLE_TRAILER_SUMMARY);
    expect(worker.summary).not.toBe(NO_TRAILER_SUMMARY);
  });

  test("a verdict that PARSED and was rejected on its CONTENT is never classified as silence, proven member by member over the closed set of parsed-content rejections currently conflated with no response — a judge verdict citing evidence absent from the judged diff, and a consult verdict whose action is outside the permitted set — each keeping the exact fail-closed result it returns today and each distinguishable from a boundary that never spoke", async () => {
    const fabricated = await judge((nonce) => JSON.stringify({
      nonce,
      pass: true,
      criteria: [{
        criterion: "c1", met: true, reason: "invented", evidence: { path: "src/work.ts", line: 999 },
      }],
    }));
    expect(fabricated.result).toMatchObject({
      gate: "acceptance",
      pass: false,
      meta: { unparseable: true },
    });
    expect(fabricated.result.details).toMatch(/evidence absent from the judged diff/i);
    expect(fabricated.result.meta?.cause).toBeUndefined();

    const unknownActionParse = consultModule.parseConsultVerdict(
      JSON.stringify({ nonce: "c011ca11", action: "dance" }),
      "c011ca11",
    );
    expect(unknownActionParse).toEqual({ verdict: null });
    const unknownAction = await runConsult((nonce) => JSON.stringify({ nonce, action: "dance" }));
    expect(unknownAction.result).toEqual({
      action: "human",
      notes: "consult verdict unparseable — failing safe to human",
    });

    const silentJudge = await judge((nonce) => `TICKMARKR_EXIT_${nonce}:0`);
    expect(silentJudge.result.meta?.cause).toBe("no-verdict");
    expect(silentJudge.result.details).toMatch(/judge dispatch failed/i);

    const silentConsult = consultModule.parseConsultVerdict("TICKMARKR_EXIT_c011ca11:0", "c011ca11");
    expect(silentConsult.verdict).toBeNull();
    expect(silentConsult.cause).toBe("no-verdict");
    const silentConsultRun = await runConsult((nonce) => `TICKMARKR_EXIT_${nonce}:0`);
    expect(silentConsultRun.result).toEqual({
      action: "human",
      notes: "consult verdict unparseable — failing safe to human",
    });
    expect(silentConsult).not.toEqual(unknownActionParse);
    expect(silentConsultRun.result).toEqual(unknownAction.result);
  });
});
