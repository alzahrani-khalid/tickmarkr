# Board port rules (queue rows 331 and 332)

These rules are binding for `src/board/` and `hooks/board/`. The goldens in `goldens.json` enforce most of them. Where
a rule names a deliberate difference from `reference/summarize.py`, the rule wins.

## S. Summarizer (`src/board/summarize.ts`, a port of `reference/summarize.py` lines 15–422)

- S1 Times: epoch seconds as floats from `Date.parse(ts) / 1000`. A timestamp that is not an offset-bearing ISO string
  with at most millisecond precision throws. The offset is `Z`, `±HH`, `±HHMM` or `±HH:MM`, each read as Python 3.14's
  `fromisoformat` (which generated the goldens) reads it; a seconds-bearing offset is a deliberate difference and throws
  (D-2178 add.210). `summarize.ts` owns the parser and `read.ts` imports it, so both read one set of forms. `hm` and `stamp` format in the process's local time zone (`getHours`,
  never `getUTCHours`, never a fixed offset).
- S2 Numbers:
  - Python `round()` is round-half-to-even (`roundHalfEven`).
  - `int()` truncates numbers toward zero, parses a decimal integer string with Python's sign and whitespace rules, and
    throws on anything else.
  - Floor division floors.
  - `dur` clamps to zero before truncating; `elapsedMin` is never clamped.
  - A zero result is positive zero.
  - Integers in the input, values produced by `int()` or `roundHalfEven()`, and accumulated integer results must stay
    within ±(2^53−1); otherwise throw before returning or using the unsafe value.
- S3 Truth and defaults:
  - Python truthiness: empty lists, dicts and strings, and zero, are false.
  - `a or b` returns an operand as Python does; it is never `??`.
  - `d.get(k, default)` takes the default only when the key is absent, so an explicit null, zero or empty string is
    kept.
- S4 Strings:
  - f-strings and `str()` render null and a missing `get()` as `None`, and booleans as `True` or `False`.
  - Slices count Unicode code points.
  - `first_red_line` uses Python's `splitlines`, `strip` and `split(None, 1)` whitespace semantics.
  - `partition` splits at the first separator and keeps the rest.
  - `str.replace` replaces every occurrence.
  - Every literal (`{since}`, `✓ ✖ ◉ ‖ → ← ·`) is copied byte for byte.
  - A JSON number inside text renders as JavaScript `String(n)`. tickmarkr's journal writer (`JSON.stringify`) never
    writes `1.0`, so this matches the reference on every journal tickmarkr writes. List or dict values in text
    fields are out of scope.
- S5 Collections:
  - Python dicts are insertion-ordered maps with no prototype membership; a task may be named `constructor`.
  - `spans` and `open` share span objects, so `stop()` updates history.
  - `dict(v)` is a shallow copy; `sorted`, `list` and `reversed` never mutate their input.
  - Attempt keys keep first-seen order.
  - Tuple keys compare element by element, with false before true, and strings compare by code point (never
    `localeCompare`).
  - `max()` with a key keeps the first maximal element, and key sorts are stable.
  - `isinstance(x, dict)` excludes arrays and null.
  - Negative indexes are translated explicitly.
- S6 Purity: the module imports no node built-in and never reads the clock. `summarize` returns the reference object
  without `readAt`; events carry `_line`, the 1-based journal line counted on LF only.
- S7 Resumed runs (D-2184): a `run-resume` after a `run-end` reopens the run. It clears `ended`, the track's end time,
  and any approval window opened before that resume. Until a later `run-end`, `ended` and `endEpoch` are null and
  `atEpoch` is `now`; a later end supplies its own record and time. Spans closed by the earlier end stay closed.
  This deliberately differs from `reference/summarize.py`, which retains the earlier end after resume.
