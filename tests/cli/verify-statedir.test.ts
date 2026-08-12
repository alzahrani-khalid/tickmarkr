import { createHash } from "node:crypto";
import { realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { verifyStateDir } from "../../src/cli/commands/verify.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

// GATE-FIX-4 defect 1: on macOS os.tmpdir() is a symlink (/var/folders/… → /private/var/…), so a
// baseline captured under the repo path and a battery run under the tmp path disagreed on every
// path-bearing fingerprint — false REDs on green diffs. The fix canonicalizes tmpdir() with
// realpathSync at construction. CI cannot rely on the macOS symlink, so this test builds its own:
// TMPDIR pointed at a symlink must never leak the symlinked spelling into the state dir.
describe("verify state dir canonicalizes tmpdir", () => {
  test("a symlinked TMPDIR resolves to its realpath in the built state dir", () => {
    const real = makeTestTempDir("tickmarkr-verify-real-");
    const link = join(makeTestTempDir("tickmarkr-verify-link-"), "tmp-link");
    symlinkSync(real, link); // link → real, mimicking /var → /private/var
    const prior = process.env.TMPDIR;
    process.env.TMPDIR = link; // os.tmpdir() reads TMPDIR per call on POSIX
    try {
      const dir = verifyStateDir("/some/repo");
      const digest = createHash("sha256").update("/some/repo").digest("hex").slice(0, 12);
      // realpathSync(real): makeTestTempDir itself lives under tmpdir, which may be symlinked too
      expect(dir).toBe(join(realpathSync(real), "tickmarkr-verify", digest));
      expect(dir).not.toContain("tmp-link"); // the symlinked spelling never reaches a fingerprint
    } finally {
      if (prior === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prior;
    }
  });

  test("state dir is keyed by cwd digest under the canonical tmpdir", () => {
    const dir = verifyStateDir("/repo/a");
    const digest = createHash("sha256").update("/repo/a").digest("hex").slice(0, 12);
    expect(dir).toBe(join(realpathSync(tmpdir()), "tickmarkr-verify", digest));
    expect(verifyStateDir("/repo/b")).not.toBe(dir); // different checkout, different cache
  });
});
