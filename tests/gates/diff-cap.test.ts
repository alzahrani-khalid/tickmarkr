import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, DEFAULT_DIFF_CAP } from "../../src/config/config.js";
import { acceptanceGate } from "../../src/gates/acceptance.js";
import {
  CAPTURE_ARTIFACT_MANIFEST,
  captureDiffCapFor,
  measureArtifactDiff,
  type CaptureArtifactManifest,
} from "../../src/gates/artifact-manifest.js";
import * as llm from "../../src/gates/llm.js";
import {
  checkDiffCap,
  checkTaskDiffCaps,
  diffCapParkReason,
  fetchTaskDiff,
  isDiffCapPark,
  REGENERABLE_CAPTURE_PATHS,
  reviewGate,
} from "../../src/gates/review.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeRepo } from "../helpers/tmprepo.js";

function scatteredSweepRepo(fileCount: number, lineLen: number): { repo: string; base: string } {
  const ctx = `${"c".repeat(lineLen)}\n`;
  const files: Record<string, string> = {};
  for (let i = 0; i < fileCount; i++) {
    // multi-line docs: one changed line per file; default diff carries ~3 lines of context per hunk.
    files[`docs/f${i}.md`] = `${ctx}${ctx}${"x".repeat(lineLen)}\n${ctx}${ctx}`;
  }
  const repo = makeRepo(files);
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  for (let i = 0; i < fileCount; i++) {
    const content = `${ctx}${ctx}${"y".repeat(lineLen)}\n${ctx}${ctx}`;
    writeFileSync(join(repo, `docs/f${i}.md`), content);
  }
  execSync("git add -A && git commit --no-gpg-sign -m sweep", { cwd: repo });
  return { repo, base };
}

function deletionHeavyRepo(): { repo: string; base: string } {
  const retiredBody = (label: string) =>
    Array.from({ length: 120 }, (_, i) => `export const ${label}_${i} = "${"x".repeat(80)}";`).join("\n") + "\n";
  const repo = makeRepo({
    "retired/alpha.ts": retiredBody("alpha"),
    "retired/beta.ts": retiredBody("beta"),
    "kept.ts": "export const kept = 'before';\n",
  });
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  rmSync(join(repo, "retired"), { recursive: true });
  writeFileSync(join(repo, "kept.ts"), "export const kept = 'after';\n");
  execSync("git add -A && git commit --no-gpg-sign -m retire", { cwd: repo });
  return { repo, base };
}

function fakeWith(script: Record<string, unknown>): FakeAdapter {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-diffcap-"));
  const p = join(dir, "s.json");
  writeFileSync(p, JSON.stringify({ tasks: {}, ...script }));
  const fake = new FakeAdapter(p);
  return fake;
}

const CAP = DEFAULT_DIFF_CAP;

const judgeTask = validateGraph({
  version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{ id: "T1", title: "sweep", goal: "g", shape: "docs", complexity: 3, acceptance: ["token sweep ok"] }],
}).tasks[0];

const reviewTask = validateGraph({
  version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{ id: "T1", title: "sweep", goal: "g", shape: "implement", complexity: 9, acceptance: ["ok"] }],
}).tasks[0];

describe("diff cap — OBS-48 zero-context metric", () => {
  test("scattered one-line hunks: full diff over cap, -U0 under cap, gate passes to judge", async () => {
    const { repo, base } = scatteredSweepRepo(95, 200);
    const { full, forCap } = await fetchTaskDiff(repo, base);
    expect(full.length).toBeGreaterThan(CAP);
    expect(forCap.length).toBeLessThanOrEqual(CAP);

    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] } });
    let calls = 0;
    const cmd = fake.headlessCommand.bind(fake);
    fake.headlessCommand = (...args) => { calls++; return cmd(...args); };

    const r = await acceptanceGate(judgeTask, repo, base, { adapter: fake, model: "fake-1" });
    expect(r.pass).toBe(true);
    expect(calls).toBe(1);
  });

  test("a diff whose added and modified content alone exceeds the cap still fails closed with the same guidance as before", async () => {
    const { repo, base } = scatteredSweepRepo(400, 280);
    const { forCap } = await fetchTaskDiff(repo, base);
    expect(forCap.length).toBeGreaterThan(CAP);

    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] } });
    let calls = 0;
    const cmd = fake.headlessCommand.bind(fake);
    fake.headlessCommand = (...args) => { calls++; return cmd(...args); };

    const r = await acceptanceGate(judgeTask, repo, base, { adapter: fake, model: "fake-1" }, undefined, { diffCap: CAP });
    expect(r.pass).toBe(false);
    expect(r.details).toMatch(/diff exceeds verifiable cap/i);
    expect(calls).toBe(0);
    expect(isDiffCapPark(r)).toBe(true);
    const prior = checkDiffCap("acceptance", forCap.length, CAP)!;
    expect(r.details.endsWith(prior.details)).toBe(true);
    expect(r.meta).toEqual(prior.meta);
  });
});

