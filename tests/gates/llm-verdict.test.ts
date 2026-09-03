import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { claudeCode } from "../../src/adapters/claude-code.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";
import {
  extractVerdictJson,
  resetGateCpuAccountantFactoryForTests,
  runViaDriver,
  setGateCpuAccountantFactoryForTests,
  verdictNonceLine,
} from "../../src/gates/llm.js";

const NONCE = "c4804dad";

type ReviewVerdict = { approve: boolean; findings: unknown[] };

function shippedBraceScan<T>(raw: string, nonce: string): T | null {
  const fenced = [...raw.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  for (let fi = fenced.length - 1; fi >= 0; fi--) {
    try {
      const v = JSON.parse(fenced[fi]![1]);
      if (v && typeof v === "object" && v.nonce === nonce) return v as T;
    } catch { /* fall through */ }
  }
  let pos = raw.length - 1;
  while (pos >= 0) {
    const end = raw.lastIndexOf("}", pos);
    if (end === -1) return null;
    let depth = 1;
    let stepped = false;
    for (let i = end - 1; i >= 0; i--) {
      if (raw[i] === "}") depth++;
      else if (raw[i] === "{") {
        depth--;
        if (depth === 0) {
          stepped = true;
          try {
            const v = JSON.parse(raw.slice(i, end + 1));
            if (v && typeof v === "object" && v.nonce === nonce) return v as T;
          } catch { /* keep scanning */ }
          pos = i - 1;
          break;
        }
      }
    }
    if (!stepped) return null;
  }
  return null;
}

describe("extractVerdictJson", () => {
  test("test: extractVerdictJson parses the persisted run 3202 raw reviewer output pinned under tests fixtures reviews to a nonce-bound verdict whose findings array has four entries and still parses a synthetic verdict whose strings carry lone or balanced braces whereas the shipped scan that returns null for that fixture fails", () => {
    const raw = readFileSync(new URL("../fixtures/reviews/review-raw-T5-1788307566802.txt", import.meta.url), "utf8");

    expect(shippedBraceScan<ReviewVerdict>(raw, NONCE)).toBeNull();
    expect(extractVerdictJson<ReviewVerdict>(raw, NONCE)?.findings).toHaveLength(4);

    const synthetic = JSON.stringify({
      nonce: NONCE,
      approve: false,
      findings: [
        { note: "lone { inside a JSON string", severity: "material" },
        { note: "balanced { but still string } braces", severity: "minor" },
      ],
    });
    expect(extractVerdictJson<ReviewVerdict>(synthetic, NONCE)?.findings).toHaveLength(2);
  });

  test("test: a pane-mode review or judge seat whose pane shows the adapter declared trust dialog fingerprint receives that dialog key exactly once through the driver so the gate then reads the verdict whereas the shipped runViaDriver that ignores the dialog returns the empty pane text and fails", async () => {
    const nonce = "abc123ef";
    const verdict = `noise\n{"nonce":"${nonce}","pass":true,"criteria":[]}\nTICKMARKR_EXIT_${nonce}:0`;
    const slot: Slot = { id: "s1", name: "judge · T1", cwd: "/tmp" };
    const sent: string[] = [];
    const driver: ExecutorDriver = {
      id: "trust-stub", interactive: true,
      slot: async () => slot,
      run: async () => {},
      waitOutput: async () => sent.length > 0,
      waitAgentStatus: async () => false,
      status: async () => "working",
      read: async () => sent.length ? verdict : claudeCode.trustDialog.kind === "none" ? "" : claudeCode.trustDialog.fingerprint,
      sendKey: async (_slot, key) => { sent.push(key); },
      notify: async () => {},
      close: async () => {},
      worktree: async () => "/tmp",
    };
    setGateCpuAccountantFactoryForTests(() => ({ start: async () => {}, read: () => ({ cpu: { ms: 0, resolutionMs: 1 }, gaps: 0 }), stop: async () => {} }));
    try {
      const out = await runViaDriver(claudeCode, "sonnet", `TICKMARKR-JUDGE\n## Task T1: x\n${verdictNonceLine(nonce)}`, "/tmp", { driver, name: "judge · T1" }, 50);
      expect(sent).toEqual(["Enter"]);
      expect(extractVerdictJson<{ pass: boolean }>(out, nonce)?.pass).toBe(true);
    } finally {
      resetGateCpuAccountantFactoryForTests();
    }
  });
});
