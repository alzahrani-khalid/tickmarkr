## Pane mechanics that bite

- **Verified send protocol**:
  - **On herdr (`HERDR_ENV=1`)**: `herdr agent send` writes WITHOUT Enter, and `pane run`'s Enter can be swallowed
    by bracketed-paste on long payloads. Robust sequence: read the pane (bare prompt required) → send-text →
    sleep 2–3s → read back. Send `send-keys Enter` only when that read-back shows the staged text on the
    composer and no permission prompt or numbered choice holds focus — an Enter sent onto an active prompt
    approves it or picks a choice instead of submitting the brief (OBS-1119). When a prompt or choice holds
    focus instead, resolve it first, then re-read before retrying. After a submitted Enter, read back once
    more and confirm the composer is empty or the agent shows `working` — the pre-Enter read only proved
    Enter was safe to send, not that the brief was submitted. Never report "briefed" without
    both read-backs. Long content goes in a brief file, never pane text. `scripts/seat-send.sh` encodes
    this whole path — size guard, atomic prompt, prompt-line read-back, optional interrupt — and never
    auto-resends. Each adapter declares its prompt glyph beside its input-box matchers; `seat-send.sh` reads
    that declaration rather than assuming Claude's `❯`.
  - **On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`)**: Briefs travel as a file announced by `terminal send` with enter and a submit wait whose receipt is read for observed submission rather than input acceptance:
    `orca terminal send --terminal <handle> --text "Read <brief-file> and follow it exactly." --enter --wait-submit 15 --json`
    Read `result.send.prompt.stages` and treat the brief as delivered only when a `turn_started` stage is present; `accepted: true` proves input acceptance, not a started turn; never resend on `accepted` alone.
- **Evidence collection**:
  - **On herdr (`HERDR_ENV=1`)**: Evidence is read from watcher files, journal events, and `herdr pane read <pane>`.
  - **On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`)**: Evidence is files beside `terminal read`: read verdict files, journals, and pane state with `orca terminal read --terminal <handle> --limit <lines> --json` (or `--screen`).

### On herdr (`HERDR_ENV=1`) — pane mechanics

  **Probe the prompt line before writing (herdr):** if it
  already holds a non-ghost draft, wait only the script's bounded window and return `SEND_DEFERRED`
  without writing a byte. An unsubmitted post-send draft returns `SEND_UNSUBMITTED`. This protects both
  Codex's `›` prompt and a HUMAN typing in a pane; delivery is never allowed to glue onto either draft.
  **PROBE THE READ-BACK WITH THE SHORTEST DISTINCTIVE TOKEN — a commit hash, a pid, an OBS id — NEVER a sentence.** A long phrase crosses the pane's render wrap boundary, so grepping for it returns zero on a
  message that arrived intact, and **a badly-probed successful send is byte-identical to a truncated one.**
  Both natural reactions to that false negative are wrong: re-sending duplicates the message into the
  target's queue, and escalating reports a delivery failure that never happened. Measured 2026-08-06
  (OBS-396): a grep for the full sentence returned 0 while a grep for one word of the same sentence
  returned 1. This trap lives *inside* the verification step above, which is why it survives — the rule
  that is supposed to catch dropped sends is the rule that manufactures the phantom.
  **AND A CONTENT PROBE — TOKEN, TAIL, FULL TEXT — CANNOT VERIFY DELIVERY AT ALL, only presence.**
  Measured 2026-08-18: `herdr pane read` includes the INPUT BOX, so an unsubmitted message renders
  identically to a submitted one and every content-based probe returns the same answer in both
  states. A freeze hold was "verified delivered" by three independent content methods and had never
  been submitted; the receiving seat stopped 19 minutes later without ever reading it — the frozen
  set was protected by nothing but the operator's manual Esc. **The prompt line is the only state
  that discriminates** — text sitting on `❯` is exactly what will not run — and a delivery report
  is prompt-line state alone, or nothing: a decorative check beside a real one reads as
  corroboration (two greens, one of which was never capable of disagreeing).
  **Law 50 applies to every handoff, including `/clear`: a seat-send to a WORKING seat leaves a DRAFT.**
  Send only when the seat is idle and the ANSI prompt line is empty or dim-only (the Esc/SGR discriminator
  separates an autosuggest ghost from typed input), then read back activity or an ACK; presence is not
  delivery. If a stale draft must be replaced, supersede it explicitly with
   **On herdr (`HERDR_ENV=1`)**, use `herdr pane run <pane> "<-- disregard … ACTUAL: …"` instead of
   stacking another instruction behind it. On Orca, send the replacement through the verified
   terminal-send branch above.