describe("diff cap — OBS-134 deletion facts", () => {
  test("a diff dominated by whole-file deletions passes the cap when its added and modified content is under the limit", async () => {
    const { repo, base } = deletionHeavyRepo();
    const { forCap } = await fetchTaskDiff(repo, base);
    const cap = 1_000;
    expect(forCap.length).toBeGreaterThan(cap);

    const fake = fakeWith({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "retired" }] } });
    let calls = 0;
    const cmd = fake.headlessCommand.bind(fake);
    fake.headlessCommand = (...args) => { calls++; return cmd(...args); };

    const r = await acceptanceGate(judgeTask, repo, base, { adapter: fake, model: "fake-1" }, undefined, { diffCap: cap });
    expect(r.pass).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("diff cap — shared implementation", () => {
  test("acceptance and review import the same checkDiffCap", () => {
    const fail = checkDiffCap("acceptance", 70_000, CAP);
    expect(fail?.meta).toEqual({ park: "human" });
    expect(checkDiffCap("review", CAP, CAP)).toBeNull();
  });

  test("review gate uses the same cap path as acceptance", async () => {
    const { repo, base } = scatteredSweepRepo(400, 280);
    const fake = fakeWith({ review: { approve: true, issues: [] } });
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.judge.adapter = "fake";
    cfg.gates.diffCap = CAP;
    const channels = [
      { adapter: "fake", vendor: "a", model: "fake-1", channel: "sub" as const, tier: "frontier" as const },
      { adapter: "fake", vendor: "b", model: "fake-2", channel: "api" as const, tier: "frontier" as const },
    ];
    const author = { adapter: "fake", model: "fake-1", channel: "sub" as const, tier: "frontier" as const };
    let calls = 0;
    const cmd = fake.headlessCommand.bind(fake);
    fake.headlessCommand = (...args) => { calls++; return cmd(...args); };

    const r = await reviewGate(reviewTask, repo, base, author, channels, [fake], cfg);
    expect(r.pass).toBe(false);
    expect(isDiffCapPark(r)).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("diff cap — park('human') policy", () => {
  test("cap trip carries park meta and the remedy message", () => {
    const fail = checkDiffCap("acceptance", 80_728, 60_000)!;
    expect(fail.meta).toEqual({ park: "human" });
    expect(fail.details).toMatch(/split the task/i);
    expect(fail.details).toMatch(/raise gates\.diffCap/i);
  });

  test("diffCapParkReason short-circuits escalation — no ladder steps consumed", () => {
    const capFail = checkDiffCap("acceptance", 80_728, CAP)!;
    const results = [
      { gate: "scope", pass: true, details: "ok" },
      capFail,
    ];
    const reason = diffCapParkReason(results);
    expect(reason).toMatch(/diff exceeds verifiable cap/i);
    const ladder = ["retry", "escalate", "consult"];
    const stepsTaken = isDiffCapPark(capFail) ? [] : ladder;
    expect(stepsTaken).toEqual([]);
  });

  test("the separate capture cap is finite and uses the same human-park lifecycle", () => {
    const captureCap = captureDiffCapFor(CAP);
    const fail = checkTaskDiffCaps(
      "acceptance",
      { logicBytes: CAP, captureBytes: captureCap + 1 },
      CAP,
    )!;
    expect(fail.details).toContain(`capture cap (${captureCap + 1} > ${captureCap})`);
    expect(isDiffCapPark(fail)).toBe(true);
    expect(diffCapParkReason([fail])).toBe(fail.details);
  });
});

// ---------------------------------------------------------------------------
// v1.82 T1 — the verifiable cap measures what a READER MUST READ, not what a run
// must write. The regenerable frame corpora are asserted byte-for-byte by the
// corpus tests and never read, so counting them is a category error. The frozen
// appearance anchors and the captured engagement journals are reviewed evidence
// and keep counting, under every shape.
// ---------------------------------------------------------------------------

const CAPTURES = REGENERABLE_CAPTURE_PATHS;
const FRAME_CAPTURE = CAPTURES.find((p) => p.startsWith("tests/fixtures/cockpit/frames/"))!;
const COLOUR_CAPTURE = CAPTURES.find((p) => p.startsWith("tests/fixtures/cockpit/colour/"))!;
const SPARE_CAPTURES = CAPTURES.filter((p) => p !== FRAME_CAPTURE && p !== COLOUR_CAPTURE);
// deliberately the SAME BASENAME as a manifest frame: only the full path separates the frozen
// oracle from its regenerable twin, so a shape-based membership rule would swallow it.
const ANCHOR = `tests/fixtures/cockpit/anchors/${FRAME_CAPTURE.split("/").at(-1)}`;
const JOURNAL = "tests/fixtures/cockpit/sources/run-20260724-231138.journal.jsonl";
const COLOUR_JOURNAL = "tests/fixtures/cockpit/colour/sources/run-20260718-000943.journal.jsonl";
const UNMANIFESTED = "tests/fixtures/cockpit/frames/scratch-not-in-manifest.txt";
// pinned from the receipt itself: the withheld headers + hunk of a one-line box-drawing capture.
const EXACT_WITHHELD_BYTES = 187;

// box-drawing rows: the bytes a real captured frame is made of, and the reason a UTF-16 code-unit
// count and a UTF-8 byte count disagree about their size.
const frameBody = (label: string, rows = 60) =>
  Array.from({ length: rows }, (_, i) => `│ ${label} row ${i} ${"─".repeat(60)} │`).join("\n") + "\n";

const everyCapture = (label: string) =>
  Object.fromEntries(CAPTURES.map((p) => [p, frameBody(label)])) as Record<string, string>;

function applyChange(repo: string, after: Record<string, string | null>): void {
  for (const [p, content] of Object.entries(after)) {
    const full = join(repo, p);
    if (content === null) { rmSync(full); continue; }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function repoWithChange(
  before: Record<string, string>,
  after: Record<string, string | null>,
  extra?: (repo: string) => void,
): { repo: string; base: string } {
  const repo = makeRepo(before);
  const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
  applyChange(repo, after);
  extra?.(repo);
  execSync("git add -A && git commit --no-gpg-sign -m change", { cwd: repo });
  return { repo, base };
}

// the diff as it was BEFORE this task existed — no exclusion applied, the size that parked the run.
const rawU0 = (repo: string, base: string) =>
  execSync(`git diff -U0 ${base}..HEAD`, { cwd: repo, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
const rawFull = (repo: string, base: string) =>
  execSync(`git diff ${base}..HEAD`, { cwd: repo, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });

function capturingFake(script: Record<string, unknown>): { fake: FakeAdapter; prompts: string[] } {
  const fake = fakeWith(script);
  const prompts: string[] = [];
  const orig = fake.headlessCommand.bind(fake);
  fake.headlessCommand = (promptFile, model) => {
    prompts.push(readFileSync(promptFile, "utf8"));
    return orig(promptFile, model);
  };
  return { fake, prompts };
}

function observedPromptDiff(
  prompt: string,
  heading: "## Diff (vs base)" | "## Diff",
): {
  rendered: string;
  logicBytes: number;
  captureBytes: number;
  classifications: readonly {
    readonly kind: "capture" | "logic";
    readonly path?: string;
    readonly producer?: string;
  }[];
} {
  const opening = `${heading}\n\`\`\`diff\n`;
  const start = prompt.indexOf(opening);
  if (start === -1) throw new Error(`missing ${heading} fence`);
  const contentStart = start + opening.length;
  const end = prompt.indexOf("\n```", contentStart);
  if (end === -1) throw new Error(`unterminated ${heading} fence`);
  const rendered = prompt.slice(contentStart, end);
  const sections = rendered.split(/(?=^diff --git )/m).filter(Boolean);
  const classifications = sections.map((section) => {
    const receipt = /^set aside: regenerable capture (.+?) — (\d+) bytes withheld \(producer ([^;]+);/m.exec(section);
    return receipt
      ? { kind: "capture" as const, path: receipt[1], producer: receipt[3] }
      : { kind: "logic" as const };
  });
  const captureBytes = [...rendered.matchAll(
    /^set aside: regenerable capture .+? — (\d+) bytes withheld\b/gm,
  )].reduce((sum, match) => sum + Number(match[1]), 0);
  return {
    rendered,
    logicBytes: Buffer.byteLength(rendered, "utf8"),
    captureBytes,
    classifications,
  };
}

const CHANNELS = [
  { adapter: "fake", vendor: "a", model: "fake-1", channel: "sub" as const, tier: "frontier" as const },
  { adapter: "fake", vendor: "b", model: "fake-2", channel: "api" as const, tier: "frontier" as const },
];
const AUTHOR = { adapter: "fake", model: "fake-1", channel: "sub" as const, tier: "frontier" as const };

function reviewCfg(cap: number) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.judge.adapter = "fake";
  cfg.gates.diffCap = cap;
  return cfg;
}

// structured {path, line} evidence, never the fake seam's free-text quote (clause 8).
const citing = (path: string, line: number) => ({
  pass: true,
  criteria: [{ criterion: "c1", met: true, reason: "ok", evidence: { path, line } }],
});

const runAcceptance = (repo: string, base: string, fake: FakeAdapter, diffCap: number) =>
  acceptanceGate(judgeTask, repo, base, { adapter: fake, model: "fake-1" }, undefined, { diffCap });

const runReview = (repo: string, base: string, fake: FakeAdapter, cap: number) =>
  reviewGate(reviewTask, repo, base, AUTHOR, CHANNELS, [fake], reviewCfg(cap));

describe("diff cap — v1.82 T1 regenerable capture boundary", () => {
  // Clause 1's other half: the gate's member list is the SHIPPED manifest, not a hand-kept guess. The
  // gate cannot import this module (it is the Ink renderer, and dragging the TUI into every gate's
  // module graph memoises chalk's colour level and turns the fleet suite red), so the equality is
  // asserted here instead — add, rename or drop a frame case and this goes red until the gate matches.
  test("the gate's member list is exactly the shipped capture manifest, and every member exists", async () => {
    const { COLOUR_FRAME_CASES, GOLDEN_FRAME_CASES } = await import("../../src/tui/cockpit/capture.js");
    expect([...CAPTURES].sort()).toEqual([
      ...GOLDEN_FRAME_CASES.map((c) => `tests/fixtures/cockpit/frames/${c.fixture}`),
      ...COLOUR_FRAME_CASES.map((c) => `tests/fixtures/cockpit/colour/${c.fixture}`),
    ].sort());
    // and the directories are the real ones: a member that does not exist would silently discount nothing
    const repoRoot = new URL("../../", import.meta.url).pathname;
    expect(CAPTURES.filter((p) => !existsSync(join(repoRoot, p)))).toEqual([]);
  });

  test("test: a change confined to the regenerable frame corpora no longer counts toward the verifiable cap at either gate that measures it", async () => {
    const { repo, base } = repoWithChange(
      { "src/keep.ts": "export const keep = 1;\n", ...everyCapture("before") },
      everyCapture("after"),
    );
    const small = 20_000;
    const { forCap } = await fetchTaskDiff(repo, base);
    expect(rawU0(repo, base).length).toBeGreaterThan(small);
    expect(forCap.length).toBeLessThanOrEqual(small);

    const { fake: judge } = capturingFake({ judge: citing(FRAME_CAPTURE, 0) });
    const accepted = await runAcceptance(repo, base, judge, small);
    expect(accepted.pass).toBe(true);

    const reviewed = await runReview(repo, base, fakeWith({ review: { approve: true, issues: [] } }), small);
    expect(isDiffCapPark(reviewed)).toBe(false);
    expect(reviewed.pass).toBe(true);
  });

  test("test: a corpus regeneration large enough to have parked the task before now passes both measuring gates", async () => {
    const { repo, base } = repoWithChange(everyCapture("before"), everyCapture("after"));
    // the wall this task removes: the same regeneration, measured the old way, parked for a human.
    const raw = rawU0(repo, base);
    expect(raw.length).toBeGreaterThan(DEFAULT_DIFF_CAP);
    expect(isDiffCapPark(checkDiffCap("acceptance", raw.length, DEFAULT_DIFF_CAP)!)).toBe(true);

    const accepted = await runAcceptance(repo, base, fakeWith({ judge: citing(FRAME_CAPTURE, 0) }), DEFAULT_DIFF_CAP);
    expect(accepted.pass).toBe(true);
    const reviewed = await runReview(repo, base, fakeWith({ review: { approve: true, issues: [] } }), DEFAULT_DIFF_CAP);
    expect(reviewed.pass).toBe(true);
  });

  test("test: a source change of the same size still counts, so the exclusion is scoped to what is regenerable rather than to size", async () => {
    // byte-for-byte the same bodies as the regeneration above, written to source paths instead.
    const sourcePath = (p: string) => `src/generated/${p.split("/").at(-1)}`;
    const before = Object.fromEntries(CAPTURES.map((p) => [sourcePath(p), frameBody("before")]));
    const after = Object.fromEntries(CAPTURES.map((p) => [sourcePath(p), frameBody("after")]));
    const { repo, base } = repoWithChange(before, after);
    const { forCap } = await fetchTaskDiff(repo, base);
    expect(forCap.length).toBeGreaterThan(DEFAULT_DIFF_CAP);

    const accepted = await runAcceptance(repo, base, fakeWith({ judge: citing(FRAME_CAPTURE, 0) }), DEFAULT_DIFF_CAP);
    expect(isDiffCapPark(accepted)).toBe(true);
    const reviewed = await runReview(repo, base, fakeWith({ review: { approve: true, issues: [] } }), DEFAULT_DIFF_CAP);
    expect(isDiffCapPark(reviewed)).toBe(true);
  });

  test("test: only a member of the shipped capture manifest is set aside, asserted by placing an unmanifested file beside real captures and observing it measured and shown in full", async () => {
    const stranger = frameBody("stranger", 80);
    const { repo, base } = repoWithChange(
      { [FRAME_CAPTURE]: frameBody("before"), [UNMANIFESTED]: frameBody("before") },
      { [FRAME_CAPTURE]: frameBody("after"), [UNMANIFESTED]: stranger },
    );
    const { full, forCap } = await fetchTaskDiff(repo, base);
    // same directory, same extension, same shape — and it is measured and shown in full anyway
    expect(dirname(UNMANIFESTED)).toBe(dirname(FRAME_CAPTURE));
    expect(full).toContain("│ stranger row 0 ");
    expect(forCap).toContain("│ stranger row 0 ");
    expect(full).not.toContain("│ after row 0 ");
    expect(forCap.length).toBeGreaterThan(stranger.length);

    const { fake, prompts } = capturingFake({ judge: citing(UNMANIFESTED, 1) });
    const r = await runAcceptance(repo, base, fake, DEFAULT_DIFF_CAP);
    expect(r.pass).toBe(true);
    expect(prompts.join("")).toContain("│ stranger row 0 ");
    // and its bytes alone still trip a cap below them: it was never discounted
    expect(isDiffCapPark(await runAcceptance(repo, base, fakeWith({ judge: citing(UNMANIFESTED, 1) }), 2_000))).toBe(true);
  });

  test("test: a change to the frozen appearance oracle counts in full and reaches a reader with its bytes intact, and one large enough to exceed a small cap still parks both gates", async () => {
    const { repo, base } = repoWithChange(
      { [ANCHOR]: frameBody("frozen"), [FRAME_CAPTURE]: frameBody("before") },
      { [ANCHOR]: frameBody("moved"), [FRAME_CAPTURE]: frameBody("after") },
    );
    const { full, forCap } = await fetchTaskDiff(repo, base);
    // the anchor shares its basename with a manifest frame — membership is the PATH, not the shape
    expect(ANCHOR.split("/").at(-1)).toBe(FRAME_CAPTURE.split("/").at(-1));
    expect(full).toContain("│ moved row 0 ");
    expect(forCap).toContain("│ moved row 0 ");
    expect(full).toContain("set aside: regenerable capture " + FRAME_CAPTURE);

    const { fake, prompts } = capturingFake({ judge: citing(ANCHOR, 1) });
    expect(isDiffCapPark(await runAcceptance(repo, base, fake, DEFAULT_DIFF_CAP))).toBe(false);
    expect(prompts.join("")).toContain("│ moved row 0 ");

    const small = 1_000;
    expect(isDiffCapPark(await runAcceptance(repo, base, fakeWith({ judge: citing(ANCHOR, 1) }), small))).toBe(true);
    expect(isDiffCapPark(await runReview(repo, base, fakeWith({ review: { approve: true, issues: [] } }), small))).toBe(true);

    // and REMOVING an anchor is a change too: the whole-file-removal collapse would have shrunk it to a
    // single line and let it slip under the same cap, so protected evidence bypasses that filter as well.
    const gone = repoWithChange({ [ANCHOR]: frameBody("frozen", 200) }, { [ANCHOR]: null });
    expect(isDiffCapPark(await runAcceptance(gone.repo, gone.base, fakeWith({ judge: citing(ANCHOR, 0) }), small))).toBe(true);
    expect(isDiffCapPark(await runReview(gone.repo, gone.base, fakeWith({ review: { approve: true, issues: [] } }), small))).toBe(true);
  });

  test("test: a change to a captured engagement journal counts in full and reaches a reader with its bytes intact", async () => {
    const line = (label: string) => `{"event":"${label}","note":"│ engagement ─ capture │"}\n`;
    const { repo, base } = repoWithChange(
      { [JOURNAL]: line("before"), [COLOUR_JOURNAL]: line("before"), [COLOUR_CAPTURE]: frameBody("before") },
      { [JOURNAL]: line("after"), [COLOUR_JOURNAL]: line("after"), [COLOUR_CAPTURE]: frameBody("after") },
    );
    const { full, forCap } = await fetchTaskDiff(repo, base);
    expect(full).toContain(line("after").trim());
    expect(forCap).toContain(line("after").trim());
    // the colour journals live INSIDE the colour corpus directory and are still not members
    expect(dirname(COLOUR_JOURNAL).startsWith(dirname(COLOUR_CAPTURE))).toBe(true);
    expect(full).toContain("set aside: regenerable capture " + COLOUR_CAPTURE);

    const { fake, prompts } = capturingFake({ judge: citing(JOURNAL, 1) });
    const r = await runAcceptance(repo, base, fake, DEFAULT_DIFF_CAP);
    expect(r.pass).toBe(true);
    expect(prompts.join("")).toContain(line("after").trim());
  });

  test("test: a rename that crosses the boundary in either direction is measured and shown whole, including the line naming where it came from", async () => {
    const inbound = "src/tui/cockpit/inbound.txt";
    const outbound = "src/tui/cockpit/outbound.txt";
    const [intoCorpus, outOfCorpus] = SPARE_CAPTURES;
    const { repo, base } = repoWithChange(
      { [inbound]: frameBody("inbound"), [outOfCorpus!]: frameBody("outbound"), "src/keep.ts": "export const keep = 1;\n" },
      // one line changes on each side so both sections carry a content hunk; similarity stays high
      // enough that git still reports the rename.
      {
        [inbound]: null,
        [intoCorpus!]: frameBody("inbound").replace("row 0", "row 0 edited"),
        [outOfCorpus!]: null,
        [outbound]: frameBody("outbound").replace("row 0", "row 0 edited"),
      },
    );
    const { full, forCap } = await fetchTaskDiff(repo, base);
    for (const [from, to] of [[inbound, intoCorpus!], [outOfCorpus!, outbound]]) {
      expect(full).toContain(`rename from ${from}`);
      expect(full).toContain(`rename to ${to}`);
      expect(forCap).toContain(`rename from ${from}`);
    }
    // both crossings keep their content: one real side is not a member, so neither is set aside
    expect(full).toContain("row 0 edited");
    expect(full).not.toContain("set aside: regenerable capture");
    expect(forCap).not.toContain("set aside: regenerable capture");
  });

  test("test: a newly added capture and a removed capture are each set aside with what happened to them still legible to a reader", async () => {
    const [added, removed] = SPARE_CAPTURES;
    const { repo, base } = repoWithChange(
      { [removed!]: frameBody("removed"), "src/keep.ts": "export const keep = 1;\n" },
      { [added!]: frameBody("added"), [removed!]: null },
    );
    const { full } = await fetchTaskDiff(repo, base);
    expect(full).toContain(`new file mode`);
    expect(full).toContain(`deleted file mode`);
    expect(full).toContain(`set aside: regenerable capture ${added}`);
    expect(full).toContain(`set aside: regenerable capture ${removed}`);
    // content is gone; the account of what happened is not
    expect(full).not.toContain("│ added row 0 ");
    expect(full).not.toContain("│ removed row 0 ");
    // the deletion is never presented as a file that still exists
    const removedSection = full.split(/(?=^diff --git )/m).find((s) => s.includes(`a/${removed} `))!;
    expect(removedSection).toMatch(/^deleted file mode /m);
    expect(removedSection).not.toMatch(/^new file mode /m);
  });

  test("test: a capture whose mode or kind changed without any content change is left exactly as it was rather than given a receipt", async () => {
    const [chmodded, renamedFrom, renamedTo, kindOnly, retargeted] = SPARE_CAPTURES;
    // spelled relative to the capture's own directory, so a regular file holding exactly this string
    // and a symlink pointing at it are the SAME blob: the kind changes, the content does not.
    const linkTarget = (p: string) => "../".repeat(p.split("/").length - 1) + "src/target.txt";
    const { repo, base } = repoWithChange(
      {
        [chmodded!]: frameBody("mode"),
        [renamedFrom!]: frameBody("pure-rename"),
        [kindOnly!]: linkTarget(kindOnly!),
        [retargeted!]: frameBody("kind"),
        "src/target.txt": "target\n",
      },
      { [renamedFrom!]: null, [renamedTo!]: frameBody("pure-rename"), [kindOnly!]: null, [retargeted!]: null },
      (repo) => {
        execSync(`chmod +x ${shq(join(repo, chmodded!))}`);
        symlinkSync(linkTarget(kindOnly!), join(repo, kindOnly!));
        symlinkSync(linkTarget(retargeted!), join(repo, retargeted!));
      },
    );
    const { full } = await fetchTaskDiff(repo, base);
    const sectionsOf = (diff: string, path: string) =>
      diff.split(/(?=^diff --git )/m).filter((s) => s.startsWith(`diff --git a/${path} `)).join("");
    const sections = (path: string) => sectionsOf(full, path);

    // mode-only: no content hunk, so nothing was withheld and no receipt is manufactured
    expect(sections(chmodded!)).toMatch(/^old mode /m);
    expect(sections(chmodded!)).toMatch(/^new mode /m);
    expect(sections(chmodded!)).not.toContain("set aside: regenerable capture");
    // pure rename between two members: also no content hunk, also untouched
    expect(sections(renamedFrom!)).toContain(`rename to ${renamedTo}`);
    expect(sections(renamedFrom!)).not.toContain("set aside: regenerable capture");
    // kind-only: git spells regular-file-to-symlink as a removal plus a creation, each carrying a hunk
    // — and when the file's bytes ARE the link target, those two hunks are identical. A hunk is
    // therefore not proof of a content change: nothing was withheld, so both halves survive
    // byte-for-byte against raw git and neither is handed a receipt.
    const kind = sections(kindOnly!);
    expect(kind).toMatch(/^deleted file mode 100644$/m);
    expect(kind).toMatch(/^new file mode 120000$/m);
    expect(kind).toContain(`-${linkTarget(kindOnly!)}`);
    expect(kind).toContain(`+${linkTarget(kindOnly!)}`);
    expect(kind).not.toContain("set aside: regenerable capture");
    expect(kind).toBe(sectionsOf(rawFull(repo, base), kindOnly!));
    // the boundary that proves the rule is about CONTENT and not about the kind lines: the same
    // regular-file-to-symlink change that DID move bytes is an ordinary content change, set aside like
    // any other — and a reader can still name each operation.
    const moved = sections(retargeted!);
    expect(moved).toMatch(/^deleted file mode 100644$/m);
    expect(moved).toMatch(/^new file mode 120000$/m);
    expect(moved.match(new RegExp(`set aside: regenerable capture ${retargeted}`, "g"))).toHaveLength(2);
    expect(moved).not.toContain("│ kind row 0 ");
  });

  test("test: the replacement text a reader receives counts toward the measurement, so many set-aside captures cannot measure as nothing", async () => {
    const one = repoWithChange({ [FRAME_CAPTURE]: frameBody("before") }, { [FRAME_CAPTURE]: frameBody("after") });
    const many = repoWithChange(everyCapture("before"), everyCapture("after"));
    const oneMeasured = (await fetchTaskDiff(one.repo, one.base)).forCap.length;
    const manyMeasured = (await fetchTaskDiff(many.repo, many.base)).forCap.length;
    expect(oneMeasured).toBeGreaterThan(0);
    expect(manyMeasured).toBeGreaterThan(oneMeasured * (CAPTURES.length - 1));

    // a cap under the receipts' own volume still parks: N set-aside sections never measure as zero
    const r = await runAcceptance(many.repo, many.base, fakeWith({ judge: citing(FRAME_CAPTURE, 0) }), Math.floor(manyMeasured / 2));
    expect(isDiffCapPark(r)).toBe(true);
  });

  test("test: the size a receipt claims is the byte count of what was withheld, asserted to an exact value on a capture whose characters make a code-unit count disagree with a byte count", async () => {
    const { repo, base } = repoWithChange(
      { [FRAME_CAPTURE]: "│ before ─ row │\n" },
      { [FRAME_CAPTURE]: "│ after ─ row │\n" },
    );
    const raw = rawU0(repo, base);
    const withheld = raw.slice(raw.indexOf("--- "));
    expect(Buffer.byteLength(withheld, "utf8")).not.toBe(withheld.length); // UTF-8 ≠ UTF-16 here
    const { forCap } = await fetchTaskDiff(repo, base);
    const claimed = Number(/ — (\d+) bytes withheld/.exec(forCap)![1]);
    expect(claimed).toBe(Buffer.byteLength(withheld, "utf8"));
    expect(claimed).toBe(EXACT_WITHHELD_BYTES);
    expect(claimed).not.toBe(withheld.length);
  });

  test("test: a set-aside capture is not reduced a second time by the filter that shortens whole-file removals, so its receipt still reaches a reader", async () => {
    const { repo, base } = repoWithChange(
      { [FRAME_CAPTURE]: frameBody("doomed"), "src/keep.ts": "export const keep = 1;\n" },
      { [FRAME_CAPTURE]: null },
    );
    const { fake, prompts } = capturingFake({ judge: citing(FRAME_CAPTURE, 0) });
    const r = await runAcceptance(repo, base, fake, DEFAULT_DIFF_CAP);
    expect(r.pass).toBe(true);
    const prompt = prompts.join("");
    expect(prompt).toContain(`set aside: regenerable capture ${FRAME_CAPTURE}`);
    expect(prompt).toContain("deleted file mode");
    // the whole-file-removal collapse would have replaced the receipt with this one line
    expect(prompt).not.toContain(`deleted file: ${FRAME_CAPTURE}`);
  });

  test("test: a change made only of set-aside captures produces a verdict a reader can parse, from evidence citing a location the change index knows", async () => {
    const { repo, base } = repoWithChange(everyCapture("before"), everyCapture("after"));
    const { prompt, result } = await judgeCiting(repo, base, FRAME_CAPTURE, 0);
    expect(prompt).toContain(`- ${FRAME_CAPTURE}: 0`);
    expect(result.pass).toBe(true);
    expect(result.meta?.unparseable).toBeUndefined();
    expect(result.details).toContain("c1");
  });

  test("test: a change that only removes protected evidence produces a verdict a reader can parse, from evidence citing a location the change index knows", async () => {
    const { repo, base } = repoWithChange({ [ANCHOR]: frameBody("frozen", 4) }, { [ANCHOR]: null });
    const { prompt, result } = await judgeCiting(repo, base, ANCHOR, 0);
    // exempt from the whole-file-removal collapse (clause 5), so its bytes reach the judge whole
    expect(prompt).toContain("│ frozen row 0 ");
    expect(prompt).not.toContain(`deleted file: ${ANCHOR}`);
    expect(prompt).toContain(`- ${ANCHOR}: 0`);
    expect(result.pass).toBe(true);
    expect(result.meta?.unparseable).toBeUndefined();
  });

  test("test: every citation assertion here supplies a structured location rather than free text, and still passes when the older free-text path is out of the test's reach", async () => {
    const setAside = repoWithChange(everyCapture("before"), everyCapture("after"));
    const removed = repoWithChange({ [ANCHOR]: frameBody("frozen", 4) }, { [ANCHOR]: null });
    for (const [{ repo, base }, path] of [[setAside, FRAME_CAPTURE], [removed, ANCHOR]] as const) {
      const { result, servedLegacyEvidence } = await judgeCiting(repo, base, path, 0);
      expect(result.pass).toBe(true);
      // the fake's free-text evidence-injection seam was never invoked: only the structured citation
      // could have carried these verdicts through the validator.
      expect(servedLegacyEvidence).toBe(false);
    }
    // and the structure is load-bearing: the same shape with an uncited line is still rejected
    const { result: fabricated } = await judgeCiting(setAside.repo, setAside.base, FRAME_CAPTURE, 7);
    expect(fabricated.pass).toBe(false);
    expect(fabricated.details).toMatch(/evidence absent from the judged diff/i);
  });
});

// The judge run for every citation assertion above: runLlm is replaced, so the fake adapter — and with
// it llm.ts's legacy free-text evidence injection — is out of the test's reach entirely. Only a
// structured {path, line} the change index knows can carry the verdict.
async function judgeCiting(repo: string, base: string, path: string, line: number) {
  let prompt = "";
  let servedLegacyEvidence = false;
  const fake = fakeWith({});
  fake.headlessCommand = () => { servedLegacyEvidence = true; return "true"; };
  const spy = vi.spyOn(llm, "runLlm").mockImplementation(async (_a, _m, p) => {
    prompt = p;
    return JSON.stringify({ nonce: llm.extractPromptNonce(p)!, ...citing(path, line) });
  });
  try {
    const result = await runAcceptance(repo, base, fake, DEFAULT_DIFF_CAP);
    return { prompt, result, servedLegacyEvidence };
  } finally {
    spy.mockRestore();
  }
}

test("test: real-git capture-cap matrix changes a manifest member produced through a registered capture producer beyond the logic cap but within the capture cap, and both acceptanceGate and reviewGate dispatch with one byte-counted citable receipt while an equal-size source change parks both, so one undifferentiated cap or a Cockpit-only producer special case fails", async () => {
  const capture = CAPTURE_ARTIFACT_MANIFEST.artifacts.find((artifact) =>
    artifact.producer === "cockpit-colour-frames"
  )!;
  const before = frameBody("registered-before", 500);
  const after = frameBody("registered-after", 500);
  const logicCap = 10_000;
  const changedCapture = repoWithChange(
    { [capture.path]: before },
    { [capture.path]: after },
  );
  const measured = await fetchTaskDiff(changedCapture.repo, changedCapture.base);
  expect(measured.logicBytes).toBeLessThanOrEqual(logicCap);
  expect(measured.captureBytes).toBeGreaterThan(logicCap);
  expect(measured.captureBytes).toBeLessThanOrEqual(captureDiffCapFor(logicCap));
  expect(measured.classifications).toContainEqual(expect.objectContaining({
    kind: "capture",
    producer: capture.producer,
  }));

  const { fake: judge, prompts: judgePrompts } = capturingFake({ judge: citing(capture.path, 0) });
  const accepted = await runAcceptance(changedCapture.repo, changedCapture.base, judge, logicCap);
  expect(accepted.pass).toBe(true);
  const judgePrompt = judgePrompts.join("");
  expect(judgePrompt.match(/set aside: regenerable capture/g)).toHaveLength(1);
  expect(judgePrompt).toContain(`- ${capture.path}: 0`);
  expect(Number(/— (\d+) bytes withheld/.exec(judgePrompt)![1]))
    .toBe(measured.fullMeasurement.captureBytes);

  const { fake: reviewer, prompts: reviewPrompts } = capturingFake({ review: { approve: true, issues: [] } });
  const reviewed = await runReview(changedCapture.repo, changedCapture.base, reviewer, logicCap);
  expect(reviewed.pass).toBe(true);
  expect(reviewPrompts.join("").match(/set aside: regenerable capture/g)).toHaveLength(1);

  const sourcePath = "src/generated/equal-size-capture.txt";
  const changedSource = repoWithChange(
    { [sourcePath]: before },
    { [sourcePath]: after },
  );
  const sourceMeasured = await fetchTaskDiff(changedSource.repo, changedSource.base);
  expect(sourceMeasured.captureBytes).toBe(0);
  expect(sourceMeasured.logicBytes).toBeGreaterThan(logicCap);
  const { fake: parkedJudge, prompts: parkedJudgePrompts } = capturingFake({ judge: citing(sourcePath, 1) });
  const { fake: parkedReviewer, prompts: parkedReviewPrompts } = capturingFake({ review: { approve: true, issues: [] } });
  expect(isDiffCapPark(await runAcceptance(changedSource.repo, changedSource.base, parkedJudge, logicCap))).toBe(true);
  expect(isDiffCapPark(await runReview(changedSource.repo, changedSource.base, parkedReviewer, logicCap))).toBe(true);
  expect(parkedJudgePrompts).toEqual([]);
  expect(parkedReviewPrompts).toEqual([]);
});

test("test: unmanifested-payload control places hand-authored bytes beside a manifested capture under tests/fixtures and observes the manifested file classified by provenance while the neighbour counts in full and parks both gates, so directory-prefix or extension classification fails", async () => {
  const capture = CAPTURE_ARTIFACT_MANIFEST.artifacts.find((artifact) =>
    artifact.producer === "cockpit-colour-frames"
  )!;
  const neighbour = `${dirname(capture.path)}/hand-authored-frame.txt`;
  const logicCap = 8_000;
  const capturedBody = frameBody("manifested", 240);
  const neighbourBody = frameBody("hand-authored", 240);
  const { repo, base } = repoWithChange(
    { [capture.path]: frameBody("before", 240), [neighbour]: frameBody("before", 240) },
    { [capture.path]: capturedBody, [neighbour]: neighbourBody },
  );
  const measured = await fetchTaskDiff(repo, base);
  const captureSection = measured.classifications.find((row) => row.paths.includes(capture.path));
  const neighbourSection = measured.classifications.find((row) => row.paths.includes(neighbour));
  expect(captureSection).toMatchObject({
    kind: "capture",
    reason: "manifest-provenance",
    producer: capture.producer,
  });
  expect(neighbourSection).toMatchObject({ kind: "logic", reason: "unmanifested" });
  expect(measured.forCap).toContain(`set aside: regenerable capture ${capture.path}`);
  expect(measured.forCap).toContain("│ hand-authored row 0 ");
  expect(measured.logicBytes).toBeGreaterThan(logicCap);

  const { fake: judge, prompts: judgePrompts } = capturingFake({ judge: citing(neighbour, 1) });
  const { fake: reviewer, prompts: reviewPrompts } = capturingFake({ review: { approve: true, issues: [] } });
  expect(isDiffCapPark(await runAcceptance(repo, base, judge, logicCap))).toBe(true);
  expect(isDiffCapPark(await runReview(repo, base, reviewer, logicCap))).toBe(true);
  expect(judgePrompts).toEqual([]);
  expect(reviewPrompts).toEqual([]);
});

test("test: protected-evidence matrix changes a frozen anchor and a captured source journal beside a generated frame, where anchor and journal bytes always count at logic rates and the frame gets capture treatment only when its manifest producer and provenance match, so path-only exemption or forged provenance fails", async () => {
  const logicCap = 10_000;
  const { repo, base } = repoWithChange(
    {
      [ANCHOR]: frameBody("anchor-before", 180),
      [JOURNAL]: frameBody("journal-before", 180),
      [FRAME_CAPTURE]: frameBody("frame-before", 180),
    },
    {
      [ANCHOR]: frameBody("anchor-after", 180),
      [JOURNAL]: frameBody("journal-after", 180),
      [FRAME_CAPTURE]: frameBody("frame-after", 180),
    },
  );
  const measured = await fetchTaskDiff(repo, base);
  const classification = (path: string) =>
    measured.classifications.find((row) => row.paths.includes(path));
  expect(classification(ANCHOR)).toMatchObject({ kind: "logic", reason: "protected-evidence" });
  expect(classification(JOURNAL)).toMatchObject({ kind: "logic", reason: "protected-evidence" });
  expect(classification(FRAME_CAPTURE)).toMatchObject({ kind: "capture", reason: "manifest-provenance" });
  expect(measured.forCap).toContain("│ anchor-after row 0 ");
  expect(measured.forCap).toContain("│ journal-after row 0 ");
  expect(measured.forCap).not.toContain("│ frame-after row 0 ");
  expect(measured.logicBytes).toBeGreaterThan(logicCap);

  const { fake: judge, prompts: judgePrompts } = capturingFake({ judge: citing(ANCHOR, 1) });
  const { fake: reviewer, prompts: reviewPrompts } = capturingFake({ review: { approve: true, issues: [] } });
  expect(isDiffCapPark(await runAcceptance(repo, base, judge, logicCap))).toBe(true);
  expect(isDiffCapPark(await runReview(repo, base, reviewer, logicCap))).toBe(true);
  expect(judgePrompts).toEqual([]);
  expect(reviewPrompts).toEqual([]);

  const frameEntry = CAPTURE_ARTIFACT_MANIFEST.artifacts.find((entry) => entry.path === FRAME_CAPTURE)!;
  const forgedManifest: CaptureArtifactManifest = {
    version: 1,
    producers: CAPTURE_ARTIFACT_MANIFEST.producers,
    artifacts: [
      ...CAPTURE_ARTIFACT_MANIFEST.artifacts.map((entry) => entry.path === FRAME_CAPTURE
        ? { ...entry, provenance: { ...entry.provenance, revision: "forged" } }
        : entry),
      { path: ANCHOR, producer: frameEntry.producer, provenance: frameEntry.provenance },
      { path: JOURNAL, producer: frameEntry.producer, provenance: frameEntry.provenance },
    ],
  };
  const forged = measureArtifactDiff(rawU0(repo, base), forgedManifest);
  const forgedClassification = (path: string) =>
    forged.sections.find((row) => row.paths.includes(path));
  expect(forgedClassification(ANCHOR)).toMatchObject({ kind: "logic", reason: "protected-evidence" });
  expect(forgedClassification(JOURNAL)).toMatchObject({ kind: "logic", reason: "protected-evidence" });
  expect(forgedClassification(FRAME_CAPTURE)).toMatchObject({ kind: "logic", reason: "stale-provenance" });
  expect(forged.captureBytes).toBe(0);
  expect(forged.logicBytes).toBe(Buffer.byteLength(rawU0(repo, base), "utf8"));
});

test("test: manifest lifecycle matrix exercises add, modify, delete, rename and mode-only cases through acceptanceGate and reviewGate, requires pairwise-equal classification and byte counts from both gates, and makes a stale manifest entry or missing producer fail closed rather than disappear or measure zero", async () => {
  const captures = CAPTURE_ARTIFACT_MANIFEST.artifacts
    .filter((entry) => entry.producer === "cockpit-golden-frames");
  const [addedPath, modifiedPath, deletedPath, renamedFrom, renamedTo, modePath] =
    captures.map((entry) => entry.path);
  const body = frameBody("lifecycle", 100);
  const control = "src/lifecycle-control.ts";
  const cases = [
    {
      name: "add",
      repo: repoWithChange({ [control]: "export const state = 'before';\n" }, { [addedPath!]: body }),
      evidence: addedPath!,
      line: 0,
      content: true,
    },
    {
      name: "modify",
      repo: repoWithChange({ [modifiedPath!]: frameBody("before", 100) }, { [modifiedPath!]: body }),
      evidence: modifiedPath!,
      line: 0,
      content: true,
    },
    {
      name: "delete",
      repo: repoWithChange(
        { [deletedPath!]: body, [control]: frameBody("source-deletion", 20) },
        { [deletedPath!]: null, [control]: null },
      ),
      evidence: deletedPath!,
      line: 0,
      content: true,
    },
    {
      name: "rename",
      repo: repoWithChange(
        { [renamedFrom!]: body },
        { [renamedFrom!]: null, [renamedTo!]: body.replace("row 0", "row 0 renamed") },
      ),
      evidence: renamedTo!,
      line: 0,
      content: true,
    },
    {
      name: "mode-only",
      repo: repoWithChange(
        { [modePath!]: body, [control]: "export const state = 'before';\n" },
        { [control]: "export const state = 'after';\n" },
        (repo) => execSync(`chmod +x ${shq(join(repo, modePath!))}`),
      ),
      evidence: control,
      line: 1,
      content: false,
    },
  ] as const;

  for (const lifecycle of cases) {
    const measurement = await fetchTaskDiff(lifecycle.repo.repo, lifecycle.repo.base);
    expect(measurement.classifications.some((row) => row.kind === "capture"), lifecycle.name)
      .toBe(true);
    expect(measurement.logicBytes, lifecycle.name).toBeGreaterThan(0);
    if (lifecycle.content) {
      expect(measurement.captureBytes, lifecycle.name).toBeGreaterThan(0);
    } else {
      expect(measurement.captureBytes, lifecycle.name).toBe(0);
    }

    const { fake: judge, prompts: judgePrompts } = capturingFake({
      judge: citing(lifecycle.evidence, lifecycle.line),
    });
    const { fake: reviewer, prompts: reviewPrompts } = capturingFake({
      review: { approve: true, issues: [] },
    });
    const accepted = await runAcceptance(
      lifecycle.repo.repo,
      lifecycle.repo.base,
      judge,
      100_000,
    );
    const reviewed = await runReview(
      lifecycle.repo.repo,
      lifecycle.repo.base,
      reviewer,
      100_000,
    );
    expect(accepted.pass, `${lifecycle.name}: ${accepted.details}`).toBe(true);
    expect(reviewed.pass, `${lifecycle.name}: ${reviewed.details}`).toBe(true);
    expect(judgePrompts, lifecycle.name).toHaveLength(1);
    expect(reviewPrompts, lifecycle.name).toHaveLength(1);
    const acceptanceObserved = observedPromptDiff(judgePrompts[0]!, "## Diff (vs base)");
    const reviewObserved = observedPromptDiff(reviewPrompts[0]!, "## Diff");
    expect({
      classifications: acceptanceObserved.classifications,
      logicBytes: acceptanceObserved.logicBytes,
      captureBytes: acceptanceObserved.captureBytes,
    }, lifecycle.name).toEqual({
      classifications: reviewObserved.classifications,
      logicBytes: reviewObserved.logicBytes,
      captureBytes: reviewObserved.captureBytes,
    });
    expect(reviewObserved.rendered, lifecycle.name).toBe(acceptanceObserved.rendered);
    expect(acceptanceObserved.captureBytes, lifecycle.name)
      .toBe(measurement.fullMeasurement.captureBytes);
    if (lifecycle.name === "delete") {
      expect(acceptanceObserved.rendered).toContain(`deleted file: ${control}`);
      expect(acceptanceObserved.rendered).not.toContain("source-deletion row 0");
    }
  }

  const modified = cases.find((entry) => entry.name === "modify")!.repo;
  const raw = rawU0(modified.repo, modified.base);
  const entry = CAPTURE_ARTIFACT_MANIFEST.artifacts.find((artifact) => artifact.path === modifiedPath)!;
  const missingProducer: CaptureArtifactManifest = {
    ...CAPTURE_ARTIFACT_MANIFEST,
    producers: CAPTURE_ARTIFACT_MANIFEST.producers.filter((producer) => producer.id !== entry.producer),
  };
  const staleProvenance: CaptureArtifactManifest = {
    ...CAPTURE_ARTIFACT_MANIFEST,
    artifacts: CAPTURE_ARTIFACT_MANIFEST.artifacts.map((artifact) => artifact.path === modifiedPath
      ? { ...artifact, provenance: { ...artifact.provenance, revision: "stale" } }
      : artifact),
  };
  for (const [reason, manifest] of [
    ["missing-producer", missingProducer],
    ["stale-provenance", staleProvenance],
  ] as const) {
    const failedClosed = measureArtifactDiff(raw, manifest);
    expect(failedClosed.sections).toContainEqual(expect.objectContaining({ kind: "logic", reason }));
    expect(failedClosed.captureBytes).toBe(0);
    expect(failedClosed.logicBytes).toBeGreaterThan(0);
    expect(failedClosed.rendered).toContain("│ lifecycle row 0 ");
  }
});
