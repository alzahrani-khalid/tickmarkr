## Supervision watcher

### On herdr (`HERDR_ENV=1`) — supervision instruments

#### ⛔ EDITING A WATCHER WHILE WATCHERS ARE ARMED: REPLACE BY RENAME, NEVER IN PLACE

**`bash` reads a running script BY BYTE OFFSET.** Edit the file a live watcher is executing and every
offset after your edit shifts — a comment-only insertion is enough — and the process runs garbage from
wherever it happens to be. **The failure signature is SILENCE: a corrupted watcher and a correctly-quiet
one emit byte-identical evidence.**

> **Write a temp file, then `mv` it over the target.** `mv` swaps the directory entry and yields a NEW
> inode; the running `bash` keeps its old inode open and finishes unharmed on the old bytes. **An in-place
> `sed -i`, or a `>` truncate-and-rewrite, corrupts a running script mid-flight.** Re-arm afterwards to
> pick up the new bytes — the running process will not.


**Arm your OWN tier first, in the same call chain that arms everything else.** `status` derives each
tier's state from a beat file the tier itself writes, so a seat that never beats reads `ABSENT` — and
`ABSENT` means *never armed*, which is a lie about a seat that is working the run. Measured on the P99
run: `orchestrator ARMED / overseer ABSENT / watch ABSENT` for the whole milestone, with a live overseer
watching it. Two thirds of that line were constants, not measurements.

The beat is one shipped command and it arms through two explicit verbs, `--new-arm` and `--loop` —
never a bare invocation. `--loop` already implies `--new-arm`: it creates a durable arm and beats in
this process every 10 seconds, exiting nonzero with its reason within one interval after a stand-down.
Never launch it by hand: `beat start` runs it detached and owns it, following the start/stop/status
lifecycle in Host-owned daemon and detached beats; never as a harness task or visible tab:

```bash
# beat start owns the detached --loop child; do not execute the loop as a foreground or harness task.
cd <repo> && tickmarkr beat start overseer --seat <overseer-agent-or-pane>
cd <repo> && tickmarkr beat stop overseer --seat <overseer-agent-or-pane>  # deliberately hand off; reads back DISARMED
```

**The legacy wrapper loop, `while :; do tickmarkr beat overseer --seat <pane>; sleep 10; done`, is the
UNSAFE form and must not be used.** It is a bare one-shot call repeated by a shell loop the product
cannot see, and it is the shape that re-armed a recorded stand-down (OBS-583, OBS-1088): a bare beat
reuses whatever durable arm is already on disk instead of acknowledging the marker a stand-down just
wrote, so a stray shell loop left running by a predecessor seat kept a stood-down tier reading ARMED.
`--new-arm` and `--loop` are the only verbs that acknowledge a stand-down; a bare beat, wrapped in
shell or not, never does. The pre-2.1.3 forms `while :; do tickmarkr beat overseer; sleep 10; done`
and `tickmarkr beat overseer --stand-down` are preserved here only as older migration warnings: both
are now rejected outright because neither declares which seat the tier speaks for. Do not copy or
run either legacy form. To leave an arm a legacy writer left, run the **Legacy beat migration** steps in Host-owned
daemon and detached beats: the printed `--stand-down` under the recorded seat, then `beat start`.

One beat per LIVE PROCESS, deliberately: `--loop`'s recorded pid is that process's own, so the tier's
liveness is exactly as verifiable as the process table — stop the loop, or let it die, and the
tier ages to `STALE` (never `ABSENT`) within six beats, which is the state that says *armed, then lost*.
Stand down explicitly when you hand off, or a deliberate exit reads as a death. Same rule as rule 29
below, now with a conventional path the other tier already reads: `tickmarkr status` shows it.

