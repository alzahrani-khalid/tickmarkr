### Context is a supervised resource, for BOTH tiers (host-specific)

**THE TIERS CLEAR EACH OTHER AT 50%. Neither tier clears itself on its own notice.** Operator directive,
2026-08-28, and it exists because **a seat cannot reliably observe its own exhaustion** — the seat that
most needs clearing is the one least able to notice, and this project has now measured that three ways:
an overseer ran nine hours at 86% unable to read its own number; a context watcher went **alive and blind**
when the run's own status text pushed the percentage off the statusline; and an orchestrator went
**366k → 970k of 1M between two checks** while its ACT wake sat unread in a detached log.

- **On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`)**, use the same mutual-clear
  policy through brief/handoff files and `orca terminal send --enter --wait-submit`; identify seats by
  terminal handle, verify submission from the receipt, and read the terminal before continuing. Do not
  run the Herdr pane commands or Herdr context watcher below.

#### On herdr (`HERDR_ENV=1`) — mutual clear

**On herdr (`HERDR_ENV=1`) only**, use this protocol in both directions:

1. **Overseer sees orch at ≥50%** → nudge it: write `HANDOFF-ORCH-<ver>.md`, then `/clear`, then re-read
   its brief **and** its handoff. **A same-process `/clear` keeps every background task alive**; it clears
   conversation context, not processes. Re-arm is therefore a controlled replacement: read only this
   seat's pid files, verify each pid in two process-table reads, kill those exact pids, arm replacements,
   and verify every new pid in two reads. Never retire by pattern.
2. **The returning orch, now fresh, checks the OVERSEER.** If the overseer is at ≥50%, it directs the
   overseer to write its handoff and clear, and **points it at `HANDOFF-OVERSEER-<ver>.md` by path**.
3. Whichever seat is fresh performs the check. **Never both at once** — the run keeps one supervising tier
   at all times, and the seat holding the endgame goes second.
4. **The duty to clear the other tier must SURVIVE a clear**, so it belongs in BOTH handoff files as a
   standing re-arm item — not only in the message that ordered it. Earned 2026-08-28: the orchestrator
   performed the check on the overseer BEFORE its own clear, precisely because clearing first would have
   wiped the instruction to do it, and its handoff did not record the duty.
5. **A seat cannot `/clear` ITSELF — so the OTHER TIER SENDS IT.** `/clear` is a CLI command typed into a
   session and no tool invokes it in your own pane, but it is just text in someone else's: the partner
   tier types it into your pane. **This is the whole reason the protocol is mutual**, and it means the
   loop closes without the operator. The exchange, both directions, in this exact order:

   ```bash
   # 1. the seat crossing 50% writes its handoff FIRST, ending with its terminal marker
   # 2. it asks the partner, naming its own pane and handoff path:
   herdr pane run <partner> "I am at <N>%. Clear me: send /clear to <my-pane>, then point me at <my-handoff>."
   # 3. the PARTNER sends the clear, then VERIFIES before pointing:
   herdr pane run <my-pane> "/clear"
   #    read the pane back — a cleared claude session shows an empty prompt and a LOWER context percentage
   # 4. and only THEN, as a SEPARATE send, the re-orientation:
   herdr pane run <my-pane> "You were cleared at <N>%. Read <handoff> and <brief>. Same-process clear kept
   every background task alive: retire only your recorded watcher pids, verify twice, kill-by-pid, arm,
   verify every new pid twice, preserve the partner-owned watchers the stand-down lists, then confirm."
   ```

   **Log every open per CITE-IS-NOT-READ:** the moment the returning seat opens `<handoff>` or
   `<brief>`, append `opened <path>` to the append-only log `.tickmarkr/overseer/opened-files.log`
   (create it if absent; never truncate or rewrite an existing line). On both hosts this log — not the
   transcript — is the record a later handoff is measured against (OBS-1102).

   ⚠ **Steps 3 and 4 are two sends, never one.** A pointer batched with the clear lands *during* it and is
   lost with the context it was meant to survive. Verify the clear landed by reading the prompt line
   and re-reading the banner percentage below its pre-clear value before sending the pointer — the same
   read-back every other send in this skill requires. A working seat or a typed prompt defers the act;
   neither authorises a queued `/clear`.
   ⚠ **The partner must not clear itself in the same window.** One supervising tier stays live at all
   times; the seat holding the endgame goes second.
   ⚠ **Step 4 must state an EXPECTED-RETURN DEADLINE**, e.g. *"confirm you are back within 10 minutes."*
   A clear order without one is an unbounded wait: see rule 6.

6. **THE RETURN LEG — the returning seat's FIRST act after re-arming is a verified notice to its partner.**
   Not its second, not once the next milestone lands. **Measured 2026-08-28 (OBS-743):** an overseer cleared
   at 00:05Z, was back at 00:07Z, *read the orchestrator's pane at 00:10Z to take its percentage* — and said
   nothing. The orchestrator's last line had been *"T7 is mine until you're back."* It then held the task
   alone for **53 minutes** across a reviewer flake, a retry, a merge and the whole tip verify, with no
   signal that its supervising tier existed. The notice went out only because the operator noticed the gap.

   **A one-way read is not a handshake.** The adopt step tells you to READ the partner's pane, which feels
   like contact and transmits nothing — that is exactly how this gets skipped by a seat following the
   protocol correctly.

   The notice is ONE line (a newline submits early), sent with `herdr pane run` and **read back**, and it
   carries four things:
   ```bash
   herdr pane run <partner> "RETURN NOTICE <seat>: back on <my-pane> since <HH:MM>Z. WATCHERS I NOW HOLD:
   <list>. SWEPT: <what was dead>. MISSION STATE AS I READ IT: <one clause>. Reply with every watcher YOU
   still hold so we deconflict — do not arm anything I just named."
   ```
   - **where and since when**, so the partner can stop holding your duties;
   - **the watcher inventory you now hold** — coverage is the thing both tiers silently assume about each
     other, and a returning seat that re-arms without saying so produces double-coverage that reads as
     redundancy and is actually two tiers each trusting the other;
   - **anything you swept**, because a dead watcher the partner armed is *its* belief about coverage, not
     yours, and it will keep believing it;
   - **an explicit deconfliction request.** Ask for the partner's inventory back; do not infer it.

   ⚠ **RE-ADOPT EVERY DETACHED WATCHER ON RETURN, and prove it from disk.** A detached watcher (`ppid 1`)
   is the one kind that SURVIVES your clear, which is exactly why it rots unattended: `stat` its heartbeat
   and treat **stale as dead**. Measured the same morning (OBS-742): a detached resolution watcher's
   heartbeat was **157 minutes stale** and the task it existed to report had resolved **2h04m after its
   last beat** — present, silent, and indistinguishable from healthy to anyone who did not look. Sweep it,
   archive the heartbeat rather than deleting it so the gap stays measurable, and name it in the notice.

   ⚠ **A CLEAR AND A DEATH ARE THE SAME SILENCE.** A seat that clears and never returns — wrong pane,
   crashed host, operator closed the tab — is indistinguishable from one mid-`/clear`. That is why step 4
   states a deadline: **partner silent past it → escalate to the operator.** Without the deadline the
   protocol's most dangerous state has no timeout, and the surviving tier waits forever on a peer that no
   longer exists.

⚠ **`∑ NNNk tok` ON A CLAUDE STATUSLINE IS CUMULATIVE SESSION SPEND, NOT CONTEXT FILL.** The percentage
is the fill; the token total is what has been spent across every turn and keeps climbing after a compaction
or a clear. **Measured 2026-08-28, expensively:** this seat built a fallback watcher on `∑ Nk tok`, read
`970k` as 97% of a 1M window, and sent an urgent clear-order to an orchestrator that was actually at
**33%** — which then began a handoff and offered to discard a session two-thirds fresh, mid-endgame.
**Read the `%`. Never derive fill from the token total, and never build an instrument on a signal whose
SEMANTICS you have not verified against a second source.**

**Why 50% and not 85%:** a handoff written at 50% is written by a seat whose judgment is intact. One
written at 85% is written by a seat already degraded, about the decisions it is least able to summarise.
The threshold buys judgment, not headroom.

**Why the OTHER tier issues it:** a self-issued clear competes with whatever the seat is doing and loses.
An instruction from the other tier arrives as work, and the tier issuing it is not the tier that has to
overcome its own momentum to obey.

⚠ **A detached watcher gives COVERAGE and takes away NOTIFICATION.** A wake written to a log file that no
seat reads is not a wake. If the watcher must outlive a turn, it also needs a path that reaches a seat —
a beat the other tier reads, a notification, or an artifact the other tier watches. **Measured 2026-08-28:
`ACT: orch-215 at 970k/1000k — handoff + /clear NOW` fired correctly and sat unread in a scratchpad log
while the orchestrator kept working.**

**On herdr (`HERDR_ENV=1`) only**, arm a context watcher on the orchestrator at spawn time and treat a threshold wake as a first-class event:
finish the step, write a handoff, `/clear` **plus a fresh brief — never `/compact`**, because a compaction
is a lossy summary nobody trusts while a clean session re-oriented from disk-verifiable state is reliable.
**Do the same for yourself before you are forced to**: write the handoff while your judgment is still
good, not after. If your own context cannot be read by the watcher, say so to the operator and ask for the
number — an unmeasured budget is not a small budget.

```bash
# WARN 50 / ACT 50 — the mutual-clear threshold above, not a headroom alarm.
<skill-dir>/scripts/watch-context.sh orchestrator <orchestrator-agent-or-pane> 50 50 <handoff-file>
<skill-dir>/scripts/watch-context.sh overseer <overseer-agent-or-pane> 50 50 <handoff-file>
```

#### On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`) — mutual clear

