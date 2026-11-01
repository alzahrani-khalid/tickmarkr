import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { writeDoctor } from "../../src/adapters/registry.js";
import { scope as scopeCommand } from "../../src/cli/commands/scope.js";
import { COMMANDS, USAGE } from "../../src/cli/index.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { compileNative } from "../../src/compile/native.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { clarificationGate, extractDraft, formatScopePreview, previewScope, scopeIntent, validateDraft } from "../../src/plan/scope.js";
import { SCOPE_END, SCOPE_EXAMPLE, scopePrompt } from "../../src/plan/prompt.js";

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

  // 2.16.0 (D-2178 add.171): a live drafting seat wrote an unindented second goal paragraph three times running,
  // because the prompt never stated the task-block grammar the parser enforces (OBS-488).
  test("the scope prompt's example draft passes the real draft validator with two tasks", () => {
    expect(validateDraft(SCOPE_EXAMPLE)).toBe(2);
  });

  test("the first and the repair scope prompts state the closed task-block grammar and carry the example draft", () => {
    for (const prompt of [scopePrompt("# Intent"), scopePrompt("# Intent", { draft: "bad", error: "no parse rule consumes this line" })]) {
      expect(prompt).toContain("Task block grammar (closed; the compiler rejects every other line):");
      expect(prompt).toContain("indents every line after its first by two spaces");
      expect(prompt).toContain('never "." or a bare directory');
      expect(prompt).toContain("(only in a repository that runs vitest; otherwise use command:)");
      expect(prompt).toContain("context, when present, is a comma-separated list of existing repository paths the worker should read, never prose");
      expect(prompt).toContain(`<example>\n${SCOPE_EXAMPLE}</example>`);
    }
  });

  // 2.16.0 (D-2178 add.171), the closed case table of a seat's raw output, from a captured codex transcript. A
  // driver read returns the banner, the ECHOED prompt (its own spec markers first), the answer, a footer, the
  // answer again and the nonce exit trailer; a headless read returns the answer alone.
  test("the draft extractor returns the model's answer for a headless answer, a bare trailer and a driver transcript that echoes the prompt", () => {
    const answer = VALID_DRAFT.trimEnd() + "\n";
    const prompt = scopePrompt("# Export reports\n\nExport reports as JSON");
    const transcript = ["tickmarkr", "spec in, verified work out.", "user", prompt, "codex", answer, "tokens used", "12,345", answer,
      "TICKMARKR_EXIT_ab12cd34:0", "operator@host ~ %"].join("\n");
    expect(transcript.indexOf("<!-- tickmarkr:spec -->")).toBeLessThan(transcript.indexOf("codex\n"));
    expect(extractDraft(answer, prompt)).toBe(answer);
    expect(extractDraft(`${answer}\nTICKMARKR_EXIT:0\n`, prompt)).toBe(answer);
    expect(extractDraft(transcript, prompt)).toBe(answer);
    expect(extractDraft(transcript)).toBe(answer);
    expect(validateDraft(extractDraft(transcript, prompt))).toBe(1);
  });

  test("an echoed intent holding a fenced spec and a JSON spec object, and an echoed repair prompt, never become the draft", () => {
    const answer = VALID_DRAFT.trimEnd() + "\n";
    const intent = '# Export\n\n```markdown\n<!-- tickmarkr:spec -->\n# ECHOED FENCE\n```\n\n{"spec": "ECHOED JSON"}\n';
    for (const prompt of [scopePrompt(intent), scopePrompt(intent, { draft: "<!-- tickmarkr:spec -->\n# OLD DRAFT\n", error: "boom" })]) {
      const transcript = ["user", prompt, "codex", answer, "tokens used", "12,345", answer, "TICKMARKR_EXIT_ab12cd34:0"].join("\n");
      expect(extractDraft(transcript, prompt)).toBe(answer);
    }
  });

  test("a headless JSON spec object and a headless fenced answer still yield the draft", () => {
    const answer = VALID_DRAFT.trimEnd() + "\n";
    const prompt = scopePrompt("# Export reports");
    expect(extractDraft(JSON.stringify({ spec: answer }), prompt)).toBe(answer);
    expect(extractDraft(`Here is the spec:\n\n\`\`\`markdown\n${answer}\`\`\`\n`, prompt)).toBe(answer);
  });

  // 2.16.0 (D-2178 add.174): review round 2 and the judge reproduced three echo shapes a line-anchored boundary missed.
  test("a CRLF transcript, an echo with no answer and an intent carrying a sample exit trailer never select echoed content", () => {
    const answer = VALID_DRAFT.trimEnd() + "\n";
    const intent = '# Export\n\n```markdown\n<!-- tickmarkr:spec -->\n# ECHOED FENCE\n```\n\n{"spec": "ECHOED JSON"}\nTICKMARKR_EXIT_deadbeef:0\n';
    const prompt = scopePrompt(intent);
    const transcript = ["user", prompt, "codex", answer, "tokens used", "12,345", answer, "TICKMARKR_EXIT_ab12cd34:0"].join("\n");
    expect(extractDraft(transcript, prompt)).toBe(answer);
    expect(extractDraft(transcript.replace(/\n/g, "\r\n"), prompt)).toBe(answer);
    for (const echoOnly of [["user", prompt, "TICKMARKR_EXIT_ab12cd34:0"].join("\n"), ["user", prompt].join("\n").trimEnd()]) {
      const draft = extractDraft(echoOnly, prompt);
      expect(draft).not.toContain("ECHOED");
      expect(() => validateDraft(draft)).toThrow(/native marker/);
    }
  });

  test("each scope prompt ends with its own per-call nonce line", () => {
    const [a, b] = [scopePrompt("# Intent"), scopePrompt("# Intent")].map((prompt) => prompt.trimEnd().split("\n").at(-1)!);
    expect(a).toMatch(new RegExp(`^${SCOPE_END} [0-9a-f]{16}$`));
    expect(a).not.toBe(b);
  });

  test("outOfScope is a valueless list header: the example's nested outOfScope list validates and an inline outOfScope value fails", () => {
    expect(SCOPE_EXAMPLE).toContain("- outOfScope:\n  - ");
    expect(scopePrompt("# Intent")).toContain('or a list header with no value, "- acceptance:" or "- outOfScope:"');
    expect(validateDraft(SCOPE_EXAMPLE)).toBe(2);
    expect(() => validateDraft(SCOPE_EXAMPLE.replace("- outOfScope:\n  - CSV and other export formats.", "- outOfScope: CSV and other export formats.")))
      .toThrow(/must be a nested list/);
  });

  test("a draft whose goal continues in an unindented paragraph fails validation at that line", () => {
    const broken = SCOPE_EXAMPLE.replace("  A missing report path is an error that names the path.", "\nA missing report path is an error that names the path.");
    expect(broken).not.toBe(SCOPE_EXAMPLE);
    expect(() => validateDraft(broken)).toThrow(/no parse rule consumes this line: "A missing report path is an error that names the path\."/);
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

describe("scope preview candidate health (review finding: routing permission is not health evidence)", () => {
  test("does not report a candidate as installed/authed when only routing.allowUnverifiedModels lets an unverified model through", () => {
    const { repo, intentFile, cfg, fake } = fixture({ spec: VALID_DRAFT });
    cfg.routing.allowUnverifiedModels = true;
    // Cached health has NO modelAuth at all — every model's authed status is unknown; only
    // allowUnverifiedModels lets discoverChannels/route treat fake-1 as routable.
    writeDoctor(repo, { fake: { installed: true, authed: true, models: ["fake-1", "fake-2"] } });

    const preview = previewScope(intentFile, repo, { cfg, adapters: [fake] });

    expect(preview.candidate).toBeUndefined();
    const text = formatScopePreview(preview);
    expect(text).toMatch(/cached candidate: unknown/);
    expect(text).not.toMatch(/installed\/authed/);
  });

  test("still reports the candidate when the doctor cache actually marked it authed", () => {
    const { repo, intentFile, cfg, fake } = fixture({ spec: VALID_DRAFT });
    writeDoctor(repo, {
      fake: { installed: true, authed: true, models: ["fake-1", "fake-2"], modelAuth: { "fake-1": { authed: true, probedAt: "2026-09-05T00:00:00.000Z" } } },
    });

    const preview = previewScope(intentFile, repo, { cfg, adapters: [fake] });

    expect(preview.candidate).toEqual({ adapter: "fake", model: "fake-1" });
    expect(formatScopePreview(preview)).toMatch(/fake:fake-1 \(installed\/authed at last doctor run\)/);
  });
});

describe("confirmed scope cached model health", () => {
  test("preserves cached per-model health when a real-adapter-shaped probe omits modelAuth", async () => {
    const { repo, intentFile, cfg, fake } = fixture({ spec: VALID_DRAFT });
    expect(cfg.routing.allowUnverifiedModels).toBe(false);
    writeDoctor(repo, {
      fake: {
        installed: true,
        authed: true,
        models: ["fake-1", "fake-2"],
        modelAuth: { "fake-1": { authed: true, probedAt: "2026-09-05T00:00:00.000Z" } },
      },
    });
    const preview = previewScope(intentFile, repo, { cfg, adapters: [fake] });
    expect(preview.candidate).toEqual({ adapter: "fake", model: "fake-1" });

    // Shipped adapters' probe() contract has adapter health and detected models, but no modelAuth.
    vi.spyOn(fake, "probe").mockResolvedValue({
      installed: true, authed: true, version: "real-shaped", models: ["fake-1", "fake-2"],
    });
    const author = vi.spyOn(fake, "headlessCommand");

    const result = await scopeIntent(intentFile, repo, {
      cfg, adapters: [fake], candidate: preview.candidate!,
    });

    // OBS-1182: the bound seat configures no effort, so the draft launches at the CLI's default
    expect(author).toHaveBeenCalledWith(expect.any(String), "fake-1", undefined);
    expect(readFileSync(result.specFile, "utf8")).toBe(VALID_DRAFT);
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
      const out = await scopeCommand(["reports.intent.md", "--yes"], repo, [fake]);
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
