## Specialist pipeline rules

### On herdr (`HERDR_ENV=1`) — specialist panes

- **Dedicated consultant tab**: Consultants (agents spawned to gather synthesis input for decisions like SCOPER analysis or architectural reviews) must run in a DEDICATED tab separate from the ORCHESTRATOR tab. The dedicated consultant tab persists beyond an orchestrator retirement only while the mission continues; the latest settled round follows mission-end teardown at that mission's end (queue row 240; D-2138 add.1 R3).
- **Scoper worktree rule**: The SCOPER (or any worktree-based specialist synthesizing into the spec pipeline) must do ALL git operations in a dedicated worktree in the seats-directory home `<repo>-seats/<name>` (e.g., `git worktree add -b spec/<mission> <repo>-seats/scoper-<mission>`), never switching the main checkout's branch. Append its path, scoper purpose, owner seat and mission-end removal condition to `.tickmarkr/overseer/checkouts.ledger` before use. The hand-made checkout law (queue row 240; D-2138 add.1 R4, add.4) governs it: at mission end remove only a clean owned checkout with no keep reason using `git worktree remove <repo>-seats/scoper-<mission>` without force and close its line; dirty or kept checkouts stay and are reported. Before removing a detached HEAD, prove reachability from a retained named ref with `git for-each-ref --contains <sha>`, otherwise pin `refs/tickmarkr/preserved/<sha>` and write that handle on its ledger line first. This prevents race conditions between the specialist's branch operations and the orchestrator's shipping logic.
- **One fresh pane per consult ROUND** (operator rule, 2026-08-04): every consult round spawns a NEW pane in
  the consult tab rather than re-prompting the seat that answered last round — unless there is a stated
  reason to reuse. Two payoffs: each round starts with a clean context window instead of inheriting the
  previous round's, which is what fills a long mission's seats and forces mid-mission `/clear`; and the
  prior round's pane persists as a readable record of what that seat actually saw and said. Reuse only when
  continuity of the seat's own reasoning is the point, and say so when you do.
- **CLOSE WHAT YOU SPAWNED**: apply the universal mission-end teardown, including the spawn record
  ownership check and current mission's stand-down. The spawner is responsible for closure.
  Keep the active seat and latest settled consult round while the mission continues; at its end close
  or name the next mission and clear before reuse (queue row 240; D-2138 add.1 R3, add.4).
  - For a seat owning its tab, after verified `herdr pane close <pane>`, explicitly use
    `herdr tab close <tab>` at the recorded tab id and prove absence from `herdr tab list`; shared tabs
    stay while a pending sibling owns a pane. The spawn record must match live label and checkout first.
  - **Automatic closure**: `TKR_CLOSE_PANES="w1:p1,w1:p2" watch-artifacts.sh …` supplies one recorded
    pane address per artifact, in argument order. Both all-complete and wake-on-any exits close only
    completed artifacts with current-mission stood-down files and verified ledger identity, never
    pending siblings or timeout. No ledger record means a reported refusal and an open pane.
    Do not arm closure for the latest settled consult round while its mission continues.

- **MEASURE BEFORE EVERY SPLIT, AND JOIN *DOWN* WHEN A RIGHT-SPLIT WOULD GO UNDER THE FLOOR.**
  **Operator-observed 2026-08-06, with a screenshot:** five consult panes in one tab rendered **14 columns
  wide each** out of 220 — every one unreadable, including the two that had finished hours earlier.
  **This rule's own earlier wording said to "split the newest pane; the tree stays balanced", and that
  remedy is wrong** — an OVERSEER followed it the next session and measured `110/55/55`, which is the
  exact split the old text cited as the *failure*. Corrected, with the measurement:
  - **Direction is decided by arithmetic, not by which pane you pick.** The driver's floor is real and
    derived from measurement — `TRAILER_SAFE_FLOOR_COLS = 108` (`src/drivers/herdr.ts:13`, *"narrowest
    safe 53 → floor 108"*), and it splits right only while `paneWidth/2 ≥ 108 + 2` (`herdr.ts:494`),
    otherwise **down**. Apply the same test by hand: `herdr pane layout --pane <id>`, halve the width,
    and if the halves fall under the floor, split `--direction down`.
  - **The daemon-placed ORCH board is outside this manual split rule — width does not place it at all.**
    The halving bound protects worker-pane trailers; the board carries none. The daemon, not the overseer,
    splits the supervising seat DOWN at ratio 0.72 and swaps the new pane ABOVE it (`boardSplitPlan`,
    `src/drivers/herdr.ts`), so the board is full width and the narration is the rail beneath it at every
    terminal width. Look for that pane and do not split, place, resize, or recreate it.
  - **Binary splits cannot produce an even 3-column row at any width.** 220 goes to 110/55/55 whichever
    pane you split. **At a 220-col terminal the width-derived cap is TWO side-by-side panes**; a third
    seat goes below one of them, or into its own tab. "Three panes" is a *height* heuristic
    (tickmarkr's own `workersPerTab: 3` assumes ~50 rows) and it does not authorise a third column.
  - **A finished seat keeps its width.** Panes are a fixed budget — every seat you do not close is taken
    out of the readability of the ones still working. There is no rebalance command, so the fix is
    closing, not resizing.
  **The general lesson, which is why this correction is worth its lines: a prose rule that restates a
  measurement without carrying the number reproduces the defect at full price.** The floor lives in
  `src/`; every seat that hand-splits panes is outside it and re-learns this by hand.

### On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`) — specialist terminals

Create specialist seats using `orca terminal create --worktree path:<repo> --command "<agent-cmd>" --json` and record each returned handle. For a deliberate split use `orca terminal split --terminal <owned-handle> --direction horizontal --command "<agent-cmd>" --json`, retaining the child receipt. Deliver briefs with `terminal send --enter --wait-submit 15`, verify observed submission (`result.send.prompt.stages.includes("turn_started")`), and collect files beside `orca terminal read --terminal <handle> --screen --json`. Completion watchers use the universal mission-end teardown: artifact plus terminal marker, current-mission stand-down read back, and spawn ledger matched to the live tab title and checkout before closing the recorded handle with `orca terminal close --terminal <handle> --json`; require the handle receipt or documented live refusal, handle absence and final owned-tab absence. Timeout never authorizes closure (queue row 240; D-2138 add.4).

