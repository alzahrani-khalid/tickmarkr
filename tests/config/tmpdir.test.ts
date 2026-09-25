import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { makeTestTempDir, recordTmpdirChild, TEST_BASE_TMPDIR_ENV, TMPDIR_CHILD_ENV, TMPDIR_CHILD_TEST, type TmpdirChildRecord } from "../helpers/tmprepo.js";

// Runs only inside the spawned child: records, then FAILS on purpose so the file tears down red.
test.skipIf(!process.env[TMPDIR_CHILD_ENV])(TMPDIR_CHILD_TEST, () => {
  recordTmpdirChild("failing.json");
  throw new Error("deliberate failure: teardown must still restore and reap TMPDIR");
});

const CHILD_FILES = ["tests/config/tmpdir.test.ts", "tests/helpers/tmprepo.test.ts"];

test("test: real test environments confine direct child-process temporaries to their own recorded TMPDIR across failure teardown and subsequent single-fork files, so deleting an unrecorded sibling or leaving a dangling TMPDIR fails", async () => {
  // Two inheritances a nested runner meets. Absent: no TMPDIR, so the effective base is os.tmpdir()'s next
  // fallback, TMP. Outer: an outer runner's relocated TMPDIR plus its marker — the second file must still
  // root under the marker's base, never nest under the outer relocation, so teardown restores the marker.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST") && !["TMPDIR", "TMP", "TEMP", TEST_BASE_TMPDIR_ENV].includes(k)));
  for (const inherited of ["absent", "outer"] as const) {
    const base = makeTestTempDir("base-");
    const outer = makeTestTempDir("outer-t-");
    const out = makeTestTempDir("out-");
    const sibling = join(base, "unrecorded-sibling");
    mkdirSync(sibling);
    writeFileSync(join(sibling, "keep.txt"), "keep\n");
    // The repository's `suite` project fans files out across forks and CLI pool options never reach a
    // project, so the child runs the same setup file under a minimal single-fork config of its own, its
    // sequencer pinning the failing file FIRST so the green file really follows a red teardown.
    const config = join(out, "vitest.single-fork.config.mjs");
    writeFileSync(config, `const order = ${JSON.stringify(CHILD_FILES)};
const rank = (s) => order.findIndex((f) => s.moduleId.endsWith(f));
export default { test: { root: ${JSON.stringify(process.cwd())}, setupFiles: ["tests/setup.ts"], include: order, poolOptions: { forks: { singleFork: true } },
  sequence: { sequencer: class { async shard(files) { return files; } async sort(files) { return [...files].sort((a, b) => rank(a) - rank(b)); } } } } };\n`);
    const tmp = inherited === "absent" ? { TMP: base } : { TMPDIR: outer, [TEST_BASE_TMPDIR_ENV]: base };
    const child = spawn(
      join("node_modules", ".bin", "vitest"),
      ["run", "--config", config, "-t", "^child runner: record"],
      { cwd: process.cwd(), env: { ...env, ...tmp, [TMPDIR_CHILD_ENV]: out }, stdio: "ignore" },
    );
    const exit = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(exit, inherited).toBe(1); // the first child file failed on purpose; the run is red, not crashed

    const records = ["failing.json", "passing.json"].map((f) => JSON.parse(readFileSync(join(out, f), "utf8")) as TmpdirChildRecord);
    const [failing, passing] = records;
    expect(passing.pid).toBe(failing.pid); // one fork ran both files in sequence
    expect(passing.at).toBeGreaterThan(failing.at); // the green file ran AFTER the red teardown
    expect(passing.tmpdir).not.toBe(failing.tmpdir);
    for (const r of records) {
      expect(r.base, inherited).toBe(base); // an absolute effective base, pinned across the failed teardown
      expect(dirname(dirname(r.tmpdir)), inherited).toBe(join(base, "tkr")); // a short leaf under this runner's root, never nested in a prior leaf
      expect(Buffer.byteLength(r.tmpdir) - Buffer.byteLength(base)).toBeLessThanOrEqual(31); // ≤ 80 bytes on a 49-byte base
      for (const temp of [r.mktemp, r.mkdtemp]) {
        expect(dirname(temp)).toBe(r.tmpdir); // confined to the recorded TMPDIR
        expect(existsSync(temp)).toBe(false); // reaped with it
      }
      expect(existsSync(r.tmpdir)).toBe(false);
    }
    expect(readdirSync(join(base, "tkr"))).toEqual([]); // no dangling root or TMPDIR
    expect(readdirSync(outer)).toEqual([]); // nothing nested under an outer relocation
    expect(readFileSync(join(sibling, "keep.txt"), "utf8")).toBe("keep\n"); // the unrecorded sibling was never swept
  }
}, 180_000);
