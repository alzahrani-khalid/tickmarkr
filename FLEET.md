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

## Tier and deny provenance (fleet writes)

The fleet editor (`tickmarkr fleet`) persists tier assignments into the repo overlay. When you
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

In the fleet editor (step 6/6), both prefer lists are staged with a picker over the discovered channels — space adds or drops an entry, selection order is chain order — so entries are never typed by hand.
The review picker offers bare adapters and explicit `adapter:model` seats; the consult picker
offers explicit seats only. A configured entry that is absent from current discovery remains a
marked picker row until the operator deliberately drops it.

After steering, the editor renders the unified overlay diff inside Ink and accepts `y` or `n`
without opening a line editor. A `y` passes the exact candidate bytes through the production
config-loader guard before the fleet command's single filesystem write. If that guard rejects the
overlay, the editor returns to step 6 with the error inline and every staged edit intact; nothing
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
