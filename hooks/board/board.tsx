import type { ClientModule, ClientSurface, JsonValue } from 'claude-code'

import type { AttemptLine, AttemptPart, RunSnapshot, TaskRow } from "./state"

/**
 * The now board, drawn as a Client surface module: it knows its width (`surface.columns`) and lays out by it, and its
 * frame clock ticks every running duration once a second between the hooks module's polls. The hooks module hands it
 * `{ snap, error }` as props; a press that needs `$` (Copy) goes back through `surface.post`.
 */
/**
 * `fit`: text characters per layout cell. Desktop measures the pane in its code font's advance but draws this text in a
 * narrower proportional font, so a line cut at the cell count ends well short of the edge.
 */
export type BoardProps = { snap: RunSnapshot; error: string | null; fit?: number; marks?: 'glyph' | 'devicons' }
type BoardState = { ticks: number; seen: number; live: boolean; sel: string | null }
type Layout = 'wide' | 'medium' | 'narrow'
type Mark = 'pass' | 'fail' | 'running' | 'queued' | 'pending'
type Piece = { text: string; color?: string; bold?: boolean }

/**
 * tickmarkr's board palette (the approved tasks-redesign frame; xterm-256 index → hex). Colour carries state, never
 * identity; text hierarchy stays on the theme's text / subtle / inactive, so a light theme keeps it readable.
 */
export const INK = {
  accent: '#5fafff', // 75: structure and focus — section bars, task numbers, merged time
  pass: '#5faf5f', // 71
  fail: '#d78787', // 174
  warn: '#d7af5f', // 179: in flight
  park: '#af87d7', // 140: waits on a human
  chrome: '#444444', // 238: rules, borders, separators, the keys line
  brand: '#00d75f', // brand ramp anchor 41: the tickmark tile behind the product chip
  ink: '#121212', // the near-black knockout ink on a filled chip or pill
} as const

export const WIDE = 140
export const MEDIUM = 90
export const layoutFor = (columns: number): Layout => (columns === 0 ? 'medium' : columns >= WIDE ? 'wide' : columns >= MEDIUM ? 'medium' : 'narrow')

/** one visual weight: the dingbat ticks and the geometric circles render at the same size (◎ waits, ● runs, ○ has not started) */
const MARK_GLYPH: Record<Mark, string> = { pass: '✔', fail: '✖', running: '●', queued: '◎', pending: '○' }
const MARK_COLOR: Record<Mark, string> = { pass: INK.pass, fail: INK.fail, running: INK.warn, queued: INK.accent, pending: 'inactive' }
/** a release stage draws in the task marks' own glyph and colour: done ✔, failed ✖, running ●, pending ○ */
const STAGE_MARK: Record<'pending' | 'running' | 'done' | 'failed', Mark> = { done: 'pass', failed: 'fail', running: 'running', pending: 'pending' }
const TONE_COLOR: Record<AttemptPart['tone'], string> = { pass: INK.pass, fail: INK.fail, wait: 'subtle', open: INK.warn }
const CHECKS = ['build', 'lint', 'evidence', 'scope'] as const
/** The four gate marks on a card, by name. 'Build' covers the cheap pre-merge checks (build, lint, evidence, scope). */
const GATE_NAMES = ['Build', 'Accept', 'Review', 'Test'] as const
/** Cells a card needs before two sit side by side; below it one card takes the width and its lines wrap or cut. */
export const CARD_MIN = 60
/** The task number's column: tall (two rows) where the surface has type sizes, plain bold on the terminal. At least
 * BADGE_W cells, widened to the run's longest id so a five-character id (T2441) never wraps or clips at title size. */
const BADGE_W = 6
/** Cells a title-size character takes where the surface scales text (fit > 1); one cell on the terminal. */
const TITLE_CELLS = 1.3
/** The board's text step: one below body, so the pane reads as a dense board beside the chat. */
const TEXT_SIZE = 'footnote'
export const badgeWidth = (ids: readonly string[], fit: number): number =>
  Math.max(BADGE_W, Math.ceil(Math.max(0, ...ids.map(len)) * (fit > 1 ? TITLE_CELLS : 1)) + 1)

