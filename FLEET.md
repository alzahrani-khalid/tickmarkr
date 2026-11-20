# Fleet advanced reference

Operator workflow lives in the README's [Choosing your fleet](README.md#choosing-your-fleet-tickmarkr-fleet)
section. This document is the deep reference for routing-mode semantics, steering syntax,
tier provenance, and run-time routing flags. Implementation anchors: `src/config/config.ts`
(mode compilation), `src/route/router.ts` (production routing), `src/route/complexity.ts` (a line given
out by complexity), `src/fleet/` and
`src/cli/commands/fleet-screen.ts` (the `tickmarkr fleet` screen: your team, and what needs you),
`src/cli/commands/fleet.ts` (the editor behind `tickmarkr fleet --edit`, and `--pick`, `--print`),
`src/cli/commands/run.ts` (run flags).

## Routing precedence

Routing obeys a strict precedence — **pin > floors > prefer > marginal-cost auto**; floors filter channel eligibility before preference ordering applies:

- **pin** a shape to an exact channel: `map: { plan: { pin: { via: claude-code, model: fable } } }`
- **floors** set the minimum capability band per shape (`migration: frontier`, `tests: cheap`);
  only channels at or above the floor stay eligible for auto-routing
- **prefer**-rank adapters per shape among eligible channels:
  `map: { implement: { prefer: [cursor-agent, codex] } }`; marginal-cost auto then picks the
  cheapest sufficient tier within that ordering
- **deny/allow** bench models or whole adapters without touching tiers (see `routing.deny` in config)
- **tiers** classify models into bands — only classified, doctor-authed models ever route

Optional levers (absent config keeps default behavior):

- `routing.explore` — fence the exploration budget: `mode: off`, `excludeShapes`,
  `excludeComplexityAtOrAbove`, and a per-channel `cap`; `tickmarkr run --no-explore` disables
  exploration probes for a single run
- `tiers.<adapter>.windows` — declare context-window sizes per model; `tickmarkr doctor` grows a
  window column and `tickmarkr plan` warns (advisory, never blocking) when a task's payload
  estimate exceeds the routed model's window
- `routing.sla` — per-shape latency expectations, surfaced as advisory plan lints against the
  learned performance profile

## Routing modes

`routing.mode` is a preset that compiles into floor assignments at config load time. The router
never sees the mode itself; it receives resolved floors only (`resolveRoutingMode` in
`src/config/config.ts`).

Three routing modes are available:

- **`risk-based`** (default): byte-identical to pre-v1.51 routing. Absent `mode` key resolves as risk-based.
- **`partner-led`**: resolves every non-overridden shape to a `frontier` floor and disables exploration — use when quality is paramount and cost is secondary.
- **`staff-led`**: lowers each mode default by one tier (e.g., `implement` and `refactor` become `cheap` instead of `mid`) while keeping the preset floor for the integrity set (`plan`, `spec`, `migration`, `ui`) at `frontier`.

Explicit `routing.floors` entries beat mode-preset deltas and are linted during `tickmarkr plan` if they shadow the mode's delta; an explicit integrity floor below `frontier` is also linted. The mode is compiled once at config load and never consulted during routing.

Floor provenance recorded at compile time:

- Shapes still governed by an explicit overlay floor → `"config floors"`
- Shapes filled from the mode preset → `"mode <name>"` (e.g. `mode partner-led`)

The one screen's header names the mode in words, `mode partner-led (frontier models only)`: that is what the mode asks
of every shape, not what every line holds. A line that already names a model below the bar keeps it, and that line's
row says how much of its work runs below the bar: `<n>% below the bar`.

## How a line gives out its tasks

A shape's line is `routing.map.<shape>.pool: { mode, channels }`: the models named for that shape, and the way they
get its tasks. The way is one of three:

- **By complexity** (`mode: complexity`, new in 2.27): the expensive, strongest models are kept for the very complex
  tasks, complexity `routing.hardFrom` to 10. Every task gets a complexity from 1 to 10 when its spec is compiled
  (`tickmarkr compile`). The line's models are put in groups by score, strongest first: models within
  `routing.similarWithin` points of a group's strongest share that group. The first group takes the very complex
  tasks; the complexities below are divided among the other groups, strongest first. With one group, it takes every
  task. The models of a group share its related tasks in stable turns, so the same graph, config and probe give the
  same picks. A group with no usable model for a task hands its turn on to another group.
  The exact choice for each task is what `tickmarkr plan` prints. `tickmarkr fleet --print --why` explains a shape,
  not a task: it reads no graph and asks about one sample task of complexity 3, so it can name another group and model
  than `tickmarkr plan` gives a task of that shape.
