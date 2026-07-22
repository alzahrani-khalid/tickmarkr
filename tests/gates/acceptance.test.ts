import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq } from "../../src/adapters/types.js";
import { acceptanceGate } from "../../src/gates/acceptance.js";
import * as llm from "../../src/gates/llm.js";
import { extractJson, runHeadless } from "../../src/gates/llm.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

const task = validateGraph({
  version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: ["greets by name"] }],
}).tasks[0];

const twoCriteria = validateGraph({
  version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{ id: "T2", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: ["first", "second"] }],
}).tasks[0];

function fakeWithJudge(judge: unknown): FakeAdapter {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-judge-"));
  const p = join(dir, "s.json");
  writeFileSync(p, JSON.stringify({ tasks: {}, judge }));
  return new FakeAdapter(p);
}

function fakeWithRawJudge(judge: unknown): FakeAdapter {
  const fake = fakeWithJudge(judge);
  fake.headlessCommand = () => `printf %s ${shq(JSON.stringify(judge))}`;
  return fake;
}

function repoWithDiff(): { repo: string; base: string } {
  const repo = makeRepo({ "greet.js": "module.exports = () => 'hi';\n" });
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "greet.js"), "module.exports = (n) => `hi ${n}`;\n");
  execSync("git add -A && git commit -m greet --no-gpg-sign", { cwd: repo });
  return { repo, base };
}

describe("extractJson", () => {
  test("fenced block, bare object, garbage", () => {
    expect(extractJson('noise\n```json\n{"a":1}\n```\ntail')).toEqual({ a: 1 });
    expect(extractJson('prose {"pass":true,"criteria":[]} more')).toEqual({ pass: true, criteria: [] });
    expect(extractJson("no json here")).toBeNull();
  });
});

describe("runHeadless", () => {
  test("routes prompt file through adapter.headlessCommand", async () => {
    const fake = fakeWithJudge({ pass: true, criteria: [] });
    const out = await runHeadless(fake, "fake-1", "TICKMARKR-JUDGE\njudge this", "/tmp");
    expect(out).toContain('"pass"');
  });
});

