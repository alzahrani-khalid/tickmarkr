import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { EvidenceArtifactSchema, type EvidenceArtifact, type GateEvidenceReceipt } from "./protocol.js";

// OBS-1101 retrieval (D-174): the one production reader of an execution-evidence receipt. It answers
// from the bytes on disk under the run root the receipt was minted in and nothing else — no
// re-execution, no substitute chosen by name or timestamp, no symlink followed anywhere: not in the
// reference, not at the root, not above it. The caller hands a canonical root (its own trust anchor);
// a root reached through any link is refused outright.

export const RECEIPT_UNAVAILABLE_REASONS = ["outside-root", "symlink", "hash-mismatch", "expired", "missing"] as const;
export type ReceiptUnavailableReason = (typeof RECEIPT_UNAVAILABLE_REASONS)[number];

export type ReceiptResolution =
  | { readonly ok: true; readonly path: string; readonly sha256: string }
  | { readonly ok: false; readonly path: string; readonly reason: ReceiptUnavailableReason };

/** Resolve one artifact reference against the run root it was recorded under. Fails closed. */
export function resolveReceipt(reference: unknown, runRoot: string): ReceiptResolution {
  const parsed = EvidenceArtifactSchema.safeParse(reference);
  const path = typeof (reference as { path?: unknown })?.path === "string" ? (reference as { path: string }).path : "";
  if (!parsed.success) {
    const escapes = path && (isAbsolute(path) || path.includes("\\") || path.split("/").includes(".."));
    return { ok: false, path, reason: escapes ? "outside-root" : "missing" };
  }
  const ref: EvidenceArtifact = parsed.data;
  if (ref.availability === "expired") return { ok: false, path: ref.path, reason: "expired" };
  if (ref.availability !== "available" || ref.sha256 === null) return { ok: false, path: ref.path, reason: "missing" };

  const root = resolve(runRoot);
  const full = resolve(root, ref.path);
  const rel = relative(root, full);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { ok: false, path: ref.path, reason: "outside-root" };

  const read = readUnderRoot(root, rel.split(sep));
  if (typeof read === "string") return { ok: false, path: ref.path, reason: read };
  const sha256 = createHash("sha256").update(read).digest("hex");
  if (sha256 !== ref.sha256 || read.length !== ref.retainedBytes) return { ok: false, path: ref.path, reason: "hash-mismatch" };
  return { ok: true, path: ref.path, sha256 };
}

const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

/** Every ancestor of the root, root first excluded — "/" itself cannot be a link. */
function ancestors(root: string): string[] {
  const out: string[] = [];
  for (let p = dirname(root); p !== dirname(p); p = dirname(p)) out.push(p);
  return out;
}

/**
 * Walk `parts` below `root` one descriptor at a time and return the leaf's bytes. Every component —
 * the root's ancestors, the root, each directory, the leaf — is opened O_NOFOLLOW and must be the
 * same inode lstat reports for that name before AND after the open, so a component swapped for a
 * link mid-walk is refused rather than followed. Every platform takes the same pathname open: an
 * ancestor swap by a same-privilege writer can only ever yield hash-identical bytes (D-269), so no
 * descriptor-anchored traversal is layered on top (D-279: the boundary is the run root).
 */
function readUnderRoot(root: string, parts: readonly string[]): Buffer | ReceiptUnavailableReason {
  for (const p of ancestors(root)) {
    let st: Stats;
    try { st = lstatSync(p); } catch { return "missing"; }
    if (st.isSymbolicLink()) return "symlink";
  }
  const fds: number[] = [];
  try {
    let parent = openComponent(root, true);
    if (typeof parent === "string") return parent;
    fds.push(parent);
    let at = root;
    for (let i = 0; i < parts.length; i++) {
      at = resolve(at, parts[i]!);
      const fd = openComponent(at, i < parts.length - 1);
      if (typeof fd === "string") return fd;
      fds.push(fd);
      parent = fd;
    }
    return readFileSync(parent);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ELOOP" ? "symlink" : "missing";
  } finally {
    for (const fd of fds) closeSync(fd);
  }
}

function openComponent(path: string, dir: boolean): number | ReceiptUnavailableReason {
  let before: Stats;
  try { before = lstatSync(path); } catch { return "missing"; }
  if (before.isSymbolicLink()) return "symlink";
  if (dir ? !before.isDirectory() : !before.isFile()) return "missing";
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (dir ? constants.O_DIRECTORY : 0);
  const fd = openSync(path, flags);
  let after: Stats;
  try { after = lstatSync(path); } catch { closeSync(fd); return "missing"; }
  const opened = fstatSync(fd);
  if (after.isSymbolicLink() || !same(before, opened) || !same(after, opened)) { closeSync(fd); return "symlink"; }
  // A leaf reachable under a second name (a hard link) is an alias the inode check cannot see through;
  // evidence is written once under one name, so any aliased leaf is refused.
  if (!dir && opened.nlink !== 1) { closeSync(fd); return "symlink"; }
  return fd;
}

/** Both artifacts of a receipt, stdout first, each resolved independently. */
export function resolveReceiptArtifacts(receipt: GateEvidenceReceipt, runRoot: string): ReceiptResolution[] {
  return [receipt.stdout, receipt.stderr].map(ref => resolveReceipt(ref, runRoot));
}

/** One line per artifact for a human surface: the reference, then its verified availability. */
export function formatReceiptResolution(r: ReceiptResolution): string {
  return r.ok ? `${r.path} available sha256=${r.sha256}` : `${r.path} unavailable (${r.reason})`;
}