- **My order** (`mode: ordered`): the first model that works takes every task; the others are backups, in order.
- **As saved before 2.27** (`mode: any`): see below.

A shape with no line of its own (no pool and no pin) is not given out by complexity: the cheapest model at the bar takes
each task, unless an explicit prefer list names an order, which ranks before cost.

**The two numbers.** Both are one setting each, for every line given out by complexity:

- `routing.hardFrom` — where very complex starts: a whole number from 2 to 10, default 8 (1 is refused: every other
  group would get nothing).
- `routing.similarWithin` — how close two scores must be to share a group: a number from 0 to 100, default 5.

A value outside its range, or of another type, is a config error that names the key. Scores are compared in tenths, so
64.6 and 59.6 are exactly 5 apart. On the one screen, `c` in an opened line given out by complexity moves `hardFrom` up by one (from 10 back to
2) as one pending change for every line by complexity; from a script, `tickmarkr fleet --set hardFrom=7`.
`similarWithin` is set in the config file.

```yaml
routing:
  hardFrom: 8          # very complex is 8 to 10
  similarWithin: 5     # scores within 5 points share tasks
  map:
    implement:
      pool: { mode: complexity, channels: [claude-code:claude-fable-5-2, claude-code:claude-opus-5-5, codex:gpt-6-astra, codex:gpt-6.1-sol] }
```

**A score and a list price.** A model's score is its Artificial Analysis Intelligence Index, and it comes from the
model catalogs the probe reads. Its list price is the price in US dollars per million tokens, in and out. The probe
(`tickmarkr doctor`, `r` on the screen, `tickmarkr fleet --fresh`) records both as `modelFacts` in the doctor record;
routing reads the score from that record, so a new score reaches routing at the next probe. With no Artificial Analysis
data the probe still succeeds. When a model a line could use for a task has no score, the line is grouped by level,
frontier then mid then cheap, and `tickmarkr plan` names the model that has no score.

**A subscription model's list price is shown, not charged.** The price column is the vendor's list price; a model you
reach through a subscription is billed by that subscription, and no screen calls it free. Giving tasks out by
complexity reads no price at all. A price appears on the line view and in its cost note, which names a model whose
output price is at least 3 times the lowest above zero in its group (`gpt-6-astra costs 5 times gpt-6.1-sol for a
similar score.`); a recorded price of zero is shown as `$0` and compared with nothing.

**Reading it back.** `tickmarkr plan` ends each task's line with how it was given out, for example
`by complexity: very complex 8-10, group 1 of 2 (config routing.map)` or
`by complexity: the rest 1-7, group 2 of 2, one of 3 that take turns (config routing.map)`; a task moved to another
group adds `group 2 has no model that can take it, moved up`, and a line grouped by level adds
`grouped by level: <cli:model> has no score`. The one screen's WORKERS heads read `VERY COMPLEX 8-10` and `THE REST 1-7`;
an opened line shows each group's models with their score, price and share, counted over 400 sample tasks, 40 at each
complexity.

**A line saved before 2.27.** A line written `mode: any` routes exactly as it did in 2.26.1: each task goes to the
cheapest model by marginal cost, spread over the vendors, and within one vendor the lighter or earlier-written model
comes first. `any` does not share tasks between every model on the line: a second model of the same vendor at the same
cost can get no tasks at all. The one screen shows such a row as `<names> share every task` (`<name> does every task` when one model
takes all of it) and, in the warning style,
`no tasks: <names>`; the opened line, "As saved before 2.27", gives each model that gets none its one reason (for
example `<name>, of the same vendor, is written before it` or `it costs more than <name>`). To change it, answer yes to
the item `complexity` (`<lines> are given out the way they were saved before 2.27. Give them out by complexity?`),
which sets exactly those lines to by complexity and keeps every model on them; or open the line with Enter and choose
By complexity or My order; or run `tickmarkr fleet --set <shape>=complexity:<models>`; or write `mode: complexity` in
the config. A script may still write `--set <shape>=any:<models>`, which does what it did in 2.26.1; only the screen is
limited to by complexity and my order. `--set <shape>=<models>` with no way keeps the line's way, and a line that has
none becomes by complexity (in 2.26.1 it became `any`). `tickmarkr fleet --edit` offers only `any` and `ordered`: a
line by complexity re-pooled there takes the mode chosen there.