⚠ **`--loop` NAMES A SEAT BUT STILL BINDS ITS LIFETIME TO A PROCESS — and that distinction is
load-bearing.** The command refuses an anonymous beat, and `status` renders the declared seat beside
the tier state; a legacy tier+pid+instant record cannot be attributed and reads `UNREADABLE`, never
`ARMED`. Naming the seat does not prove that the named seat is still alive: its `--loop` process can
outlive the seat's clear, re-brief, or replacement while that process remains alive. The current loop
does not re-arm after stand-down: it observes the recorded marker and exits within one interval.

Measured 2026-08-24 (OBS-583), the now-unsafe legacy wrapper loop left a **2d20h** orphan from a
predecessor seat holding `orchestrator ARMED` through a **three-hour window in which no orchestrator
was alive**; that wrapper could also re-arm a recorded stand-down. On the same sweep the overseer tier
had three beat writers, one owned by an unrelated session. The shipped `--loop` supersedes that wrapper,
but its process ownership still needs a live check. So:

- **Split the liveness reads.** A tier's liveness is read from beat freshness in the repository status
  path. The loop's liveness is read from the live process payload of both arm forms: the loop arm
  (`tickmarkr beat <tier> --seat <seat> --loop` in this repo) and the legacy wrapper
  (`while :; do tickmarkr beat <tier> --seat <seat>; sleep 10; done`). Neither liveness claim is read from a recorded pid:
  a pid recorded earlier can be stale, reused, or detached from the beat now holding the tier green.
- **At every adopt, clear, or re-brief, sweep for pre-existing beat writers on YOUR tier before
  arming one** (`pgrep -f "tickmarkr beat <tier>"`, **read twice and intersected** — this exact probe
  returned its own shell as pid 14680 on 2026-08-31). **The PRIMARY target is the legacy
  `while … tickmarkr beat <tier>` wrapper**, which is why the pattern carries no `--loop` qualifier:
  a `--loop` exits by itself once your new arm replaces its own, but the wrapper's bare tick beats
  whatever arm is on disk, so it survives your re-arm and never exits on its own. Trace each survivor
  to its parent session. Stop an unowned writer only — never its parent — then verify the parent survived.
  **Reconcile this probe with the recorded-pid ownership rule.** That rule retires watchers this seat
  armed by the exact recorded pid, and it never uses `pkill -f`, `pgrep -f`, or an argv pattern. This
  probe is the listing of unowned legacy writers that have no pid file; the pattern stays
  `pgrep -f "tickmarkr beat <tier>"` with no `--loop` qualifier. A stop is kill-by-pid of an unowned
  survivor after the two reads. The probe does not retire a recorded pid.
