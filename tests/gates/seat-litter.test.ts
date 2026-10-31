import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { type Assignment, type BillingChannel, shq } from "../../src/adapters/types.js";
import { narrationRow, RAIL_ROWS } from "../../src/cli/commands/run.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { type GateContext, type GateEvent, runGates } from "../../src/gates/run-gates.js";
import { validateGraph } from "../../src/graph/schema.js";
import { Journal } from "../../src/run/journal.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// Exercise real Git snapshots except when forcing the preservation boundary to fail or race.
const preservation = vi.hoisted(() => ({ mode: "real" as "real" | "throw" | "empty" | "new-dirt" }));
vi.mock("../../src/run/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/git.js")>();
  return { ...actual, preserveWorktree: async (...args: Parameters<typeof actual.preserveWorktree>) => {
    if (preservation.mode === "throw") throw new Error("forced preservation failure");
    if (preservation.mode === "empty") return undefined;
    const ref = await actual.preserveWorktree(...args);
    if (preservation.mode === "new-dirt") writeFileSync(join(args[0], "late-litter.txt"), "late\n");
    return ref;
  } };
});

const author: Assignment = { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" };
const channels: BillingChannel[] = [
  { adapter: "fake", vendor: "fake-a", model: "fake-1", channel: "sub", tier: "frontier" },
  { adapter: "fake", vendor: "fake-b", model: "fake-2", channel: "api", tier: "frontier" },
];
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

class ReviewSeat extends FakeAdapter {
  constructor(script: string, private readonly effect: string) { super(script); }
  override headlessCommand(prompt: string, model: string): string {
    const inner = super.headlessCommand(prompt, model);
    return readFileSync(prompt, "utf8").includes("TICKMARKR-REVIEW")
      ? `(${inner}) && (${this.effect})` : inner;
  }
}

function fixture(effect = "mkdir -p seat && printf 'seat bytes\\n' > seat/note.txt", deleted = false) {
  const repo = makeRepo({ "src/a.ts": "export const a = 1;\n", "café.txt": "old\n", ".gitignore": "test-ran\n" });
  const baseRef = git(repo, "rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
  if (deleted) git(repo, "rm", "café.txt");
  git(repo, "add", "-A");
  git(repo, "commit", "--no-gpg-sign", "-qm", "subject");
  const head = git(repo, "rev-parse", "HEAD").trim();
  const diff = git(repo, "diff", `${baseRef}..HEAD`);
  const script = join(makeTestTempDir("tickmarkr-seat-litter-"), "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {}, review: { approve: true, issues: [] } }));
  const cfg = structuredClone(DEFAULT_CONFIG);
  const task = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "h" },
    tasks: [{ id: "T1", title: "seat litter", goal: "test the committed subject", shape: "implement",
      complexity: 8, files: ["**"], acceptance: ["passes"], gates: ["build", "lint", "evidence", "scope", "review", "test"] }],
  }).tasks[0];
  const events: GateEvent[] = [];
  const run = (over: Partial<GateContext> = {}) => runGates(task, {
    worktree: repo, baseRef, author, channels, cfg, adapters: [new ReviewSeat(script, effect)],
    result: { ok: true, summary: "subject committed", deviations: [], raw: "" },
    // This command records its execution only if it observes the actual committed, clean subject.
    commands: { test: 'test -z "$(git status --porcelain --untracked-files=all)" && echo passed >> test-ran' },
    baseline: { commands: { test: { exitCode: 0, fingerprints: [] } } },
    onGate: (event) => { events.push(event); }, ...over,
  });
  const cleared = () => events.find((e): e is Extract<GateEvent, { phase: "note" }> =>
    e.phase === "note" && e.name === "worktree-litter-cleared");
  return { repo, baseRef, head, diff, events, run, cleared };
}

