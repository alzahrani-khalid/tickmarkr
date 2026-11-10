import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const source = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

// B1: construct the only allowed port and contract S differences, then compare every shipped byte.
test("the shipped board.tsx equals the reference board.tsx line for line except the state types import the tickmarkr-board reopen footer the spec-naming head the contract S stale additions and the row 393 ended-run lines", () => {
  const reference = source("tests/fixtures/board/reference/board.tsx");
  let expected = reference;
  const replaceOne = (from: string, to: string) => {
    expect(expected.split(from), `reference contains exactly one ${from}`).toHaveLength(2);
    expected = expected.replace(from, to);
  };

  replaceOne("import type { AttemptLine, AttemptPart, RunSnapshot, TaskRow } from '../types'",
    'import type { AttemptLine, AttemptPart, RunSnapshot, TaskRow } from "./state"');
  replaceOne("type BoardState = { ticks: number; seen: number; live: boolean; sel: string | null }",
    "type BoardState = { ticks: number; seen: number; live: boolean; sel: string | null; readAt: string; unreadSec: number; readTicks: number; anchor: number }");
  replaceOne("  // The frame clock: start it once; it ticks while the run is live, and a new snapshot (a new atEpoch) restarts the count.",
    "  // The frame clock counts time since the last read even for ended runs; live ticks keep their atEpoch-based meaning.");
  replaceOne("      if (cur?.live) surface.setState({ ...cur, ticks: cur.ticks + 1 })",
    "      if (cur) surface.setState({ ...cur, ticks: cur.ticks + (cur.live ? 1 : 0), unreadSec: cur.unreadSec + 1 })");
  replaceOne("    st = { ticks: 0, seen: s.atEpoch, live, sel: null }",
    "    st = { ticks: 0, seen: s.atEpoch, live, sel: null, readAt: s.readAt, unreadSec: 0, readTicks: 0, anchor: Math.floor(Date.now() / 1000) }");
  replaceOne(`  } else if (st.seen !== s.atEpoch || st.live !== live) {
    st = { ...st, ticks: 0, seen: s.atEpoch, live }
    surface.setState(st)
  }
  const now = s.atEpoch + (live ? st.ticks : 0)`, `  } else if (st.seen !== s.atEpoch || st.live !== live || st.readAt !== s.readAt) {
    const newRead = st.readAt !== s.readAt
    const ticks = st.seen !== s.atEpoch || st.live !== live ? 0 : st.ticks
    st = { ...st, ticks, seen: s.atEpoch, live, readAt: s.readAt, unreadSec: newRead ? 0 : st.unreadSec, readTicks: newRead ? ticks : st.readTicks, anchor: newRead ? Math.floor(Date.now() / 1000) : st.anchor }
    surface.setState(st)
  }
  const stale = st.unreadSec >= 30
  const now = s.atEpoch + (live ? stale ? st.readTicks : st.ticks : 0)
  // queue row 393 (D-2187 add.16): atEpoch is the run's end once ended, so the age clock is wall time
  // anchored at this read plus the frame timer. Live durations keep \`now\`.
  const frame = st.anchor + st.unreadSec
  const age = ageOf(frame - (s.endEpoch ?? frame))`);
  replaceOne("  const life = s.ended", "  const life = stale ? { word: `STALE · read ${s.readAt}`, color: INK.warn } : s.ended");
  replaceOne("        word: s.ended.owed === null ? 'ENDED · owed unknown' : s.ended.owed > 0 ? `ENDED · owes ${s.ended.owed}` : 'ENDED',",
    "        word: `${s.ended.owed === null ? 'ENDED · owed unknown' : s.ended.owed > 0 ? `ENDED · owes ${s.ended.owed}` : 'ENDED'} · ended ${hmOf(s.endEpoch ?? s.atEpoch)} · ${age} ago`,");
  replaceOne("        <Box key=\"head-2\"", "        {stale ? <Text color={INK.warn}>not refreshed since {s.readAt} — /tickmarkr-board reloads it</Text> : null}\n        {s.ended ? <Text color={INK.warn}>{`no run live — showing the last run, ${s.runId}, ended ${age} ago`}</Text> : null}\n        {s.ended && s.supersededBy ? <Text color={INK.warn}>{`older than release ${s.supersededBy} — a newer run left no journal under these roots`}</Text> : null}\n        <Box key=\"head-2\"");
  replaceOne("<Text bold>{s.runId.replace(/^run-/, '').replace(/-0+(\\d+)$/, ' · #$1')}</Text>",
    "<Text bold>{s.spec ? `${s.spec} · ${s.runId.replace(/^.*-0*(?=\\d+$)/, '#')}` : s.runId.replace(/^run-/, '').replace(/-0+(\\d+)$/, ' · #$1')}</Text>");
  replaceOne("/run-progress reopens", "/tickmarkr-board reopens");
  replaceOne(`const dur = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec))
  return s >= 3600 ? \`\${Math.floor(s / 3600)}h \${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m\` : s >= 60 ? \`\${Math.floor(s / 60)}m \${String(s % 60).padStart(2, '0')}s\` : \`\${s}s\`
}`, `const dur = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec))
  return s >= 3600 ? \`\${Math.floor(s / 3600)}h \${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m\` : s >= 60 ? \`\${Math.floor(s / 60)}m \${String(s % 60).padStart(2, '0')}s\` : \`\${s}s\`
}
/** Age of an ended run (queue row 393, D-2187 add.16): the frame clock minus endEpoch, floored. A negative difference reads \`0m\`. */
const ageOf = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec))
  if (s >= 48 * 3600) return \`\${Math.floor(s / 86400)}d\`
  if (s >= 3600) return \`\${Math.floor(s / 3600)}h\`
  return \`\${Math.floor(s / 60)}m\`
}
/** Local \`HH:MM\` of an epoch, rounded the way the reader formats \`readAt\`. */
const hmOf = (epoch: number): string => {
  const d = new Date(Math.floor(Math.round(epoch * 1e6) / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  return \`\${two(d.getHours())}:\${two(d.getMinutes())}\`
}`);
  replaceOne("    if (!s.id) return [{ ...lead, text: `${lead.text}…` }]",
    "    if (!s.id) return [{ ...lead, text: `${lead.text}…` }]\n    // queue row 393 (D-2187 add.16): an oracles judge is not a harness, so the seat has no mark\n    if (s.id === 'oracles') return [{ ...lead, text: `${lead.text}oracles` }]");
  replaceOne("/** The harnesses seated anywhere in the run, in first-seen order, for the legend under the board. */\nconst harnessesOf = (s: RunSnapshot): string[] =>\n  [...new Set(s.tasks.flatMap(t => [t.worker, t.judge, t.reviewer]).filter(Boolean).map(id => splitSeat(id).harness))]",
    "/** The harnesses seated anywhere in the run, in first-seen order, for the legend under the board. `oracles` is not one (row 393, D-2187 add.16). */\nconst harnessesOf = (s: RunSnapshot): string[] =>\n  [...new Set(s.tasks.flatMap(t => [t.worker, t.judge, t.reviewer]).filter(id => id !== '' && id !== 'oracles').map(id => splitSeat(id).harness))]");
  // B1, queue row 398 (D-2187 add.24): the cannot-finish ETA, the blocked state, the exclusion lines and the reason drawn once.
  replaceOne("/** A pill's glyph", "/** Queue row 398 (D-2187 add.24): a blocked task has not started either, so its pill and colour read as pending's. */\nconst idle = (t: TaskRow): boolean => t.state === 'pending' || t.state === 'blocked'\n\n/** A pill's glyph");
  replaceOne("t.state === 'pending' ? '○'", "idle(t) ? '○'");
  replaceOne("  : t.state === 'worker' ? { word: 'RUNNING'",
    "  : t.state === 'blocked' ? { word: 'BLOCKED', color: INK.fail } // row 398 (D-2187 add.24): stranded behind a stop\n  : t.state === 'worker' ? { word: 'RUNNING'");
  replaceOne("t.state === 'pending' ? 'subtle'", "idle(t) ? 'subtle'");
  replaceOne("            {t.state === 'pending'", "            {idle(t)");
  replaceOne("  const eta = s.eta\n",
    "  // queue row 398 (D-2187 add.24): a run that cannot finish names its stopped roots instead of promising a time\n  const eta = s.eta?.cannotFinish ? `cannot finish · stopped by ${s.eta.stoppedBy.join(', ')}`\n    : s.eta\n");
  replaceOne("            eta ? <Text color=\"subtle\">{eta}</Text> : null,",
    "            eta ? <Text color={s.eta?.cannotFinish ? INK.fail : 'subtle'}>{eta}</Text> : null,");
  replaceOne("            {red && t.note ? <Text color={stateColor(t)} wrap=\"truncate-end\">{clip(`↳ ${t.note}`, room)}</Text> : null}",
    "            {/* row 398 (D-2187 add.24): the reason is drawn once (no ↳ line when the now-sentence already carries it) and wraps whole */}\n            {red && t.note && !nowOf(t).includes(t.note) ? <Text color={stateColor(t)} wrap=\"wrap\">{`↳ ${t.note}`}</Text> : null}");
  replaceOne("a newer run left no journal under these roots`}</Text> : null}\n",
    "a newer run left no journal under these roots`}</Text> : null}\n        {/* queue row 398 (D-2187 add.24): one line per channel excluded run-wide; none without an entry */}\n        {(s.exclusions ?? []).map(x => <Text color={INK.warn}>{`excluded run-wide: ${x.channel} — ${x.cause} (journal line ${x.line})`}</Text>)}\n");

  // B1, queue row 408 (D-2187 add.48 and add.49): the budget's `more` prop and the one more-tasks line after the last card.
  replaceOne("export type BoardProps = { snap: RunSnapshot; error: string | null; fit?: number; marks?: 'glyph' | 'devicons' }",
    "/** `more` (queue row 408, D-2187 add.48 and add.49): the count of last tasks the board budget left out of `snap`. */\nexport type BoardProps = { snap: RunSnapshot; error: string | null; fit?: number; marks?: 'glyph' | 'devicons'; more?: number }");
  replaceOne("  const { snap: s, error, fit = 1, marks: logos = 'glyph' } = raw as unknown as BoardProps",
    "  const { snap: s, error, fit = 1, marks: logos = 'glyph', more = 0 } = raw as unknown as BoardProps");
  replaceOne("        {s.tasks.map(t => card(t, t.id === s.needsYou[0]?.task))}\n      </Box>\n",
    "        {s.tasks.map(t => card(t, t.id === s.needsYou[0]?.task))}\n      </Box>\n      {/* queue row 408 (D-2187 add.48 and add.49): the budget left the last tasks out; one line counts them */}\n      {more > 0 ? <Text key=\"more\" color=\"subtle\" wrap=\"truncate-end\">{`+${more} more tasks (see tickmarkr status)`}</Text> : null}\n");

  expect(source("hooks/board/board.tsx")).toBe(expected);
});