- **`ARMED (<seat>)` is an attributable claim, not proof that the named seat is still alive.** Before
  trusting it, ask whose session owns the beater; a still-running `--loop` can keep naming a departed
  seat (rule 11's outliving-its-trigger failure, in beat form).
- **Stand down with `--stand-down` and verify the `--loop` exits within one interval.** Do not use the
  legacy bare shell wrapper: unlike `--loop`, it cannot observe the marker and was the form that
  re-armed a stand-down.

Keep only watchers that must WAKE this seat in the harness, re-armed at their cap.
Arm the bundled watcher as its OWN Bash call with `run_in_background` — chaining it after other commands
with `&` orphans it from the wake chain. It prints one wake reason and exits; re-arm after every wake.

```bash
<skill-dir>/scripts/watch-panes.sh WORKER_PANE ORCH_PANE [--fast-blocked]
```

Default mode wakes only when both panes are quiet (dropped handoff) or the orchestrator blocks; the
orchestrator gets a 90s grace window to handle worker blocks first. For long parked stretches a targeted
`herdr agent wait <pane-or-name> --until <s> --timeout <ms>` beats the watcher. When parking a human
checkpoint, also fire `herdr notification show "HUMAN CHECKPOINT: <gate>" --sound request`.

**⚠ THIS WATCHER KEYS ON `agent_status`, AND `agent_status` IS A PROXY THAT FAILS IN BOTH DIRECTIONS.**
Measured 2026-08-06 on ONE pane inside TEN MINUTES: a worker wedged behind a CLI's modal trust prompt
reported **`idle`** (not `blocked`), and the same pane minutes later reported **`done`** while demonstrably
mid-work — reading files, context climbing. So a status-keyed watcher can both **sleep through a wedged
worker** and **fire on a working one**, and neither failure announces itself. The bundled watcher inherits
this; so does any `herdr agent wait`. It is still worth arming — it catches vanished panes and real
blocks — but **never treat its silence as evidence a worker is healthy.**
**A THIRD failure of the same proxy, and it hits the SUPERVISING seat, not a worker: a session wedged
on a provider error or a CLI auto-update reports `working` forever.** Measured 2026-08-24: an
orchestrator took an API 529 mid-turn, its frame froze with the error rendered, and `agent_status`
read `working` across ten minutes while nothing advanced — and its own last transcript line claimed a
resume it had never issued, which disk falsified (journal ended at `run-end`, no lock, no daemon).
Nothing in a watcher set aimed at the RUN can see this: a wake delivered to a wedged seat's queue
reaches nobody. Two cheap guards, both of which this seat lacked:
- **Poll the supervised seat's VIEWPORT for a persistent error frame** — the same text present in two
  reads minutes apart is the tell; one read cannot distinguish a frozen frame from a live one.
- **Falsify the seat's own claims against disk at every state change it reports.** A wedged or
  context-exhausted seat narrates intentions as completions. The lock, the journal's last row, and the
  process table settle it in one command.
When it fires: interrupt (Esc, bounded), have the seat correct the false record in writing rather than
silently, then handoff + `/clear` + fresh brief BEFORE it takes the next boundary — a seat that just
mis-reported its own state is not the seat to hand a release decision to.
Two keys that do not lie, in order of strength:
- **The daemon's own waiter.** What `herdr pane wait-output` is matching on tells you the phase from the
  harness's state machine rather than from a status field: a `--match` on a readiness banner means the
  worker has not launched; a `--regex` on the completion trailer means it is running. That is how a stuck
  launch was distinguished from a slow one, and it beats reading the pane.
- **Pane CONTENT.** A rendered prompt pattern is the condition itself; `agent_status` is the harness's
  opinion about the agent. The repo's own `trust-sweeper` scans content and caught a trust modal at
  04:40 that a status-keyed dialog watcher missed at 16:04 — same class, same day, same machine.
**The product fix for the modal case is adapter parity, not a sweeper:** the claude-code adapter passes
`--strict-mcp-config` precisely so MCP-trust modals cannot stall a worker. An adapter lacking that flag
will keep producing this stall, and a sweeper that has been running since 04:40 is evidence the gap was
visible and got swept instead of fixed.

**Every seat you spawn gets FOUR watchers armed in the SAME call that spawns it — ARTIFACT,
BLOCKED-STATE, PENDING-INPUT, and CONTEXT.** Each is blind to what the others catch: the artifact watcher cannot
see a stall, the blocked watcher cannot see a finish, neither can see a seat sitting **idle with
unsubmitted text in its own prompt**, and none of them can see a seat running out of context.
**CONTEXT was mandated in prose above and omitted from this list, so it shipped in 2.1.2 and was never armed
once** — an overseer ran nine hours at 86% unable to read its own number. Arm
`scripts/watch-context.sh` here, by name, like the other three. Note also that BLOCKED-STATE relies on
Herdr's `agent_status`, which is unreliable for vendors whose screen detection is skipped (kimi) — for
those, the spawn-time auto-approve flag is the control, not this watcher.

For `consult`, `surgeon`, and `reviewer` seats, the CONTEXT watcher is wake-only: arm it with
`TKR_AUTO_CLEAR=0 <skill-dir>/scripts/watch-context.sh <consult|surgeon|reviewer>
<agent|pane> 50 50 <handoff-file>`. Only `orchestrator` and `overseer` seats may use auto-clear.

```bash
<skill-dir>/scripts/watch-pending-input.sh <agent|pane> [poll-s] [cap-s] [confirm-polls]
```

**Measured 2026-08-07 (OBS-430), twice in one hour on one orchestrator.** `❯ classify worker-dead-held,
then author the fresh-run spec` and `❯ dry-compile ships too — add it as T13` each sat unsubmitted while
the seat reported **`done`**. Both held live, correct work — the second was a sweep that had been
explicitly ordered — and neither ran. An Enter swallowed by bracketed paste produces this, and so does a
seat that drafts and never sends; **the remedy is the same either way — SUPERSEDE the draft, never
re-send**, because re-sending appends to what is already in the box and submits both.

⚠ **This is the correction to a rule that was itself a correction.** The earlier version of this line said
*two* watchers, on the reasoning that one cannot see a stall and the other cannot see a finish. That
reasoning was sound and its coverage claim was wrong. **A watcher set is only ever proven against the
failure modes you have already met** — three is what three known ones cost, not a proof. The honest form:
a supervising tier must still periodically READ the seat it supervises; watchers reduce how often that has
to be true, they do not remove it.

**Measured 2026-08-07 (OBS-423).** This seat held artifact watchers only. Its orchestrator sat `blocked` on
a host permission prompt, and **the operator noticed first** — *"fix the orch is asking permission and you
are not paying attention."* An artifact watcher keys on a file plus its terminal marker, so **a blocked
seat writes no file and its silence is byte-identical to working, slow, and blocked-forever.** That is this
project's oldest law — *a guard whose failure is silence needs a positive control* — unapplied to the tier
that recites it.

The blocked half is one line and has no bundled script because the host provides it:

```bash
herdr agent wait <name> --until blocked --timeout <ms>    # run_in_background
```

⚠ **Its exit status is not evidence.** That command exits **0 on timeout** and **0 when the pane is gone**,
exactly as it does on a real block — so confirm every wake by READING the pane before acting on it.

**And note what no watcher can cover:** the supervision beat above proves this seat is ARMED and nothing
more — it is a liveness claim, not a wake signal, so the seat still improvises the wakes, and an improvised
set is where a whole failure class hides. A **host** permission
modal is invisible to tickmarkr entirely, so no `src/**` change closes that one — it is covered here or
nowhere.

**The artifact watcher** — bundled, and keyed on the deliverable rather than the seat:

```bash
TKR_ARMING_SEAT=<this-seat> <skill-dir>/scripts/watch-artifacts.sh \
  [--changed-from <content-sha-or-now>] <MARKER> <cap-s> <poll-s> <file>...
```

It wakes when every named file exists AND ends with its terminal marker, and on timeout it reports each
file as READY / PARTIAL / ABSENT so a quiet arm still proves the watcher was alive. Tell each seat, in its
brief, the exact marker its report must end with — you cannot watch for a marker you never demanded.
**A re-arm over an artifact that already has its marker uses `--changed-from now` (or its captured SHA).**
The existing marked bytes are the baseline, not a fresh delivery: the watcher fires only after content
differs from that baseline and then stabilizes, once. Without the changed-from baseline, re-arm is an
instant replay of old completion rather than observation of new work.
**Arm on the marker YOU demanded, verified against the FILE — never on the seat's report of its own
marker.** Measured 2026-08-17: a seat reported its sweep "ends `SWEEP-END`"; the file on disk ended
`ORDER4-END`. A watcher armed on the reported marker never fires while the artifact sits COMPLETE, and
that hang is byte-identical to a seat still working. The script prints each unfinished file's actual
last line on every timeout heartbeat — read it there, and when in doubt `tail -1` the artifact, never
the transcript's claim about it.

**An ABSENT artifact ALONE cannot discriminate a working producer from a dead watcher.** A producer still
working and a watcher that died with its seat write byte-identical evidence — nothing — so a missing file
is one signal carrying at least three meanings (still working, watcher dead, producer dead), and it is
**never** evidence that the watcher is still waiting. Reading it that way infers an instrument's liveness
from the silence it was built to sit through. Settle it with two probes that do not share a failure:
the watcher from the process table, the producer from its pane or seat status. Measured 2026-08-25
(OBS-622): both consultants were live and had written nothing, so the artifact side could not see that
nothing was watching them.

**Arm it in the same call as the spawn, not the next one.** A watcher armed "after I finish this step"
leaves a gap exactly as wide as however long you stay busy, and you will be busy — you just spawned work.
**Measured 2026-08-06 (OBS-369): two consult verdicts, 30KB and 12.8KB, sat COMPLETE with their markers
while the overseer hand-polled and reported them as still running. The operator had to ask.** Project
memory has carried this rule since before that session and the operator had already flagged it twice; it
was re-earned a third time because nothing in this skill made it a spawn-time step. It is one now.

**Never key a watcher on an agent's `done`.** `done` is TURN end, not mission end — a briefed seat flips to
`done` the moment it finishes acknowledging you, and a watcher waiting on "not working" wakes instantly and
reports a deliverable that does not exist. Key it on the artifact instead: the deliverable file existing **and
containing its terminal marker**, or `blocked`, or the pane being gone. Those are the three states that
actually require you. The same applies to a run: the journal's `run-end` event is the signal, never an
orchestrator turn boundary.

### On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`) — supervision instruments

At seat spawn, arm file/journal watchers for artifact completion, run events, missing progress and context evidence. Record each watcher owner and bounded expiry; renew on every wake and stop on stand-down. Read `orca terminal read --terminal <handle> --screen --json` on each wake to detect blocked or pending input. For a human gate, write a checkpoint evidence file and announce it through verified terminal send; the moment a successor opens that file (or any other cited file) back, log the open per CITE-IS-NOT-READ (`opened <path>` appended to `.tickmarkr/overseer/opened-files.log`). Use Orca notifications only when the installed host advertises a notification capability; the current CLI has no `notification` command, so the file and terminal receipt remain the delivery path. A notification or accepted input alone never proves delivery or completion. A seat-liveness watcher on the ORCHESTRATOR handle is mandatory, not optional: poll `orca terminal read --terminal <handle> --screen --json` on a bounded interval and key liveness on `result.terminal.status === "running"` — never on the envelope's own `ok`. `ok: true` proves only that the READ command executed; a closed seat's read still returns that same `ok: true` with `result.terminal.status: "exited"`, and a matcher keyed on `ok` reads that exited seat as alive and never fires (OBS-1087). Treat `result.terminal.status !== "running"`, `terminal_handle_stale`, or a missing terminal as seat death, and re-resolve by title before re-arming (OBS-1050 — the orchestrator seat exited silently and the daemon ran unsupervised to a PARTIAL run-end).

The artifact watcher is available on Orca (queue row 240; D-2138 add.4):
`TKR_CLOSE_TERMINALS="<handle>,<handle>" bash skills/tickmarkr-overseer/scripts/watch-artifacts.sh <MARKER> <cap-s> <poll-s> <file>...`.
Supply one recorded address per artifact in argument order; a length mismatch is refused at arm time.
Both all-complete and wake-on-any exits close only each completed artifact's stood-down seat after
matching the spawn ledger to its live tab title, leaf handle and layout checkout. Pending siblings,
missing markers, missing/current-mission-mismatched stand-downs and timeouts close nothing.
The verified close uses `orca terminal close --terminal <handle> --json`, checks the handle receipt
or documented live refusal, then handle absence from the terminal list and owned-tab absence from
visual layouts. A stale handle permits read-only re-resolution by title; it never licenses a close.
Do not arm closure for the latest settled consult round while its mission continues.

