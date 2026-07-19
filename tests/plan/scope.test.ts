import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { scope as scopeCommand } from "../../src/cli/commands/scope.js";
import { COMMANDS, USAGE } from "../../src/cli/index.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { compileNative } from "../../src/compile/native.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { clarificationGate, scopeIntent } from "../../src/plan/scope.js";
import { scopePrompt } from "../../src/plan/prompt.js";

const VALID_DRAFT = `<!-- tickmarkr:spec -->
# Export reports

## Requirements
- REQ-01: Export reports as JSON

## Assumptions
- Existing authorization rules apply

## Traceability
| Requirement | Tasks |
| --- | --- |
| REQ-01 | T1 |

## T1: Export reports [REQ-01]
- goal: Export reports as JSON
- shape: implement
- files: src/reports.ts
- acceptance:
  - command: npm test
`;

function fixture(draft: unknown) {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-scope-test-"));
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

describe("scope clarification gate", () => {
  test("returns only unanswered blocking questions and rejects a fourth", () => {
    const intent = `# Export reports

## Blocking questions
1. Which format?
2. Where should exports be stored?
3. How long should they be retained?

## Answers
1. JSON
`;

    expect(clarificationGate(intent)).toEqual([
      "Where should exports be stored?",
      "How long should they be retained?",
    ]);
    expect(() => clarificationGate(intent.replace("## Answers", "4. Who may export?\n\n## Answers"))).toThrow(/at most 3 blocking questions/i);
  });
});

describe("scope drafting", () => {
  test("the scope gate prompt begins with TICKMARKR-SCOPE", () => {
    expect(scopePrompt("# Intent")).toMatch(/^TICKMARKR-SCOPE/);
    expect(scopePrompt("# Intent")).toContain("<!-- tickmarkr:spec -->");
  });

  test("rejects a legacy-marked draft", async () => {
    const legacy = ["dro", "vr"].join("");
    const { repo, intentFile, cfg, fake } = fixture({ spec: VALID_DRAFT.replace("tickmarkr", legacy) });

    await expect(scopeIntent(intentFile, repo, { cfg, adapters: [fake] })).rejects.toThrow(/tickmarkr native marker/);
  });

  test("routes a token-free draft through the fake adapter and writes a compiled native spec", async () => {
    const { repo, intentFile, cfg, fake } = fixture({ spec: VALID_DRAFT });

    const result = await scopeIntent(intentFile, repo, { cfg, adapters: [fake] });

    expect(result).toMatchObject({ attempts: 1, tasks: 1 });
    expect(result.specFile).toBe(join(repo, "reports.spec.md"));
    expect(readFileSync(result.specFile, "utf8")).toBe(VALID_DRAFT);
    expect(compileNative(result.specFile).tasks[0].acceptance).toEqual([{ oracle: "command", command: "npm test" }]);
  });

  test("accepts the fake adapter's JSON-string draft shape", async () => {
    const { repo, intentFile, cfg, fake } = fixture(VALID_DRAFT);

    const result = await scopeIntent(intentFile, repo, { cfg, adapters: [fake] });

    expect(result.attempts).toBe(1);
    expect(readFileSync(result.specFile, "utf8")).toBe(VALID_DRAFT);
  });

  test("feeds compile errors into one repair call before writing", async () => {
    const broken = VALID_DRAFT.replace("- acceptance:\n  - command: npm test\n", "");
    const { repo, intentFile, cfg, fake } = fixture([{ spec: broken }, { spec: VALID_DRAFT }]);
    const prompts: string[] = [];
    const headlessCommand = fake.headlessCommand.bind(fake);
    fake.headlessCommand = (promptFile, model) => {
      prompts.push(readFileSync(promptFile, "utf8"));
      return headlessCommand(promptFile, model);
    };

    const result = await scopeIntent(intentFile, repo, { cfg, adapters: [fake] });

    expect(result.attempts).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/acceptance criteria are required/i);
    expect(readFileSync(result.specFile, "utf8")).toBe(VALID_DRAFT);
  });

  test("stops after two repair retries and leaves no partial spec", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missingAcceptance = VALID_DRAFT.replace("- acceptance:\n  - command: npm test\n", "");
    const untypedAcceptance = VALID_DRAFT.replace("command: npm test", "npm test");
    const missingMapping = VALID_DRAFT.replace("| REQ-01 | T1 |", "| REQ-01 | none |");
    const { repo, intentFile, cfg, fake } = fixture([
      { spec: missingAcceptance },
      { spec: untypedAcceptance },
      { spec: missingMapping },
    ]);
    const prompts: string[] = [];
    const headlessCommand = fake.headlessCommand.bind(fake);
    fake.headlessCommand = (promptFile, model) => {
      prompts.push(readFileSync(promptFile, "utf8"));
      return headlessCommand(promptFile, model);
    };

    await expect(scopeIntent(intentFile, repo, { cfg, adapters: [fake] })).rejects.toThrow(/REQ-01 is not mapped/);

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toMatch(/acceptance criteria are required/i);
    expect(prompts[2]).toMatch(/untyped acceptance item/i);
    expect(existsSync(join(repo, "reports.spec.md"))).toBe(false);
    warn.mockRestore();
  });

  test("refuses to overwrite before dispatch unless forced", async () => {
    const { repo, intentFile, cfg, fake } = fixture({ spec: VALID_DRAFT });
    const specFile = join(repo, "reports.spec.md");
    writeFileSync(specFile, "operator-authored\n");
    let calls = 0;
    const headlessCommand = fake.headlessCommand.bind(fake);
    fake.headlessCommand = (promptFile, model) => {
      calls++;
      return headlessCommand(promptFile, model);
    };

    await expect(scopeIntent(intentFile, repo, { cfg, adapters: [fake] })).rejects.toThrow(/--force/);
    expect(calls).toBe(0);
    expect(readFileSync(specFile, "utf8")).toBe("operator-authored\n");

    await scopeIntent(intentFile, repo, { cfg, adapters: [fake], force: true });
    expect(calls).toBe(1);
    expect(readFileSync(specFile, "utf8")).toBe(VALID_DRAFT);
  });

  test("does not retry or overwrite when the spec appears during drafting", async () => {
    const { repo, intentFile, cfg, fake } = fixture({ spec: VALID_DRAFT });
    const specFile = join(repo, "reports.spec.md");
    let calls = 0;
    const headlessCommand = fake.headlessCommand.bind(fake);
    fake.headlessCommand = (promptFile, model) => {
      calls++;
      if (calls === 1) writeFileSync(specFile, "created-concurrently\n");
      return headlessCommand(promptFile, model);
    };

    await expect(scopeIntent(intentFile, repo, { cfg, adapters: [fake] })).rejects.toThrow(/EEXIST/);
    expect(calls).toBe(1);
    expect(readFileSync(specFile, "utf8")).toBe("created-concurrently\n");
  });

  test("refuses unanswered intent without calling the adapter", async () => {
    const { repo, intentFile, cfg, fake } = fixture({ spec: VALID_DRAFT });
    writeFileSync(intentFile, `# Export reports

## Blocking questions
1. Which format?
2. Where should exports be stored?

## Answers
1. JSON
`);
    let calls = 0;
    const headlessCommand = fake.headlessCommand.bind(fake);
    fake.headlessCommand = (promptFile, model) => {
      calls++;
      return headlessCommand(promptFile, model);
    };

    await expect(scopeIntent(intentFile, repo, { cfg, adapters: [fake] })).rejects.toThrow(/Where should exports be stored\?/);
    expect(calls).toBe(0);
    expect(existsSync(join(repo, "reports.spec.md"))).toBe(false);
  });

  test("honors visibility.llm pane through the shared driver machinery", async () => {
    const { repo, intentFile, cfg, fake } = fixture({ spec: VALID_DRAFT });
    cfg.visibility.llm = "pane";
    let output = "";
    const slot = vi.fn(async (cwd: string, name: string) => ({ id: "scope-1", name, cwd }));
    const close = vi.fn(async () => {});
    const driver = {
      slot,
      run: async (s: { cwd: string }, command: string) => { output = execSync(command, { cwd: s.cwd, encoding: "utf8" }); },
      waitOutput: async () => true,
      read: async () => output,
      close,
    } as unknown as ExecutorDriver;

    await scopeIntent(intentFile, repo, { cfg, adapters: [fake], driver });

    expect(slot).toHaveBeenCalledWith(repo, expect.stringMatching(/^scope-reports-1-fake$/), { label: "SCOPE" });
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("tickmarkr scope command", () => {
  test("loads config, resolves the intent path, and reports the written spec", async () => {
    const { repo, cfg: _cfg, fake } = fixture({ spec: VALID_DRAFT });
    mkdirSync(join(repo, ".tickmarkr"));
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), `routing:
  map:
    spec:
      pin: { via: fake, model: fake-1 }
`);
    const oldXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(repo, "xdg");
    try {
      const out = await scopeCommand(["reports.intent.md"], repo, [fake]);
      expect(out).toMatch(/reports\.intent\.md → reports\.spec\.md \(1 task, 1 LLM call\)/);
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
    }
  });

  test("is registered and documented", () => {
    expect(COMMANDS.scope).toBe(scopeCommand);
    expect(USAGE).toContain("scope <intent>");
  });
});
