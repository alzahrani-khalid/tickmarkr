import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { contextWindowLints, estimateTaskPayloadTokens } from "../../src/adapters/model-lints.js";
import { compileSource } from "../../src/compile/index.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import type { Task } from "../../src/graph/schema.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// OBS-535 was measured against a live 41-task graph and against nothing in this repo: every fixture
// here declared plain files[] and no context, which is exactly why pricing write scope as payload
// survived until a real graph met it. fixtures/payload-shape/p99-shaped.spec.md carries that graph's
// shape at five tasks; this suite is the fence around it.
const FIXTURE = "fixtures/payload-shape/p99-shaped.spec.md";
// The fixture cites paths absent from every base tree on purpose (wave-1 outputs, a gitignored
// ruling), so it must compile where compileNative's reachability check fails open — outside a repo.
const compileFixture = (): Task[] => {
  const dir = makeTestTempDir("tickmarkr-payload-shape-");
  const spec = join(dir, "p99-shaped.spec.md");
  copyFileSync(FIXTURE, spec);
  return compileSource(spec).tasks;
};

// 10 localisation sources at 90k chars each: ~225k tokens once the brace glob is priced, against
// cursor-agent:composer-2.5's declared 200k window. Under-pricing the glob (the pre-OBS-535
// behaviour, and any future regression) drops T2 below the window and the overflow lint disappears.
const SOURCE_BYTES = 90_000;
const LOCALES = ["ar", "en"] as const;
const NAMESPACES = ["common", "dossier", "intake", "tasks", "settings"] as const;

const fixtureRepo = (): string => {
  const files: Record<string, string> = {
    "docs/payload-shape/PLAN.md": "the plan every task reads\n",
    ".gitignore": ".state/\n",
  };
  for (const locale of LOCALES) {
    for (const namespace of NAMESPACES) files[`src/i18n/${locale}/${namespace}.json`] = "x".repeat(SOURCE_BYTES);
  }
  const repo = makeRepo(files);
  // present in the checkout, reachable by no commit — the class RULING-P99-14 found (17 tasks)
  mkdirSync(join(repo, ".state"), { recursive: true });
  writeFileSync(join(repo, ".state", "RULING-TERMINOLOGY.md"), "x".repeat(1_000));
  return repo;
};

const lintsFor = (tasks: Task[], repo: string) =>
  contextWindowLints(
    tasks,
    tasks.map((t) => ({ taskId: t.id, adapter: "cursor-agent", model: "composer-2.5" })),
    DEFAULT_CONFIG,
    repo,
  );
const forTask = (lints: string[], id: string) => lints.filter((l) => l.startsWith(`${id}:`));

describe("the P99-shaped payload fixture (OBS-535 regression fence)", () => {
  test("the fixture still carries the four shape features it was vendored for, so a later edit cannot quietly turn it into an ordinary graph", () => {
    const tasks = compileFixture();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    expect([...byId.keys()]).toEqual(["T1", "T2", "T3", "T4", "T5"]);

    // 1. brace-glob write scope, intact through the parser (commas inside braces are not separators)
    expect(byId.get("T1")!.files).toContain("scripts/{audit-strict.mjs,census.mjs}");
    expect(byId.get("T2")!.files.some((f) => f.startsWith("src/i18n/{") && f.split(",").length === 10)).toBe(true);
    // 2. an output declared in files[]
    expect(byId.get("T1")!.files).toContain(".planning/payload-shape/T1-SUMMARY.md");
    // 3. a wave-1 artifact consumed by a TRANSITIVE dependent: T3 -> T2 -> T1 writes scripts/census.mjs
    expect(byId.get("T3")!.deps).toEqual(["T2"]);
    expect(byId.get("T3")!.context).toContain("scripts/census.mjs");
    // 4. the same class of artifact cited with no producer upstream, and a gitignored ref
    expect(byId.get("T4")!.deps).toEqual([]);
    expect(byId.get("T4")!.context).toContain("scripts/audit-strict.mjs");
    expect(byId.get("T5")!.context).toContain(".state/RULING-TERMINOLOGY.md");
  });

  test("write scope is priced, not billed as unreadable payload: the comparison is ARMED on every task, the brace glob's tracked bytes are charged, and a task whose only unmeasurable path is its own output still gets a number", () => {
    const tasks = compileFixture();
    const repo = fixtureRepo();
    const lints = lintsFor(tasks, repo);

    // T1: outputs and a brace glob that matches nothing yet — measurable anyway, and silent
    expect(estimateTaskPayloadTokens(tasks.find((t) => t.id === "T1")!, repo)).toBeTypeOf("number");
    expect(forTask(lints, "T1")).toEqual([]);

    // T2: the 10-branch glob over tracked sources is charged, so the payload clears the 200k window.
    // The one unmeasurable ref (scripts/audit-strict.mjs, written by T1) is named as a lower bound.
    expect(forTask(lints, "T2")).toEqual([
      expect.stringMatching(
        /^T2: payload ~\d{6} tokens exceeds cursor-agent:composer-2\.5 window 200000 \(lower bound — 1 context ref\(s\) are produced upstream and not yet measurable\)$/,
      ),
    ]);
    // The charge is the glob's, not the prompt's: the same task under a 2-file scope stays silent.
    expect(forTask(lintsFor(tasks, repo), "T3")).toEqual([]);
  });

  test("an absent context ref is classified by who can satisfy it: silent when a transitive dependency writes it, named when no task does, and named as uncarryable when it is gitignored", () => {
    const tasks = compileFixture();
    const repo = fixtureRepo();
    const lints = lintsFor(tasks, repo);

    // T3 reads scripts/census.mjs, written by T1 two hops upstream — reachable at dispatch, no lint
    expect(forTask(lints, "T3")).toEqual([]);

    // T4 cites the same shape of path with nothing upstream to write it
    expect(forTask(lints, "T4")).toEqual([
      'T4: context unreachable — "scripts/audit-strict.mjs" is absent from the base tree and no task in this graph produces it; the worker\'s "read these first" list dangles and the context-window comparison is skipped',
    ]);

    // T5's ref exists in the checkout under a gitignored tree: no commit can carry it to a worktree
    expect(forTask(lints, "T5")).toEqual([
      'T5: context unreachable — ".state/RULING-TERMINOLOGY.md" is gitignored — no commit can carry it into a worktree; the worker\'s "read these first" list dangles and the context-window comparison is skipped',
    ]);
  });
});