- S8 Oracles judge (queue row 394, D-2187 add.16): an acceptance `gate-result` with no `invocations` field (a
  deterministic-oracle round writes none) sets the task's `judge` to `oracles`; one whose invocations name a channel
  sets that channel as at the base, an empty list changes nothing, and the later result wins. This deliberately
  differs from `reference/summarize.py`, which leaves the judge blank. Every golden cut with such a result asserts
  S8's judge and exact golden equality for every other field, a reopened cut (S7) included: there only S7's
  differences are allowed (no end record or time, `atEpoch` at now, the live clock and ETA, tokens on done tasks
  alone), and the same cut with each such result's field present but empty reads the same summary but the judge;
  every other cut keeps exact golden equality.

## R. Reader (`src/board/read.ts`, a port of `reference/summarize.py` lines 425–560)

- R1 Wire contract version 1 is exactly one of the following.
  - A full snapshot: `{ version: 1, ...summarize(...), runId, readAt, release, spec }`. `readAt` is the local `HH:MM:SS`
    of `now` (epoch seconds). `release` is always present: a card or null. `spec` is always present (queue row 335,
    D-2178 add.203): the base name of the run's `graph.json` `spec.paths[0]` without a final `.spec.md`, or null when
    the graph names no spec path.
  - An empty answer: exactly `{ version: 1, empty: "no tickmarkr run under <roots>" }`.
- R2 Repository roots come first, from git's own files and never by running git, in this order:
  1. The enclosing checkout's `.tickmarkr`.
  2. The main checkout's, when it is distinct.
  3. Every other linked worktree's.

  The walk:
  - Stop at the nearest `.git` entry, a submodule's included.
  - A `.git` file holds `gitdir: <path>`, resolved against the checkout.
  - `<gitdir>/commondir` resolves against the git directory. When it is absent, the git directory is the common one.
  - A common directory named `.git` belongs to the main checkout (its parent). A bare common directory has no main
    checkout.
  - Each `<common>/worktrees/<name>/gitdir` names a checkout's `.git` entry, resolved against that administrative
    folder. Its parent is the checkout. A missing or stale target is skipped.
  - Strip trailing CR and LF only.
  - Outside a repository, the first root is `<cwd>/.tickmarkr`. A cwd inside a bare repository, with no `.git` entry
    above it, counts as outside a repository.
- R3 Given roots expand independently, in argument order:
  - `~` and `~/` expand to the home folder.
  - `*`, `?` and `[...]` match within one segment and never consume a leading dot; `**` is a single-segment `*`.
  - Each pattern's matches sort by code point, and a literal path must exist.
  - Missing paths are skipped, and each real path is read once.
- R4 Deliberate difference: every enumeration that Python leaves in native directory order (run folders, history
  journals, suite jobs) sorts by name. The newest journal by mtime wins, and the later name wins a tie. Journal lines
  split on LF only.
- R5 The lock is the `graph.lock` of the root holding the run. It is compared with the run folder's name, not the
  journal's runId.
  - A match converts the pid with Python `int` semantics and probes `process.kill(pid, 0)`, zero and negative pids
    included. Success is true; any throw is false.
  - A mismatching readable lock gives pid null and alive null.
  - A missing, unreadable or invalid matching lock gives pid null and alive false.
- R6 History:
  - Exclude the current run, then take the newest six sibling journals.
  - p50 is the upper middle.
  - A semantic round ends on its second acceptance or review result.
  - Only passed tests over 60000 ms count.
  - Malformed lines are skipped.
  - R6a Deliberate difference (queue row 334, D-2178 add.202): the sibling journals are pooled from the runs folder of
    the root holding the run and, when that root is one of R2's repository roots, from every repository root's runs
    folder. The whole pool sorts by mtime and then by run-folder name, so R4's later-name tie rule holds whichever
    checkout holds a journal and whichever checkout the board is read from. The reference reads only the run's own
    folder, so a run in a fresh worktree had no history.
  - R6b Deliberate difference (queue row 334): when the pooled history has no worker sample, `eta` is null. The
    reference scheduled every phase at 0 s and floored each task at 60 s, which printed "ETA 1m – 1m".