## Where a fleet save lands

**On the one screen (`tickmarkr fleet`).** Its keys are `↑↓ move · Enter change the line · y n answer · s save · u undo ·
r check again · ? help · q quit`. A yes and a change wait under NOT SAVED, and nothing is written until the save: `s`
opens it (`Nothing to save.` when nothing is pending). The save lists each change after and before, and under WRITTEN TO
names every file it writes: `your settings: ~/.config/tickmarkr/config.yaml`, read by every project with no line of its
own, or `this project's settings: .tickmarkr/config.yaml`, read by this project only. In a linked worktree with no config
of its own, a save that writes this project's settings says it writes a full copy there, after which a change to the
file it read no longer reaches that checkout; a save that writes only your settings makes no local copy. `d` shows each file's changed lines with their numbers and its +N −M count, and `d` again returns; Enter saves;
Esc goes back with nothing written. Each edit goes to the file that holds what it changes: your settings only when they
hold it and this project's do not; held by both, or by neither, this project's settings. One save may write both files.
Before either file is touched the save checks that neither changed while the screen was open (if one did, the save is
refused: answer again) and that the candidate bytes load. `tickmarkr fleet --yes <id>` and `--set` print the same save
as text and write it only with `--save`.

**In the 2.24.0 editor (`tickmarkr fleet --edit`), unchanged in 2.27, a save follows its own rule.** The rest of this
section, and the rows, rails, `t`, Space, `w` and `y` keys it names, are that editor's.

Every `w` review writes exactly ONE overlay and names it in the review title (`review · <path>`).
Before you press `w`, an excluded row's detail line already names where each excluding scope is held,
as `held: <scope> @ <path>:<line>` (for example `held: routing.allow @ .tickmarkr/config.yaml:13`).
The choice follows the config merge (defaults → user → repo; a list replaces the lower list whole,
`null` deletes it), so an edit always lands where it is effective in this repository:

- **Membership** — `routing.allow` (`adapters`, `models`) plus the all-seats deny lists
  (`routing.deny.adapters`, `routing.deny.models`) are one coupled family: the allow form is
  regenerated from the whole staged fleet. It goes to the **repo overlay** (`.tickmarkr/config.yaml`)
  when that file declares any of those leaves — an empty list `[]` counts — or masks one with
  `null` at the leaf or above (`allow: null`, `deny: null`); otherwise to the **user overlay**
  (`~/.config/tickmarkr/config.yaml`), which every repository on the machine inherits. A bare
  `allow: {}` declares no leaf, so an inherited user allow edit stays a user save — except one whose
  user save would drop the user allow form: that empty map alone keeps the allowlist on, so that save
  goes to the repository, which masks it. The user form stays (and so does the save) while anything
  still needs it: an allow exclusion, a staged all-seats deny, or an authored entry for a channel this
  probe never served. A whole
  `routing: null` is no holder: the routing block is required, so that overlay does not load and
  Fleet does not open on it. A worker deny materialized under a `deny: null` mask keeps every other
  deny leaf masked, so a lower layer's lists never return beside it.
  An inherited allow leaf the repository leaves undeclared stays effective, so a repository save
  keeps its entries for channels this probe never served (one `allow.adapters` declared beside an
  inherited `allow.models` keeps the inherited models).
- **Worker denies** — each `routing.deny.workers.*` leaf follows its own holder: the repo overlay
  when it declares or masks that leaf, else the user overlay.
- **A classification** (a tier you typed with `t`, or Space/Enter on an unclassified row) goes to
  the user overlay, except one admitted in the same session — its own allow entry or its own all-seats
  deny lifted: it co-locates with its own admission.
- **Everything else** — routing mode, Shapes pins/pools/prefer, effort, judge, review/consult
  steering — goes to the user overlay.

A batch whose edits need both overlays is refused at `w` before anything is written; the refusal
names each edit with its path. Save them in separate sessions: stage one side, `w`, `y`, then the
other. A repo-overlay review says the file is **tracked** — Fleet never stages or commits it; commit
it to share the change. Either save affects **future config loads only**; a run already in progress
keeps the config it loaded. Both overlays are re-read at `y`: if either changed after the review
(including a change that moves which layer holds the family), the save is refused as a stale
preview — press `w` again — and it is never retargeted to the other file.