const len = (s: string): number => [...s].length
const clip = (s: string, n: number): string => (n <= 0 ? '' : len(s) > n ? [...s].slice(0, Math.max(0, n - 1)).join('') + '…' : s)
/** Live durations read to the second under an hour, so a running phase visibly moves. */
const dur = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec))
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}
const fill = (text: string, since: number | null | undefined, now: number): string => (since == null ? text : text.replace('{since}', dur(now - since)))
const sentence = (s: string): string => s.toLowerCase().replace(/^\w/, c => c.toUpperCase())

/**
 * Steps that keep their TAIL within `width`: the latest steps are what matter, so the oldest go first, the first step
 * kept as an anchor where it fits (`first → … → last two`), and a last step too long by itself is cut at its head.
 */
const tailPieces = (pieces: Piece[], width: number): Piece[] => {
  const total = (ps: Piece[]) => ps.reduce((n, p) => n + len(p.text), 0)
  if (total(pieces) <= width) return pieces
  const sep = (p: Piece): Piece => ({ ...p, text: p.text.replace(/^ → /, '') })
  const tail = (k: number) => pieces.slice(pieces.length - k).map((p, i) => (i === 0 ? sep(p) : p))
  // first the middle gives way (`first → … → the latest`), keeping at least the last two; then the first step too
  for (let k = pieces.length - 2; k >= 2; k--) {
    const anchored = [pieces[0]!, { text: ' → … → ', color: 'subtle' }, ...tail(k)]
    if (total(anchored) <= width) return anchored
  }
  for (let k = pieces.length - 1; k >= 1; k--) {
    const bare = [{ text: '… → ', color: 'subtle' }, ...tail(k)]
    if (total(bare) <= width) return bare
  }
  const last = sep(pieces[pieces.length - 1]!)
  return [{ ...last, text: len(last.text) <= width ? last.text : '…' + [...last.text].slice(len(last.text) - width + 1).join('') }]
}

/** Pieces clipped so their total stays within `width`: the cut piece ends in an ellipsis and nothing after it shows. */
const fitPieces = (pieces: Piece[], width: number): Piece[] => {
  const out: Piece[] = []
  let room = width
  for (const p of pieces) {
    if (room <= 0) break
    const t = len(p.text) <= room ? p.text : clip(p.text, room)
    out.push({ ...p, text: t })
    room -= len(t)
    if (t !== p.text) break
  }
  return out
}

/**
 * The four cells, read from the gate results of the current attempt. A cell with no result is the open one while the
 * task is in its gates: the checks first, then acceptance and review together, then the full suite. A suite-slot wait
 * shows ◎ on the cell it holds up (the full suite, or acceptance while its oracle waits for the slot).
 */
export const cellMarks = (t: TaskRow): Mark[] => {
  const g = t.gates
  const res = (k: string): Mark | undefined => (g[k] === 'pass' ? 'pass' : g[k] === 'fail' ? 'fail' : undefined)
  const checksRed = CHECKS.some(k => g[k] === 'fail')
  const chk: Mark = checksRed ? 'fail' : CHECKS.some(k => g[k] !== undefined) || g.acceptance !== undefined || g.review !== undefined || g.test !== undefined ? 'pass' : 'pending'
  const marks: Mark[] = [chk, res('acceptance') ?? 'pending', res('review') ?? 'pending', res('test') ?? 'pending']
  if (t.state === 'done') return marks.map(m => (m === 'pending' ? 'pass' : m))
  if (t.state !== 'gates' || checksRed) return marks
  if (chk === 'pending') return ['running', ...marks.slice(1)]
  if (marks[1] === 'pending' || marks[2] === 'pending') {
    if (marks[1] === 'pending') marks[1] = t.suiteWaiting ? 'queued' : 'running'
    if (marks[2] === 'pending') marks[2] = 'running'
  } else if (marks[3] === 'pending') {
    marks[3] = t.suiteWaiting ? 'queued' : 'running'
  }
  return marks
}