- R7 Suite progress:
  - Strip exactly the final `.job.json`.
  - Count only running jobs, and skip unreadable or malformed pairs.
  - Count every completed entry, and sort only the failing dict entries.
  - For a task, the last job by name wins.
- R8 Release card: port `CI_HEAD`, `POLL` and the version rule exactly. The last header section wins, even when it is
  malformed. Poll lines are trimmed. Release and recut headers both count.
- R8a Deliberate difference (D-2178 add.198): the card follows the release being worked on.
  - Among the expanded release folders that hold at least one regular file, choose the one whose newest file has
    the latest mtime; the later name wins a tie. The reference instead takes the newest `ci-watch.log`, so it showed
    the previous release while the next one was still in its proof.
  - When the chosen folder has a `ci-watch.log`, the card is the R8 port over that folder.
  - When it has none, the card is the R8 port over the folder with: `ciRun` and `mirror` null, `status` `pending`,
    `conclusion` and `polledAt` empty, and the CI stage `pending` with an empty detail. The tag, npm and main
    stages and the version follow R8 unchanged.
  - `goldens.json` `releaseSelection` holds OBSERVER-authored cases for this rule. Each case is labeled with its
    author, because the reference cannot produce them.
- R9 Validate before summarizing, with no git and no process:
  - Task ids and run ids obey the existing rules in `src/graph/schema.ts` and `src/run/journal.ts`.
  - Dependencies name existing tasks and are acyclic.
  - Park lines are positive integers.

  Invalid input throws a nonempty error instead of producing an approval command or an endless walk. `{run}` in each
  needsYou cmd becomes the runId, which falls back to the run folder name.
- R10 Nothing under `src/board` imports a process-spawning built-in. Comments cite queue rows 331 and 332, never
  private paths.