describe("acceptanceGate", () => {
  test("a verdict covering every criterion id exactly once with all met parses as a pass", async () => {
    const { repo, base } = repoWithDiff();
    const fake = fakeWithJudge({ pass: true, criteria: [{ criterion: "c1", met: true, reason: "uses n" }] });
    const r = await acceptanceGate(task, repo, base, { adapter: fake, model: "fake-1" });
    expect(r).toMatchObject({ gate: "acceptance", pass: true });
    expect(r.details).toContain("c1");
  });

  test("failing verdict → fail listing unmet criteria", async () => {
    const { repo, base } = repoWithDiff();
    const fake = fakeWithJudge({ pass: false, criteria: [{ criterion: "c1", met: false, reason: "hardcoded" }] });
    const r = await acceptanceGate(task, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(false);
    expect(r.details).toContain("hardcoded");
  });

  test("a verdict omitting a criterion id fails closed", async () => {
    const { repo, base } = repoWithDiff();
    const fake = fakeWithRawJudge({ pass: true, criteria: [] });
    const r = await acceptanceGate(task, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/missing criterion id c1/i);
    expect(r.meta?.unparseable).toBeUndefined();
  });

  test("a verdict whose overall pass contradicts an unmet item fails closed", async () => {
    const { repo, base } = repoWithDiff();
    const fake = fakeWithRawJudge({ pass: true, criteria: [{ criterion: "c1", met: false, reason: "missing" }] });
    const r = await acceptanceGate(task, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/pass=true contradicts unmet criterion c1/i);
    expect(r.meta?.unparseable).toBeUndefined();
  });

  test("a verdict with fewer criteria than judge items fails naming the missing id", async () => {
    const { repo, base } = repoWithDiff();
    const fake = fakeWithRawJudge({ pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] });
    const r = await acceptanceGate(twoCriteria, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/missing criterion id c2/i);
    expect(r.meta?.unparseable).toBeUndefined();
  });

  test("a verdict with a duplicate criterion id fails closed", async () => {
    const { repo, base } = repoWithDiff();
    const fake = fakeWithRawJudge({
      pass: true,
      criteria: [
        { criterion: "c1", met: true, reason: "ok" },
        { criterion: "c1", met: true, reason: "dup" },
      ],
    });
    const r = await acceptanceGate(twoCriteria, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/duplicate criterion id c1/i);
    expect(r.details).toMatch(/missing criterion id c2/i);
    expect(r.meta?.unparseable).toBeUndefined();
  });

  test("a verdict with an unknown criterion id fails closed", async () => {
    const { repo, base } = repoWithDiff();
    const fake = fakeWithRawJudge({
      pass: true,
      criteria: [{ criterion: "c9", met: true, reason: "bogus" }],
    });
    const r = await acceptanceGate(task, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/unknown criterion id c9/i);
    expect(r.details).toMatch(/missing criterion id c1/i);
    expect(r.meta?.unparseable).toBeUndefined();
  });

  test("a verdict with a non-string reason fails closed", async () => {
    const { repo, base } = repoWithDiff();
    const fake = fakeWithRawJudge({
      pass: true,
      criteria: [{ criterion: "c1", met: true, reason: 42 }],
    });
    const r = await acceptanceGate(task, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/malformed verdict shape/i);
    expect(r.meta?.unparseable).toBeUndefined();
  });

  test("verdict with more items than criteria fails closed even when all met=true", async () => {
    const { repo, base } = repoWithDiff();
    const multiClause = validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T3", title: "t", goal: "g", shape: "implement", complexity: 3,
        acceptance: [{ oracle: "judge", text: "clause one; clause two; clause three" }] }],
    }).tasks[0];
    const fake = fakeWithRawJudge({
      pass: true,
      criteria: [
        { criterion: "c1", met: true, reason: "ok" },
        { criterion: "c2", met: true, reason: "ok" },
        { criterion: "c3", met: true, reason: "ok" },
      ],
    });
    const r = await acceptanceGate(multiClause, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/unknown criterion id c2/i);
    expect(r.meta?.unparseable).toBeUndefined();
  });

  test("the judge prompt renders each criterion with its stable id", async () => {
    const { repo, base } = repoWithDiff();
    let capturedPrompt = "";
    const fake = fakeWithJudge({
      pass: true,
      criteria: [
        { criterion: "c1", met: true, reason: "ok" },
        { criterion: "c2", met: true, reason: "ok" },
      ],
    });
    const orig = fake.headlessCommand.bind(fake);
    fake.headlessCommand = (promptFile, model) => {
      capturedPrompt = readFileSync(promptFile, "utf8");
      return orig(promptFile, model);
    };
    await acceptanceGate(twoCriteria, repo, base, { adapter: fake, model: "fake-1" });
    expect(capturedPrompt).toContain("[c1] first");
    expect(capturedPrompt).toContain("[c2] second");
  });

  test("the acceptance judge invocation uses a 900000ms timeout", async () => {
    const { repo, base } = repoWithDiff();
    const spy = vi.spyOn(llm, "runLlm").mockImplementation(async (_a, _m, prompt) => {
      const n = llm.extractPromptNonce(prompt)!;
      return JSON.stringify({ nonce: n, pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] });
    });
    await acceptanceGate(task, repo, base, { adapter: fakeWithJudge({}), model: "fake-1" });
    expect(spy).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), undefined, 900_000,
    );
    spy.mockRestore();
  });

  test("diff over the configured cap fails closed before any judge call", async () => {
    const { repo, base } = repoWithDiff();
    const fake = fakeWithRawJudge({ pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] });
    const command = fake.headlessCommand.bind(fake);
    let calls = 0;
    fake.headlessCommand = (...args) => { calls++; return command(...args); };
    const opts = { testCmd: undefined, diffCap: 1 };
    const r = await acceptanceGate(task, repo, base, { adapter: fake, model: "fake-1" }, undefined, opts);
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/diff exceeds verifiable cap/i);
    expect(r.details).toMatch(/split the task/i);
    expect(r.details).toMatch(/raise gates\.diffCap/i);
    expect(r.meta).toEqual({ park: "human" });
    expect(calls).toBe(0);
  });

  test("unparseable judge output fails closed", async () => {
    const { repo, base } = repoWithDiff();
    const fake = fakeWithJudge("not an object at all");
    const r = await acceptanceGate(task, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/unparseable/i);
  });

  // v1.19 (T1, still true under T2): a typed {oracle:"judge"} item renders into the judge prompt via
  // the same shared helper as the worker prompt (no [object Object]). Under T2 judge items are the ONLY
  // thing rendered — deterministic oracles run mechanically and never reach the prompt.
  test("typed judge acceptance items render into the judge prompt without breaking the gate", async () => {
    const { repo, base } = repoWithDiff();
    const fake = fakeWithJudge({ pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] });
    const typedTask = validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T9", title: "t", goal: "g", shape: "implement", complexity: 3,
        acceptance: [{ oracle: "judge", text: "reads nice" }] }],
    }).tasks[0];
    const r = await acceptanceGate(typedTask, repo, base, { adapter: fake, model: "fake-1" });
    expect(r).toMatchObject({ gate: "acceptance", pass: true });
    expect(r.details).toContain("c1");
  });
});

