import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { validateGraph } from "../../src/graph/schema.js";

const task = validateGraph({
  version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: ["a"] }],
}).tasks[0];

function makeFake(script: object): FakeAdapter {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-fake-"));
  const p = join(dir, "script.json");
  writeFileSync(p, JSON.stringify(script));
  return new FakeAdapter(p);
}

describe("FakeAdapter", () => {
  test("invoke runs scripted shell per attempt and emits trailer", () => {
    const fake = makeFake({
      tasks: { T1: [
        { shell: "echo attempt-one", result: { ok: false, summary: "flaked" } },
        { shell: "echo attempt-two", result: { ok: true, summary: "worked" } },
      ] },
    });
    const cwd = mkdtempSync(join(tmpdir(), "tickmarkr-fake-cwd-"));
    // the fake reads the run nonce from the prompt writePrompt handed it; simulate that prompt
    const promptFile = join(cwd, "T1-a0.md");
    writeFileSync(promptFile, 'TICKMARKR_RESULT_testnonce {"ok":true|false,...}');
    const a = { adapter: "fake", model: "fake-1", channel: "sub" as const, tier: "frontier" as const };
    const out1 = execSync(fake.invoke(task, cwd, a, { promptFile }).command, { cwd, encoding: "utf8" });
    expect(out1).toContain("attempt-one");
    expect(fake.parse(out1, "testnonce")).toMatchObject({ ok: false, summary: "flaked" });
    const out2 = execSync(fake.invoke(task, cwd, a, { promptFile }).command, { cwd, encoding: "utf8" });
    expect(fake.parse(out2, "testnonce")).toMatchObject({ ok: true, summary: "worked" });
  });

  test("headlessCommand serves canned judge/review/consult by prompt marker", () => {
    const fake = makeFake({ tasks: {}, judge: { pass: true, criteria: [] }, consult: { action: "human", notes: "n" } });
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-fake-p-"));
    const jp = join(dir, "j.md");
    writeFileSync(jp, "TICKMARKR-JUDGE\ncriteria...");
    expect(execSync(fake.headlessCommand(jp, "fake-1"), { encoding: "utf8" })).toContain('"pass": true');
    const cp = join(dir, "c.md");
    writeFileSync(cp, "TICKMARKR-CONSULT\ndossier...");
    expect(execSync(fake.headlessCommand(cp, "fake-1"), { encoding: "utf8" })).toContain('"action": "human"');
  });

  test("declares two vendors for the diversity rule", () => {
    const fake = makeFake({ tasks: {} });
    const vendors = new Set(fake.channels(undefined as never).map((c) => c.vendor));
    expect(vendors).toEqual(new Set(["fake-a", "fake-b"]));
  });

  test("probe records positive verdicts for every fake channel", async () => {
    const health = await makeFake({ tasks: {} }).probe();

    expect(health.modelAuth).toMatchObject({
      "fake-1": { authed: true },
      "fake-2": { authed: true },
    });
  });
});
