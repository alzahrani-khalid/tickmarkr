The shipped cockpit is **1 Home, 4 Run, 5 Evidence**: `tickmarkr ui [runId]` defaults to
Home on the latest journal, or empty Home with no run. `tickmarkr ui <runId> --view run`
and `--view evidence` select delivered views; `tickmarkr ui --setup <runId>` opens Run
Parks for that run. Fleet/Bootstrap and Plan/Health are follow-ons; keys 2/3/6 are not
installed. Continue using `fleet`, `init`, `plan` and `doctor` as CLI workflows.

Walk the recorded partial-human-park case before declaring green: **1/3 merged**, human
T2, blocked T3, tip passed is **PARTIAL**. T2 is a `humanGate: true` park before dispatch.
In Run select T2, press `a` Actions, choose Approve with Enter, then read the confirmation's
run/task, original park `#L`, actor/reason, exact argv, consequence and enactor. Only `y`
confirms; `n`/Esc cancel; Enter never confirms. Read the receipt's appended `task-approved`
line and actor/reason back from the journal. Approval records permission, never dispatch,
a passed gate or task completion. With no live owner it says **approved; resume required**:
exit the observer and launch `tickmarkr resume <runId>` explicitly with the same detached launch above. A matching live daemon
enacts at its next task boundary; if a different live run owns the repository lock, wait
for that run to end before resuming this one.

For a non-TTY decision, the same command is
`tickmarkr approve <runId> T2 --park <line>@<ts> --by operator --reason 'ready to proceed'`,
naming the park token `tickmarkr status <runId>` prints; check its receipt and explicitly
resume. Every decision binds to one park (a waive also to its failed gate:
`tickmarkr approve <runId> T2 --waive --park <line>@<ts> --gate review`); once a newer park
opens, a stale token, unbound release or mismatched gate refuses — the daemon journals
`approval-refused` and never waives the newer gate. A failed task keeps its recheck with its
own bound failure token: status prints `failed — T3 — failure <line>@<ts>`, then
`tickmarkr approve <runId> T3 --recheck --park <line>@<ts>` re-gates its landed commits. Preserve resume refusals and repair the named source/config issue
(including deny/prefer conflicts); never edit the compiled graph to force a result. Resume
makes CURRENT TIP PENDING; historical GATES RAN does not prove completion. The completed
case has 3/3 recorded merges, a latest run-end, a nonfailed known tip result, empty
`failed`, `human`, `blocked`, `pending` buckets, and CURRENT status reading `outstanding 0`
— owed checks outstanding empty AND known. Replay D-660 before calling it green: the same
3/3 with every bucket empty, after T2's review was waived, reads `outstanding 1 (T2 review)`;
`resume` exits 0 and its final line says `execution complete; outstanding 1 (T2 review)`, not
`verified`. It is green only once `tickmarkr verify --record <runId>` discharges that check and
CURRENT status reads `outstanding 0` — even after run-end, whose record still carries 1.
`outstanding unknown` (a legacy waiver) is never green. A mismatched graph is “not comparable.”

Run offers only validated park verbs: human/attempt-cap/other non-gate parks allow approve;
infra allows approve or `--recheck`; review gate-fail allows `--waive`, `--uphold` or
`--recheck`; other gate-fail allows waive/recheck. Waive satisfies only the identified
failed gate, uphold funds a fixed attempt carrying review findings, and recheck reruns the
declared battery without satisfying a gate. A waive needs EXECUTED evidence: mark every
out-of-band (OOB) read behind it `OOB: static` (diff and source read, nothing run) or
`OOB: executed` (the finding's claim run at the task's head commit, exit code and log on file).
Static CLEAN never backs a waive — a static read that missed an executed material defect looks
like one that found none, and a static read relabelled executed is a false record. When the
finding's reproduction, executed at the task head, fails, the ruling is uphold or recheck; waive
only when it passes and the record names it, keeping the park/gate binding and the owed check
(`outstanding 1 (T2 review)` until `tickmarkr verify --record <runId>`):
`D-NNN WAIVE T2 review — park <line>@<ts> --gate review — OOB: executed — <reproduction> at <task-head-sha>: exit 0, log <path>`. A stall park that recorded a `reapFailure`
(unreadable or surviving worker census) allows approve or `--recheck --park <line>@<ts>`:
recheck re-verifies that attempt's owned census and gates its harvested commits with no
worker only with an explicitly recorded empty survivors array (`[]`) — a missing,
unreadable or surviving census
re-parks the stall under a new token — while plain approve dispatches a worker. An
ordinary stall park (no `reapFailure`) stays approve-only; `--recheck` refuses it. Attempt-cap approval resets the budget while
retaining routing exclusions. Tombstones and failures without identified gate evidence
are diagnostic-only. Decisions cannot be undone; stale or duplicate decisions refuse.

