// T4: end-to-end regression for the scope flow — clarification refusal, compile-repair loop,
// judge-compat warning for untyped acceptance, and REQ-nn traceability. Every fixture is written to a
// temp dir inside the test (the scope.test.ts / daemon.test.ts idiom) so nothing is committed under
// tests/e2e/fixtures and the scope gate stays clean.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { scope as scopeCommand } from "../../src/cli/commands/scope.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { compileNative } from "../../src/compile/native.js";
import { tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { scopeIntent } from "../../src/plan/scope.js";
import { runDaemon } from "../../src/run/daemon.js";
import { COMMIT, makeRepo } from "../helpers/tmprepo.js";

// A drafted native spec (the shape scopeIntent produces) — two REQs, each traced to its own task.
const VALID_DRAFT = `<!-- tickmarkr:spec -->
# Export reports

## Requirements
- REQ-01: Export reports as JSON
- REQ-02: Log every export

## Assumptions
- Existing authorization rules apply

## Traceability
| Requirement | Tasks |
| --- | --- |
| REQ-01 | T1 |
| REQ-02 | T2 |

## T1: Export reports [REQ-01]
- goal: Export reports as JSON
- shape: implement
- files: src/reports.ts
- acceptance:
  - command: test -f src/reports.ts

## T2: Log every export [REQ-02]
- goal: Append one log line per export
- shape: implement
- files: src/logs.ts
- acceptance:
  - command: test -f src/logs.ts
`;

// Mechanical section extractor — independent of src/plan/scope.ts so the traceability assertion does
// not trust the same parser it is verifying.
function section(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^#{1,6}\\s+${name}\\s*$`, "i").test(l));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+.+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n");
}

function writeDraft(draft: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-scope-flow-compile-"));
  const file = join(dir, "draft.spec.md");
  writeFileSync(file, draft);
  return file;
}

function scopeFixture(draft: unknown) {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-scope-flow-"));
  const intentFile = join(repo, "reports.intent.md");
  const scriptFile = join(repo, "fake.json");
  writeFileSync(intentFile, `# Export reports

## Blocking questions
1. Which format?

## Answers
1. JSON
`);
  writeFileSync(scriptFile, JSON.stringify({ tasks: {}, judge: draft }));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.routing.map.spec = { pin: { via: "fake", model: "fake-1" } };
  return { repo, intentFile, cfg, fake: new FakeAdapter(scriptFile) };
}

describe("scope flow regression (fake adapter, zero tokens)", () => {
  test("repair loop: an intentionally broken first draft compiles on the first retry", async () => {
    const broken = VALID_DRAFT.replace("- acceptance:\n  - command: test -f src/reports.ts\n", "");
    const { repo, intentFile, cfg, fake } = scopeFixture([{ spec: broken }, { spec: VALID_DRAFT }]);
    const prompts: string[] = [];
    const headlessCommand = fake.headlessCommand.bind(fake);
    fake.headlessCommand = (promptFile, model) => {
      prompts.push(readFileSync(promptFile, "utf8"));
      return headlessCommand(promptFile, model);
    };

    const result = await scopeIntent(intentFile, repo, { cfg, adapters: [fake] });

    expect(result.attempts).toBe(2); // first retry after the broken first draft
    expect(result.tasks).toBe(2);
    // the repair feedback named the real compile error (missing acceptance) — not a blind retry
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/acceptance criteria are required/i);
    // the written spec compiles cleanly — the retry produced a valid draft
    const graph = compileNative(result.specFile);
    expect(graph.tasks).toHaveLength(2);
    expect(graph.tasks[0].acceptance).toEqual([{ oracle: "command", command: "test -f src/reports.ts" }]);
  });

  test("untyped acceptance strings warn at compile (judge-compat) and still execute end-to-end", async () => {
    const repo = makeRepo({ "base.txt": "base\n" });
    const specFile = join(repo, "feature.spec.md");
    writeFileSync(specFile, `<!-- tickmarkr:spec -->
# Feature

## T1: Ship the feature
- goal: ship the feature
- shape: implement
- files: src/feature.ts
- acceptance:
  - the feature works end to end
  - command: test -f src/feature.ts
`);

    // judge-compat warning fires at compile for the plain-string acceptance item
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const graph = compileNative(specFile);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/1 acceptance item.*is a plain string.*compiled as judge oracle/));
    warn.mockRestore();

    // the plain string is retained as a judge oracle (compat path), alongside the typed command oracle
    expect(graph.tasks[0].acceptance).toEqual([
      "the feature works end to end",
      { oracle: "command", command: "test -f src/feature.ts" },
    ]);

    // still executes: the compiled graph runs through the daemon and completes (judge oracle passes)
    saveGraph(repo, graph);
    const sdir = mkdtempSync(join(tmpdir(), "tickmarkr-scope-flow-script-"));
    const scriptPath = join(sdir, "s.json");
    writeFileSync(scriptPath, JSON.stringify({
      judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "diff adds src/feature.ts" }] },
      review: { approve: true, issues: [] },
      tasks: { T1: [{ shell: `mkdir -p src && echo ok > src/feature.ts && ${COMMIT} feature`, result: { ok: true, summary: "feature" } }] },
    }));
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "judge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1 }\n");
    const fake = new FakeAdapter(scriptPath);

    const s = await runDaemon(repo, { adapters: [fake], runId: "run-scope-flow-untyped" });
    expect(s.done).toEqual(["T1"]);
  });

  test("a drafted spec's REQ-nn ids each map to at least one task (asserted mechanically)", () => {
    const draft = VALID_DRAFT;

    // parse REQ-nn ids from the Requirements section only (not from titles or the trace table)
    const reqIds = [...new Set([...section(draft, "Requirements").matchAll(/\bREQ-\d{2}\b/g)].map((m) => m[0]))];
    expect(reqIds).toEqual(["REQ-01", "REQ-02"]);

    // the compiled graph's real task ids — the mapping target must exist, not just be any string
    const taskIds = compileNative(writeDraft(draft)).tasks.map((t) => t.id);

    // every REQ appears in the Traceability table on a row that names at least one real task id
    const traceRows = section(draft, "Traceability").split("\n").filter((l) => /\bREQ-\d{2}\b/.test(l));
    for (const req of reqIds) {
      const mappedRows = traceRows.filter((l) => l.includes(req));
      expect(mappedRows.length).toBeGreaterThanOrEqual(1);
      const mappedTasks = mappedRows.flatMap((l) => [...l.matchAll(/\bT\d+\b/g)].map((m) => m[0]));
      expect(mappedTasks.length).toBeGreaterThanOrEqual(1);
      expect(mappedTasks.every((id) => taskIds.includes(id))).toBe(true);
    }
  });

  test("the 3-question ceiling rejects a 4th blocking question at the CLI boundary", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-scope-flow-cli-"));
    const intentFile = join(repo, "reports.intent.md");
    writeFileSync(intentFile, `# Export reports

## Blocking questions
1. Which format?
2. Where are exports stored?
3. How long are they retained?
4. Who may export?

## Answers
1. JSON
`);
    // an unused fake script — the ceiling must reject before any adapter dispatch
    const scriptFile = join(repo, "fake.json");
    writeFileSync(scriptFile, JSON.stringify({ tasks: {}, judge: { spec: VALID_DRAFT } }));
    const fake = new FakeAdapter(scriptFile);

    // isolate from the operator's real global config (loadConfig is the CLI entry's first call)
    const oldXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(repo, "xdg");
    try {
      await expect(scopeCommand(["reports.intent.md"], repo, [fake])).rejects.toThrow(/at most 3 blocking questions/i);
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
    }
    // nothing was written — the gate refused before drafting
    expect(readFileSync(intentFile, "utf8")).toMatch(/4\. Who may export\?/);
  });
});