/**
 * A harness's mark: a glyph shaped after its logo in place of its name (a Client draws text only, so no logo images),
 * in the vendor's brand colour where it has one, so ✻ reads as Claude the way Orca's sidebar draws it, with no font or
 * setting to install. Marks are always the bold glyph beside a seat, never a state, so state keeps its own palette.
 * ponytail: the harnesses this fleet runs; an unknown one draws a bullet and still gets its legend entry.
 */
const HARNESS: Record<string, string> = {
  'claude-code': '✻', codex: '⬡', agy: '✦', gemini: '✦', grok: '⊘', qwen: '◈', kimi: '☾', pi: 'π', omp: 'π', opencode: '◫',
}
/**
 * The `devicons` marks option: the real logos, as Devicons icon-font codepoints (devicons@2.3.0 dist/devicons.css,
 * the `-icon` symbol variants where one exists). They draw only where the terminal's font list names Devicons, so
 * glyphs stay the default. A harness Devicons has no logo for (pi, omp) keeps its glyph.
 */
const DEVICONS: Record<string, string> = {
  'claude-code': '\uf214', codex: '\uf7d2', agy: '\uf86a', gemini: '\uf7a6', grok: '\uf7a7', qwen: '\uf7ea',
  kimi: '\uf81d', opencode: '\uf7e6',
}
/** Brand colours, read from each logo's own SVG fill and lifted where the logo's ink is too dark for a dark pane. */
const BRAND: Record<string, string> = {
  'claude-code': '#d97757', codex: '#7a9dff', agy: '#3186ff', gemini: '#3186ff', qwen: '#6a7dff', kimi: '#1783ff',
}
export const markOf = (harness: string, marks: BoardProps['marks'] = 'glyph'): { glyph: string; color: string } => {
  const glyph = (marks === 'devicons' ? DEVICONS[harness] : undefined) ?? HARNESS[harness]
  return glyph ? { glyph, color: BRAND[harness] ?? 'text' } : { glyph: '•', color: 'subtle' }
}
/** `codex:gpt-6.1-sol` → harness `codex`, model `gpt-6.1-sol`; a bare id is all harness. */
const splitSeat = (id: string): { harness: string; model: string } => {
  const i = id.indexOf(':')
  return i < 0 ? { harness: id, model: '' } : { harness: id.slice(0, i), model: id.slice(i + 1) }
}

/**
 * The seats on a task, the one working right now marked active: the worker while it runs, the judge and reviewer while
 * their gates run. Each seat reads `role ⬡ model`, the harness drawn as its mark.
 */
const seats = (t: TaskRow, logos: BoardProps['marks']): Piece[] => {
  const [, a, r] = cellMarks(t)
  const list = [
    t.worker ? { role: 'worker', id: t.worker, active: t.state === 'worker' } : null,
    t.judge || a === 'running' ? { role: 'judge', id: t.judge, active: a === 'running' } : null,
    t.reviewer || r === 'running' ? { role: 'review', id: t.reviewer, active: r === 'running' } : null,
  ].filter((s): s is { role: string; id: string; active: boolean } => s !== null)
  return list.flatMap((s, i) => {
    const tone = { color: s.active ? INK.warn : 'subtle', bold: s.active }
    const lead = { text: `${i ? ' · ' : ''}${s.role} `, ...tone }
    if (!s.id) return [{ ...lead, text: `${lead.text}…` }]
    const { harness, model } = splitSeat(s.id)
    const m = markOf(harness, logos)
    return [lead, { text: m.glyph, color: m.color, bold: true }, ...(model ? [{ text: ` ${model}`, ...tone }] : [])]
  })
}

/** The harnesses seated anywhere in the run, in first-seen order, for the legend under the board. */
const harnessesOf = (s: RunSnapshot): string[] =>
  [...new Set(s.tasks.flatMap(t => [t.worker, t.judge, t.reviewer]).filter(Boolean).map(id => splitSeat(id).harness))]

/** A pill's glyph, so the strip never reads by colour alone. */
const pillGlyph = (t: TaskRow): string =>
  t.state === 'done' ? '✔' : t.state === 'parked' ? '◍' : t.state === 'failed' ? '✖' : t.state === 'pending' ? '○' : t.suiteWaiting ? '◎' : '●'