**Admitting an unclassified model in one session.** An unclassified model is never routed, and an
allow form names only classified models, so a new model the allow form leaves out reads
`out allow`. Classify it (`t`), and the editor stages that model's own allow entry beside the tier;
Space → in then admits it before `w`, and the preview row reads `in`. Membership is not
routability: a model with no probe verdict yet stays unroutable until `tickmarkr fleet --fresh`.
Pressing out · all seats after admitting it undoes the admission — the model stays out, and that
new deny is a membership edit of its own (so its tier and it are then saved separately). Space on a
model whose adapter the allow form leaves out whole clears only its own entry: the adapter's entry
still excludes it, so nothing is admitted and its tier is saved to the user overlay alone.

**Grouped rows act on every real member.** One row can stand for several real models: effort/speed
variants doctor reported collapse into one base row (`C` for `C-low`, `C-high`, `C-max`; the bare `C`
is a member only when doctor served it too), and gateway ids that resolve to one catalog record fold
under one row (`×N`), each constituent keeping all of its variants. The row's label is never substituted
for the member set: when the label is itself a real id doctor served (the bare `C`, or a fold's first
gateway id), it is written only as that one member, beside every other member's own id. `t` (or a bulk
`s`) stages the tier and provenance on **every** real member — the detail line lists them after
`classify writes` — and stages each member's own `adapter:model` allow entry, so Space → in admits the
whole group in the same session, before `w`; no second session is needed. A staged allow entry another
member's recorded identity also reaches (`C-high` recorded as `C-low`) is still the group's own, so the
same in admits both. Each reach
choice applies the same one-reason act to every member: out · workers writes a
`routing.deny.workers.models` entry for each member's real id, so workers skip all of them while judge,
review and consult keep every one; out · all seats and in work the same way, and a clear takes one own
reason per member, so a member that still holds another reason stays out and is named. The row reads
`in`, `out workers` or `out all` only when every member has that state; when members disagree it reads
`partial`, and its detail line — like the rail's reach picker — names each affected member's real id and
scope, so one excluded member never hides behind the others. An entry that also covers another real
channel (another member included) or a whole adapter is never lifted from a row: the row names it, and
`l` (or the rail, for an adapter entry) owns it. Admission is membership, not authentication: only
members doctor probed and authed join the worker, judge, review and consult pools. A member doctor
recorded unauthed, or never probed, is named on the row and in the save outcome — re-probe it with
`tickmarkr doctor` (or `tickmarkr fleet --fresh`); the group's admission never makes it routable.

