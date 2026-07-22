import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { evalCommand } from "../../src/cli/commands/eval.js";

function makeFixturesDir(items: Record<string, { start: Record<string, string>; hasSolution?: boolean }>): string {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-eval-cli-"));
  for (const [name, { start, hasSolution = true }] of Object.entries(items)) {
    const dir = join(root, name);
    mkdirSync(join(dir, "start"), { recursive: true });
    for (const [p, content] of Object.entries(start)) {
      writeFileSync(join(dir, "start", p), content);
    }
    if (hasSolution) {
      mkdirSync(join(dir, "solution"), { recursive: true });
      writeFileSync(join(dir, "solution", "solution.txt"), "solution");
    }
  }
  return root;
}

describe("tickmarkr eval", () => {
  test("the command lists every checked-in fixture it discovers with a stable identifier for each one", async () => {
    const root = makeFixturesDir({
      "add-one": { start: { "todo.txt": "add one" } },
      "add-two": { start: { "todo.txt": "add two" } },
    });
    const out = await evalCommand([root], process.cwd());
    expect(typeof out === "string" ? out : out.out).toContain("add-one");
    expect(typeof out === "string" ? out : out.out).toContain("add-two");
    expect(typeof out === "string" ? out : out.out).toContain("discovered 2 fixtures");
  });

  test("a fixture directory missing a required part is reported as invalid rather than silently skipped", async () => {
    const root = makeFixturesDir({
      good: { start: { "a.txt": "a" } },
      bad: { start: { "a.txt": "a" }, hasSolution: false },
    });
    const result = await evalCommand([root], process.cwd());
    expect(typeof result === "object" && result.code).toBe(1);
    const text = typeof result === "string" ? result : result.out;
    expect(text).toContain("bad");
    expect(text).toContain("invalid fixtures:");
    expect(text).toContain("missing required part");
  });

  test("the default fixtures root is fixtures/eval relative to cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tickmarkr-eval-cwd-"));
    const out = await evalCommand([], cwd);
    expect(typeof out === "string" ? out : out.out).toContain("discovered 0 fixtures");
  });
});
