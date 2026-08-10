import { cpSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { compile } from "../../src/cli/commands/compile.js";
import { plan } from "../../src/cli/commands/plan.js";
import { harnessLine, resolveHarness } from "../../src/cli/harness.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { authedModels, makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// v1.89 T4: `tickmarkr version` cannot separate an installed package from a checkout — package.json bumps
// only at release, so equality is the EXPECTED reading in the failure case. These pin the two things that
// do separate them: the resolved location, and a provenance derived from it.

// a pinned doctor keeps plan off the real fleet: no probe, no token, deterministic table
const DOCTOR5 = Object.fromEntries(
  ["claude-code", "codex", "cursor-agent", "opencode", "pi"].map((id) =>
    [id, { installed: true, authed: true, models: [], modelAuth: authedModels(Object.keys(DEFAULT_CONFIG.tiers[id]?.models ?? {})) }]),
);

function mkPlanRepo(): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  writeDoctor(repo, DOCTOR5);
  saveGraph(repo, validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
  }));
  return repo;
}

function mkCompileRepo(): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  cpSync("fixtures/sample.prd.md", join(repo, "feature.prd.md"));
  return repo;
}

/** a real file inside `dir`, plus a symlink to it from somewhere else — the shape a global bin has */
function linkedHarness(dir: string, real: string): { realPath: string; linkPath: string } {
  const path = join(dir, real);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "// harness\n");
  const linkPath = join(dir, "bin-tickmarkr");
  symlinkSync(path, linkPath);
  // macOS tmpdir is itself a symlink (/var → /private/var), so the EXPECTED real file is realpath'd too —
  // otherwise this would pass on a resolver that resolved nothing at all.
  return { realPath: realpathSync(path), linkPath };
}