**Worker-only deny on a partially excluded adapter (two presses).** When some of an adapter's
channels are out through the allow form, a direct out · workers on its rail is refused (the rail edits
only the adapter's own entries). Press out · all seats on the rail, then out · workers: the second
press moves that same entry to `routing.deny.workers.adapters`. Only the final state is reviewed and
written — the intermediate `routing.deny.adapters` entry never reaches the review or the file, so
review, judge and consult seats keep that adapter.

**What a save keeps.** A save changes only what its answers name, and the file lines (`d` in the one screen's save,
the review in the editor) show every line it will change, with its +N −M count, before anything is written. On the one screen (`tickmarkr fleet`, its `--yes` and `--set`)
the saved files load and their merged settings change only at the answered settings; an edit it cannot prove that of is
refused, naming the file and the setting, and nothing is written. The bytes of lines an edit does not touch are kept when
every line ends LF or every line ends CR LF — a file whose lines end both ways has no one form to keep, and the writer can
rewrite its endings — with or without a byte-order mark, with a tab before a comment, and with its long lines whole when the
file has a line over 80 columns (a line counts by its value, without a trailing comment). The indent is the file's first indented line's,
the step from the first nested block map's key to the line under it; a list does not set it, and a file that shows no such
line is written at two spaces. A line indented otherwise is rewritten to it, even when that first line is the minority.
The file's style is read once, for the whole file; where it mixes two (padded and unpadded flow collections,
list items in both places) the fewer are rewritten, maps and lists counted together. Where the two are equal in number, list
items are written indented and flow collections unpadded. An edit that empties a list in a file whose list items sit at
their key's indent indents every list in the file only when the writer's first rendering fails to parse,
such as when that flat list is emptied under a comment, since the other form would not parse.
Emptying a flat list that still parses does not indent the others: a flat `routing.deny.models`
emptied while `review.prefer` is also flat writes `models: []` and leaves `review.prefer` flat. An untouched value aligned with
extra spaces is normalized to one space. An untouched double-quoted value written with an escape for a character that prints
can be rewritten with the character itself; an escape for a tab stays an escape. A comment on a block map's or
list's key line moves below that line, and the gap before a comment after an implicit null, or after a `|` or `>` header,
is written as two spaces (a comment that continues on the next line moves instead, as listed below). A `%YAML 1.1` file gets a real map where a write needs a new one, and a file that holds only
`---` or comments is written to. What the writer can still rewrite on an untouched line: a flow collection padded unlike
most of the file's (a padded `{ a: b }` among unpadded ones), a flow list written over several lines, a plain or quoted
scalar written over several lines (joined onto one; a literal `|` block stays a literal block, and a folded `>` can be reflowed), a
comment after the last line (it gains a blank line before it), a flow collection's comma spacing; and a file with no
newline at its end gets one. Also on an untouched line: trailing spaces and runs of blank lines go; a comment on the
`---` line, a comment line indented unlike the lines around it, and a comment that continues under an implicit null or
under an alias written out as a copy move; `key : value`, a value after a tab and extra spaces after a list's dash take
one space; a flow map over several lines is joined, a comma at a flow collection's end and the padding of an empty `[ ]`
go; a number written `+45`, `.5`, `4.5e1`, `0x2D` or `04` is respelled; a literal block's lines take the file's indent
when they sit deeper; a double-quoted value of 40 characters or more that holds `\n` is written over several lines; and
an escape for a character that does not print (`\_`, `\N`, `\u200B`, `\x7f` and the like) is written as that character
(queue row 494); none of these changes what the file means or drops a comment's text. The review shows each such line
(queue row 452). An aliased or
anchored list is read as the config loader reads it, so its entries for channels this probe never served stay admitted;
an edit through a shared anchor never changes the anchor's other aliases — each one is written out as a copy of its
original value first. Fleet writes through no YAML merge key: a membership edit whose path
(the edited list or any mapping above it) takes keys through `<<` is refused at review — it names the
path and the merge (`<<: *base`), publishes nothing and leaves both overlays byte for byte; inline the
merged keys into that mapping by hand, then save again.

**From a script.** `tickmarkr fleet --json` prints the screen and changes nothing; beside `--yes`, `--set` or `--save`
it is refused, so a dropped answer is never read as done. `--yes <id> --save` exits 0 when the answer was saved and 1
when the fleet does not ask about that id now (an item already answered, say), so a script that repeats the line reads
`--json` first:

```sh
tickmarkr fleet --json | grep -q '"id": "setup"' && tickmarkr fleet --yes setup --save
```

## KEPT OUT: what removes a rule

The one screen's KEPT OUT lists every rule of every deny list in force (`routing.deny.*`), in the lists' order. A
row may show a reason taken from a comment in the config file; a rule with no reason found shows none. An entry of a
workers' list ends ` · workers only` (with no reason it reads `kept out for workers`).

**No item removes a KEPT OUT rule.** No yes changes, empties, removes or adds to a deny list, with no exception. The
tidy item removes names from lines only; a judge item may offer a replacement the rules allow, and its yes changes the
judge only; the consult and judge items, when the model they would pick is kept out by a rule, have no yes: they name the rule and say to remove it from its own line of KEPT OUT or to pick another model.
The new-model item's yes adds a model to `routing.allow.models` only when the allow list excludes it: that is an
allowance, not a KEPT OUT rule.

On the screen a rule is removed only from its own line of KEPT OUT: Enter on the rule's row shows the rule, its reason
and the models it keeps out now, `x` removes it as a pending change, and `s` then Enter saves it. The `+ keep a model or
a CLI out` row adds a rule, and never removes one that was there when the screen opened. A model added to a line lifts
no rule: the models view refuses a model a rule keeps out and names the rule. From a script, `tickmarkr fleet --set`
removes no rule either: naming a model a rule keeps out, or giving a deny list without an entry that is saved, is
refused by name, exits 1 and writes nothing; `--set` on a deny list may add entries. Outside the one screen and its
commands, a rule is removed by editing the config file. `tickmarkr fleet --edit`, the 2.24.0 editor, is unchanged and
still changes a rule from its own rows.