Use `tickmarkr status <runId>` and `tickmarkr status <runId> --oneline` for preserved
snapshots. `tickmarkr status <runId> --watch` opens Run on a TTY and uses line output on
non-TTY; `--watch --plain` keeps the line/ANSI fallback even on a TTY. `--watch --events`
replays and follows projected decision JSON documents on stdout; `--jsonl` and
`--decision-events` are aliases. Keep stderr keepalives separate, never `2>&1`; raw
`journal.jsonl` remains distinct. Webhooks require explicit opt-in. `report` retains text,
learning preview and comparison warnings; `report --md` stays stdout, `--compare
<baseline-runId>` compares records, `--bundle <path>` writes a proof bundle, and `stats`
reports all runs without a run ID. Keep `fleet --print` and `fleet --why` separate.
Absent usage/cost evidence remains “not measurable.”

Manual UI keeps a receipt at run-end and observes a later resume of that same run. The
daemon-owned board by default gracefully stops its own watch presence before closing its owned pane;
unconfirmed cleanup is reported; `visibility.keepPanes: forever` preserves panes. It preserves Herdr grouping, short titles and placement
beside the caller without taking focus. `q`, Ctrl-C and SIGTERM restore raw/pointer/title/
alternate-screen state and release only this observer's presence. `?` opens shortcuts,
Tab/Shift-Tab traverse visible focus, and Esc closes the deepest overlay. Text input keeps
`q1?` literal. Evidence retains original `#L` pointers and full verdict paging with stable
selection while Follow is off; Run's `o` focuses only a verified owned pane, otherwise
showing its evidence diagnostic. Missing historical reviewer-floor metadata stays unknown.

For inert guidance use `tickmarkr ui --help`, `tickmarkr eval --help`,
`tickmarkr unlock --help` and `tickmarkr profile reset --help`. Before `--`, help returns
without UI/probes/writes; after `--`, arguments are literal data. Displayed examples do
not execute. Recovery uses `unlock <runId>` for a matching dead lock or `unlock --garbage`
for malformed bytes, with confirmation (`--yes` for non-TTY) and identity recheck; live,
inaccessible or changed holders refuse. `doctor --cached`, `--probe-preflight`,
`--fix-only` and `--refresh-catalog` distinguish cached reads, budget disclosure, local
repair and catalog refresh; default doctor and `--fix` still probe. `scope <intent-file>
--preview` performs no probes, model calls or writes; authoring requires confirmation or
`--yes`. These actions remain CLI entries until their follow-on views ship.

**macOS host failure: a launchservicesd restart (D-787/D-789).** If GUI apps suddenly read "The
application … is not open anymore" during a local suite, launchservicesd crashed and respawned with an
empty app registry. That was measured on 2026-09-30: `0x1000600b` Mach port exhaustion under node
`process.title` check-ins, crash at 17:15:00Z and respawn at 17:15:09Z. `tickmarkr doctor` and standalone
`tickmarkr verify` record the daemon's pid/start through the separate `src/run/launchservices-check.ts`
module: one bounded `/bin/ps` read with a 5000 ms kill ceiling. doctor's wiring is five lines in
`src/cli/commands/doctor.ts`. The identity lives on the first `doctor.json` record, and one advisory
prints and persists when it changed. Unknown evidence keeps the prior identity, and verdicts and retries
never change. Confirm the identity with `/bin/ps -o pid=,lstart= -p "$(pgrep -x launchservicesd)"`: it
is young beside Dock and Finder. Confirm the log with `/usr/bin/log show --start '<that lstart minus two
minutes>'`, looking for `0x1000600b` then `Successfully spawned launchservicesd`. Type the full path: a bare
`log` is a zsh builtin that prints nothing. Then quit and relaunch the affected apps, or log out /
restart once the run is stood down; a restart ends agent sessions and wipes `/private/tmp`.
