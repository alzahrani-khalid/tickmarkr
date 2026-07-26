import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, useApp, useInput } from "ink";
import { createElement, useEffect, useState } from "react";
import { stateDirName } from "../../graph/graph.js";
import { Journal, parseRunId } from "../../run/journal.js";
import type { RunCockpitData, RunCockpitSource } from "./derive.js";
import { deriveRunCockpitData, RunCockpitFrame } from "./run-cockpit.js";
import {
  applyFilterInput,
  dispatchRunKey,
  initialRunInteractionState,
  SURFACE_KEY_BINDINGS,
  type RunInteractionState,
} from "./keys.js";

// ponytail: fixed 2s re-derive cadence, matching `status --watch`; promote to a
// config knob only if an operator asks.
const REFRESH_MS = 2_000;

/**
 * THE engagement selection rule — stated once, here, so it can change in one
 * place without touching the renderer or the command: an explicit engagement
 * reference from the command line wins; the bare command opens the most
 * recently started engagement that has a readable journal.
 */
export function selectEngagementRunId(cwd: string, explicit?: string): string | null {
  if (explicit !== undefined) return parseRunId(explicit);
  return Journal.latestRunId(cwd, { withJournal: true });
}

/**
 * The journal bytes of a real engagement — never a committed capture. A read
 * failure throws: the caller refuses rather than drawing from nothing.
 */
export function loadEngagementSource(cwd: string, runId: string): RunCockpitSource {
  const id = parseRunId(runId);
  const path = join(cwd, stateDirName(cwd), "runs", id, "journal.jsonl");
  const raw = readFileSync(path, "utf8");
  return { fileName: `${id}.journal.jsonl`, raw };
}

// The same s/m/h age vocabulary `status` speaks (status.ts fmtAge).
export function formatEventAge(ageMs: number): string {
  const safe = Math.max(0, ageMs);
  if (safe < 90_000) return `${Math.floor(safe / 1_000)}s`;
  if (safe < 5_400_000) return `${Math.floor(safe / 60_000)}m`;
  return `${Math.floor(safe / 3_600_000)}h`;
}

function lastEventMs(raw: string): number | undefined {
  const lines = raw.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { ts?: unknown };
      const ms = typeof parsed.ts === "string" ? Date.parse(parsed.ts) : NaN;
      if (Number.isFinite(ms)) return ms;
    } catch {
      // a torn trailing line does not hide the event written before it
    }
  }
  return undefined;
}

/**
 * Live derivation over a real engagement's journal bytes. The header's
 * elapsed field additionally states how long ago the engagement's last event
 * arrived, so an engagement that has stopped moving reads as stale rather
 * than as current. Throws on unreadable bytes (empty capture, no run-start) —
 * the caller refuses instead of rendering a plausible surface from nothing.
 */
export function deriveLiveRunCockpitData(
  source: RunCockpitSource,
  binaryVersion: string,
  now: () => number = Date.now,
): RunCockpitData {
  const data = deriveRunCockpitData(source, binaryVersion);
  const lastMs = lastEventMs(source.raw);
  const staleness = lastMs === undefined
    ? "last event unknown"
    : `last event ${formatEventAge(now() - lastMs)} ago`;
  return { ...data, elapsed: `${data.elapsed} · ${staleness}` };
}

function LiveApp({
  cwd,
  runId,
  binaryVersion,
  columns,
  rows,
  refreshMs,
  now,
}: {
  cwd: string;
  runId: string;
  binaryVersion: string;
  columns: number;
  rows: number;
  refreshMs: number;
  now: () => number;
}) {
  const { exit } = useApp();
  const [data, setData] = useState<RunCockpitData>(() =>
    deriveLiveRunCockpitData(loadEngagementSource(cwd, runId), binaryVersion, now)
  );
  const [interaction, setInteraction] = useState<RunInteractionState>(
    initialRunInteractionState,
  );
  useEffect(() => {
    const timer = setInterval(() => {
      try {
        setData(deriveLiveRunCockpitData(loadEngagementSource(cwd, runId), binaryVersion, now));
      } catch {
        // a torn read mid-append keeps the last good frame rather than blanking the surface
      }
    }, refreshMs);
    return () => clearInterval(timer);
  }, [cwd, runId, binaryVersion, refreshMs, now]);
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    // While the / prompt is open it owns the keyboard: characters grow the
    // query and no advertised binding fires.
    if (interaction.filterPrompt) {
      const prompted = applyFilterInput({ input, key }, interaction);
      if (prompted !== undefined) setInteraction(prompted);
      return;
    }
    const next = dispatchRunKey(
      { input, key },
      interaction,
      SURFACE_KEY_BINDINGS.run,
    );
    if (next === undefined) return;
    setInteraction(next);
    if (next.quit) exit();
  });
  return createElement(RunCockpitFrame, { data, columns, rows, interaction });
}

export async function runLiveCockpit({
  input,
  output,
  cwd,
  runId,
  binaryVersion,
  refreshMs = REFRESH_MS,
  now = Date.now,
}: {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  cwd: string;
  runId: string;
  binaryVersion: string;
  refreshMs?: number;
  now?: () => number;
}): Promise<void> {
  const columns = output.columns ?? 80;
  const rows = output.rows ?? 24;
  const app = render(createElement(LiveApp, {
    cwd,
    runId,
    binaryVersion,
    columns,
    rows,
    refreshMs,
    now,
  }), {
    stdin: input,
    stdout: output,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await app.waitUntilExit();
  } finally {
    app.unmount();
  }
}