- R11 Deliberate difference (queue row 394, D-2187 add.16, add.29 and add.52): only the session's own project is
  searched. The narrowed rule of D-2187 add.52 REPLACES every earlier matching rule.
  - Physical first, everywhere: every path is reduced with `realpathSync.native` (libc realpath, as the kernel and
    Python resolve it) on the path AS GIVEN, before any `resolve()`, `join()` or lexical walk, so a `..` after a
    symlink resolves from the symlink's target (`A/alias/..`, alias -> B/src, is B). This covers the session cwd, every
    state root, every release folder, R2's automatic checkout roots and an absolute local origin; a path that does not
    exist is its longest existing prefix's real path with the rest appended. A session path holding a `..` segment is
    its real path; any other keeps its spelling. Every git pointer R2's walk follows (a `.git` file's `gitdir:`, a
    `commondir`, an administrative `gitdir`) joins its base unnormalized and is then its tidy spelling only when that
    names the same real path, else its real path, so `gitdir: A/alias/../.git` is B's git directory, never A's. Reads
    under a root or release folder join its given spelling unnormalized (as `os.path.join` does), so the file system
    reaches the same target the identity check did. The displayed spelling and R2's order are kept.
  - A path's identity is read from git's own files, never by running git, with R2's walk: the PHYSICAL common
    directory of the checkout enclosing the path's real path, and the origin read from that common directory's
    `config` by the closed FORMAT table below, which only decides whether a config is READABLE and what its origin
    says; it never matches.
  - Two identities are the SAME project ONLY when (a) their physical common directories are equal; or (b) one side's
    origin is an ABSOLUTE local path whose physical common directory equals the other's, AND both configs are
    readable: one hop, never a chain (two clones of one local repository are not one project).
  - A NETWORK URL origin (a `scheme://` URL other than `file://`, or an scp-like `host:path` whose first `:` has no
    `/` before it) is readable but never makes a match; no URL is normalized or compared. Two independent clones of
    one network remote read as different projects: a dropped root, never a wrong one.
  - UNREADABLE on EITHER side compares by common directory alone, checked before any origin.
  - The closed FORMAT table (D-2187 add.29), a whitelist and never a git-config parser; every input outside it is
    UNREADABLE:
    - The origin section is ONLY a line that is exactly `[remote "origin"]` (surrounding whitespace allowed),
      followed, before the next section header, by ONE line `url = <value>`.
    - The value is EITHER bare (no `"` and no `\`; the first whitespace-prefixed `#` or `;` starts a comment,
      stripped to the line's end, so inner whitespace and a `#` or `;` with no whitespace before it stay in the
      value) OR one fully double-quoted string with no `"` or `\` inside (no comment after it).
    - UNREADABLE: no config; any line ending in `\` (a continuation); an `include` or `includeIf` section; origin's
      section in any other spelling (the single-line `[remote "origin"] url = …` form, another case, the dotted
      `[remote.origin]` form, a trailing comment); any header line that is not wholly `[name]` or `[name "sub"]`
      (`[core] trailing-garbage` included); no url line or two url lines (two origin sections included); a value in
      neither form (partial quotes, escapes, a quoted value with a comment after it, only a comment).
    - A local origin is read only as an ABSOLUTE path that resolves; a relative path, a `file://` URL and an absolute
      path that does not resolve are UNREADABLE.
  - A session inside a repository counts R2's own roots first, in R2's order, each only when it passes the same
    physical project check (walked from `<cwd>` as given when its real path sits in the same checkout, or both sit
    outside every checkout, else from its real path), then each R3 root of the same project in R3 order. Another
    project's root and a root outside every checkout are never searched; when no run is found the empty answer adds
    `; ignored as another project's: <paths>`, the ignored roots (R2's first) then the ignored release folders, and
    reads `no tickmarkr run; ignored …` when every root is ignored.
  - The release card (R8a) chooses only among the same project's release folders.
  - A session outside every repository counts every root and folder, as at the base (R3).
  - The reference searches every named root whatever project holds it, and reads paths through the kernel.
- R12 Deliberate difference (queue row 393, D-2187 add.16): a full snapshot gains `supersededBy: string | null`, the
  chosen release card's version (its folder name when the version is empty) when the run is ended and the card
  folder's newest file is newer than the run's `endEpoch`; otherwise null (a live or reopened run, no card, or a card
  no newer than the run's end). The reference has no such field.
- R13 Deliberate difference (queue row 398, D-2187 add.24): `src/board/run-truth.ts`, a pure module, is applied by
  `readRunBoard` after `summarize`; `summarize.ts` and the goldens are unchanged, and every golden layout (none holds a
  failed or parked task, or an exclusion row naming a channel) keeps exact equality.
  - (a) A task is UNREACHABLE when it is not done and it is failed or parked, or its dependency closure reaches a
    failed or parked task. When any task is unreachable, a non-null `eta` gains `cannotFinish: true`, `stoppedBy`
    names the failed and parked roots (the unreachable tasks that are themselves failed or parked, in task order),
    and `cleanMin` and `oneRepairMin` are 0: no estimate, kept as numbers so the wire shape holds. With no
    unreachable task the `eta` is exactly the base's, with no `cannotFinish` key. An ended run's `eta` stays null.
    A live run with no worker sample (R6b) keeps a `cannotFinish` ETA, which promises no time and whose critical
    path is the graph's alone; a reachable run without a sample still has no ETA.
  - (b) Each failed task adds one needsYou entry `{ task, kind: "failed", reason: <its note>, since: <its latest
    task-failed time>, blocks, cmd: "tickmarkr resume {run} --retry-failed" }`, in task order after the base's park
    entries, which are kept as they are. `{run}` becomes the run id (R9).
  - (c) A `pending` task whose dependency closure reaches a failed or parked task has state `blocked` (graph.ts
    `blockedTasks`' rule, the run-end row's `blocked` bucket) and now-sentence `blocked by <root> (failed|parked)`,
    `nowSince` null; every other field is the base's. `<root>` is the NEAREST failed or parked task by graph.ts
    `attributeBlocked`'s rule: level order over `deps` from the task, the first failed or parked task met wins, so
    a task under two roots names the nearer one, which need not be on the base's `waits on` chain (that chain
    follows each task's first unfinished dependency). Only a `pending` row turns blocked; a dependent of a running
    task keeps the base's `waits on …` row exactly. The oracle: over a journal cut just before its run-end row, the
    board files every task of that row's `done`, `failed`, `human`, `blocked` and `pending` buckets as `done`,
    `failed`, `parked`, `blocked` and a not-done live state (`pending`, `worker`, `waiting`, `gates`).
  - (d) Run-wide exclusions, folded as `Journal.replayExcludedChannels` folds them, in journal order: a
    `channel-demotion` or `channel-exclusion` row excludes its string `data.channel`, a `dead-channel-failover` row its
    string `data.from`, and a `channel-readmit` row lifts its string `data.channel`; a row naming no string channel
    (the fixtures' shrunk demotions) changes nothing. The snapshot gains `exclusions: [{ channel, cause, line }]`, one
    entry per channel still excluded, at its LATEST excluding row (a dead channel's exclusion and failover rows make
    one entry, at the failover's line; a channel excluded again after its readmit is listed at that later row), in
    the journal order of those rows. `cause` is `no-trailer streak <data.streak>` for a demotion, otherwise the row's
    `data.reason` (the event name when it has none), as the pool-excluded park names it; `line` is the reader's own
    1-based journal line (R9). The field is present only while some channel stands excluded: a run with none, or
    whose every exclusion was readmitted, has no `exclusions` key and reads exactly as at the base.
  - (e) A failed task's note is its full error: the latest `task-failed` row's string `data.error`, else its string
    `data.reason`, never cut at 90 code points; its now-sentence stays `failed — <note>` over that note, and its
    needsYou entry's `reason` (b) is that note. One form is summarized: the router's floor-pool refusal (`[RoutingError:
    ]<id>: routing.map.<shape>.pool has no live channel at task floor <tier> — declared: <list>[; skipped <list>];
    doctor found: <list>`, lists joined by `, `) reads `pool <shape> has no live channel at floor <tier>: <e> excluded
    run-wide (<channels>), <b> below floor, <n> not found`. Each declared channel is excluded run-wide when an (d)
    entry names it, else below floor when doctor found it, else not found (a skipped channel is classified by the
    same rule; the skipped clause carries no counter); the excluded channels are listed in declared order, and a
    counter at zero is omitted with its separator. Any other text, including the pool's `is exhausted` refusal, a
    multi-line error and a floor-pool text missing its doctor clause, is kept whole. A parked task's note is the
    base's. A non-string error keeps the base's note.
  - The reference promised a time while tasks had failed (`stoppedBy` named parked tasks only), listed no failed
    task under needs-you, read a task stranded behind a failed or parked task as pending (`waits on …`), showed no
    run-wide exclusion, and cut a failed task's error at 90 code points, mid-reason.

## B. Plugin board (`hooks/board/`)

- B1 `board.tsx` is `reference/board.tsx` byte for byte except the types import reads from `"./state"`,
  the footer literal `/run-progress reopens` reads `/tickmarkr-board reopens`, and the head names the spec being built
  as `<spec> · #<n>`, keeping the reference's run-id head when `spec` is null (queue row 335), plus contract S's
  D-2184 additions: the frame clock counts seconds since `readAt` changed even for ended snapshots; at 30 seconds
  the head reads `STALE · read <readAt>` in `INK.warn` (never `LIVE`) and the line below reads
  `not refreshed since <readAt> — /tickmarkr-board reloads it`. Durations, the approval countdown and ETA freeze
  at the last read: live `now` is `atEpoch` plus the live ticks counted up to that read. A new `readAt` restores
  the fresh display on the next frame. Row 393 (D-2187 add.16) adds, for an ended snapshot only: the life word
  gains ` · ended <HH:MM> · <age> ago`, where `<HH:MM>` is the local time of `endEpoch` and `<age>` is the frame
  clock minus `endEpoch`, floored to `<m>m` under an hour, `<h>h` under 48 hours, otherwise `<d>d` (a negative
  difference reads `0m`). The frame clock is the wall time anchored when that read was drawn plus the seconds the
  frame timer has counted since; `atEpoch` is the run's end once ended, so it cannot be the clock. The line under
  the head, after contract S's stale line when that line is present, reads
  `no run live — showing the last run, <runId>, ended <age> ago` in `INK.warn`. When `supersededBy` is a non-empty
  string, the next line reads `older than release <supersededBy> — a newer run left no journal under these roots`
  in `INK.warn`. A live or daemon-down head is unchanged and gains neither line. Contract S keeps precedence: at
  30 seconds the head is still exactly `STALE · read <readAt>` and the stale line still comes first. A task whose
  judge is `oracles` draws the seat `judge oracles` with no harness mark and no legend entry. Row 398 (D-2187
  add.24, R13) adds four pane rows:
  - Cannot finish (R13 (a)): when `eta.cannotFinish` is true, the head's ETA slot reads
    `cannot finish · stopped by <stoppedBy joined by ", ">` in `INK.fail` instead of a time, with no `ETA` or
    `clock stopped on` text. An absent or false `cannotFinish` draws the reference's ETA exactly, and a null `eta`
    draws neither.
  - Blocked (R13 (c)): a `blocked` task's card draws the status word `BLOCKED` in `INK.fail` and its now-sentence
    (`blocked by <root> (failed|parked)`) on the reference's wrapping now line. It has not started, so its colour, pill
    glyph `○` and unfilled `inactive` pill read as a pending task's. A dependent of a running task keeps the
    reference's `waits on …` row and `WAITING`.
  - Exclusions (R13 (d)): one head line per `exclusions` entry, in snapshot order, after the lines above and before
    the merged count: `excluded run-wide: <channel> — <cause> (journal line <line>)` in `INK.warn`. An absent or
    empty `exclusions` draws no such line.
  - A reason drawn once (R13 (e)): a parked or failed card draws its `↳ <note>` line only when the drawn now-sentence
    does not already contain the note. A failed task's now-sentence is `failed — <note>`, so its reason is drawn
    once, on the now line. The `↳` line wraps whole (`wrap="wrap"`) and is never clipped to the card. Each now line
    already wraps, so a reason longer than the card wraps whole on either line.
  The reference drew a time for a run that could not finish, a blocked row as a queued task with an amber running
  pill, no run-wide exclusion, and a failed task's reason twice, once cut at the card's width. Row 408 (D-2187
  add.48 and add.49) adds the budget's `more` prop: `BoardProps` gains `more?: number` (read as 0 when absent), and
  when it is above 0 the pane draws one line `+<more> more tasks (see tickmarkr status)` in `subtle`, keyed `more`,
  right after the tasks box that holds the last card (B10, level 3). The reference drew every task and had no such
  line. The reference test pins every other line.
- B2 `state.d.ts` declares wire contract version 1 (R1), with no repository runtime import:
  - `RunSnapshot` gains `version: 1`, `readAt: string`, `release: ReleaseSnapshot | null` and `spec: string | null`,
    and the optional `supersededBy?: string | null` (R12): its shape check accepts the field absent, which reads as
    null, so a pane over an older CLI still draws.
  - `eta` gains the optional `cannotFinish?: boolean` (R13, queue row 398, D-2187 add.24): its shape check accepts the
    field absent, which reads as false, and rejects any other type.
  - A task row's `state` may also read `blocked` (R13 (c), queue row 398, D-2187 add.24); its shape check accepts it
    and still rejects any state outside the union. An older CLI never sends it.
  - The snapshot gains the optional `exclusions?: { channel: string; cause: string; line: number }[]` (R13 (d), queue
    row 398, D-2187 add.24): its shape check accepts the field absent, which reads as none, and rejects a non-list or
    an entry missing a field or carrying another type.
  - The empty answer is `{ version: 1; empty: string }`.
  - It exports `BoardState = { snapshot: RunSnapshot | null; empty: string | null; error: string | null }` and declares
    the plugin-state key `tickmarkr` as `{ runBoard: BoardState }`, so one host write replaces the whole state.
  - model.ts imports neither claude-code nor src/board at runtime. Its Vitest tests use fixed wire fixtures and
    mocked process results.
- B3 `visible` keeps its policy: C0 except tab and newline, DEL, and C1 show as escapes. `shown(snapshot)` is a deep
  copy with every nested string through `visible`. Props, the fallback render, `boardStatusLine`, and every error,
  empty and diagnostic string pass through `visible`.
- B4 `boardArgs(options)`: each trimmed, nonblank, comma-separated `stateRoots` entry becomes `--root`, and each
  `releaseRoots` entry becomes `--release`.
- B5 `parseBoard(ran)` returns exactly one of snapshot, empty or error, with the other two null, and validates the full
  or empty shape:
  - A rejection uses its message.
  - A nonzero exit uses its last nonblank stderr line, or `tickmarkr board exited <code>; install tickmarkr 2.19.0 or
    later`.
  - Truncated output and malformed or misshapen JSON are errors.
  - Another version gives `the board needs tickmarkr 2.19.0 or later`.
- B6 `copyTarget(snapshot, posted)` returns the raw cmd only when exactly one distinct raw cmd has `visible(cmd)`
  equal to `posted`. Otherwise, including for a non-string or a stale post, it returns undefined.
- B7 `boardController(deps)` takes plain-function deps: cwd, directory check, process run, pane open, status, timer,
  clock and `publish(state: BoardState): Promise<void>`. The controller has no host-state import.
  - Each result publishes one complete replacement. The active session generation is checked before every
    publication, status and pane effect.
  - `start(interactive)`: it autoloads only when interactive and the cwd's own `.tickmarkr` is a directory. Then it
    refreshes and opens the pane without requesting focus. A missing, non-directory or rejected check, or a
    non-interactive start, has no board effect. An unplaced open sets the status `Run board ready — /tickmarkr-board opens it`. Otherwise
    it reads, polls, opens and sets nothing (queue row 280).
  - `command()` enables the board without the autoload condition, refreshes and opens the pane. Contract C (D-2184):
    it leaves exactly one armed timer. A poll that has stopped is armed again, exactly one new timer. A timer that
    is already armed stays that timer. While a read is in flight the command starts a fresh read.
  - Each automatic refresh rechecks the current cwd's `.tickmarkr`. Contract C (D-2184): a folder check that rejects
    (throws) keeps polling and that tick reads nothing. The tick still ages a read that was already in flight when
    the tick started; that age is taken before the check and stays bound to that read. A check that answers
    not-a-directory, or finds `.tickmarkr` gone, stops polling.
  - An automatic tick shares a read that has been in flight for fewer than 12 consecutive ticks. On the 12th (60 s)
    eligible tick it starts a fresh read (contract C, D-2184). Rejected checks count toward those 12. Ticks whose
    check resolves only after a newer read has started do not age or replace that newer read.
  - Newest wins (contract C, D-2184): only the most recently started read publishes, sets the status line or feeds
    autoOpen. An older read that settles later has no effect. A pane placement already in flight that resolves false
    cannot write the ready hint after a newer read starts, even before that read publishes or when it publishes the
    same run with updated status. A successful placement still records the run id. `end()` still invalidates every
    pending effect.
  - Every result replaces the whole state. A failure or empty result clears Copy and the status line.
  - `end()` cancels the timer and invalidates the session, so a late read publishes nothing. Session-generation
    checks and autoOpen's once-per-run latch stay as they are.
- B8 `view(state)` shows one of:
  - `shown(snapshot)` with marks and fit, passed through the B10 budget;
  - the empty text: `No tickmarkr runs found.`, then the searched roots, then `Compile a spec and review its plan,
    then run tickmarkr run. This board refreshes every 5 seconds.`;
  - the error, through `visible`.
- B9 The Vitest render harness:
  - supplies callable Client elements that return inspectable React elements;
  - recursively evaluates function components, the reference's Text wrapper included;
  - tells Copy buttons apart from task-selector buttons;
  - uses no global `h` shim.
- B10 Deliberate difference (queue row 408, D-2187 add.48 and add.49, option A): the board budget,
  `hooks/board/budget.ts`. The reference handed the pane every task, attempt and part with no bound, so a large run's
  tree passed the host's limit and the host refused the whole pane.
  - Bounds, read from the engine typings the board imports from `claude-code` (Claude Code 2.1.319
    claude-code.d.ts): the ClientElements and ClientModule docs keep "every tree's bounds (20,000 nodes, 32 deep,
    100,000 characters serialized)" and unmount a module past them; the Client props doc bounds `props` at 100,000
    characters serialized and unmounts the Client past it. The typings name no serializer, so the budget measures JSON
    length with a margin. All four must hold: props (the JSON length of `{ snap, error, marks, fit? }`) at most 80,000;
    tree characters (the JSON length of the drawn host-element tree: type, key, props without functions, children,
    function components evaluated) at most 80,000; tree nodes (host elements) at most 16,000; tree depth at most 32.
  - Where it runs: model.ts's `view()` passes the props through `budget` before they reach the pane, because the host
    refuses oversized props before the pane draws and the engine documents file imports for the hooks module only
    (board.tsx has type imports alone). It sheds detail from the snapshot DATA. The hooks side does not know the pane's
    width, so it measures the drawn tree by calling the Board function over a measuring element table, in every
    layout (140, 90 and 60 columns), each with the focus on the featured task and on the task with the longest
    history (its ATTEMPTS selector pressed).
  - Levels, closed, cumulative and in this order; the FIRST level at which all four bounds hold in every measurement
    is drawn. 0: none, and the props pass through as the same value, so every fitting snapshot draws byte-identical
    to the base. 1: the history of every task in state `done` becomes one line, its last attempt's `{ att, start }`
    with one part `{ text: "<k> attempts · merged", tone: "pass" }`, k its history's length. 2: also every history
    part `reason`, task `note` and needsYou `reason` longer than 120 characters keeps its first 119 and gains `…`,
    and a task's `now` that carries its cut note (a failed task's `failed — <note>`) carries that same cut note in
    its place, so the drawn tree holds the reason once (row 408, D-2187 add.90); ids, titles, commands (`cmd`) and
    every other field stay whole. 3 (row 408, D-2187 add.48 and add.49): also the last N tasks in the snapshot's task
    order are left out of the task list, never a task named in needsYou (`leaveOut`); N is the SMALLEST count at
    which all four bounds hold, and the props carry `more: N`, which the pane draws as B1's one
    `+N more tasks (see tickmarkr status)` line after the last card. The pane never goes blank: it still draws the
    head, the needsYou line and every task needsYou names. Past every task that may be left out, the most-shed props
    are returned with `fits: false`. `state.d.ts`'s `BudgetLevel` stays 0 to 2; budget.ts widens it to `ShedLevel`.
  - `state.d.ts` declares the budget's types (`BudgetBounds`, `BudgetLevel`, `BudgetMeasure`, `BudgetResult`).
    model.ts itself still imports neither claude-code nor src/board; through budget.ts it reaches board.tsx, whose
    JSX the host compiles with its own runtime. The frozen reference is not edited.