describe("v1.89 T4 — the harness says which harness it is", () => {
  test("plan and compile each emit the resolved harness path, and that path is the real file after symlink resolution rather than the invoked name", async () => {
    const dir = makeTestTempDir("tickmarkr-harness-");
    const { realPath, linkPath } = linkedHarness(dir, "lib/node_modules/tickmarkr/dist/cli/index.js");
    expect(linkPath).not.toBe(realPath); // the invoked name and the real file genuinely differ

    // The SHIPPED path, not an injected one: NEITHER command is handed a location here, so each falls to
    // its production default and reads the invoked name off argv[1] — the shape `tickmarkr plan` has when
    // a global bin symlink is on PATH. Nothing but real resolution can turn that name into the target.
    // (Spawning the built CLI would widen the proof, but a new dist reader must join vitest.config.ts's
    // DIST_COUPLED_TESTS set or it races bin.test.ts's mid-suite rebuild — OBS-96 — and that config file
    // is outside this task's file scope. The argv seam drives the identical default.)
    const invoked = process.argv[1];
    let planOut: string;
    let compileOut: string;
    try {
      process.argv[1] = linkPath;
      planOut = await plan([], mkPlanRepo());
      compileOut = await compile(["feature.prd.md"], mkCompileRepo());
    } finally {
      process.argv[1] = invoked;
    }

    for (const out of [planOut, compileOut]) {
      const line = out.split("\n").find((l) => l.startsWith("harness: "))!;
      expect(line).toContain(realPath);
      expect(line).not.toContain(linkPath); // the invoked name never reaches the surface unresolved
      // nor may it name an internal module of the harness instead of the harness itself
      expect(line).not.toMatch(/commands\/(plan|compile)\.[jt]s/);
    }
    // the banner precedes the surface it vouches for: routing table / compiled-graph line
    expect(planOut.split("\n").findIndex((l) => l.startsWith("harness: ")))
      .toBeLessThan(planOut.split("\n").findIndex((l) => l.trimStart().startsWith("T1")));
    expect(compileOut.split("\n")[0].startsWith("harness: ")).toBe(true);
  });

  test("a harness resolving inside a global package directory reports installed provenance while one resolving inside a working tree reports checkout provenance", () => {
    const globalDir = makeTestTempDir("tickmarkr-global-");
    const { realPath: installed } = linkedHarness(globalDir, "lib/node_modules/tickmarkr/dist/cli/index.js");

    // a real git working tree (makeRepo runs `git init`), no node_modules segment on the path.
    // The checkout's harness is a BYTE COPY of the installed one: identical content, two locations,
    // two readings — which no build-time constant and nothing the file asserts about itself could
    // produce. That is the derivation criterion, proved here rather than in a test of its own.
    const checkoutRepo = makeRepo({ "keep.txt": "x\n" });
    mkdirSync(join(checkoutRepo, "dist/cli"), { recursive: true });
    const checkout = join(checkoutRepo, "dist/cli/index.js");
    cpSync(installed, checkout);
    expect(readFileSync(checkout, "utf8")).toBe(readFileSync(installed, "utf8"));

    expect(resolveHarness(installed).provenance).toBe("installed");
    expect(resolveHarness(checkout).provenance).toBe("checkout");
    expect(harnessLine(resolveHarness(installed))).toContain("(installed package)");
    expect(harnessLine(resolveHarness(checkout))).toContain("(working checkout)");
  });

  test("the emitted provenance distinguishes two harnesses that report the identical version string, proving version equality alone does not decide it", async () => {
    // the exact false clear this exists for: an installed 1.86.0 and a checkout two milestones ahead that
    // still reads 1.86.0, because package.json bumps only at release.
    const VERSION = "1.86.0";
    const globalDir = makeTestTempDir("tickmarkr-vglobal-");
    const { realPath: installed } = linkedHarness(globalDir, "lib/node_modules/tickmarkr/dist/cli/index.js");
    writeFileSync(join(globalDir, "lib/node_modules/tickmarkr/package.json"), JSON.stringify({ version: VERSION }));

    const checkoutRepo = makeRepo({ "package.json": JSON.stringify({ version: VERSION }) });
    mkdirSync(join(checkoutRepo, "dist/cli"), { recursive: true });
    const checkout = join(checkoutRepo, "dist/cli/index.js");
    writeFileSync(checkout, "// harness\n");

    const versionOf = (pkg: string) => JSON.parse(readFileSync(pkg, "utf8")).version as string;
    expect(versionOf(join(globalDir, "lib/node_modules/tickmarkr/package.json"))).toBe(versionOf(join(checkoutRepo, "package.json")));

    // identical version ⇒ the preflight's equality check reads "same"; the emitted lines still differ.
    // One repo, two locations: the repo is the plan's subject, the location is what is under test.
    const repo = mkPlanRepo();
    const a = await plan([], repo, undefined, installed);
    const b = await plan([], repo, undefined, checkout);
    const line = (out: string) => out.split("\n").find((l) => l.startsWith("harness: "))!;
    expect(line(a)).not.toBe(line(b));
    expect(line(a)).toContain("(installed package)");
    expect(line(b)).toContain("(working checkout)");
  });

  test("a location that does not resolve yields no provenance claim, so unresolved text naming node_modules is never read as installed", () => {
    // fail closed: with nothing resolved there is nothing to derive FROM, and reading the raw text would
    // manufacture exactly the trust claim this banner exists to earn.
    const ghost = "/nowhere/lib/node_modules/tickmarkr/dist/cli/index.js";
    const h = resolveHarness(ghost);
    expect(h.provenance).toBe("unresolved");
    expect(h.provenance).not.toBe("installed");
    expect(h.path).toBe(ghost); // kept as diagnostic, never as evidence
    expect(harnessLine(h)).toContain("(unresolved location)");
    expect(resolveHarness("/nowhere/at/all/index.js").provenance).toBe("unresolved");
  });

  test("an absent invoked location resolves to nothing rather than to the caller's directory", async () => {
    // `realpathSync("")` returns the CWD instead of throwing, so an absent `process.argv[1]` would name a
    // directory as the executing harness — and inside a checkout it would read "working checkout" off the
    // caller's location, the false clear in the exact shape this banner exists to prevent. Absence arrives
    // in both forms — `undefined` from an entrypoint node never gave one, `""` from any caller that
    // coalesces it — and the guard rejects both before realpathSync sees them.
    for (const absent of [undefined, ""]) {
      expect(resolveHarness(absent).provenance).toBe("unresolved");
      expect(harnessLine(resolveHarness(absent))).not.toContain(process.cwd());
    }

    // and through the shipped default of BOTH commands, with argv[1] genuinely absent — each runs in a git
    // repo, so a cwd fallback would surface as "working checkout" here.
    const invoked = process.argv[1];
    let outs: string[];
    try {
      delete process.argv[1];
      outs = [await plan([], mkPlanRepo()), await compile(["feature.prd.md"], mkCompileRepo())];
    } finally {
      process.argv[1] = invoked;
    }
    for (const out of outs) {
      const line = out.split("\n").find((l) => l.startsWith("harness: "))!;
      expect(line).toContain("(unresolved location)");
      expect(line).not.toContain(process.cwd());
    }
  });

  test("a resolved file under neither node_modules nor a git tree reads unknown, distinct from unresolved", () => {
    const bare = join(makeTestTempDir("tickmarkr-bare-"), "index.js");
    writeFileSync(bare, "// harness\n");
    expect(resolveHarness(bare).provenance).toBe("unknown");
    expect(harnessLine(resolveHarness(bare))).toContain("(unknown origin)");
  });
});