describe("post-semantic seat litter clearance", () => {
  test("test: in a daemon-owned worktree a review seat that leaves an untracked nested file after the semantic stage has the file preserved on a recovery ref and removed, a worktree-litter-cleared note names it and the ref, and the test gate runs and passes, so a round still refused for seat litter fails", async () => {
    const f = fixture();
    const result = await f.run({ ownsWorktree: true });
    expect(result.results.every((r) => r.pass)).toBe(true);
    expect(result.results.find((r) => r.gate === "test")).toMatchObject({ pass: true });
    expect(readFileSync(join(f.repo, "test-ran"), "utf8")).toBe("passed\n");
    expect(existsSync(join(f.repo, "seat/note.txt"))).toBe(false);
    expect(lstatSync(join(f.repo, "seat")).isDirectory()).toBe(true);
    const note = f.cleared()!;
    expect(note.payload.paths).toEqual(["seat/note.txt"]);
    const ref = note.payload.preservedRef as string;
    expect(ref).toMatch(/^refs\/tickmarkr\/preserved\/[0-9a-f]{40,64}$/);
    expect(git(f.repo, "show", `${ref}:seat/note.txt`)).toBe("seat bytes\n");
    expect(note.payload).not.toHaveProperty("gate");
    expect(note.payload.reason).toContain("1");
    expect(note.payload.reason).toContain("seat/note.txt");
    expect(note.payload.reason).toContain(ref);
    const noteAt = f.events.indexOf(note);
    expect(noteAt).toBeGreaterThan(f.events.findIndex((e) => e.phase === "end" && e.gate === "review"));
    expect(noteAt).toBeLessThan(f.events.findIndex((e) => e.phase === "start" && e.gate === "test"));
    expect(git(f.repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git(f.repo, "rev-parse", "HEAD").trim()).toBe(f.head);
    expect(git(f.repo, "diff", `${f.baseRef}..HEAD`)).toBe(f.diff);
  });

  test("test: without the ownership flag the same seat litter is refused at the test gate as before and the file is still on disk, so a clearance that reaches tickmarkr verify and the operator's own checkout fails", async () => {
    const f = fixture();
    const { results } = await f.run();
    expect(results.find((r) => r.gate === "review")?.pass).toBe(true);
    expect(results.find((r) => r.gate === "test")).toMatchObject({ pass: false,
      meta: { dirtyWorktree: true, paths: ["seat/note.txt"] } });
    expect(readFileSync(join(f.repo, "seat/note.txt"), "utf8")).toBe("seat bytes\n");
    expect(existsSync(join(f.repo, "test-ran"))).toBe(false);
    expect(f.cleared()).toBeUndefined();
  });

  test("test: a tracked file modified during the semantic stage, an untracked path present in the committed diff, an untracked directory, and a failed preservation each still refuse at the test gate with nothing removed, so a clearance wider than untracked litter outside the diff fails", async () => {
    const cases = [
      { name: "tracked", effect: "echo litter > 00-keep.txt; echo changed >> src/a.ts", paths: ["00-keep.txt", "src/a.ts"] },
      { name: "committed diff", effect: "echo litter > 00-keep.txt; echo recreated > café.txt", deleted: true, paths: ["00-keep.txt", "café.txt"] },
      { name: "directory", effect: "echo litter > 00-keep.txt; git init -q seat-dir && git -C seat-dir -c user.name=test -c user.email=test@local commit --allow-empty --no-gpg-sign -qm seed && echo keep > seat-dir/kept.txt", paths: ["00-keep.txt", "seat-dir/kept.txt"] },
      { name: "preservation throws", mode: "throw" as const, effect: "echo litter > 00-keep.txt", paths: ["00-keep.txt"] },
      { name: "preservation returns no ref", mode: "empty" as const, effect: "echo litter > 00-keep.txt", paths: ["00-keep.txt"] },
    ];
    for (const c of cases) {
      const f = fixture(c.effect, c.deleted);
      preservation.mode = c.mode ?? "real";
      try {
        const { results } = await f.run({ ownsWorktree: true });
        expect(results.find((r) => r.gate === "test"), c.name).toMatchObject({ pass: false, meta: { dirtyWorktree: true } });
        for (const path of c.paths) expect(existsSync(join(f.repo, path)), `${c.name}: ${path}`).toBe(true);
        expect(existsSync(join(f.repo, "test-ran")), c.name).toBe(false);
        expect(f.cleared(), c.name).toBeUndefined();
      } finally { preservation.mode = "real"; }
    }
  });

  test("test: a worktree-litter-cleared journal event renders as a rail row carrying the litter cleared label and its reason sentence, so an event the TTY rail suppresses fails", async () => {
    const f = fixture();
    const journal = Journal.create(makeTestTempDir("tickmarkr-litter-journal-"), "run-seat-litter");
    await f.run({ ownsWorktree: true, onGate: (e) => {
      if (e.phase === "note") journal.append(e.name, "T1", e.payload);
    } });
    const event = journal.read().find((e) => e.event === "worktree-litter-cleared")!;
    expect(event).toBeDefined();
    expect(event.data).not.toHaveProperty("gate");
    expect(RAIL_ROWS[event.event]).toEqual({ label: "litter cleared", tone: "attention" });
    const row = narrationRow(event, "run-seat-litter", 400);
    expect(row).not.toBeNull();
    expect(row).toContain("litter cleared");
    expect(row).toContain(event.data.reason);
  });

  test("symlinks and multiple losslessly named nested files are preserved and unlinked without touching their targets", async () => {
    const target = join(makeTestTempDir("tickmarkr-litter-target-"), "target");
    writeFileSync(target, "outside\n");
    const path = "seat/café 'notes\n.txt";
    const f = fixture(`mkdir seat; printf bytes > ${shq(path)}; ln -s ${shq(target)} seat/link`);
    const { results } = await f.run({ ownsWorktree: true });
    expect(results.every((r) => r.pass)).toBe(true);
    const ref = f.cleared()!.payload.preservedRef as string;
    expect(f.cleared()!.payload.paths).toEqual([path, "seat/link"]);
    expect(git(f.repo, "show", `${ref}:${path}`)).toBe("bytes");
    expect(git(f.repo, "show", `${ref}:seat/link`)).toBe(target);
    expect(git(f.repo, "ls-tree", ref, "seat/link")).toContain("120000 blob");
    expect(existsSync(join(f.repo, path))).toBe(false);
    expect(existsSync(join(f.repo, "seat/link"))).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("outside\n");
  });

  test("new dirt observed by the fresh post-unlink check refuses and restores the cleared files", async () => {
    const f = fixture();
    preservation.mode = "new-dirt";
    try {
      const { results } = await f.run({ ownsWorktree: true });
      expect(results.find((r) => r.gate === "test")).toMatchObject({ pass: false, meta: { dirtyWorktree: true } });
      expect(readFileSync(join(f.repo, "seat/note.txt"), "utf8")).toBe("seat bytes\n");
      expect(existsSync(join(f.repo, "late-litter.txt"))).toBe(true);
      expect(existsSync(join(f.repo, "test-ran"))).toBe(false);
      expect(f.cleared()).toBeUndefined();
    } finally { preservation.mode = "real"; }
  });
});
