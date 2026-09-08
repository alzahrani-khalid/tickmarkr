import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

// C10 (R11/R16/R45): --preview is a cache-only disclosure — it must never probe an adapter, call a
// model, or write a spec. Active scope must gate on a disclosed TTY confirmation or --yes before it
// reaches the unchanged production authoring path. Both flags are exercised at the CLI boundary here
// (src/cli/commands/scope.ts); tests/plan/scope.test.ts keeps the lower-level scopeIntent coverage.
const { mockCreateInterface, mockQuestion } = vi.hoisted(() => {
  const mockQuestion = vi.fn();
  const mockCreateInterface = vi.fn(() => ({ question: mockQuestion, close: vi.fn() }));
  return { mockCreateInterface, mockQuestion };
});
vi.mock("node:readline/promises", () => ({ createInterface: mockCreateInterface }));

import { FakeAdapter } from "../../src/adapters/fake.js";
import { writeDoctor } from "../../src/adapters/registry.js";
import { scope as scopeCommand } from "../../src/cli/commands/scope.js";
import { compileNative } from "../../src/compile/native.js";

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

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-scope-cli-"));
  const intentFile = join(repo, "reports.intent.md");
  const specFile = join(repo, "reports.spec.md");
  const scriptFile = join(repo, "fake.json");
  writeFileSync(intentFile, `# Export reports

## Blocking questions
1. Which format?

## Answers
1. JSON
`);
  writeFileSync(scriptFile, JSON.stringify({ tasks: {}, judge: { spec: VALID_DRAFT } }));
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), `routing:
  map:
    spec:
      pin: { via: fake, model: fake-1 }
`);
  return { repo, intentFile, specFile, fake: new FakeAdapter(scriptFile) };
}

// Isolates loadConfig() from the operator's real global config — the CLI command loads config
// itself (no injection seam), so the boundary the plan-level tests use (passing cfg directly) is
// unavailable here.
async function withIsolatedXdg<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(repo, "xdg");
  try {
    return await fn();
  } finally {
    if (old === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = old;
  }
}

const withTTY = async (fn: () => Promise<void>) => {
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    await fn();
  } finally {
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
};

test("Production scope --preview <intent> performs local validation and shows cached candidate availability, concrete output destination and at most three authoring calls plus separately disclosed probe calls. Missing health says unknown with zero fake model/probe turns and a positively seeded target retains its bytes, while confirmed scope can call that same adapter. A preview writing a spec, buying health or claiming unknown health is ready fails.", async () => {
  const { repo, fake, specFile } = fixture();
  const probeSpy = vi.spyOn(fake, "probe");
  const headlessCommand = fake.headlessCommand.bind(fake);
  const headlessSpy = vi.fn((promptFile: string, model: string) => headlessCommand(promptFile, model));
  fake.headlessCommand = headlessSpy;

  await withIsolatedXdg(repo, async () => {
    // Missing health (no doctor.json cache written yet): unknown, never an implicit probe, never "ready".
    const missing = await scopeCommand(["reports.intent.md", "--preview"], repo, [fake]);
    expect(missing).toMatch(/unknown/i);
    expect(missing).not.toMatch(/\bready\b/i);
    expect(missing).toContain(specFile);
    expect(missing).toMatch(/up to 3/);
    expect(missing).toMatch(/probe call/i);
    expect(probeSpy).not.toHaveBeenCalled();
    expect(headlessSpy).not.toHaveBeenCalled();
    expect(existsSync(specFile)).toBe(false);

    // A positively seeded destination retains its exact bytes across a preview.
    writeFileSync(specFile, "operator-authored\n");
    const seeded = await scopeCommand(["reports.intent.md", "--preview"], repo, [fake]);
    expect(seeded).toContain("exists");
    expect(readFileSync(specFile, "utf8")).toBe("operator-authored\n");
    expect(probeSpy).not.toHaveBeenCalled();
    expect(headlessSpy).not.toHaveBeenCalled();
    rmSync(specFile); // reset for the clean confirmed-dispatch step below

    // Cached candidate availability: writing doctor.json (never done by preview itself) surfaces the
    // same adapter:model identity a probe would — with zero probe/model turns.
    writeDoctor(repo, {
      fake: { installed: true, authed: true, models: ["fake-1", "fake-2"], modelAuth: { "fake-1": { authed: true, probedAt: "2026-09-05T00:00:00.000Z" } } },
    });
    const cached = await scopeCommand(["reports.intent.md", "--preview"], repo, [fake]);
    expect(cached).toContain("fake:fake-1");
    expect(cached).toMatch(/up to 3/);
    expect(probeSpy).not.toHaveBeenCalled();
    expect(headlessSpy).not.toHaveBeenCalled();
    expect(existsSync(specFile)).toBe(false); // still never written by preview

    // Confirmed scope can call that very same cached candidate.
    const active = await scopeCommand(["reports.intent.md", "--yes"], repo, [fake]);
    expect(headlessSpy).toHaveBeenCalledOnce();
    expect(headlessSpy.mock.calls[0]![1]).toBe("fake-1");
    expect(active).toMatch(/1 LLM call/);
    expect(readFileSync(specFile, "utf8")).toBe(VALID_DRAFT);
  });
});

