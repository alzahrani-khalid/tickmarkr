import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  fleetEditableFromConfig,
  fleetEditableEquals,
  fleetRepoOverlayFromDelta,
  globalConfigDir,
  loadConfigWithMode,
  readOverlayFile,
  repoOverlayPath,
  repoOverlayYaml,
  unifiedYamlDiff,
  type FleetEditable,
} from "../config/config.js";
import { isRunLockLive } from "../run/lock.js";

export type SaveTarget = "repo" | "global";

/** Notice surfaced in the save modal whenever a run lock is live. */
export const RELOAD_GUARD_NOTICE =
  "reload guard: a live run is active; the running daemon will not see these changes until it reloads";

export type SaveProposal = {
  target: SaveTarget;
  targetPath: string;
  before: string;
  after: string;
  diff: string;
  liveRun: boolean;
  loadError: string | null;
};

export type SaveResult =
  | { kind: "written"; path: string }
  | { kind: "declined" }
  | { kind: "refused"; reason: string };

function overlayPath(repoRoot: string, target: SaveTarget, globalDir?: string): string {
  return target === "repo"
    ? repoOverlayPath(repoRoot)
    : join(globalDir ?? globalConfigDir(), "config.yaml");
}

function currentOverlayText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function computeAfterBytes(
  target: SaveTarget,
  loaded: FleetEditable,
  staged: FleetEditable,
  repoRoot: string,
  globalDir?: string,
): string {
  const path = overlayPath(repoRoot, target, globalDir);
  const existing = readOverlayFile(path);
  // Reuse the existing fleet serializer and diff renderer rather than inventing a parallel formatter.
  const merged = fleetRepoOverlayFromDelta(loaded, staged, existing);
  return repoOverlayYaml(merged);
}

function roundTripError(
  target: SaveTarget,
  repoRoot: string,
  after: string,
  staged: FleetEditable,
  globalDir?: string,
): string | null {
  try {
    let effective;
    if (target === "repo") {
      effective = loadConfigWithMode(repoRoot, { globalDir, repoOverlayText: after });
    } else {
      // Validate a candidate global overlay by loading with it in a scratch globalDir.
      const scratch = mkdtempSync(join(tmpdir(), "tickmarkr-global-rt-"));
      try {
        writeFileSync(join(scratch, "config.yaml"), after);
        effective = loadConfigWithMode(repoRoot, { globalDir: scratch });
      } finally {
        try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
      }
    }
    const reparsed = fleetEditableFromConfig(effective.cfg);
    if (!fleetEditableEquals(reparsed, staged)) {
      return "round-trip mismatch: the written overlay does not re-parse to the staged state";
    }
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Build the diff-confirm payload for the current staging delta and chosen target. */
export function buildSaveProposal(opts: {
  repoRoot: string;
  loaded: FleetEditable;
  staged: FleetEditable;
  target: SaveTarget;
  globalDir?: string;
}): SaveProposal {
  const path = overlayPath(opts.repoRoot, opts.target, opts.globalDir);
  const before = currentOverlayText(path);
  const after = computeAfterBytes(opts.target, opts.loaded, opts.staged, opts.repoRoot, opts.globalDir);
  const diff = unifiedYamlDiff(before, after, path);
  const loadError = roundTripError(opts.target, opts.repoRoot, after, opts.staged, opts.globalDir);
  return {
    target: opts.target,
    targetPath: path,
    before,
    after,
    diff,
    liveRun: isRunLockLive(opts.repoRoot),
    loadError,
  };
}

function atomicWrite(path: string, bytes: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // The sibling temp keeps rename(2) on one filesystem: readers see old or new bytes, never a partial overlay.
  const tmp = join(dir, `.tickmarkr-save-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true }); // a failed rename must not leave a partial candidate behind
    throw e;
  }
}

/** Confirm and execute the write for the chosen target. */
export function confirmSave(opts: {
  repoRoot: string;
  loaded: FleetEditable;
  staged: FleetEditable;
  target: SaveTarget;
  globalDir?: string;
}): SaveResult {
  const proposal = buildSaveProposal(opts);
  if (proposal.loadError) {
    return { kind: "refused", reason: proposal.loadError };
  }
  if (proposal.before === proposal.after) {
    return { kind: "declined" };
  }
  atomicWrite(proposal.targetPath, proposal.after);
  return { kind: "written", path: proposal.targetPath };
}
