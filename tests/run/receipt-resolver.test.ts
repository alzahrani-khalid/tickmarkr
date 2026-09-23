import { createHash } from "node:crypto";
import fs from "node:fs";
import { linkSync, mkdirSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { EvidenceArtifact, GateEvidenceReceipt } from "../../src/run/protocol.js";
import { formatReceiptResolution, resolveReceipt, resolveReceiptArtifacts } from "../../src/run/receipt-resolver.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function artifact(path: string, bytes: Buffer, overrides: Partial<EvidenceArtifact> = {}): EvidenceArtifact {
  return { path, availability: "available", sha256: sha(bytes), retainedBytes: bytes.length, droppedBytes: 0, truncated: false, ...overrides };
}

function receipt(stdout: EvidenceArtifact, stderr: EvidenceArtifact): GateEvidenceReceipt {
  return {
    invocationId: "inv-1",
    subject: { runId: "run-1", taskId: "T1", attempt: 0, gate: "build", subjectCommit: null },
    termination: { kind: "exit", exitCode: 0, signal: null, timedOut: false },
    availability: "available", redaction: { material: false }, stdout, stderr,
  };
}

function seedRun(): { root: string; out: Buffer; err: Buffer } {
  // Callers hand the resolver a canonical root: it is their trust anchor, and the resolver follows no link.
  const root = realpathSync(makeTestTempDir("tickmarkr-receipt-"));
  mkdirSync(join(root, "gate-evidence"), { recursive: true });
  const out = Buffer.from("build ok\n"), err = Buffer.from("");
  writeFileSync(join(root, "gate-evidence", "inv-1-stdout.log"), out);
  writeFileSync(join(root, "gate-evidence", "inv-1-stderr.log"), err);
  return { root, out, err };
}

