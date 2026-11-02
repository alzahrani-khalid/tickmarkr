import { atom, read, update } from 'claude-code'
import type { ClientElements, ClientSurface, EngineInterface as Engine, PluginOptions, Register } from 'claude-code'

import type { RunSnapshot } from '../types'
import Board from './board'

// The roots come from the manifest's userConfig (stateRoots, releaseRoots): comma-separated, ~ and globs expanded by the
// summarizer, so a new spec worktree under a globbed folder shows without an edit here.
const list = (v: PluginOptions[string] | undefined): string[] =>
  (Array.isArray(v) ? v : String(v ?? '').split(',')).map(s => s.trim()).filter(Boolean)
let summarizerArgs: string[] = []
let marks: 'glyph' | 'devicons' = 'glyph'
const PANE = 'tkr-run'
// the summarizer reads a run in ~0.13 s; between polls the board's own clock ticks the durations
const POLL_MS = 5000
const FALLBACK_COLUMNS = 100

const snapshot = atom({ plugin: 'tkr-run-progress', key: 'snapshot' } as const, null)
const error = atom({ plugin: 'tkr-run-progress', key: 'error' } as const, null)

const refresh = async ($: Engine): Promise<void> => {
  const ran = await $.process.run(['/usr/bin/python3', '-I', `${$.plugin.root}/hooks/summarize.py`, ...summarizerArgs], { timeoutMs: 20000 })
    .catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  if (ran.exitCode !== 0) {
    await update($, error, () => ran.stderr.trim().split('\n').slice(-1)[0] ?? 'summarizer failed')
    return
  }
  const snap = JSON.parse(ran.stdout) as RunSnapshot
  await update($, snapshot, () => snap)
  await update($, error, () => null)
  $.ui.status(statusLine(snap))
}

const statusLine = (s: RunSnapshot): string => {
  const done = s.tasks.filter(t => t.state === 'done').length
  const busy = s.tasks.filter(t => t.state !== 'done' && t.state !== 'pending').map(t => `${t.id} ${t.state}`)
  const life = s.ended ? 'ended' : s.alive ? 'live' : 'daemon down'
  const needs = s.needsYou.length ? ` · NEEDS YOU ${s.needsYou.map(n => n.task).join(', ')}` : ''
  const ci = s.release?.stages.find(g => g.name === 'CI')
  const rel = s.release ? ` · ${s.release.version} CI ${ci?.state === 'done' ? 'green' : ci?.state ?? '?'}` : ''
  return `tkr ${s.runId.slice(-4)} ${life} · ${done}/${s.tasks.length} done${needs}${busy.length ? ' · ' + busy.join(', ') : ''}${rel}`
}

/** Copies an approve command the board asked for, only when the current snapshot names it. */
const copyCommand = async ($: Engine, data: unknown, surface: Parameters<Engine['ui']['copy']>[0]['surface']): Promise<void> => {
  const cmd = (data as { copy?: unknown } | null)?.copy
  const s = await read($, snapshot)
  if (typeof cmd === 'string' && s?.needsYou.some(n => n.cmd === cmd)) await $.ui.copy({ text: cmd, ...(surface ? { surface } : {}) })
}

export const register: Register = (on, options) => {
  const releases = list(options?.releaseRoots)
  marks = String(options?.marks ?? '').trim() === 'devicons' ? 'devicons' : 'glyph'
  summarizerArgs = [...list(options?.stateRoots), ...(releases.length ? ['--release', ...releases] : [])]
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'run-progress', description: 'Show the live tickmarkr run in a pane' })
    void $.ui.open({ id: PANE, title: 'tickmarkr run' })
    void refresh($)
    $.clock.every(POLL_MS, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'run-progress' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'tickmarkr run' })
    return { text: 'Run progress pane opened.' }
  })

  // the board's Copy press: the surface module has no `$`, so it posts the command here
  on('ui.message', async ($, e, next) => {
    if (e.element !== 'board') return next(e)
    await copyCommand($, e.data, e.surface)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const s = await read($, snapshot)
    const err = await read($, error)
    if (s === null) return <els.Text color="subtle">{err ?? 'Waiting for the first read of the run…'}</els.Text>
    // ponytail: desktop's proportional body text ran ~1.3 characters per code-font cell (measured on its pane); the board
    // draws a step smaller (footnote), estimated at ~1.5. A line of unusually wide glyphs is then cut by Text's
    // truncate-end instead. A measured text width, if the surface ever offers one.
    const props = { snap: s, error: err, marks, ...(e.surface === 'desktop' ? { fit: 1.5 } : {}) }
    // a Client knows its width and ticks its own clock (terminal and desktop draw one; a resolved table names every
    // element, an absent one drawing as a fragment, so the surface decides, not the table); elsewhere the board draws once
    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Client } = $.ui.resolve(e)
      return <Client key="board" module="./board.tsx" props={props} width="100%" />
    }
    const still: ClientSurface<never> = {
      elements: els as unknown as ClientElements,
      state: undefined,
      setState: () => {},
      columns: FALLBACK_COLUMNS,
      rows: 0,
      every: () => () => {},
      onPointer: () => () => {},
      onKey: () => () => {},
      post: data => void copyCommand($, data, e.surface),
    }
    return Board(props as never, still as never)
  })
}