test("Active scope requires disclosed TTY confirmation or explicit --yes before the existing authoring path executes. Declined and non-TTY unconfirmed cases preserve a seeded destination, and confirmed fake authoring writes a compiled/validated source spec with actual call counts within the disclosed budget. A prompt skipped merely because stdin is non-TTY or a success receipt before a valid file is written fails.", async () => {
  const { repo, fake, specFile } = fixture();
  const headlessCommand = fake.headlessCommand.bind(fake);
  const headlessSpy = vi.fn((promptFile: string, model: string) => headlessCommand(promptFile, model));
  fake.headlessCommand = headlessSpy;
  writeFileSync(specFile, "operator-authored\n"); // a seeded destination

  await withIsolatedXdg(repo, async () => {
    // Non-TTY without --yes: the prompt is never skipped merely because stdin is non-interactive —
    // it refuses outright rather than silently proceeding.
    await expect(scopeCommand(["reports.intent.md"], repo, [fake])).rejects.toThrow(/not confirmed/);
    expect(readFileSync(specFile, "utf8")).toBe("operator-authored\n");
    expect(headlessSpy).not.toHaveBeenCalled();

    // Declined at a real TTY: also refuses, and the question itself discloses the destination and budget.
    mockQuestion.mockResolvedValueOnce("n");
    await withTTY(async () => {
      await expect(scopeCommand(["reports.intent.md"], repo, [fake])).rejects.toThrow(/not confirmed/);
    });
    expect(readFileSync(specFile, "utf8")).toBe("operator-authored\n");
    expect(headlessSpy).not.toHaveBeenCalled();
    const question = mockQuestion.mock.calls.at(-1)?.[0] as string;
    expect(question).toContain("reports.spec.md");
    expect(question).toMatch(/up to 3 authoring calls?/);
    expect(question).toMatch(/probe call/);

    // Confirmed via TTY "y" (needs --force: the destination is still the seeded file above).
    mockQuestion.mockResolvedValueOnce("y");
    await withTTY(async () => {
      const out = await scopeCommand(["reports.intent.md", "--force"], repo, [fake]);
      expect(out).toMatch(/1 LLM call/);
    });
    expect(readFileSync(specFile, "utf8")).toBe(VALID_DRAFT);
    expect(compileNative(specFile).tasks).toHaveLength(1); // a compiled/validated source spec, not raw text
    expect(headlessSpy).toHaveBeenCalledTimes(1); // within the disclosed up-to-3 budget

    // Confirmed via explicit --yes on a fresh destination writes the same validated spec.
    rmSync(specFile, { force: true });
    headlessSpy.mockClear();
    const out2 = await scopeCommand(["reports.intent.md", "--yes"], repo, [fake]);
    expect(out2).toMatch(/reports\.spec\.md/);
    expect(existsSync(specFile)).toBe(true);
    expect(compileNative(specFile).tasks).toHaveLength(1);
    expect(headlessSpy.mock.calls.length).toBeGreaterThan(0);
    expect(headlessSpy.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

test("Confirmed active scope binds dispatch to the exact candidate --preview disclosed; a stale doctor cache that a fresh probe contradicts fails loud instead of silently rerouting to a different, unconfirmed channel (stale-cache regression, review finding).", async () => {
  const { repo, fake, specFile } = fixture();
  // Free routing (no map pin) so a fresh probe excluding the cached candidate can genuinely make
  // route() pick a different live channel — a pinned config would instead trip its own fail-loud
  // "pinned … not available" check, never exercising the reroute this test guards against.
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), `routing:
  map:
    spec:
      prefer: [fake]
`);
  const headlessCommand = fake.headlessCommand.bind(fake);
  const headlessSpy = vi.fn((promptFile: string, model: string) => headlessCommand(promptFile, model));
  fake.headlessCommand = headlessSpy;

  await withIsolatedXdg(repo, async () => {
    // Doctor cache: only fake-1 (the cheaper "sub" channel) is marked authed, so the disclosed
    // candidate is unambiguously fake:fake-1.
    writeDoctor(repo, {
      fake: { installed: true, authed: true, models: ["fake-1", "fake-2"], modelAuth: { "fake-1": { authed: true, probedAt: "2026-09-05T00:00:00.000Z" } } },
    });
    const preview = await scopeCommand(["reports.intent.md", "--preview"], repo, [fake]);
    expect(preview).toContain("fake:fake-1");

    // The world moved on since that doctor run: fake-1 is now unauthed and fake-2 (the "api" channel)
    // is the only live one. An unbound route() would freely reroute to fake-2 here.
    vi.spyOn(fake, "probe").mockResolvedValue({
      installed: true, authed: true, version: "fake", models: ["fake-1", "fake-2"],
      modelAuth: {
        "fake-1": { authed: false, reason: "revoked", probedAt: "2026-09-05T01:00:00.000Z" },
        "fake-2": { authed: true, probedAt: "2026-09-05T01:00:00.000Z" },
      },
    });

    await expect(scopeCommand(["reports.intent.md", "--yes"], repo, [fake])).rejects.toThrow(/fake:fake-1 is no longer available/);
    expect(headlessSpy).not.toHaveBeenCalled(); // never silently dispatched to fake-2 instead
    expect(existsSync(specFile)).toBe(false);
  });
});