describe("receipt resolver", () => {
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

  test("a directory swapped for a symlink while the leaf is being opened is refused, not followed (deterministic race)", () => {
    // One pathname open on every platform (no /proc/self/fd branch), so this swap fires identically on Ubuntu and macOS.
    const { root, out } = seedRun();
    // A decoy directory whose entry is the SAME inode (a hard link) under the RIGHT name, reached only
    // via a link: a post-open inode comparison by pathname cannot tell it from the real leaf.
    const real = join(root, "gate-evidence"), aside = join(root, "gate-evidence.aside");
    const target = join(real, "inv-1-stdout.log");
    mkdirSync(join(root, "decoy"));
    linkSync(target, join(root, "decoy", "inv-1-stdout.log"));
    let swapped = 0;
    const open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      // Between the pre-open check and the open of the LEAF: gate-evidence becomes a link to the decoy…
      if (path === target) { renameSync(real, aside); symlinkSync(join(root, "decoy"), real); swapped++; }
      try { return open(path as string, flags as number, mode as number); }
      // …and is restored before any post-open check could notice by pathname alone.
      finally { if (path === target) { fs.unlinkSync(real); renameSync(aside, real); } }
    });
    syncBuiltinESMExports();
    const resolved = resolveReceipt(artifact("gate-evidence/inv-1-stdout.log", out), root);
    expect(swapped).toBe(1);
    expect(resolved).toEqual({ ok: false, path: "gate-evidence/inv-1-stdout.log", reason: "symlink" });
  });

  test("verified bytes under the run root resolve available with their hash", () => {
    const { root, out, err } = seedRun();
    const rows = resolveReceiptArtifacts(receipt(artifact("gate-evidence/inv-1-stdout.log", out), artifact("gate-evidence/inv-1-stderr.log", err)), root);
    expect(rows).toEqual([
      { ok: true, path: "gate-evidence/inv-1-stdout.log", sha256: sha(out) },
      { ok: true, path: "gate-evidence/inv-1-stderr.log", sha256: sha(err) },
    ]);
    expect(formatReceiptResolution(rows[0]!)).toBe(`gate-evidence/inv-1-stdout.log available sha256=${sha(out)}`);
  });

  test("test: a reference outside the run root a symlink inside the run root or a hash mismatch resolves as unavailable naming the reason, so a resolver that dereferences any symlink or trusts an unverified file fails", () => {
    const { root, out } = seedRun();
    const outside = makeTestTempDir("tickmarkr-receipt-outside-");
    writeFileSync(join(outside, "leak.log"), out);

    // Outside the root, by traversal or by absolute path — the schema's own bounds are re-checked here.
    expect(resolveReceipt({ ...artifact("../leak.log", out) }, root)).toEqual({ ok: false, path: "../leak.log", reason: "outside-root" });
    expect(resolveReceipt({ ...artifact(join(outside, "leak.log"), out) }, root)).toMatchObject({ ok: false, reason: "outside-root" });
    expect(resolveReceipt({ ...artifact("gate-evidence/../../x/leak.log", out) }, root)).toMatchObject({ ok: false, reason: "outside-root" });

    // A symlink inside the root — to a file with the RIGHT bytes — is still refused: never dereferenced.
    symlinkSync(join(root, "gate-evidence", "inv-1-stdout.log"), join(root, "gate-evidence", "link-stdout.log"));
    expect(resolveReceipt(artifact("gate-evidence/link-stdout.log", out), root)).toEqual({ ok: false, path: "gate-evidence/link-stdout.log", reason: "symlink" });
    // …and a symlinked directory component is refused before any file under it is read.
    symlinkSync(join(root, "gate-evidence"), join(root, "linked-dir"));
    expect(resolveReceipt(artifact("linked-dir/inv-1-stdout.log", out), root)).toMatchObject({ ok: false, reason: "symlink" });

    // A run root that is itself a symlink is refused before anything under it is inspected…
    const linkedRoot = join(realpathSync(makeTestTempDir("tickmarkr-receipt-linkroot-")), "root");
    symlinkSync(root, linkedRoot);
    expect(resolveReceipt(artifact("gate-evidence/inv-1-stdout.log", out), linkedRoot)).toMatchObject({ ok: false, reason: "symlink" });
    // …and so is a root reached THROUGH a link above it (`/base/link/run` with `/base/link -> /base/real`).
    const base = realpathSync(makeTestTempDir("tickmarkr-receipt-ancestor-"));
    mkdirSync(join(base, "real", "run", "gate-evidence"), { recursive: true });
    writeFileSync(join(base, "real", "run", "gate-evidence", "inv-1-stdout.log"), out);
    symlinkSync(join(base, "real"), join(base, "link"));
    expect(resolveReceipt(artifact("gate-evidence/inv-1-stdout.log", out), join(base, "real", "run"))).toMatchObject({ ok: true });
    expect(resolveReceipt(artifact("gate-evidence/inv-1-stdout.log", out), join(base, "link", "run"))).toEqual({ ok: false, path: "gate-evidence/inv-1-stdout.log", reason: "symlink" });

    // Bytes on disk that no longer match the recorded hash are not evidence.
    writeFileSync(join(root, "gate-evidence", "inv-1-stdout.log"), "tampered\n");
    expect(resolveReceipt(artifact("gate-evidence/inv-1-stdout.log", out), root)).toEqual({ ok: false, path: "gate-evidence/inv-1-stdout.log", reason: "hash-mismatch" });
    // A same-hash prefix with extra trailing bytes is a mismatch too (length is part of the check).
    writeFileSync(join(root, "gate-evidence", "inv-1-stdout.log"), out);
    expect(resolveReceipt(artifact("gate-evidence/inv-1-stdout.log", out, { retainedBytes: out.length - 1 }), root)).toMatchObject({ ok: false, reason: "hash-mismatch" });
    expect(formatReceiptResolution({ ok: false, path: "p", reason: "hash-mismatch" })).toBe("p unavailable (hash-mismatch)");
  });

  test("test: an expired or missing artifact resolves as unavailable and the view re-executes no command nor picks a substitute file by name, so a resolver that repairs a missing artifact fails", () => {
    const { root, out } = seedRun();
    // A sibling with the exact bytes and a near-identical name exists; the resolver must not pick it.
    writeFileSync(join(root, "gate-evidence", "inv-2-stdout.log"), out);
    const before = readdirSync(join(root, "gate-evidence")).sort();

    expect(resolveReceipt(artifact("gate-evidence/inv-9-stdout.log", out), root)).toEqual({ ok: false, path: "gate-evidence/inv-9-stdout.log", reason: "missing" });
    expect(resolveReceipt(artifact("gate-evidence/inv-1-stdout.log", out, { availability: "expired", sha256: null }), root)).toEqual({ ok: false, path: "gate-evidence/inv-1-stdout.log", reason: "expired" });
    expect(resolveReceipt(artifact("gate-evidence/inv-1-stdout.log", out, { availability: "missing", sha256: null }), root)).toMatchObject({ ok: false, reason: "missing" });
    expect(resolveReceipt(artifact("gate-evidence/inv-1-stdout.log", out, { availability: "not-started", sha256: null, retainedBytes: 0 }), root)).toMatchObject({ ok: false, reason: "missing" });
    // An unparseable reference is never guessed at.
    expect(resolveReceipt(undefined, root)).toEqual({ ok: false, path: "", reason: "missing" });
    expect(resolveReceipt({ path: "gate-evidence/inv-1-stdout.log" }, root)).toMatchObject({ ok: false, reason: "missing" });

    // Nothing was created, repaired or executed: the evidence directory is byte-identical in shape.
    expect(readdirSync(join(root, "gate-evidence")).sort()).toEqual(before);
  });
});
