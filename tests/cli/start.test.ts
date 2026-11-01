import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { plan, type PlanTaskRow } from "../../src/cli/commands/plan.js";
import { start, startSlug } from "../../src/cli/commands/start.js";
import { loadGraph } from "../../src/graph/graph.js";
import { makeRepo } from "../helpers/tmprepo.js";

const SENTENCE = "Add a Health endpoint!";
const SLUG = "add-a-health-endpoint";
const SPEC = `specs/${SLUG}.spec.md`;
const INTENT = `specs/${SLUG}.intent.md`;

const draft = (tasks: { title: string; shape: string; file: string; acceptance: string[] }[]) => `<!-- tickmarkr:spec -->
# Health endpoint

## Requirements
- REQ-01: Serve a health endpoint

## Assumptions
- The existing server module hosts it

## Traceability
| Requirement | Tasks |
| --- | --- |
| REQ-01 | ${tasks.map((_, i) => `T${i + 1}`).join(", ")} |

${tasks.map((task, i) => `## T${i + 1}: ${task.title} [REQ-01]
- goal: ${task.title}
- shape: ${task.shape}
- files: ${task.file}
- acceptance:
${task.acceptance.map((item) => `  - ${item}`).join("\n")}
`).join("\n")}`;

const ROUTED = draft([
  { title: "Serve the health route", shape: "implement", file: "src/health.ts", acceptance: ["command: npm test"] },
  { title: "Document the health route", shape: "chore", file: "README.md", acceptance: ["command: npm test", "judge: the README names the route"] },
]);

function fixture(spec: string, config: string | null = "judge: { adapter: fake, model: fake-1 }\nrouting:\n  map:\n    spec:\n      pin: { via: fake, model: fake-1 }\n") {
  const repo = makeRepo({ "src/health.ts": "export {};\n", "README.md": "# app\n", ...(config === null ? {} : { ".tickmarkr/config.yaml": config }) });
  writeFileSync(join(repo, "fake.json"), JSON.stringify({ tasks: {}, judge: { spec } }));
  return { repo, fake: new FakeAdapter(join(repo, "fake.json")) };
}

// Isolates loadConfig() from the operator's global config, as tests/cli/scope.test.ts does.
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

async function withoutTTY<T>(fn: () => Promise<T>): Promise<T> {
  const saved = (["stdin", "stdout"] as const).map((s) => [s, Object.getOwnPropertyDescriptor(process[s], "isTTY")] as const);
  for (const [s] of saved) Object.defineProperty(process[s], "isTTY", { configurable: true, value: false });
  try {
    return await fn();
  } finally {
    for (const [s, d] of saved) {
      if (d) Object.defineProperty(process[s], "isTTY", d);
      else delete (process[s] as { isTTY?: boolean }).isTTY;
    }
  }
}

// Every file under the repo except git's own store, with its bytes.
function snapshot(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === ".git") continue;
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(repo, path)] = readFileSync(path, "utf8");
    }
  };
  walk(repo);
  return out;
}

async function planRows(repo: string, fake: FakeAdapter): Promise<{ rows: PlanTaskRow[]; text: string }> {
  const rows: PlanTaskRow[] = [];
  const text = await plan([], repo, [fake], undefined, { onTask: (row) => rows.push(row) });
  return { rows, text };
}

