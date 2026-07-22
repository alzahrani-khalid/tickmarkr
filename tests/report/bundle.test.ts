import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  BUNDLE_SCHEMA_VERSION,
  buildProofBundle,
  KNOWN_LIMITS,
  type ProofBundle,
} from "../../src/report/bundle.js";
import type { RunEnvironment } from "../../src/run/environment.js";
import type { JournalEvent } from "../../src/run/journal.js";
import { MASK } from "../../src/run/redact.js";

// v1.70 T4: report --bundle pure surface — schema-versioned proof packet with
// task outcomes, judge evidence citations, environment identity, content hashes,
// secrets redacted, known limits, no network.

const env = (over: Partial<RunEnvironment> & { configHash: string }): RunEnvironment => ({
  tickmarkrVersion: over.tickmarkrVersion ?? "1.70.0",
  configHash: over.configHash,
  adapterVersions: over.adapterVersions ?? { fake: "fake" },
});

const citation = { path: "src/report/bundle.ts", line: 42 };

const eventsWithJudge = (secretInDetails?: string): JournalEvent[] => {
  const details = secretInDetails ?? "ok";
  return [
    {
      ts: "2026-07-22T10:00:00.000Z",
      event: "run-start",
      data: {
        baseRef: "abc",
        graphDefinitionHash: "graphhashaaaaaaaa",
        environment: env({ configHash: "cfghashaaaaaaaaa" }),
      },
    },
    {
      ts: "2026-07-22T10:00:10.000Z",
      event: "task-dispatch",
      taskId: "T1",
      data: { assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "cheap" } },
    },
    {
      ts: "2026-07-22T10:00:30.000Z",
      event: "gate-result",
      taskId: "T1",
      data: {
        gate: "acceptance",
        pass: true,
        details,
        // Structured criteria as the judge recorded them (T1 citation shape).
        criteria: [
          {
            criterion: "c1",
            met: true,
            reason: "the cited line implements the feature",
            evidence: citation,
          },
          {
            criterion: "c2",
            met: true,
            reason: "legacy free-text quote path still works",
            evidence: "export function buildProofBundle",
          },
        ],
      },
    },
    {
      ts: "2026-07-22T10:01:00.000Z",
      event: "task-done",
      taskId: "T1",
      data: { summary: "done" },
    },
    {
      ts: "2026-07-22T10:01:30.000Z",
      event: "run-end",
      data: { done: ["T1"], failed: [], human: [] },
    },
  ];
};

