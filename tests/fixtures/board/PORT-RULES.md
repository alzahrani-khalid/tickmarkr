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

## B. Plugin board (`hooks/board/`)

- B1 `board.tsx` is `reference/board.tsx` byte for byte except the types import reads from `"./state"`,
  the footer literal `/run-progress reopens` reads `/tickmarkr-board reopens`, and the head names the spec being built
  as `<spec> · #<n>`, keeping the reference's run-id head when `spec` is null (queue row 335), plus contract S's
  D-2184 additions: the frame clock counts seconds since `readAt` changed even for ended snapshots; at 30 seconds
  the head reads `STALE · read <readAt>` in `INK.warn` (never `LIVE`) and the line below reads
  `not refreshed since <readAt> — /tickmarkr-board reloads it`. Durations, the approval countdown and ETA freeze
  at the last read: live `now` is `atEpoch` plus the live ticks counted up to that read. A new `readAt` restores
  the fresh display on the next frame. The reference test pins every other line.
- B2 `state.d.ts` declares wire contract version 1 (R1), with no repository runtime import:
  - `RunSnapshot` gains `version: 1`, `readAt: string`, `release: ReleaseSnapshot | null` and `spec: string | null`.
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
  - `shown(snapshot)` with marks and fit;
  - the empty text: `No tickmarkr runs found.`, then the searched roots, then `Compile a spec and review its plan,
    then run tickmarkr run. This board refreshes every 5 seconds.`;
  - the error, through `visible`.
- B9 The Vitest render harness:
  - supplies callable Client elements that return inspectable React elements;
  - recursively evaluates function components, the reference's Text wrapper included;
  - tells Copy buttons apart from task-selector buttons;
  - uses no global `h` shim.
