# Fleet advanced reference

Operator workflow lives in the README's [Choosing your fleet](README.md#choosing-your-fleet-tickmarkr-fleet)
section. This document is the deep reference for routing-mode semantics, steering syntax,
tier provenance, and run-time routing flags. Implementation anchors: `src/config/config.ts`
(mode compilation), `src/route/router.ts` (production routing), `src/cli/commands/fleet.ts`
(interactive editor), `src/cli/commands/run.ts` (run flags).

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

## Where a fleet save lands

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

**Byte preservation.** A save rewrites only the nodes it changes; untouched block and flow lists,
full-line and inline comments (including a flow list's `[codex]  # note` gap), authored entries and
unknown subtrees keep their bytes. An aliased or anchored list is read as the config
loader reads it, so its entries for channels this probe never served stay admitted; an edit through a
shared anchor never changes the anchor's other aliases — each one is written out as a copy of its
original value first. One pre-existing limit remains: the writer re-serializes the
whole document, so a flow collection's comma spacing (`[one,two]` → `[one, two]`) and an anchored
flow mapping can be reformatted. Fleet writes through no YAML merge key: a membership edit whose path
(the edited list or any mapping above it) takes keys through `<<` is refused at review — it names the
path and the merge (`<<: *base`), publishes nothing and leaves both overlays byte for byte; inline the
merged keys into that mapping by hand, then save again.

## Tier and deny provenance (fleet writes)

The fleet editor (`tickmarkr fleet`) persists tier assignments into the overlay chosen above. When you
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

In the fleet browser's Steering view, both prefer lists are staged with a picker over the discovered channels — space adds or drops an entry, selection order is chain order — so entries are never typed by hand.
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