## Tier and deny provenance (fleet writes)

The 2.24.0 fleet editor (`tickmarkr fleet --edit`) persists tier assignments into the overlay chosen above. When you
classify a model that has no tier yet, step 3 requires a typed **benchmark-provenance note**;
the serializer stores it on the assignment and writes it as a trailing `#` comment beside that
model line in YAML.

On each fleet session load, `harvestFleetProvenance` in `src/config/config.ts` re-reads existing
`#` comments from the on-disk overlay before any edit. On confirm, `serializeFleetOverlay`
re-attaches harvested notes plus any notes typed in the current session — prior operator comments
are not stripped on a later fleet write.

Deny-list entries (`routing.deny.adapters` / `routing.deny.models`) support the same trailing
`#` comment pattern for bench reasons.

## Review preferences

`review.prefer` is an ordered list of reviewer seats for the cross-vendor code-review gate. Entries are matched by diversity (never the same vendor or model as the original worker), and routing reorders the available channels only — it does not admit unauthed or denied channels.

```yaml
review:
  prefer: [codex, kimi]           # bare adapter: inherits model from the routed channel
  prefer: [codex:gpt-5.6-sol, kimi:kimi-code/k3]  # adapter:model explicit
  prefer: [codex, kimi:kimi-code/k3]  # mixed: bare and explicit
```

**Grammar**: review prefer entries may name a bare adapter (inheriting the model from the current channel) or an explicit `adapter:model` pair. Bare adapters rank every diversity-eligible channel for that adapter; explicit pairs rank one diversity-eligible channel.

In the editor's (`tickmarkr fleet --edit`) Steering view, both prefer lists are staged with a picker over the discovered channels — space adds or drops an entry, selection order is chain order — so entries are never typed by hand.
The review picker offers bare adapters and explicit `adapter:model` seats; the consult picker
offers explicit seats only. A configured entry that is absent from current discovery remains a
marked picker row until the operator deliberately drops it.

Pressing `w` renders the unified overlay diff inside Ink and accepts `y` or `n`
without opening a line editor. A `y` passes the exact candidate bytes through the production
config-loader guard before the fleet command's single filesystem write. If that guard rejects the
overlay, the browser returns with the error inline and every staged edit intact; nothing
is written.

## Consult preferences

`consult.prefer` is a ranked failover list of seats for escalations on deadlock or gate stalls. Unlike review, a consult seat has no channel to inherit a model from, so entries **must be explicit `adapter:model` pairs**.

```yaml
consult:
  adapter: claude-code
  model: fable
  prefer: [codex:gpt-5.6-sol, kimi:kimi-code/k3]   # adapter:model ONLY
```

The daemon walks the preference list to the first live adapter, then the pinned `consult.adapter:model` pair as the final fallback. Failed or unparseable verdicts fall to the next entry.

**Grammar**: consult prefer entries require `adapter:model` form — a bare adapter name is invalid and fails config load. Every entry must declare both the adapter and the model because a consult seat runs independently with no channel context.

## Rerun control: `--supersedes`

`tickmarkr run --supersedes <prior-runId>` marks the current run as a rerun of a prior engagement. The current task graph is used for the rerun; compile it fresh first if the spec changed. The prior runId is recorded in the new journal, and the prior journal records the successor, for audit trails and change attribution.

Use this when you modify the spec or worker logic and want to mark an intentional rerun while preserving the relationship in both run journals.

## Run flag: `--quality` and `--mode`

`tickmarkr run --quality` is a **routing-mode alias** for `tickmarkr run --mode partner-led` for that run only. It selects the same compiled partner-led floors and exploration-off behavior as an explicit `--mode partner-led` flag. It has **no independent floor-raising effect** — the retired v1.47 one-band floor bump and the `TICKMARKR_QUALITY` environment seam were removed from `route()` in v1.60; `route()` never reads that variable.

You cannot combine `--quality` with an explicit `--mode`; pass one or the other. For a permanent fleet posture, set `routing.mode` in config via `tickmarkr fleet` instead of relying on per-run flags.

The legacy `TICKMARKR_QUALITY=1` shell export is scrubbed from child environments at spawn time but does not change routing outcomes.
