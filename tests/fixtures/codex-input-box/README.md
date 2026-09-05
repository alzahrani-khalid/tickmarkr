# codex-input-box fixture (OBS-930, 2026-09-05)

Verbatim captures of the **codex 0.153.4 TUI** (`codex-cli 0.153.4`) read through `herdr pane read`
— never typed from memory (law: fixtures are verbatim captures). They pin `CODEX_INPUT_BOX`
(`src/adapters/codex.ts`), the adapter-declared input box the herdr driver's typed-delivery pincer
needs (OBS-136/140 interface), and the OBS-930 launch shape that produced the pane.

## Capture record

- Host pane: `wZ:p14E`, split off the fix seat's own pane in tab `wZ:tK7` (`herdr pane split wZ:p14D
  --direction down --no-focus`); scratch repo `/private/tmp/tkr-obs930-smoke` (a `git init` with one
  empty commit, never this repository, never a tickmarkr run). Closed after capture.
- Launch (15:46:10Z): the EXACT string `codex.interactiveCommand("/private/tmp/tkr-obs930-smoke/prompt.md",
  "gpt-5.4-mini")` rendered from the fix branch's `dist/adapters/codex.js`, wrapped in a 3-line
  `launch.sh` (`cd` + the command + an exit echo), run with `herdr pane run`. The prompt file was three
  lines: "You are a smoke test. / Reply with the single word PONG and then stop. / Do not run any commands."
- The workspace-trust dialog fired first (`trust-dialog.txt`, from the `herdr pane wait-output` read at
  15:46:11Z — the exact text `CODEX_TRUST_DIALOG` fingerprints); answered with `herdr pane send-keys
  wZ:p14E Enter` at 15:46:16Z, the daemon's own `sendKey` path.
- `transcript-recent-unwrapped.txt`: `herdr pane read wZ:p14E --source recent-unwrapped --lines 60
  --format text` at 15:48:10Z, after the assistant answered. It shows the prompt submitted as the FIRST
  user turn (echoed `› You are a smoke test.` + two indented continuation rows), the answer `• PONG`,
  and the idle composer.
- `idle-visible.txt` / `idle-visible.ansi`: `herdr pane read wZ:p14E --source visible --lines 12
  --format text|ansi` at 15:48:10Z, composer idle.
- `occupied-visible.txt` / `occupied-visible.ansi`: same reads at 15:48:10Z after `herdr pane send-text
  wZ:p14E "draft turn not submitted"` (typed, NOT submitted).

## What the frames show (the matcher's evidence)

- The composer is three rows painted on one background (`48;2;46;46;46` in the ANSI form): a blank
  row, `› <text>`, a blank row — then the footer `<model> <effort> · <cwd>` on the next row
  (`gpt-5.6-luna medium · /private/tmp/tkr-obs930-smoke`). Text reads render the background rows blank.
- The caret is U+203A `›` followed by a plain ASCII space (0x20) — not the U+00A0 claude pads with.
- An EMPTY composer paints its placeholder as text: `› Ask Codex to do anything`, dim (`2m`). So
  "empty" is a closed allowlist of captured placeholders, never "no text after the caret".
- A submitted user turn is echoed into the transcript with the SAME caret (`› You are a smoke test.`),
  and the trust dialog's selection cursor is the same glyph (`› 1. Yes, continue`). Neither is followed
  by the footer row, which is what the matcher anchors on — a bare `› ` fingerprint would read every
  echoed turn as an occupied editor (the claude-submitted-echo class).
- `• You have 2 usage limit resets available. Run /usage to use one.` sits in the frame's tail: the
  `QUOTA_CHROME_RE` allowlist in `src/run/stall.ts` already filters that exact line before `QUOTA_RE`
  runs (`stallSnapshotBannerRows`), so an idle codex TUI never reads as a quota banner.
- `• Model changed to gpt-5.6-luna medium` (transcript, row 3): codex 0.153.4 MIGRATED the requested
  `--model gpt-5.4-mini` to `gpt-5.6-luna` (`[notice.model_migrations]` in the operator's
  `~/.codex/config.toml`) and ran the migrated model. The launch line and the routing record still say
  `gpt-5.4-mini`. Recorded in `.tickmarkr/overseer/FIX-OBS930-REPORT.md` as an open observation.