describe("report --bundle proof packet (v1.70 T4)", () => {
  test("test: the written bundle carries a schema version field a future reader can check before parsing the rest", () => {
    const packet = buildProofBundle("run-bundle-schema", eventsWithJudge());
    // Field is present at the top level and is a positive integer a reader can branch on first.
    expect(packet).toHaveProperty("schemaVersion");
    expect(typeof packet.schemaVersion).toBe("number");
    expect(packet.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
    expect(Number.isInteger(packet.schemaVersion)).toBe(true);
    expect(packet.schemaVersion).toBeGreaterThan(0);
    // Round-trip through JSON still exposes the field first-class (portable packet).
    const roundTrip = JSON.parse(JSON.stringify(packet)) as ProofBundle;
    expect(roundTrip.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
  });

  test("test: every judge evidence citation in the bundle matches what the judge actually recorded, unaltered", () => {
    const source = eventsWithJudge();
    const recorded = (source.find((e) => e.event === "gate-result")!.data.criteria as Array<{
      criterion: string;
      evidence: unknown;
    }>);
    const packet = buildProofBundle("run-bundle-citations", source);
    const task = packet.tasks.find((t) => t.taskId === "T1");
    expect(task).toBeDefined();
    expect(task!.judgeCriteria.length).toBe(recorded.length);
    for (let i = 0; i < recorded.length; i++) {
      const fromJudge = recorded[i]!.evidence;
      const inBundle = task!.judgeCriteria[i]!.evidence;
      // Byte-for-byte / deep-equal: structured citations and free-text quotes, unaltered.
      expect(inBundle).toEqual(fromJudge);
    }
    // Explicit pin on the structured citation shape (path + line).
    expect(task!.judgeCriteria[0]!.evidence).toEqual({ path: "src/report/bundle.ts", line: 42 });
    expect(task!.judgeCriteria[1]!.evidence).toBe("export function buildProofBundle");
  });

  test("test: a secret-shaped string present anywhere in the source journal is redacted in the written bundle", () => {
    // Anthropic-shaped vendor key — matches redactSecrets vendor-key family (prefix survives).
    const secret = "sk-ant-api03-SUPERSECRETVALUE999";
    const source = eventsWithJudge(
      `judge saw credential ${secret} in the transcript`,
    );
    // Source journal still holds the secret-shaped string.
    expect(JSON.stringify(source)).toContain(secret);

    const packet = buildProofBundle("run-bundle-redact", source);
    const written = JSON.stringify(packet);
    // Secret body must not appear in the packet; redaction mask does.
    expect(written).not.toContain("SUPERSECRETVALUE999");
    expect(written).not.toContain(secret);
    expect(written).toContain(MASK);
    // Prefix may survive (redactSecrets keeps the credential class identifiable).
    expect(written).toMatch(/sk-ant-/);
  });

  test("test: producing a bundle makes no network request of any kind", () => {
    // 1) Static pin: the pure builder module never imports a network surface.
    // Path is relative to this test file (not process.cwd) so the live-fixture
    // guard never co-matches operator-state (process.cwd + .tickmarkr*).
    const src = readFileSync(join(import.meta.dirname, "../../src/report/bundle.ts"), "utf8")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/\bfrom\s+["']node:(http|https|net|dns|dgram|tls|undici)["']/);
    expect(src).not.toMatch(/\bfrom\s+["'](http|https|net|dns|undici|node-fetch)["']/);
    expect(src).not.toMatch(/\bfetch\s*\(/);

    // 2) Runtime pin: buildProofBundle is pure over the events array — throwing fetch never fires.
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = ((..._args: unknown[]) => {
      fetchCalls++;
      throw new Error("unexpected network fetch during buildProofBundle");
    }) as typeof fetch;
    try {
      const packet = buildProofBundle("run-bundle-nonet", eventsWithJudge());
      expect(packet.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
      expect(packet.contentHashes.journal).toMatch(/^[a-f0-9]{64}$/);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // 3) Written-file path (CLI seam): local write only — path is under tmpdir, still no network.
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-bundle-"));
    const outPath = join(dir, "proof.json");
    const packet = buildProofBundle("run-bundle-write", eventsWithJudge());
    writeFileSync(outPath, JSON.stringify(packet, null, 2) + "\n");
    const onDisk = JSON.parse(readFileSync(outPath, "utf8")) as ProofBundle;
    expect(onDisk.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
  });

  // Judge pin: known limits are plain language, not an unconditional correctness claim.
  test("the bundle states its own known limits in plain language rather than presenting the packet as an unconditional proof of correctness", () => {
    const packet = buildProofBundle("run-bundle-limits", eventsWithJudge());
    expect(Array.isArray(packet.knownLimits)).toBe(true);
    expect(packet.knownLimits.length).toBeGreaterThan(0);
    expect(packet.knownLimits).toEqual([...KNOWN_LIMITS]);
    const joined = packet.knownLimits.join(" ");
    // Names the packet as a snapshot / not independent re-verification.
    expect(joined).toMatch(/snapshot|not an independent re-verification/i);
    // Explicitly disclaims unconditional correctness.
    expect(joined).not.toMatch(/unconditional proof of correctness/i);
    expect(joined).toMatch(/does not prove|not an independent|not a formal/i);
    // Environment identity + content hashes are carried for inspection.
    expect(packet.environment?.configHash).toBe("cfghashaaaaaaaaa");
    expect(packet.contentHashes.graphDefinitionHash).toBe("graphhashaaaaaaaa");
    expect(packet.tasks[0]!.outcome).toBe("done");
  });
});
