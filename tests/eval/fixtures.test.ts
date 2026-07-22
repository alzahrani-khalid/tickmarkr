import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { discoverFixtures, seedFixture, type Fixture } from "../../src/eval/fixtures.js";

function fixtureRoot(items: Record<string, { start: Record<string, string>; solution?: Record<string, string> }>): string {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-fixtures-"));
  for (const [name, { start, solution }] of Object.entries(items)) {
    const dir = join(root, name);
    for (const [p, content] of Object.entries(start)) {
      const fp = join(dir, "start", p);
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, content);
    }
    mkdirSync(join(dir, "solution"), { recursive: true });
    if (solution) {
      for (const [p, content] of Object.entries(solution)) {
        const fp = join(dir, "solution", p);
        mkdirSync(dirname(fp), { recursive: true });
        writeFileSync(fp, content);
      }
    }
  }
  return root;
}

function fixtureAt(root: string, name: string): Fixture {
  const dir = join(root, name);
  return {
    id: name,
    path: dir,
    startDir: join(dir, "start"),
    solutionDir: join(dir, "solution"),
  };
}

describe("fixture discovery", () => {
  test("discovers valid fixtures with stable identifiers", () => {
    const root = fixtureRoot({
      one: { start: { "a.txt": "a" } },
      two: { start: { "b.txt": "b" } },
    });
    const { valid, invalid } = discoverFixtures(root);
    expect(valid.map((f) => f.id)).toEqual(["one", "two"]);
    expect(invalid).toEqual([]);
  });

  test("reports a directory missing a required part as invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "tickmarkr-fixtures-"));
    mkdirSync(join(root, "broken", "start"), { recursive: true });
    writeFileSync(join(root, "broken", "start", "a.txt"), "a");
    const { valid, invalid } = discoverFixtures(root);
    expect(valid).toEqual([]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.id).toBe("broken");
    expect(invalid[0]!.reason).toContain("solution");
  });
});

describe("fixture seeding", () => {
  test("running the command against a fixture seeds a fresh temporary git repository containing only that fixture's starting files, never its reference solution", async () => {
    const root = fixtureRoot({
      sample: {
        start: { "README.md": "start", "src/main.ts": "export const x = 1;" },
        solution: { "README.md": "solution", "src/main.ts": "export const x = 2;" },
      },
    });
    const fixture = fixtureAt(root, "sample");
    const seeded = await seedFixture(fixture);

    expect(existsSync(seeded.repo)).toBe(true);
    expect(existsSync(join(seeded.repo, ".git"))).toBe(true);
    expect(readFileSync(join(seeded.repo, "README.md"), "utf8")).toBe("start");
    expect(readFileSync(join(seeded.repo, "src", "main.ts"), "utf8")).toBe("export const x = 1;");
    expect(existsSync(join(seeded.repo, "solution"))).toBe(false);
    expect(existsSync(join(seeded.repo, "README.md"))).toBe(true);

    const head = execSync("git rev-parse HEAD", { cwd: seeded.repo, encoding: "utf8" }).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);

    await seeded.cleanup();
  });

  test("two fixtures run in the same invocation each get their own isolated temporary repository with no file bleed between them", async () => {
    const root = fixtureRoot({
      alpha: { start: { "alpha.txt": "alpha" } },
      beta: { start: { "beta.txt": "beta" } },
    });
    const a = await seedFixture(fixtureAt(root, "alpha"));
    const b = await seedFixture(fixtureAt(root, "beta"));

    expect(a.repo).not.toBe(b.repo);
    expect(existsSync(join(a.repo, "alpha.txt"))).toBe(true);
    expect(existsSync(join(a.repo, "beta.txt"))).toBe(false);
    expect(existsSync(join(b.repo, "beta.txt"))).toBe(true);
    expect(existsSync(join(b.repo, "alpha.txt"))).toBe(false);

    await a.cleanup();
    await b.cleanup();
  });

  test("the seeded repository for a fixture is removed once that fixture's run completes", async () => {
    const root = fixtureRoot({ sample: { start: { "a.txt": "a" } } });
    const seeded = await seedFixture(fixtureAt(root, "sample"));
    expect(existsSync(seeded.repo)).toBe(true);
    await seeded.cleanup();
    expect(existsSync(seeded.repo)).toBe(false);
  });
});