/** A bar of `frac` of `width` cells, its last cell in eighths so short durations still differ. */
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
export const bar = (frac: number, width: number): string => {
  const cells = Math.max(0, Math.min(1, frac)) * width
  const full = Math.floor(cells)
  const part = EIGHTHS[Math.round((cells - full) * 8)] ?? ''
  return '█'.repeat(full) + (part || (full === 0 && frac > 0 ? '▏' : ''))
}

/** Attempts used: the 1-based attempt against the task's budget (one fresh plus its funded repairs). */
const attemptsUsed = (t: TaskRow): number => (t.dispatched ? t.attempt + 1 : 0)

/** `2/3`, `–` before the first dispatch; warning on the last attempt in flight, error once it stopped with none left. */
const triesText = (t: TaskRow): string =>
  !t.dispatched ? '–' : `${attemptsUsed(t)}/${t.budget}${(t.launches ?? 0) > attemptsUsed(t) ? ` · ${t.launches} in all` : ''}`
const triesColor = (t: TaskRow): string => {
  if (t.state === 'done' || attemptsUsed(t) < t.budget) return 'subtle'
  return t.state === 'parked' || t.state === 'failed' ? INK.fail : INK.warn
}

/** The card's status word. tickmarkr merges green work, so a done task reads MERGED; QUEUED waits for a worker slot. */
const statusOf = (t: TaskRow): { word: string; color: string } =>
  t.state === 'done' ? { word: 'MERGED', color: INK.pass }
  : t.state === 'parked' ? { word: 'PARKED', color: INK.park }
  : t.state === 'failed' ? { word: 'FAILED', color: INK.fail }
  : t.state === 'worker' ? { word: 'RUNNING', color: INK.warn }
  : t.state === 'gates' ? { word: 'VERIFYING', color: t.suiteWaiting ? INK.accent : INK.warn }
  : t.state === 'waiting' || /^waits on /.test(t.now) ? { word: 'WAITING', color: 'subtle' }
  : { word: 'QUEUED', color: 'subtle' }

const stateColor = (t: TaskRow): string =>
  t.state === 'done' ? INK.pass : t.state === 'parked' ? INK.park : t.state === 'failed' ? INK.fail : t.state === 'pending' ? 'subtle' : t.suiteWaiting ? INK.accent : INK.warn


const featured = (s: RunSnapshot): TaskRow | undefined =>
  s.tasks.find(t => t.state === 'parked')
  ?? s.tasks.find(t => t.state === 'worker' || t.state === 'waiting' || t.state === 'gates')
  ?? [...s.tasks].sort((a, b) => b.attempt - a.attempt)[0]

