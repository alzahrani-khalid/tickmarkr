import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

interface MillisecondCeiling {
  file: string;
  line: number;
  ms: number;
  text: string;
  hasSlowestRunnerNote: boolean;
}

const RUN_TESTS = join(import.meta.dirname, "..", "run");
const TIMEOUT_MS_DECLARATION = /\btimeoutMs\s*(?::|=)\s*([0-9][0-9_]*)\b/g;
const SLOWEST_RUNNER_NOTE = /\bslowest[- ]runner\b/i;

function listRunTests(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path);
    }
  }
  return files.sort();
}

function enumerateMillisecondCeilings(file: string, source: string): MillisecondCeiling[] {
  const lines = source.split("\n");
  const hasSlowestRunnerNote = SLOWEST_RUNNER_NOTE.test(source);
  return [...source.matchAll(TIMEOUT_MS_DECLARATION)].map((match) => {
    const line = source.slice(0, match.index).split("\n").length;
    return {
      file,
      line,
      ms: Number(match[1]!.replaceAll("_", "")),
      text: lines[line - 1]!.trim(),
      hasSlowestRunnerNote,
    };
  });
}

function unnotedSubsecondCeilings(ceilings: readonly MillisecondCeiling[]): MillisecondCeiling[] {
  return ceilings.filter((ceiling) => ceiling.ms < 1_000 && !ceiling.hasSlowestRunnerNote);
}

function formatCeilings(ceilings: readonly MillisecondCeiling[]): string {
  return ceilings.map((ceiling) => `${ceiling.file}:${ceiling.line}: ${ceiling.ms} ms — ${ceiling.text}`).join("\n");
}

describe("millisecond ceiling hygiene in run tests", () => {
  test("test: every millisecond ceiling declared in a test under the run tests is enumerated with the enumeration non-empty, a sub-second ceiling without a slowest-runner note in its file is flagged, and a fixture declaring a 100 ms ceiling with no note is flagged while the same fixture with the note is not, so a sweep that matches nothing fails", () => {
    const ceilings = listRunTests(RUN_TESTS).flatMap((path) => {
      const file = `tests/run/${relative(RUN_TESTS, path).split("\\").join("/")}`;
      return enumerateMillisecondCeilings(file, readFileSync(path, "utf8"));
    });

    expect(ceilings.length, "millisecond-ceiling sweep matched nothing").toBeGreaterThan(0);
    expect(
      unnotedSubsecondCeilings(ceilings),
      `sub-second ceiling(s) need a slowest-runner note in their file:\n${formatCeilings(ceilings)}`,
    ).toEqual([]);

    const withoutNote = enumerateMillisecondCeilings(
      "tests/run/fixture.test.ts",
      "const config = { review: { timeoutMs: 100 } };\n",
    );
    expect(unnotedSubsecondCeilings(withoutNote)).toMatchObject([
      { file: "tests/run/fixture.test.ts", line: 1, ms: 100 },
    ]);

    const withNote = enumerateMillisecondCeilings(
      "tests/run/fixture.test.ts",
      "// This 100 ms ceiling is a budget for the slowest runner.\nconst config = { review: { timeoutMs: 100 } };\n",
    );
    expect(unnotedSubsecondCeilings(withNote)).toEqual([]);
  });
});