// v1.19 (T2): deterministic command/test oracles run mechanically, fail-closed, BEFORE any LLM judge
// dispatch. A judge verdict can never override a failed command/test. Named-test oracles filter the
// detected test runner via -t. Only-judge tasks warn.
describe("acceptanceGate — deterministic oracles (T2)", () => {
  const task = (acceptance: unknown[]) => validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "TD", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance }],
  }).tasks[0];

  // judge would fail-closed IF consulted: a pass here proves it never ran (zero LLM calls).
  const noCall = () => fakeWithJudge("DEFINITELY NOT JSON");

  test("command oracle exits non-zero → fails before any LLM judge dispatch", async () => {
    const { repo, base } = repoWithDiff();
    const r = await acceptanceGate(task([{ oracle: "command", command: "printf 'boom\\n' >&2; exit 7" }]), repo, base, { adapter: noCall(), model: "fake-1" });
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/exit 7/);
    expect(r.details).toContain("boom"); // stderr tail surfaced as context
    expect(r.details).not.toMatch(/unparseable/i); // judge never ran
  });

  test("command oracle exits zero → passes with zero LLM calls", async () => {
    const { repo, base } = repoWithDiff();
    const r = await acceptanceGate(task([{ oracle: "command", command: "true" }]), repo, base, { adapter: noCall(), model: "fake-1" });
    expect(r.pass).toBe(true);
    expect(r.details).toMatch(/exit 0/);
    expect(r.details).not.toMatch(/unparseable/i);
  });

  test("only deterministic oracles (command + test) → passes with zero LLM calls; test named in details", async () => {
    const { repo, base } = repoWithDiff();
    const r = await acceptanceGate(
      task([{ oracle: "command", command: "true" }, { oracle: "test", test: "greets by name" }]),
      repo, base, { adapter: noCall(), model: "fake-1" }, undefined,
      { testCmd: `bash -c 'printf "%s\\n" "      Tests  1 passed | 0 skipped (1)"'` },
    );
    expect(r.pass).toBe(true);
    expect(r.details).toContain("greets by name");
    expect(r.details).not.toMatch(/unparseable/i);
  });

  test("test oracle fails → names the test + exit code, fail-closed, zero LLM calls", async () => {
    const { repo, base } = repoWithDiff();
    const r = await acceptanceGate(
      task([{ oracle: "test", test: "greets by name" }]),
      repo, base, { adapter: noCall(), model: "fake-1" }, undefined, { testCmd: "false" },
    );
    expect(r.pass).toBe(false);
    expect(r.details).toContain("greets by name");
    expect(r.details).toMatch(/exit/);
    expect(r.details).not.toMatch(/unparseable/i);
  });

  test("test oracle with no testCmd configured → fails closed naming the test", async () => {
    const { repo, base } = repoWithDiff();
    const r = await acceptanceGate(
      task([{ oracle: "test", test: "greets" }]),
      repo, base, { adapter: fakeWithJudge({ pass: true, criteria: [] }), model: "fake-1" },
    );
    expect(r.pass).toBe(false);
    expect(r.details).toContain("greets");
  });

  test("a passing judge can never override a failed deterministic oracle", async () => {
    const { repo, base } = repoWithDiff();
    const fake = fakeWithJudge({ pass: true, criteria: [] }); // a judge that WOULD pass
    const r = await acceptanceGate(
      task([{ oracle: "command", command: "exit 1" }, { oracle: "judge", text: "looks nice" }]),
      repo, base, { adapter: fake, model: "fake-1" },
    );
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/exit 1/);
    expect(r.details).not.toMatch(/judge passed/);
  });

  test("deterministic passes THEN judge runs — details carry both, no only-judge warning", async () => {
    const { repo, base } = repoWithDiff();
    const fake = fakeWithJudge({ pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] });
    const r = await acceptanceGate(
      task([{ oracle: "command", command: "true" }, { oracle: "judge", text: "reads nice" }]),
      repo, base, { adapter: fake, model: "fake-1" },
    );
    expect(r.pass).toBe(true);
    expect(r.details).toMatch(/exit 0/);       // deterministic line present
    expect(r.details).toContain("c1"); // judge line present
    expect(r.details).not.toMatch(/warning/i); // not only-judge → no warning
  });
});