const kTok = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const Board: ClientModule<JsonValue, BoardState> = (raw, surface: ClientSurface<BoardState>) => {
  const { Box, Button } = surface.elements
  // One step below body for the whole board, set once here so no Text can miss it; a Text that names a size keeps it.
  // The terminal has one size and ignores the step.
  const Text: typeof surface.elements.Text = p => surface.elements.Text({ size: TEXT_SIZE, ...p })
  const { snap: s, error, fit = 1, marks: logos = 'glyph' } = raw as unknown as BoardProps
  const live = s.ended === null

  // The frame clock: start it once; it ticks while the run is live, and a new snapshot (a new atEpoch) restarts the count.
  let st = surface.state
  if (st === undefined) {
    surface.every(1000, () => {
      const cur = surface.state
      if (cur?.live) surface.setState({ ...cur, ticks: cur.ticks + 1 })
    })
    st = { ticks: 0, seen: s.atEpoch, live, sel: null }
    surface.setState(st)
  } else if (st.seen !== s.atEpoch || st.live !== live) {
    st = { ...st, ticks: 0, seen: s.atEpoch, live }
    surface.setState(st)
  }
  const now = s.atEpoch + (live ? st.ticks : 0)
  const cols = surface.columns
  const layout = layoutFor(cols)
  const W = Math.max(30, (cols || 110) - 2) // the room inside the 1-cell side padding
  // character budgets for text: the cells it may take times the characters a cell holds (Text still truncates at the edge)
  const TW = Math.floor(W * fit)
  const perRow = W >= 2 * CARD_MIN + 1 ? 2 : 1
  const cardW = perRow === 2 ? Math.floor((W - 1) / 2) : W
  // a card's text beside the badge: the card less its border, its padding and the badge column
  const badgeW = badgeWidth(s.tasks.map(t => t.id), fit)
  const room = Math.floor((cardW - 4 - badgeW) * fit)

  const done = s.tasks.filter(t => t.state === 'done').length
  // green only when every clause of the green rule holds: empty buckets, tip verify passed, owed checks known and zero
  const life = s.ended
    ? {
        word: s.ended.owed === null ? 'ENDED · owed unknown' : s.ended.owed > 0 ? `ENDED · owes ${s.ended.owed}` : 'ENDED',
        color: s.ended.failed.length || s.ended.human.length || s.ended.blocked.length || s.ended.pending.length
          || s.ended.tipVerify !== 'passed' || s.ended.owed !== 0 ? INK.fail : INK.pass,
      }
    : s.alive ? { word: 'LIVE', color: INK.pass } : { word: 'DAEMON DOWN', color: INK.fail }
  const eta = s.eta
    ? `ETA ${dur(s.eta.cleanMin * 60).replace(/ 00s$/, '')} – ${dur(s.eta.oneRepairMin * 60).replace(/ 00s$/, '')}${s.eta.stoppedBy.length ? ` · clock stopped on ${s.eta.stoppedBy.join(', ')}` : ''}`
    : null
  const elapsed = s.startEpoch == null ? '' : `${dur((s.endEpoch ?? now) - s.startEpoch)} elapsed`
  const focus = s.tasks.find(t => t.id === st.sel) ?? featured(s)
  const nowOf = (t: TaskRow): string => fill(t.now, t.nowSince, now)

  const pieces = (ps: Piece[], key: string) => (
    <Box key={key} flexDirection="row" flexShrink={1} minWidth={0}>
      {ps.map(p => <Text color={p.color} bold={p.bold} wrap="truncate-end">{p.text}</Text>)}
    </Box>
  )
  /** A section head as the board draws it: the accent bar, the title in bold, a muted caption. */
  const section = (key: string, title: string, caption: string) => (
    <Box key={key} flexDirection="row" gap={1}>
      <Text color={INK.accent}>▌</Text>
      <Text bold>{title}</Text>
      <Text color="subtle" wrap="truncate-end">{caption}</Text>
    </Box>
  )
  const timeOf = (t: TaskRow): string[] =>
    t.startEpoch == null ? ['not started']
    : t.endEpoch != null ? [`started ${t.startedAt}`, `merged ${t.endedAt} after ${dur(t.endEpoch - t.startEpoch)}`]
    : [`started ${t.startedAt}`, `${dur(now - t.startEpoch)} elapsed`]

  /**
   * One card per task. Its head is two rows beside the task number: the title and its status word, then tries and the four
   * gates. Under the title: the models (the one working now in amber), when it started and for how long, and what it is
   * doing now. A parked card carries its approve command. Every row wraps or cuts inside the card, so any width holds.
   */
  const card = (t: TaskRow, copyKey: boolean) => {
    const st = statusOf(t)
    const marks = cellMarks(t)
    const need = s.needsYou.find(n => n.task === t.id)
    const red = t.state === 'parked' || t.state === 'failed'
    const working = t.state === 'worker' || t.state === 'waiting' || t.state === 'gates'
    const ms = seats(t, logos)
    return (
      <Box key={`card-${t.id}`} flexDirection="column" width={cardW} flexShrink={0} paddingX={1} borderStyle="round"
        borderColor={red ? stateColor(t) : working ? INK.warn : INK.chrome}>
        <Box key={`card-top-${t.id}`} flexDirection="row">
          <Box key={`badge-${t.id}`} flexDirection="column" justifyContent="center" width={badgeW} flexShrink={0}>
            <Text color={st.color} size="heading" weight="bold">{t.id}</Text>
          </Box>
          <Box key={`head-${t.id}`} flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Box key={`title-${t.id}`} flexDirection="row" columnGap={2}>
              <Box key={`title-t-${t.id}`} flexGrow={1} flexShrink={1} minWidth={0}>
                <Text bold wrap="truncate-end">{clip(sentence(t.title), room - len(st.word) - 2)}</Text>
              </Box>
              <Box key={`status-${t.id}`} flexShrink={0}><Text color={st.color} bold>{st.word}</Text></Box>
            </Box>
            <Box key={`gates-${t.id}`} flexDirection="row" flexWrap="wrap" columnGap={2}>
              <Box key={`tries-${t.id}`} flexDirection="row" flexShrink={0}>
                <Text color="subtle">tries </Text>
                <Text color={triesColor(t)} bold>{triesText(t)}</Text>
              </Box>
              {GATE_NAMES.map((g, k) => (
                <Box key={`gate-${t.id}-${g}`} flexDirection="row" flexShrink={0}>
                  <Text color="subtle">{`${g} `}</Text>
                  <Text color={MARK_COLOR[marks[k]!]} bold>{MARK_GLYPH[marks[k]!]}</Text>
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
        <Box key={`card-body-${t.id}`} flexDirection="row">
          <Box key={`card-pad-${t.id}`} width={badgeW} flexShrink={0} />
          <Box key={`card-lines-${t.id}`} flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            {ms.length ? pieces(fitPieces(ms, room), `seats-${t.id}`) : <Text color="subtle">no model yet</Text>}
            <Box key={`time-${t.id}`} flexDirection="row" flexWrap="wrap">
              {timeOf(t).map((x, i) => <Text color="subtle">{(i ? ' · ' : '') + x}</Text>)}
            </Box>
            {t.state === 'done' ? null : <Text color={stateColor(t)} wrap="wrap">{nowOf(t)}</Text>}
            {red && t.note ? <Text color={stateColor(t)} wrap="truncate-end">{clip(`↳ ${t.note}`, room)}</Text> : null}
            {need ? (
              <Box key={`need-c-${t.id}`} flexDirection="row" columnGap={1}>
                <Button key={`copy-${t.id}`} label="Copy" variant="primary" {...(copyKey ? { hotkey: 'c' } : {})} onPress={() => surface.post({ copy: need.cmd })} />
                <Box key={`need-cmd-${t.id}`} flexShrink={1} minWidth={0}><Text wrap="wrap">{need.cmd}</Text></Box>
              </Box>
            ) : null}
          </Box>
        </Box>
      </Box>
    )
  }

  /** One attempt per line: the steps fill the room left of the red reason, which always reads last; nothing wraps. */
  const attemptWide = (t: TaskRow, a: AttemptLine) => {
    const prefix = `a${a.att} ${a.start}  `
    const red = [...a.parts].reverse().find(p => p.reason)
    const reason = red?.reason ? ` — ${red.reason}` : ''
    const room = TW - len(prefix)
    const steps: Piece[] = a.parts.map((p, k) => ({ text: (k ? ' → ' : '') + fill(p.text, p.since, now), color: TONE_COLOR[p.tone] }))
    const stepsLen = steps.reduce((n, p) => n + len(p.text), 0)
    // the reason always shows: whole when the line holds it, else up to half the room, the steps keeping their tail
    const reasonW = !reason ? 0 : stepsLen + len(reason) <= room ? len(reason) : Math.min(len(reason), Math.max(Math.floor(room / 2), room - stepsLen))
    return (
      <Box key={`att-${t.id}-${a.att}`} flexDirection="row">
        <Text bold>{`a${a.att}`}</Text>
        <Text color="subtle">{` ${a.start}  `}</Text>
        {pieces(tailPieces(steps, room - reasonW), `att-steps-${t.id}-${a.att}`)}
        {reason ? <Text color={INK.fail} wrap="truncate-end">{clip(reason, reasonW)}</Text> : null}
      </Box>
    )
  }
  const attemptNarrow = (t: TaskRow, a: AttemptLine) => (
    <Box key={`att-${t.id}-${a.att}`} flexDirection="column">
      <Text bold>{`a${a.att} ${a.start}`}</Text>
      {a.parts.map((p, k) => (
        <Box key={`att-${t.id}-${a.att}-${k}`} flexDirection="row">
          <Text color={TONE_COLOR[p.tone]} wrap="truncate-end">{clip(`  ${fill(p.text, p.since, now)}${p.reason ? ` — ${p.reason}` : ''}`, TW)}</Text>
        </Box>
      ))}
    </Box>
  )

  return (
    <Box key="dash" flexDirection="column" gap={1} paddingX={1}>
      <Box key="head" flexDirection="column">
        <Box key="head-1" flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Box key="chip" flexShrink={0}><Text backgroundColor={INK.brand} color={INK.ink} bold>{' tickmarkr '}</Text></Box>
          <Text bold>{s.spec ? `${s.spec} · ${s.runId.replace(/^.*-0*(?=\d+$)/, '#')}` : s.runId.replace(/^run-/, '').replace(/-0+(\d+)$/, ' · #$1')}</Text>
          <Text color={INK.chrome}>│</Text>
          <Text color={life.color} bold>● {life.word}</Text>
        </Box>
        <Box key="head-2" flexDirection={layout === 'narrow' ? 'column' : 'row'} columnGap={1}>
          {[
            <Text color={INK.pass} bold>{done} of {s.tasks.length} merged</Text>,
            elapsed ? <Text color="subtle">{elapsed}</Text> : null,
            eta ? <Text color="subtle">{eta}</Text> : null,
          ].filter(x => x !== null).flatMap((x, i) => (i && layout !== 'narrow' ? [<Text color={INK.chrome}>│</Text>, x] : [x]))}
        </Box>
      </Box>

      <Box key="strip" flexDirection="row" flexWrap="wrap" columnGap={1}>
        {s.tasks.map(t => (
          <Box key={`pill-${t.id}`} flexShrink={0}>
            {t.state === 'pending'
              ? <Text color="inactive">{` ${pillGlyph(t)} ${t.id} `}</Text>
              : <Text backgroundColor={stateColor(t)} color={INK.ink} bold>{` ${pillGlyph(t)} ${t.id} `}</Text>}
          </Box>
        ))}
        <Box key="strip-pct" flexShrink={0}><Text color="subtle">{`${s.tasks.length ? Math.round((100 * done) / s.tasks.length) : 0}% merged`}</Text></Box>
      </Box>

      {s.needsYou.length ? (
        <Box key="needs" flexDirection="column" borderStyle="round" borderColor={INK.park} paddingX={1}>
          <Text color={INK.park} bold wrap="truncate-end">
            {clip(`◍ ${s.needsYou.map(n => n.task).join(', ')} ${s.needsYou.length > 1 ? 'need' : 'needs'} you — the approve command is in ${s.needsYou.length > 1 ? 'their cards' : 'its card'}`, TW - 4)}
          </Text>
          {(() => {
            const w = s.approvalWindow
            if (!w) return null
            const left = Math.floor(w.closesAt - now)
            return <Text color={INK.warn} bold>{left > 0 ? `approval window closes in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} — then the run ends PARTIAL` : 'approval window closing — the run ends PARTIAL unless released'}</Text>
          })()}
        </Box>
      ) : null}

      {s.release ? (
        <Box key="release" flexDirection="column">
          {section('release-head', `RELEASE ${s.release.version}`,
            `CI run ${s.release.ciRun ?? 'unknown'}${s.release.mirror ? ` on ${s.release.mirror}` : ''}${s.release.polledAt ? ` · polled ${s.release.polledAt}` : ''}`)}
          <Box key="release-stages" flexDirection="row" flexWrap="wrap" columnGap={2}>
            {s.release.stages.map(g => (
              <Box key={`stage-${g.name}`} flexShrink={0}>
                <Text color={MARK_COLOR[STAGE_MARK[g.state]]} bold={g.state !== 'pending'}>
                  {`${MARK_GLYPH[STAGE_MARK[g.state]]} ${g.name}${g.detail ? ` ${g.detail}` : ''}`}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      ) : null}

      {section('tasks-head', 'TASKS', 'cards in run order · gates in pipeline order')}
      <Box key="tasks" flexDirection="row" flexWrap="wrap" columnGap={1}>
        {s.tasks.map(t => card(t, t.id === s.needsYou[0]?.task))}
      </Box>

      {s.ended ? (
        <Text bold wrap="truncate-end">
          {clip(`run-end · merged ${s.ended.done.join(', ') || '—'} · parked ${s.ended.human.join(', ') || '—'} · failed ${s.ended.failed.join(', ') || '—'} · blocked ${s.ended.blocked.join(', ') || '—'} · tip verify ${s.ended.tipVerify ?? '?'}`, TW)}
        </Text>
      ) : null}

      {(() => {
        // where the time went: wall time from first dispatch to merge (or now), each bar against the longest
        const started = s.tasks.filter(t => t.startEpoch != null)
        if (!started.length) return null
        const spanOf = (t: TaskRow) => (t.endEpoch ?? now) - t.startEpoch!
        const longest = Math.max(1, ...started.map(spanOf))
        const idW = Math.max(...started.map(t => len(t.id)))
        // bars measure cells, not text characters, so a block glyph in a proportional face never overruns the pane
        const barW = Math.max(8, Math.min(60, W - idW - 22))
        return (
          <Box key="time" flexDirection="column">
            <Text color={INK.chrome} wrap="truncate-end">{'─'.repeat(W)}</Text>
            {section('time-head', 'WHERE THE TIME WENT', 'wall time per task, first dispatch to merge')}
            {started.map(t => (
              <Box key={`time-row-${t.id}`} flexDirection="row" gap={1}>
                <Box key={`time-id-${t.id}`} width={idW} flexShrink={0}><Text color={INK.accent} bold>{t.id}</Text></Box>
                <Box key={`time-bar-${t.id}`} flexShrink={0}><Text color={t.endEpoch == null ? stateColor(t) : INK.accent}>{bar(spanOf(t) / longest, barW)}</Text></Box>
                <Box key={`time-dur-${t.id}`} flexShrink={0}><Text color={t.endEpoch == null ? stateColor(t) : 'subtle'} bold={t.endEpoch == null}>
                  {`${dur(spanOf(t))}${t.endEpoch == null ? (t.state === 'parked' ? ' · parked' : ' · running') : ''}`}
                </Text></Box>
              </Box>
            ))}
          </Box>
        )
      })()}

      <Box key="hist" flexDirection="column">
        <Box key="hist-head" flexDirection="row" gap={1} flexWrap="wrap">
          <Text color={INK.accent}>▌</Text>
          <Text bold>ATTEMPTS</Text>
          {s.tasks.map((t, i) => (
            <Button
              key={`pick-${t.id}`}
              label={t.id}
              plain
              dimColor={t.id !== focus?.id}
              {...(i < 9 ? { hotkey: String(i + 1) } : {})}
              onPress={() => surface.setState({ ...(surface.state ?? st), sel: t.id })}
            />
          ))}
          {focus?.tokens ? <Text color="subtle">{`tokens in ${kTok(focus.tokens.input)} · out ${kTok(focus.tokens.output)} · cache ${kTok(focus.tokens.cacheRead)}`}</Text> : null}
        </Box>
        {focus && focus.history.length
          ? focus.history.map(a => (layout === 'narrow' ? attemptNarrow(focus, a) : attemptWide(focus, a)))
          : <Text color="subtle">{focus ? `${focus.id} has not started` : 'no tasks'}</Text>}
      </Box>
      {harnessesOf(s).length ? (
        <Box key="legend" flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text color="inactive">legend</Text>
          {harnessesOf(s).map(name => (
            <Box key={`legend-${name}`} flexDirection="row" flexShrink={0}>
              <Text color={markOf(name, logos).color} bold>{markOf(name, logos).glyph}</Text>
              <Text color="subtle">{` ${name}`}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
      {error ? <Text color={INK.fail}>last read failed: {error}</Text> : null}
      <Text key="keys" color={INK.chrome} wrap="truncate-end">
        {`1–${Math.min(9, s.tasks.length)} attempts${s.needsYou.length ? ' · c copy the approve command' : ''} · /tickmarkr-board reopens · read every 5s`}
      </Text>
    </Box>
  )
}

export default Board