- **A MESSAGE TO A WORKING SEAT IS A QUEUED MESSAGE, AND THE QUEUE DRAINS ONLY AT TURN BOUNDARIES.**
  Delivery is not arrival: a message sent to a `working` claude seat lands in its queue (`Press up to
  edit queued messages` on the seat's prompt line is the tell) and is READ only when the current turn
  ends — and with in-process teammates a turn runs 20–40 minutes, so steering latency equals subagent
  runtime. Measured 2026-08-17/18 (P98 leg 1): a FREEZE HOLD and a checker-release directive stacked
  behind a planner's teammate fan-out — the freeze forbade edits its own queue could still trigger —
  and the OPERATOR ended the turn by hand. Three consequences:
  - **A queued hold is not a hold.** A freeze-class or superseding directive to a `working` seat is
    delivered by INTERRUPT, and the interrupt is the SUPERVISING tier's move, never left to the
    operator: `send-keys esc` → re-read status → esc once more if still working (two, bounded) →
    verify idle → prompt → verify. The interrupt loses the seat's in-flight step; for a
    correctness-class directive that is the price, and it is cheaper than a voided verdict.
  - **Never stack a correction behind a stale directive.** A queued message executes in a context that
    no longer matches the one it was written in. When conditions change, do not append another
    message — interrupt, then send ONE directive that NAMES the queue and overrides it (*"your queue
    holds X and Y; act on neither; current state is Z"*), and require the seat to report what its
    queue held before acting. The receiving seat re-validates every queued item against CURRENT state.
  - Five distinct send failures in one leg — front-truncation, sitting unsubmitted, two silent losses,
    a probe that mistook its own echo for a reply — is what a prose send protocol costs under load:
    run `scripts/seat-send.sh` instead.
- **On herdr (`HERDR_ENV=1`), a `pane run` into a pane whose FOREGROUND is busy is a DELAYED command, not a lost one.** The
  shell buffers the line and executes it the instant the foreground process exits — which, when that
  process is a run daemon, means *at run-end*, unattended, possibly hours later. Measured 2026-08-24: a
  resume typed into the run pane while the daemon still held it fired by itself at the next run-end;
  the seat that sent it read the later activity as an unattributed injection and nearly declared the
  pane compromised. Two consequences: **check the target pane's foreground before sending** (a live
  daemon owns it — send from your own shell instead), and **before attributing any unexplained
  activity to an intruder, ask what YOU left buffered there.** The benign explanation is the common
  one, and the alarming one costs a false security incident.
- **A compound command that `cd`s POISONS every later relative path in the same call.** The Bash tool's
  working directory persists, so `cd /tmp && …` followed by `cat .planning/x` silently reads the wrong
  tree. Measured twice on 2026-08-24: once reading a worktree's config and nearly authoring a duplicate
  fix for interims that were present all along, once failing a release export script that existed.
  **State reads during supervision use ABSOLUTE paths**, and a read that contradicts what you believe
  is a cue to check your cwd before you rewrite your model of the world.
- **Guard-before-Enter** (race-safe prompt answering): chain with `&&` — pane get shows `blocked` && pane
  read shows the expected option under the cursor && only then send-keys. If no longer `blocked`, someone
  already answered; do nothing.
- **AGENT NAMES ARE GLOBAL ACROSS WORKSPACES — verify a seat you spawned by PANE ID, never by name.**
  Names must be unique among live agents *everywhere*, not within your workspace, so another workspace can
  already hold `opus`, `sol`, `reviewer` or `orch`. When it does, your `agent start` **fails**, your pane
  is left a bare shell, and `agent list` / `agent read` for that name then resolve to the
  **stranger's seat**. Measured 2026-08-06 (OBS-392): a spawn of `fable` collided with a live seat in
  another workspace; `agent list` reported `fable -> blocked` and it was read as *this* seat coming up
  blocked. It was an operator research session sitting on a *"Resume full session?"* prompt. One more
  command would have submitted a brief into it. **Namespace every name you pick** (`fable-v187`, not
  `fable`), **treat a failed `agent start` as fatal at the call site** rather than inferring it later from
  a status read — the status read is exactly what the collision corrupts — and print the `workspace_id`
  and `cwd` columns before dispatching to any name. Same class as the liveness rule: a matcher broader
  than the thing it names finds things that are not it, and its output is shaped exactly like a right
  answer.
- **A dead pane accepts your dispatch and reports success.** `herdr agent wait` exits 1 on timeout, 0
  on match — but ALSO 0 (with an error JSON) when the pane is GONE. So does `pane run`: sending to a vanished
  pane prints `{"error":{"code":"pane_not_found"}}` and **still exits 0**, so `pane run … >/dev/null && echo
  sent` reports a delivery that never happened. Never chain `wait && act` or trust a send's exit status —
  confirm the pane exists and read it back. An orchestrator's pane can vanish mid-mission without any event
  reaching you; the first symptom is a dispatch into nothing.
- **Renaming a live agent kills every watcher keyed on the old NAME.** herdr resolves names live,
  so after `herdr agent rename` the old name stops existing and any `agent wait <old-name>` or
  name-keyed poll script exits with `agent_not_running` — an exit shaped exactly like a real wake.
  Re-arm name-keyed watchers in the same act as the rename; file-keyed artifact watchers are
  unaffected (one more reason to prefer them).
- **On herdr (`HERDR_ENV=1`)**, stale typed input is unclearable via CLI — supersede it:
  `herdr pane run <pane> "<-- disregard everything before this arrow (stale draft). ACTUAL: <message>"`.
  **But DISCRIMINATE before you supersede or file it: text on an idle seat's prompt line has FOUR
  authors** — the seat's own draft, an operator, another agent's `agent send` (writes WITHOUT Enter),
  and claude-code's AUTOSUGGEST, which renders context-plausible ghost text BYTE-IDENTICAL to a typed
  draft in text-format reads (OBS-482). The check is mechanical and only works at observation time:
  `agent read --format ansi --source visible` — dim/grey SGR (`ESC[2m`) around the text = autosuggest ghost, NOT input. ⚠ **`--source` is load-bearing and its natural choice is the wrong one.** `--source detection` is the plain-text buffer used for agent detection: it strips ANSI *entirely*, so `--format ansi --source detection` returns ZERO escape sequences and every string reads as un-styled — i.e. as real typed input. Measured 2026-08-26 on a live orchestrator: `detection` returned 0 escapes and the ghost read as a genuine unsubmitted draft; `visible` returned 100 escapes and the same line came back `ESC[0mESC[2m…`, dim, ghost. **A probe that cannot render the evidence cannot fail**, so check the capture contains escapes at all before believing its answer — that is rule 11 aimed at your own instrument. Measured
  2026-08-17 (D-206): an unattributed instruction was found in an orchestrator's box, superseded
  defensively, and its origin stayed UNRESOLVED — the one probe that discriminates was not taken while
  the text still sat there. An origin question you can close in ten seconds at the pane becomes
  permanently open the moment anyone clears the box.

### On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`) — terminal mechanics

Use recorded handles and read `orca terminal read --terminal <handle> --screen --json` before sending. Send a brief file announcement with `orca terminal send --terminal <handle> --text "Read <brief>" --enter --wait-submit 15 --json`. Read `result.send.prompt.stages` and treat the brief as delivered only when a `turn_started` stage is present; `accepted: true` proves input acceptance, not a started turn; never resend on `accepted` alone. Then read back. Watch file/journal progress independently of input acceptance.