describe("tickmarkr start", () => {
  test("start with a sentence and yes in a configured fake-adapter repo writes the intent and spec at the slug path, leaves a compiled graph and returns the card whose numbered rows name each task's title, worker, reviewer and acceptance check count above the next-run line, with each review string exactly as plan's seat line gives it, so a start that skips compile or prints plan's routing table fails", async () => {
    const { repo, fake } = fixture(ROUTED);
    await withIsolatedXdg(repo, async () => {
      expect(existsSync(join(repo, ".tickmarkr", "graph.json"))).toBe(false);
      const card = await start([SENTENCE, "--yes"], repo, [fake], undefined);

      expect(readFileSync(join(repo, INTENT), "utf8")).toBe(`# ${SENTENCE}\n\n${SENTENCE}\n`);
      expect(readFileSync(join(repo, SPEC), "utf8")).toBe(ROUTED);
      expect(loadGraph(repo).tasks.map((t) => t.title)).toEqual(["Serve the health route [REQ-01]", "Document the health route [REQ-01]"]);

      const { rows, text } = await planRows(repo, fake);
      expect(rows.map((r) => r.acceptance)).toEqual([1, 2]);
      for (const row of rows) {
        expect(row.worker).toBeDefined();
        expect(text).toContain(`    review: ${row.review}`);
      }
      const [a, b] = rows;
      expect(card).toBe([
        `tickmarkr start — ${SENTENCE}`,
        `drafted ${SPEC} · 2 tasks · compiled`,
        "",
        "  1. Serve the health route [REQ-01]",
        `     builds: ${a!.worker!.adapter}:${a!.worker!.model} · reviews: ${a!.review} · 1 acceptance check`,
        "  2. Document the health route [REQ-01]",
        `     builds: ${b!.worker!.adapter}:${b!.worker!.model} · reviews: ${b!.review} · 2 acceptance checks`,
        "",
        "next: tickmarkr run",
        `change it first: edit ${SPEC}, then tickmarkr compile ${SPEC} && tickmarkr plan`,
        "full routing detail: tickmarkr plan",
      ].join("\n"));
      expect(a!.review).toMatch(/^fake:fake-\d/);
      expect(card).not.toContain("tickmarkr plan — dry run");
      expect(card).not.toContain("judge:");
    });
  });

  test("the slug rule lowercases, folds every run of other characters into one hyphen, trims edge hyphens and turns an all-symbol sentence into start; a long sentence cuts before its last hyphen at or before zero-based index forty-eight without keeping that hyphen, with cases whose hyphen sits at index forty-seven and at forty-eight, and a forty-nine-letter word with no hyphen keeps its first forty-eight letters, so a slug carrying spaces, doubled hyphens, a trailing hyphen or more than forty-eight characters fails", () => {
    const x = (n: number, c: string) => c.repeat(n);
    const cases: [string, string][] = [
      ["Add a Health Endpoint!", "add-a-health-endpoint"],
      ["  --Hello,,  World__2026--  ", "hello-world-2026"],
      ["Ünïcode café — v2", "n-code-caf-v2"],
      ["!!! ??? ***", "start"],
      ["", "start"],
      // hyphen at index 47 (and an earlier one at 10): cut to 47 characters
      [`${x(10, "x")} ${x(36, "y")} ${x(10, "z")}`, `${x(10, "x")}-${x(36, "y")}`],
      [`${x(47, "a")} ${x(10, "b")}`, x(47, "a")],
      // hyphen at index 48 (and an earlier one at 10): cut to 48 characters, hyphen dropped
      [`${x(10, "x")} ${x(37, "y")} ${x(10, "z")}`, `${x(10, "x")}-${x(37, "y")}`],
      [`${x(48, "a")} ${x(10, "b")}`, x(48, "a")],
      // the only hyphen at or before 48 is early: cut there
      [`${x(5, "x")} ${x(50, "y")}`, x(5, "x")],
      // a forty-nine-letter word: no hyphen at or before 48 → first 48 letters
      [x(49, "a"), x(48, "a")],
      [`${x(49, "a")} b`, x(48, "a")],
      // exactly 48 stays whole
      [`${x(20, "a")} ${x(27, "b")}`, `${x(20, "a")}-${x(27, "b")}`],
    ];
    for (const [sentence, slug] of cases) {
      const got = startSlug(sentence);
      expect(got, sentence).toBe(slug);
      expect(got).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(got.length).toBeLessThanOrEqual(48);
    }
    expect(`${x(10, "x")} ${x(36, "y")} ${x(10, "z")}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").lastIndexOf("-", 48)).toBe(47);
    expect(`${x(10, "x")} ${x(37, "y")} ${x(10, "z")}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").lastIndexOf("-", 48)).toBe(48);
  });

  test("start refuses before writing any file when the config is missing, when the sentence is blank, and when the intent or spec already exists without force, and with force it proceeds, so a start that overwrites a spec unasked or leaves a stray intent behind a refusal fails", async () => {
    const bare = fixture(ROUTED, null);
    await withIsolatedXdg(bare.repo, async () => {
      const before = snapshot(bare.repo);
      await expect(start([SENTENCE, "--yes"], bare.repo, [bare.fake])).rejects.toThrow("start: no .tickmarkr/config.yaml here — run tickmarkr init first");
      expect(snapshot(bare.repo)).toEqual(before);
    });

    const { repo, fake } = fixture(ROUTED);
    await withIsolatedXdg(repo, async () => {
      const before = snapshot(repo);
      const usage = `usage: tickmarkr start "<what you want built>" [--yes] [--force]`;
      await expect(start(["--yes"], repo, [fake])).rejects.toThrow(usage);
      await expect(start(["  ", "", "\t", "--yes"], repo, [fake])).rejects.toThrow(usage);
      expect(snapshot(repo)).toEqual(before);
      expect(existsSync(join(repo, "specs"))).toBe(false);

      for (const seeded of [INTENT, SPEC]) {
        const seededRepo = fixture(ROUTED).repo;
        mkdirSync(join(seededRepo, "specs"), { recursive: true });
        writeFileSync(join(seededRepo, seeded), "operator-authored\n");
        const seededBefore = snapshot(seededRepo);
        const err = await start([SENTENCE, "--yes"], seededRepo, [fake]).then(() => undefined, (e: Error) => e);
        expect(err?.message).toContain(seeded);
        expect(err?.message).toContain("--force");
        expect(snapshot(seededRepo)).toEqual(seededBefore);

        const card = await start([SENTENCE, "--yes", "--force"], seededRepo, [fake]);
        expect(card).toContain("next: tickmarkr run");
        expect(readFileSync(join(seededRepo, SPEC), "utf8")).toBe(ROUTED);
        expect(readFileSync(join(seededRepo, INTENT), "utf8")).toBe(`# ${SENTENCE}\n\n${SENTENCE}\n`);
      }
    });
  });

  test("when scope refuses without yes on a non-TTY, start removes the intent it created and rethrows scope's not-confirmed error, while an intent that existed before the call and was forced survives, so a refused start that leaves a stray intent or deletes the user's file fails", async () => {
    const { repo, fake } = fixture(ROUTED);
    await withIsolatedXdg(repo, () => withoutTTY(async () => {
      await expect(start([SENTENCE], repo, [fake])).rejects.toThrow(/^scope: not confirmed \(pass --yes or confirm at a TTY\)$/);
      expect(existsSync(join(repo, INTENT))).toBe(false);
      expect(existsSync(join(repo, SPEC))).toBe(false);
      expect(existsSync(join(repo, ".tickmarkr", "graph.json"))).toBe(false);

      writeFileSync(join(repo, INTENT), "operator intent\n");
      await expect(start([SENTENCE, "--force"], repo, [fake])).rejects.toThrow(/^scope: not confirmed \(pass --yes or confirm at a TTY\)$/);
      expect(existsSync(join(repo, INTENT))).toBe(true);
      expect(existsSync(join(repo, SPEC))).toBe(false);
    }));
  });

  test("with yes, a spec-shape map pin on the fake adapter and an implement-shape pin on an unavailable model, drafting and compile succeed and the implement task renders a not routable yet row with plan's reason; the not ready line follows the task rows and precedes the two command footer lines, and the next-run line is absent, so a card that offers run over an unroutable task fails", async () => {
    const { repo, fake } = fixture(ROUTED, [
      "judge: { adapter: fake, model: fake-1 }",
      "routing:",
      "  map:",
      "    spec:",
      "      pin: { via: fake, model: fake-1 }",
      "    implement:",
      "      pin: { via: fake, model: absent }",
      "",
    ].join("\n"));
    await withIsolatedXdg(repo, async () => {
      const card = await start([SENTENCE, "--yes"], repo, [fake]);
      expect(readFileSync(join(repo, SPEC), "utf8")).toBe(ROUTED);
      expect(loadGraph(repo).tasks).toHaveLength(2);

      const { rows } = await planRows(repo, fake);
      const [implement, chore] = rows;
      expect(implement!.worker).toBeUndefined();
      expect(implement!.blocked).toContain("pinned fake:absent not available");
      expect(chore!.worker).toBeDefined();

      const lines = card.split("\n");
      expect(lines).toEqual([
        `tickmarkr start — ${SENTENCE}`,
        `drafted ${SPEC} · 2 tasks · compiled`,
        "",
        "  1. Serve the health route [REQ-01]",
        `     not routable yet: ${implement!.blocked}`,
        "  2. Document the health route [REQ-01]",
        `     builds: ${chore!.worker!.adapter}:${chore!.worker!.model} · reviews: ${chore!.review} · 2 acceptance checks`,
        "",
        "not ready — 1 task cannot route yet; tickmarkr plan says why",
        `change it first: edit ${SPEC}, then tickmarkr compile ${SPEC} && tickmarkr plan`,
        "full routing detail: tickmarkr plan",
      ]);
      expect(card).not.toContain("next: tickmarkr run");
    });
  });
});
