# codex-mcp-spinner fixture (OBS-82, v1.57 T2)

Eight consecutive snapshots of a **live wedged codex pane**, each read through the **production
driver read path** — `HerdrDriver.read(slot, 1000)` (`src/drivers/herdr.ts`), the exact call whose
return value the daemon's stall compare consumes (`src/run/daemon.ts`, interactive loop). Captured
by `capture.ts` in this directory, not copied from rendered prose (spec ruling 7: herdr returns
rendered screen text; a raw-pty transcript would misrepresent what the daemon actually compares).

## Capture record — 2026-07-18T18:35Z

- Pane: `wW:pFY`, split from the T2 worker's own pane (`herdr pane split wW:pFX --direction down
  --no-focus`), closed after capture.
- Wedge (spec §0e, zero tokens — codex hangs on MCP startup before any inference; no prompt was
  ever submitted): launched in the trusted repo root with the production interactive posture plus
  a merge-ADDed MCP server pointing at sleep:

  ```
  codex -a never -s workspace-write -c "mcp_servers={}" \
    -c "mcp_servers.wedge.command=\"/bin/sleep\"" \
    -c "mcp_servers.wedge.args=[\"3600\"]" \
    -c "mcp_servers.wedge.startup_timeout_sec=600"
  ```

  The merge-ADD works precisely because of the OBS-82 regression (`mcp_servers={}` merges instead
  of replacing on codex 0.144.5).
- Frames: `npx tsx tests/fixtures/codex-mcp-spinner/capture.ts wW:pFY 8 2000` — 8 reads, 2s apart,
  18:35:15Z–18:35:30Z, while the pane sat at
  `• Starting MCP servers (7/8): wedge (Ns • esc to interrupt)`.

## What the frames show

Pairwise diffs: every consecutive pair differs **only** in the elapsed-time cell of the spinner
line (`17s → 19s → 21s → 24s → 26s → 28s → 30s → 32s`). That is the OBS-82 repaint: the daemon's
raw `!==` compare sees a new string every poll and never fires the stall clock. Through the herdr
read path the rendered text carries **no ANSI escapes and no braille glyph churn** — the animation
survives rendering only as the ticking time token (the braille/ANSI forms appear on the raw-pty
subprocess path, covered by unit strings in `tests/run/stall.test.ts`).

The scrollback (identical across frames) also documents codex 0.144.5's **default 30s MCP startup
timeout** firing on an earlier un-lengthened wedge run — the reason the capture sets
`startup_timeout_sec=600`. The OBS-82 incident (45m hang) involved a plugin-provided server, which
that default demonstrably did not cover.
