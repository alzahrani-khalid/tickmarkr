import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { BillingChannel, WorkerResult } from "../adapters/types.js";
import type { AcceptanceRunResult, ChannelResult } from "./dispatch.js";
import type { Fixture } from "./fixtures.js";

export interface ReportedResult {
  runAt: string;
  fixture: {
    id: string;
    revision: string;
  };
  channel: BillingChannel & {
    channelKey: string;
  };
  skipped: boolean;
  skipReason?: string;
  worker?: WorkerResult;
  acceptance?: AcceptanceRunResult;
}

const EXCLUDED_NAMES = new Set([".git", "node_modules", ".DS_Store"]);

/**
 * Deterministic content identity for a fixture revision. Hashes every file under
 * the fixture root (start + solution) so any change to the fixture's contents
 * changes the revision digest.
 */
export function fixtureRevisionHash(fixture: Fixture): string {
  const hash = createHash("sha256");

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (EXCLUDED_NAMES.has(ent.name)) continue;
      const full = `${dir}/${ent.name}`;
      const rel = relative(fixture.path, full);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        hash.update(`${rel}\0`);
        hash.update(readFileSync(full));
        hash.update("\0");
      }
    }
  }

  if (existsSync(fixture.path)) {
    walk(fixture.path);
  }

  return hash.digest("hex");
}

/**
 * Append a single fixture-channel result to the incremental JSON output file.
 * The write is synchronous so the bytes are on disk before the caller moves on
 * to the next channel.
 */
export function appendChannelResult(
  path: string,
  fixture: Fixture,
  result: ChannelResult,
  runAt?: string,
): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const row: ReportedResult = {
    runAt: runAt ?? new Date().toISOString(),
    fixture: {
      id: fixture.id,
      revision: fixtureRevisionHash(fixture),
    },
    channel: {
      ...result.channel,
      channelKey: result.channelKey,
    },
    skipped: result.skipped,
    ...(result.skipReason !== undefined ? { skipReason: result.skipReason } : {}),
    ...(result.worker !== undefined ? { worker: result.worker } : {}),
    ...(result.acceptance !== undefined ? { acceptance: result.acceptance } : {}),
  };

  appendFileSync(path, JSON.stringify(row) + "\n");
}

/**
 * Read every parseable line from an incremental JSON report. Torn or corrupt
 * trailing lines are ignored, so an interrupted run still yields every result
 * that was fully written.
 */
export function readReport(path: string): ReportedResult[] {
  if (!existsSync(path)) return [];
  const out: ReportedResult[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ReportedResult);
    } catch {
      // torn trailing write after an interrupt — ignore; earlier lines are intact
    }
  }
  return out;
}
