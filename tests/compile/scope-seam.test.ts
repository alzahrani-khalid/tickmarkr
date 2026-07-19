import { describe, expect, test } from "vitest";
import { CompileError } from "../../src/compile/common.js";
import { compileGsd } from "../../src/compile/gsd.js";

// v1.59 export boundary: the six archived corpus dirs are VENDORED at the compiler-consumed minimum —
// plans reduced to exactly what compileGsd reads (frontmatter keys, objective first sentence, <done>
// blocks, <context> @-refs, <task> count, write directives in document order), summaries as
// presence-only markers (compileGsd never reads summary content). Reduction was verified by compiling
// each dir before/after AND against the archived original: identical tasks JSON and identical
// CompileError messages (path-prefix normalized). The live `.planning` tree ships in no export.
const DEFECTIVE = "tests/fixtures/scope-seam/29-fleet-metering";

// HARD-09: the two REAL archived v1.11 dirs that carry bare-filename write directives. Both THREW on
// unfixed HEAD (committed in 41-02-DIAGNOSIS.md § RED proof) — this is the required real-corpus RED
// reproduction (verified counts below by listing each dir's *-PLAN.md files).
const V1_11_35 = "tests/fixtures/scope-seam/35-subprocess-driver-stdin-hang-hard-05"; // 1 plan
const V1_11_36 = "tests/fixtures/scope-seam/36-adapter-honesty-headless-metering-pi-channel-truth-spend-11-"; // 2 plans

const LEGITIMATE: { dir: string; count: number }[] = [
  { dir: "tests/fixtures/scope-seam/30-config-report-currency", count: 3 },
  { dir: "tests/fixtures/scope-seam/33-fleet-preference", count: 3 },
  { dir: "tests/fixtures/scope-seam/34-exploration-within-prefer", count: 2 },
  // HARD-09 RED corpus (real, archived): both threw on HEAD; both compile clean after the fix.
  { dir: V1_11_35, count: 1 },
  { dir: V1_11_36, count: 2 },
  // HARD-09 vendored over-fire trap: bare directive whose basename IS listed under a stale
  // (relocated-away) directory literal. Throws on HEAD; compiles clean after the basename fallback.
  { dir: "tests/fixtures/scope-seam/relocated-selfwrite", count: 1 },
  // A self-writing plan (acceptance orders `Write <artifact>.md` INTO its own dir, correctly listed in
  // files_modified) — the shape every v1.11 phase used. VENDORED, not pointed at a real phase dir, because a
  // GSD plan's `files_modified` is repo-relative and therefore STALE-BY-RELOCATION the moment
  // `chore: archive <milestone>` moves the dir: the directive path then resolves against the NEW dir while
  // files_modified still names the OLD one, and assertWriteScope falsely rejects a legitimate plan.
  // Live `.planning/phases/*` paths break at the next archive; archived paths can never compile clean for
  // this shape. Only a vendored fixture is stable in both directions. (See v1.11 audit addendum.)
  { dir: "tests/fixtures/scope-seam/legit-selfwrite", count: 1 },
];

// HARD-09 vendored GUARD: a bare directive whose basename matches NO files_modified entry (not even
// by substring near-miss) must keep throwing — today AND after the fix. GREEN-BY-ACCIDENT on HEAD
// (everything bare-and-stale throws today); this is a GUARD, not a RED-proof — its red arrives via
// Task 2's mutation drills (Drills A2 + B in 41-02-DIAGNOSIS.md).
const DEFECTIVE_BARE = "tests/fixtures/scope-seam/defective-bare";

describe("HARD-07 scope seam — real corpus", () => {
  // RED on unfixed HEAD: v1.9-29 compiles clean today (proven in 37-DIAGNOSIS.md § RED proof)
  test("HARD-07: v1.9-29 — a write directive outside files[] rejects", () => {
    expect(() => compileGsd(DEFECTIVE)).toThrow();
    try {
      compileGsd(DEFECTIVE);
    } catch (e) {
      expect(e).toBeInstanceOf(CompileError);
      const msg = (e as CompileError).message;
      expect(msg).toMatch(/P29-01/);
      expect(msg).toMatch(/29-01-SUMMARY\.md/);
      expect(msg).toMatch(/files_modified/i);
    }
  });

  // SC-2 over-fire guard — includes Phase 36 hash-pin trap on paths absent from files_modified
  test("HARD-07: real corpus — the legitimate corpus still compiles clean", () => {
    for (const { dir, count } of LEGITIMATE) {
      const g = compileGsd(dir, dir);
      expect(g.tasks).toHaveLength(count);
    }
  });

  // HARD-09 guard (green-by-accident, labeled): a bare directive with no matching basename still
  // rejects — its red-capability is proven by Task 2's mutation drills, not by this run on HEAD.
  test("HARD-09: bare directive with no matching basename still rejects", () => {
    expect(() => compileGsd(DEFECTIVE_BARE, DEFECTIVE_BARE)).toThrow(CompileError);
    try {
      compileGsd(DEFECTIVE_BARE, DEFECTIVE_BARE);
    } catch (e) {
      expect(e).toBeInstanceOf(CompileError);
      const msg = (e as CompileError).message;
      expect(msg).toMatch(/01-SUMMARY\.md/);
    }
  });
});