// v1.64 gate-integrity: adversarial rubric — the judge prompt carries the completion-faking checklist,
// every criterion row must quote diff evidence, and a quote the judged diff doesn't contain is a
// hallucinated verdict (treated as unparseable → GATE-09 failover retry).
describe("acceptanceGate — adversarial judge rubric (v1.64)", () => {
  test("the acceptance judge prompt names the completion faking shortcuts as an explicit checklist", async () => {
    const { repo, base } = repoWithDiff();
    let capturedPrompt = "";
    const fake = fakeWithJudge({ pass: true, criteria: [] });
    const orig = fake.headlessCommand.bind(fake);
    fake.headlessCommand = (promptFile, model) => {
      capturedPrompt = readFileSync(promptFile, "utf8");
      return orig(promptFile, model);
    };
    await acceptanceGate(task, repo, base, { adapter: fake, model: "fake-1" });
    expect(capturedPrompt).toContain("Completion-faking checklist");
    for (const shortcut of ["hardcoded-result", "test-weakening", "vacuous-assertion", "fixture-overfit", "self-mocking", "check-bypass"]) {
      expect(capturedPrompt).toContain(shortcut);
    }
    // the checklist instructs the verdict to name which shortcut a failed criterion matches
    expect(capturedPrompt).toMatch(/criterion fails.*name which shortcut/i);
    // the response format demands the per-criterion structured-citation evidence field
    expect(capturedPrompt).toContain('"evidence"');
    expect(capturedPrompt).toMatch(/structured citation/i);
    expect(capturedPrompt).toContain('"line"');
  });

  test("a judge verdict quoting evidence present in the diff parses and its verdict stands", async () => {
    const { repo, base } = repoWithDiff();
    // evidence is a verbatim slice of the committed change in repoWithDiff
    const ok = fakeWithRawJudge({ pass: true, criteria: [{ criterion: "c1", met: true, reason: "greets by name", evidence: "module.exports = (n) =>" }] });
    const r1 = await acceptanceGate(task, repo, base, { adapter: ok, model: "fake-1" });
    expect(r1).toMatchObject({ gate: "acceptance", pass: true });
    expect(r1.meta?.unparseable).toBeUndefined();
    // a failing verdict with genuine evidence stands too — the parsed verdict decides
    const bad = fakeWithRawJudge({ pass: false, criteria: [{ criterion: "c1", met: false, reason: "hardcoded-result shortcut", evidence: "module.exports = (n) =>" }] });
    const r2 = await acceptanceGate(task, repo, base, { adapter: bad, model: "fake-1" });
    expect(r2.pass).toBe(false);
    expect(r2.details).toContain("hardcoded-result");
    expect(r2.meta?.unparseable).toBeUndefined();
  });

  test("a judge verdict whose quoted evidence is absent from the diff fails closed", async () => {
    // the bystander file exists in the worktree but never changes: quoting it proves the check runs
    // against the diff the judge received, not the worktree or any other artifact
    const repo = makeRepo({ "greet.js": "module.exports = () => 'hi';\n", "bystander.txt": "untouched worktree text\n" });
    const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    writeFileSync(join(repo, "greet.js"), "module.exports = (n) => 'hi ' + n;\n");
    execSync("git add -A && git commit -m greet --no-gpg-sign", { cwd: repo });
    const fake = fakeWithRawJudge({ pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok", evidence: "untouched worktree text" }] });
    const r = await acceptanceGate(task, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/evidence absent from the judged diff/i);
    expect(r.details).toContain("c1");
    // treated as unparseable: GATE-09 retries the judge on a failover channel off this meta
    expect(r.meta).toMatchObject({ unparseable: true, judge: "fake:fake-1" });
  });

  test("a judge verdict missing the evidence field entirely fails closed", async () => {
    const { repo, base } = repoWithDiff();
    // spy bypasses the fake adapter's zero-token evidence-injection seam: the gate itself must reject
    const spy = vi.spyOn(llm, "runLlm").mockImplementation(async (_a, _m, prompt) => {
      const n = llm.extractPromptNonce(prompt)!;
      return JSON.stringify({ nonce: n, pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] });
    });
    const r = await acceptanceGate(task, repo, base, { adapter: fakeWithJudge({}), model: "fake-1" });
    spy.mockRestore();
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/malformed verdict shape/i);
  });

  test("an empty evidence string fails closed like an absent quote", async () => {
    const { repo, base } = repoWithDiff();
    // every diff contains the empty string — a vacuous quote must not slip through includes()
    const fake = fakeWithRawJudge({ pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok", evidence: "  " }] });
    const r = await acceptanceGate(task, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(false);
    expect(r.meta).toMatchObject({ unparseable: true });
  });

  test("existing passing and failing judge verdict fixtures keep their outcomes under the extended schema", async () => {
    const { repo, base } = repoWithDiff();
    // pre-v1.64 fixtures carry no evidence field — the fake seam quotes the diff for them, so the
    // whole zero-token suite keeps its outcomes while real judges face the strict schema
    const pass = await acceptanceGate(task, repo, base,
      { adapter: fakeWithJudge({ pass: true, criteria: [{ criterion: "c1", met: true, reason: "uses n" }] }), model: "fake-1" });
    expect(pass).toMatchObject({ gate: "acceptance", pass: true });
    const fail = await acceptanceGate(task, repo, base,
      { adapter: fakeWithJudge({ pass: false, criteria: [{ criterion: "c1", met: false, reason: "hardcoded" }] }), model: "fake-1" });
    expect(fail.pass).toBe(false);
    expect(fail.details).toContain("hardcoded");
    expect(fail.meta?.unparseable).toBeUndefined();
    const inconsistent = await acceptanceGate(task, repo, base,
      { adapter: fakeWithRawJudge({ pass: true, criteria: [{ criterion: "c1", met: false, reason: "contradiction" }] }), model: "fake-1" });
    expect(inconsistent.pass).toBe(false);
    expect(inconsistent.details).toMatch(/pass=true contradicts unmet criterion c1/i);
  });
});

// v1.70 evidence-comparison T1: evidence is a structured {path, line} citation checked against the
// diff's actual changed hunks — a citation to an untouched file or an unchanged line fails closed, and
// a met criterion with no citation at all is malformed shape (the same failure a missing field is today).
describe("acceptanceGate — evidence-addressed citation (v1.70)", () => {
  test("a verdict citing a file and line genuinely changed in the judged diff is accepted as valid evidence for that criterion", async () => {
    const { repo, base } = repoWithDiff(); // repoWithDiff rewrites greet.js line 1 — cite that added line
    const fake = fakeWithRawJudge({ pass: true, criteria: [{ criterion: "c1", met: true, reason: "uses n", evidence: { path: "greet.js", line: 1 } }] });
    const r = await acceptanceGate(task, repo, base, { adapter: fake, model: "fake-1" });
    expect(r).toMatchObject({ gate: "acceptance", pass: true });
    expect(r.meta?.unparseable).toBeUndefined();
  });

  test("a verdict citing a file untouched by the judged diff is rejected as fabricated evidence rather than accepted", async () => {
    // bystander.txt exists in the repo but the committed diff only touches greet.js
    const repo = makeRepo({ "greet.js": "module.exports = () => 'hi';\n", "bystander.txt": "one\ntwo\nthree\n" });
    const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    writeFileSync(join(repo, "greet.js"), "module.exports = (n) => 'hi ' + n;\n");
    execSync("git add -A && git commit -m greet --no-gpg-sign", { cwd: repo });
    const fake = fakeWithRawJudge({ pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok", evidence: { path: "bystander.txt", line: 1 } }] });
    const r = await acceptanceGate(task, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/evidence absent from the judged diff/i);
    expect(r.details).toContain("c1");
    expect(r.meta).toMatchObject({ unparseable: true });
  });

  test("a verdict citing a line outside every changed hunk of a file that was otherwise touched is rejected rather than accepted", async () => {
    // a 20-line file; only line 10 changes, so git's 3-line context hunk covers ~7..13 — line 1 is
    // in the diff's file but outside every changed hunk
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const repo = makeRepo({ "big.txt": lines });
    const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    writeFileSync(join(repo, "big.txt"), lines.replace("line 10\n", "line 10 CHANGED\n"));
    execSync("git add -A && git commit -m edit --no-gpg-sign", { cwd: repo });
    const fake = fakeWithRawJudge({ pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok", evidence: { path: "big.txt", line: 1 } }] });
    const r = await acceptanceGate(task, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/evidence absent from the judged diff/i);
    expect(r.meta).toMatchObject({ unparseable: true });
  });

  test("a criterion marked met with no citation at all fails the same way a malformed verdict shape fails today", async () => {
    const { repo, base } = repoWithDiff();
    // spy bypasses the fake seam's evidence injection: a met criterion returned with NO evidence field
    const spy = vi.spyOn(llm, "runLlm").mockImplementation(async (_a, _m, prompt) => {
      const n = llm.extractPromptNonce(prompt)!;
      return JSON.stringify({ nonce: n, pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] });
    });
    const r = await acceptanceGate(task, repo, base, { adapter: fakeWithJudge({}), model: "fake-1" });
    spy.mockRestore();
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/malformed verdict shape/i);
    expect(r.meta?.unparseable).toBeUndefined();
  });
});

describe("acceptanceGate — only-judge warning (T2)", () => {
  test("only judge oracles → warning in details; judge verdict still decides", async () => {
    const { repo, base } = repoWithDiff();
    const fake = fakeWithJudge({ pass: true, criteria: [{ criterion: "c1", met: true, reason: "uses n" }] });
    const r = await acceptanceGate(task, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(true);
    expect(r.details).toMatch(/warning/i);
  });

  test("only judge oracles + unparseable verdict → fails closed (today's behavior preserved)", async () => {
    const { repo, base } = repoWithDiff();
    const fake = fakeWithJudge("not an object at all");
    const r = await acceptanceGate(task, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/unparseable/i);
    expect(r.meta).toMatchObject({ unparseable: true });
  });
});
