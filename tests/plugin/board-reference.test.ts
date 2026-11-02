import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const lines = (path: string): string[] => readFileSync(resolve(ROOT, path), "utf8").split("\n");

// PORT-RULES B1 (queue rows 331, 332 and 335): the operator's board ships as it is, but for the two lines that name where
// it now lives and the head line that names the spec being built, so every later edit of board.tsx must go through the reference.
test("the shipped board.tsx equals the reference board.tsx line for line except the state types import, the tickmarkr-board reopen footer and the spec-naming head", () => {
  const reference = lines("tests/fixtures/board/reference/board.tsx");
  const shipped = lines("hooks/board/board.tsx");
  expect(shipped).toHaveLength(reference.length);

  const IMPORT = "import type { AttemptLine, AttemptPart, RunSnapshot, TaskRow } from '../types'";
  const FOOTER = "/run-progress reopens";
  const importAt = reference.indexOf(IMPORT);
  const footerAt = reference.findIndex(line => line.includes(FOOTER));
  expect(importAt).toBeGreaterThanOrEqual(0);
  expect(footerAt).toBeGreaterThan(importAt);
  expect(reference.filter(line => line.includes(FOOTER))).toHaveLength(1);

  expect(shipped[importAt]).toBe('import type { AttemptLine, AttemptPart, RunSnapshot, TaskRow } from "./state"');
  expect(shipped[footerAt]).toBe(reference[footerAt]!.replace(FOOTER, "/tickmarkr-board reopens"));
  const HEAD = "<Text bold>{s.runId.replace(/^run-/, '').replace(/-0+(\\d+)$/, ' · #$1')}</Text>";
  const headAt = reference.findIndex(line => line.trim() === HEAD);
  expect(headAt).toBeGreaterThan(importAt);
  expect(shipped[headAt]!.trim()).toBe(
    "<Text bold>{s.spec ? `${s.spec} · ${s.runId.replace(/^.*-0*(?=\\d+$)/, '#')}` : s.runId.replace(/^run-/, '').replace(/-0+(\\d+)$/, ' · #$1')}</Text>");
  const differing = reference.flatMap((line, index) => line === shipped[index] ? [] : [index]);
  expect(differing).toEqual([importAt, headAt, footerAt].sort((a, b) => a - b));
});