Write the handoff and announce it with `orca terminal send --terminal <handle> --text "Read <handoff> and <brief>" --enter --wait-submit 15 --json`. Require observed submission (`result.send.prompt.stages.includes("turn_started")`) and inspect `orca terminal read --terminal <handle> --screen --json` before and after clearing. Arm file/journal and context evidence watchers for both seats.

#### Opt-in Claude context sidecar — a Claude seat's `%` from disk (OBS-1122)

A Claude seat's fill can also be read from a file instead of off its screen. It is opt-in, per seat,
Claude only, and fully reversible. Claude has ONE `statusLine` slot and it belongs to the operator, so
`scripts/context-statusline.sh` never takes it over: it **chains the operator's existing status
command** — runs it with the same stdin and returns its stdout and exit status unchanged — and only as a
side effect writes the payload's `context_window.used_percentage` (nothing else) to
`.tickmarkr/overseer/context/<seat>.json` under the launch-supplied root, atomically (temp file +
rename).

1. **Record the operator's current `statusLine.command` verbatim in the brief** — it is the reversal.
2. **The operator wraps it; this skill never edits their home configuration.** The wrapped command is
   `<repo>/<skill-dir>/scripts/context-statusline.sh '<existing statusLine command>'`,
   set in the same settings file, or in that one seat's launch `--settings` JSON so it ends with the seat.
   With no existing command, omit the argument; the collector then prints nothing.
