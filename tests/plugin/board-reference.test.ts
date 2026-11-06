import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const source = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

// B1: construct the only allowed port and contract S differences, then compare every shipped byte.
test("the shipped board.tsx equals the reference board.tsx line for line except the state types import the tickmarkr-board reopen footer the spec-naming head and the contract S stale additions", () => {
  const reference = source("tests/fixtures/board/reference/board.tsx");
  let expected = reference;
  const replaceOne = (from: string, to: string) => {
    expect(expected.split(from), `reference contains exactly one ${from}`).toHaveLength(2);
    expected = expected.replace(from, to);
  };

  replaceOne("import type { AttemptLine, AttemptPart, RunSnapshot, TaskRow } from '../types'",
    'import type { AttemptLine, AttemptPart, RunSnapshot, TaskRow } from "./state"');
  replaceOne("type BoardState = { ticks: number; seen: number; live: boolean; sel: string | null }",
    "type BoardState = { ticks: number; seen: number; live: boolean; sel: string | null; readAt: string; unreadSec: number; readTicks: number }");
  replaceOne("  // The frame clock: start it once; it ticks while the run is live, and a new snapshot (a new atEpoch) restarts the count.",
    "  // The frame clock counts time since the last read even for ended runs; live ticks keep their atEpoch-based meaning.");
  replaceOne("      if (cur?.live) surface.setState({ ...cur, ticks: cur.ticks + 1 })",
    "      if (cur) surface.setState({ ...cur, ticks: cur.ticks + (cur.live ? 1 : 0), unreadSec: cur.unreadSec + 1 })");
  replaceOne("    st = { ticks: 0, seen: s.atEpoch, live, sel: null }",
    "    st = { ticks: 0, seen: s.atEpoch, live, sel: null, readAt: s.readAt, unreadSec: 0, readTicks: 0 }");
  replaceOne(`  } else if (st.seen !== s.atEpoch || st.live !== live) {
    st = { ...st, ticks: 0, seen: s.atEpoch, live }
    surface.setState(st)
  }
  const now = s.atEpoch + (live ? st.ticks : 0)`, `  } else if (st.seen !== s.atEpoch || st.live !== live || st.readAt !== s.readAt) {
    const newRead = st.readAt !== s.readAt
    const ticks = st.seen !== s.atEpoch || st.live !== live ? 0 : st.ticks
    st = { ...st, ticks, seen: s.atEpoch, live, readAt: s.readAt, unreadSec: newRead ? 0 : st.unreadSec, readTicks: newRead ? ticks : st.readTicks }
    surface.setState(st)
  }
  const stale = st.unreadSec >= 30
  const now = s.atEpoch + (live ? stale ? st.readTicks : st.ticks : 0)`);
  replaceOne("  const life = s.ended", "  const life = stale ? { word: `STALE · read ${s.readAt}`, color: INK.warn } : s.ended");
  replaceOne("        <Box key=\"head-2\"", "        {stale ? <Text color={INK.warn}>not refreshed since {s.readAt} — /tickmarkr-board reloads it</Text> : null}\n        <Box key=\"head-2\"");
  replaceOne("<Text bold>{s.runId.replace(/^run-/, '').replace(/-0+(\\d+)$/, ' · #$1')}</Text>",
    "<Text bold>{s.spec ? `${s.spec} · ${s.runId.replace(/^.*-0*(?=\\d+$)/, '#')}` : s.runId.replace(/^run-/, '').replace(/-0+(\\d+)$/, ' · #$1')}</Text>");
  replaceOne("/run-progress reopens", "/tickmarkr-board reopens");

  expect(source("hooks/board/board.tsx")).toBe(expected);
});