3. **The launch recipe names the seat and its root:** start the Claude seat with
   `TKR_CONTEXT_SEAT=<seat>` and `TKR_CONTEXT_ROOT=<absolute repo path>` in its environment. Only a safe
   basename (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`) and an absolute root are accepted; anything else writes
   nothing — never a sanitized name that could land in another seat's file — and a seat launched without
   either collects nothing while its statusline still chains. The root never comes from the payload or
   the seat's cwd: both can differ from the last valid payload's directory, which would let a malformed
   payload's invalidation land in another tree while the stale number stayed readable.
4. **Read:** `context-statusline.sh --read <seat> [<root>]` prints the percentage, or `unknown` when the
   file is absent, malformed, attributed to another seat, older than 120 seconds, or the payload carried
   no percentage. A malformed payload overwrites the seat's last number with no percentage, so a stale
   good reading never outlives it. **`unknown` is never 0 %** — it sends you back to the screen read,
   never to headroom.
5. **Reverse:** restore the recorded command in the settings it came from, then remove
   `.tickmarkr/overseer/context/`.

**Codex seats stay screen-read.** The collector reads Claude's statusLine payload only, so it measures
nothing about a Codex seat — its `--read` stays `unknown` — and a Codex seat's fill is read off its screen
exactly as above.

### A GO has a deadline — arm the launch observer in the same act as the GO

#### On herdr (`HERDR_ENV=1`) — launch watcher

**On herdr (`HERDR_ENV=1`) only:** this launch watcher sends to an overseer pane and the following
`agent start`/notification instructions are Herdr commands.

A GO that produces no run is a silent failure until someone notices; on 2026-09-11 an orchestrator's codex
sandbox was rooted at the main repo, the spec worktree was outside its writable roots, it stopped at the
denial without reporting, the overseer's 10-minute wake expired un-re-armed, and three hours passed.
Two rules close that hole:

- **Every orchestrator seat is sandbox-rooted at the worktree it will run in** (`cd <worktree>` before
  `herdr agent start … --sandbox workspace-write`), and its brief says: *a denied path or refused command
  is reported to the overseer pane within 60 s — never a silent stop.*
- **The overseer arms the launch watcher in the SAME act as the GO**, with the lock path the run will
  create, and treats `LAUNCH_OVERDUE` as a first-class event (read the orchestrator pane, fix the seat,
  re-issue the GO):

```bash
<skill-dir>/scripts/watch-launch.sh <worktree>/.tickmarkr/graph.lock 900 <overseer-pane> &
```

It prints `LAUNCH_OK` with the lock's contents when the run starts (exit 0) and, past the deadline, delivers
`LAUNCH OVERDUE …` to the overseer pane AND as an OS notification (exit 3). Any wake you arm yourself with
a cap (a background `until` loop) must be RE-ARMED on every expiry; an expired wake is not a watch.


The first argument chooses the closed per-seat tier (`orchestrator-context` or `overseer-context`),
and every beat names the second argument as that tier's seat. The watcher beats only after reading a
rendered percentage, keeps beating on the supervision cadence even when its requested poll is slower,
continues past WARN to ACT, and records a stand-down on each controlled exit. A killed watcher alone
leaves its last beat to age into `STALE`. Auto-clear waits for `idle` plus an empty or dim-only ANSI
prompt line, prints `CONTEXT_ACT_DEFERRED` while that gate is closed, and emits `CONTEXT_CLEARED` only
after a banner read-back proves the percentage dropped; only then does it send the re-brief.
**Every handoff's re-arm list ends with the announce step from Setup 0** — inform the surviving
orchestrator the fresh seat is live — or the next seat re-arms silently beside a tier that still
believes it is alone.

#### On Orca (`TERM_PROGRAM=Orca` and non-empty `ORCA_TERMINAL_HANDLE`) — launch deadline

Arm a file watcher for the run lock and run-start journal row in the same act as GO. On expiry inspect `orca terminal read --terminal <handle> --screen --json` and write the missing-launch evidence to a file and announce its path with `orca terminal send --terminal <supervisor-handle> --text "Launch overdue: read <evidence-file>" --enter --wait-submit 15 --json`. Renew the watcher after each wake.

