import type { RegisteredCommand } from "./index.js";

type Help = { usage: string; description: string; options: Record<string, string>; examples: string[] };

// Descriptions live beside dispatch, not in mutating command bodies. The parser/registry drift
// test checks these option names against production source; adding a command requires help here.
export const COMMAND_HELP = {
  init: {
    usage: "init [options]", description: "Set up repository/global config, a starter spec and adapter health.",
    options: {
      "--global-dir <path>": "Use this global configuration directory.",
      "--agent": "Install agent skills; combine with --docs for guidance files.",
      "--force": "Refresh existing managed agent skills/docs when installing them.",
      "--docs": "Include agent guidance documents with --agent.",
      "--fresh": "Force fresh adapter probes instead of reusing recent health.",
      "--yes": "Skip the interactive setup wizard and use defaults.",
      "--remove": "Reverse init without scaffolding: delete state, skills, docs block, unedited spec, and prune worktrees.",
    }, examples: ["init --yes", "init --agent --force --docs", "init --remove"],
  },
  doctor: {
    usage: "doctor [options]", description: "Probe configured adapters and models and print diagnostics. Default probing may make model calls and refresh a stale catalog.",
    options: {
      "--models": "Include full per-model diagnostics.",
      "--fix": "Run normal probes and repair the test-runner ignore when a safe edit exists.",
      "--fix-only": "Repair and verify the test-runner ignore locally; skip model probes and catalog refresh.",
      "--cached": "Read cached diagnostics without probing or refreshing the catalog.",
      "--cached-only": "Alias for --cached.",
      "--probe-preflight": "Disclose configured model/probe counts and affected files without probing.",
      "--preflight": "Alias for --probe-preflight.",
      "--refresh-catalog": "Refresh only the model catalog; use as the sole option.",
      "--catalog-only": "Alias for --refresh-catalog; use as the sole option.",
    }, examples: ["doctor --probe-preflight", "doctor --fix-only", "doctor --models", "doctor --refresh-catalog"],
  },
  fleet: {
    usage: "fleet [options]", description: "Edit fleet configuration interactively, or print it for scripts.",
    options: {
      "--pick <role>": "Resolve one role preference as JSON without launching a seat (review or consult; roles without prefer refuse).",
      "--exclude-vendor <vendor>": "Exclude a vendor from --pick; repeat for multiple vendors.",
      "--print": "Print fleet configuration without opening the editor.",
      "--why": "Include routing eligibility explanations in printed output.",
      "--global-dir <path>": "Use this global configuration directory.",
      "--fresh": "Refresh adapter health; may make model calls.",
    }, examples: ["fleet --print --why", "fleet"],
  },
  compile: {
    usage: "compile <spec-dir-or-md> [options]", description: "Compile source into .tickmarkr/graph.json; acceptance criteria are required.",
    options: {
      "--type <speckit|prd|gsd|native>": "Select the source format explicitly.",
      "--dry-run": "Validate and report without saving the graph.",
      "--strict": "Treat all native authoring lint findings as blocking errors.",
    }, examples: ["compile feature.spec.md --type native --dry-run", "compile feature.spec.md --strict"],
  },
  scope: {
    usage: "scope <intent-file> [options]", description: "Draft a native spec beside an answered intent. Authoring requires TTY confirmation or --yes and may make model calls.",
    options: {
      "--preview": "Validate locally and show cached candidate, destination and call budget; no probes, model calls or writes.",
      "--yes": "Confirm the disclosed authoring action without a TTY prompt.",
      "--force": "Allow overwriting the destination spec after confirmation.",
    }, examples: ["scope feature.intent.md --preview", "scope feature.intent.md --yes", "scope feature.intent.md --yes --force"],
  },
  plan: {
    usage: "plan [options]", description: "Print the compiled graph's routing preview, cost estimate and floor lints without dispatching workers.",
    options: {
      "--mode <risk-based|partner-led|staff-led>": "Preview routing under the selected mode.",
      "--driver <auto|herdr|subprocess|orca>": "Preview the execution driver; orca is explicit-only.",
    }, examples: ["plan", "plan --mode risk-based --driver subprocess"],
  },
  run: {
    usage: "run [options]", description: "Execute the compiled graph with production preflight, gates and run locking.",
    options: {
      "--concurrency <N>": "Set a positive integer worker concurrency.",
      "--driver <auto|herdr|subprocess|orca>": "Choose the execution driver; orca is explicit-only.",
      "--route-strict": "Refuse routing conflicts and lints before dispatch.",
      "--no-explore": "Disable learned routing exploration for this run.",
      "--mode <risk-based|partner-led|staff-led>": "Override the routing mode for this run.",
      "--quality": "Compatibility alias for --mode partner-led; cannot combine with --mode.",
      "--supersedes <run-id>": "Record that this engagement supersedes the named run.",
    }, examples: ["run --concurrency 2 --driver subprocess --route-strict"],
  },
  status: {
    usage: "status [<run-id>] [options]", description: "Show a named run or the latest run. With --watch --events, stdout is one JSON document per decision event and stderr carries keepalive lines. Do not merge stdout and stderr (2>&1 corrupts the JSON document stream).",
    options: {
      "--oneline": "Print a compact snapshot and exit.",
      "--watch": "Follow updates; on a TTY open Run unless plain output or event streaming is selected.",
      "--plain": "Use line-mode output with --watch, including on a TTY.",
      "--events": "With --watch, replay and follow decision events as JSON documents on stdout.",
      "--jsonl": "Alias for --events.",
      "--decision-events": "Alias for --events.",
      "--webhook <url>": "With --watch, POST decision events to this URL.",
    }, examples: ["status --oneline", "status run-example --watch --plain", "status run-example --watch --events"],
  },
  stats: {
    usage: "stats", description: "Print all-run channel delivery, failure, rescue, author and reviewer statistics. Takes no run ID.",
    options: {}, examples: ["stats"],
  },
  resume: {
    usage: "resume <run-id> [options]", description: "Continue a run from its journal through production preflight and gates.",
    options: {
      "--graph-changed": "Accept and journal a changed graph identity for this run.",
      "--retry-failed": "Retry failed tasks.",
      "--driver <auto|herdr|subprocess|orca>": "Choose the execution driver; orca is explicit-only.",
    }, examples: ["resume run-example --driver subprocess", "resume run-example --retry-failed"],
  },
  report: {
    usage: "report [<run-id>] [options]", description: "Report on a named or latest run. Markdown goes to stdout; redirect stdout to save an execution record beside the spec.",
    options: {
      "--md": "Write the Markdown execution record to stdout; does not create a Markdown file.",
      "--compare <baseline-run-id>": "Include cost, gate and duration deltas with an environment comparability guard.",
      "--bundle <path>": "Write a portable JSON proof bundle to this local path.",
    }, examples: ["report run-example --md > feature.record.md", "report run-example --compare run-baseline", "report run-example --bundle proof.json"],
  },
  profile: {
    usage: "profile [reset|discount <run-id> [<task-id>]|discounts] [options]",
    description: "Show learned routing, reset the history cursor, append a discount or list discounts. Use profile <operation> --help for details.",
    options: {
      "--explain <shape> <adapter:model> [sub|api]": "Explain the learned score for a shape and channel (default billing: sub).",
      "--weight <0|0.5>": "Required for discount: set the evidence weight.",
      "--reason <text>": "Required for discount: explain the evidence claim.",
    }, examples: ["profile", "profile --explain implement fake:fake-1 sub", "profile discount run-example T1 --weight 0.5 --reason 'infra incident'", "profile discounts", "profile reset"],
  },
  ui: {
    usage: "ui [<run-id>] [options]", description: "Open the cockpit on a TTY. Delivered views: 1 Home, 4 Run, 5 Evidence. Fleet, Plan and Health remain CLI commands: tickmarkr fleet, tickmarkr plan, tickmarkr doctor. Without a TTY use tickmarkr fleet --print or tickmarkr status --watch.",
    options: {
      "--view <home|run|evidence>": "Choose a delivered view; default home (an empty repository opens Home).",
      "--setup": "Open Run Parks for the positional run ID, or latest run; overrides --view.",
    }, examples: ["ui", "ui run-example --view run", "ui run-example --view evidence", "ui --setup run-example"],
  },
  unlock: {
    usage: "unlock <run-id> [--yes] | tickmarkr unlock --garbage [--yes]", description: "Remove only a matching, provably dead run lock after confirmation. Live, inaccessible or changed holders refuse; commit rechecks the preview.",
    options: {
      "--garbage": "Recover an unparseable lock identified by its bytes/inode; no run ID is invented.",
      "--yes": "Confirm removal without a TTY prompt; all holder and race checks still apply.",
    }, examples: ["unlock run-example --yes", "unlock --garbage --yes"],
  },
  approve: {
    usage: "approve <run-id> <task-id> [options]", description: "Append a validated park decision. A running owner may enact it; a closed run requires a separate resume. Decisions cannot be undone.",
    options: {
      "--park <line>@<ts>": "Bind the decision to the park token status prints (a failed task's recheck binds its failure token); refused once a newer park opens.",
      "--gate <gate>": "Bind a waive to the park's failed gate; refused when the park failed another gate.",
      "--files <glob,…>": "Extend files[] for a scope-request park with comma-separated repository-relative globs; required for scope approval.",
      "--by <name>": "Name the actor (default: current OS user).",
      "--reason <text>": "Record the decision reason.",
      "--waive": "Waive only the identified failed gate.",
      "--uphold": "Uphold a review failure and fund a fixed attempt.",
      "--recheck": "Request rechecking an infra or failed-gate park; satisfies no gate.",
      "--review-rounds <N>": "Set a positive integer review-round ceiling that binds only this approval engagement; a later approval without --review-rounds restores the built-in default.",
    }, examples: [
      "approve run-example T1 --park 42@2026-09-26T08:00:00.000Z --by operator --reason 'ready to proceed'",
      "approve run-example T1 --waive --park 42@2026-09-26T08:00:00.000Z --gate review",
      "approve run-example T1 --recheck --park 42@2026-09-26T08:00:00.000Z --reason 'infra recovered'",
      "approve run-example T3 --recheck --park 57@2026-09-26T08:05:00.000Z --reason 'failed task: re-gate its landed commits'",
    ],
  },
  beat: {
    usage: "beat <start|stop|status> <orchestrator|orchestrator-context|overseer|overseer-context|watch> --seat <identity> | beat <tier> --seat <identity> [options]",
    description: "start launches one detached --loop beat per tier and exits 0 only after reading back that child's own advancing beat; stop retires only that recorded generation and reads back DISARMED; status is read-only and exits nonzero for STALE, MISMATCH, UNREADABLE or a dead invocation's leftovers. The legacy <tier> form writes one supervision beat using the recorded arm: stood-down arms stay DISARMED until explicitly re-armed; stopped beats become STALE. " +
      "Legacy migration: start refuses a legacy (unowned) ARMED/STALE arm nonzero and prints its exit under the RECORDED seat — `tickmarkr beat <tier> --seat <seat> --stand-down` (`--seat=<seat>` when the seat begins with a dash), after \"stop pid <N> first\" when its --loop writer is still alive (tickmarkr never signals a process it did not launch, nor takes its live claim; an arm with no recorded seat gets no invented one) — then start owns the tier and reads back ARMED. A writer stopped inside its claimed tick does not strand that step: the --stand-down reclaims the claim it died holding, printing the notice; while the writer lives, the step waits and refuses BUSY. " +
      "Claims — actors IN: compliant claim contenders (start, stop and each legacy write — one-shot, --new-arm, --loop tick, --stand-down — through this CLI), a crashed owner (holder pid ESRCH or a zombie, its claim and records left behind) and a killed compliant recovery or release taker (dead at any step of the one claim-removal path); OUT, the one residual: an external writer editing, replacing or deleting claim, lock or record files outside this CLI, under which nothing beyond the identity MISMATCH refusals is promised (its edit between a final claim check and the mutation's own system call is not seen — there is no filesystem compare-and-rename). A claim records its holder pid and birth (its runtime's own start record, read with no process probe) and, for a launch claim, the launched writer publishing under it. Every claimant takes over a held claim only when every pid read from that claim's own bytes is confirmed dead (ESRCH or a zombie) — the legacy {tier, token, pid, claimedAt} claim included — printing the reclaim notice with its final result even when it then had to wait or refuse; a live, reused or unreadable holder or writer is never taken over: start tries once, every other claimant waits at most 20 attempts 250 ms apart, then refuses BUSY with nothing written. A launched writer acts under its launcher's claim only while that launcher is not confirmed dead, recording itself as the claim's writer before its first act; once the launcher is dead, a writer past its first beat releases that claim itself (with a notice) and takes the tier claim like any writer — or, when that launcher died before binding its arm epoch, exits right after the release, leaving an abandoned launch the next start, stop or legacy write retires — and one still launching refuses having written nothing; a killed start neither strands stop nor lets recovery take the claim from a live writer. Under its launcher's claim the writer checks nothing after its last act (each act verified the claim last), so start's release after its read-back never ends the loop it launched. A claim is removed in one way only, by recovery and by its holder's release alike: under a per-claim removal lock that appears already naming its taker's pid and birth, once no claimed act is running under those bytes (a release waits up to 2 s, a recovery refuses BUSY), the checked bytes are moved aside into the lock and kept only when they are exactly those bytes — other bytes found there are put straight back, and a claim linked while that removal is under way is never acted under: its claimant withdraws exactly the claim it linked and refuses BUSY (its next attempt links afresh). Claim bytes an invocation could not remove — another live taker held them or moved them aside, even on a mistaken death proof, or its release was refused — stay provably that process's strand wherever they are (its pid, its checked birth and a token none of its invocations still holds): while a live taker holds them every claimant is BUSY naming it; once none does, that process's own next start, stop or legacy write withdraws them from the claim path, or discards them from a killed taker's lock instead of restoring them, with a notice; its own status reports them as its stranded claim wherever they are — on the claim path or moved aside into a live or dead taker's lock, naming that taker — with the recovery command (to run once a live taker has finished or exited); and once that process has exited they are a dead claim any start, stop or legacy write reclaims — so no caller, a long-lived bridge included, needs to exit before recovery completes, and no claim is left that nobody acts under and nobody can recover. Killed-taker recovery: a lock whose taker is confirmed dead is recovered by the next start, stop or legacy write with a notice naming that taker — bytes it moved aside are discarded when every pid they record is dead, otherwise restored — and that invocation also removes the act markers, <tier>.stage.<pid>.<id> directories and the pid-named entry a taker killed while assembling or releasing its lock (before its owner entry is written, or after it is moved out) left, each with a notice naming the dead pid; a live or unprovable taker's lock is never taken (BUSY, naming it). \"Never taken over\" therefore means: only a claim or lock proven dead is reclaimed, exactly as checked; nothing live or unknown is taken, and no claim, lock or stage directory is ever the operator's to remove by hand. Dead owners recover the same way: a generation whose recorded pid is confirmed dead, or a launch abandoned before it bound its pid or arm epoch (no launch holds the claim and no recorded process is alive), is retired — its owner record removed, nothing signalled — by the next stop (which stands its arm down and reads back DISARMED), by start (which stands it down, then launches and reads back ARMED) or by a legacy write from that seat (whose requested write then proceeds: a one-shot records its beat on that arm, --stand-down stands it down, --new-arm/--loop replace it), each printing the recovery; an owner whose recorded process lives is never retired this way. Every claimed mutation — each owner record rename, log open, spawn, signal and removal, and each record a staged stand-down, arm or beat write changed — is one claimed act: it marks the claim, re-runs its owner-generation check inside the act (a staged write also compares every supervision record with what it was staged from), then verifies the claim LAST, immediately before the mutation. No claim removal lands inside an act, and a claim, owner or arm replaced before that final check lands nothing further: nothing more is written, signalled or removed and the invocation refuses nonzero at its next check, its release included (a launched writer under its launcher's claim has no release: what its acts landed, they landed under the verified claim). Status (beat status <tier> and the legacy <tier> --status) only observes: over a dead claim or a killed taker's or writer's leftovers it changes no file, exits nonzero naming the dead pids and prints the command that recovers them, and it names every live holder (the claim's, and each removal lock's taker) beside the state it reads, `tickmarkr beat stop <tier> --seat <seat>` (the recorded seat, else the one given, quoted as one shell word) — start or a legacy write recovers the same way; status never does. " +
      "Identity: Linux teardown argv ([comm]) and a child dying mid-read stay UNREADABLE until a complete read or confirmed death (\"died before its beat read back\"); on Darwin a missing or unusable lsof refuses UNREADABLE naming lsof, and restoring lsof restores start/status/stop.",
    options: {
      "--seat <identity>": "Required for start, stop and every write: identify the supervising pane or agent; optional for status.",
      "--new-arm": "Create a new durable arm, allowing beats to resume after stand-down; the hand-off step for a seat taking over a stood-down tier (combine with --arm-id and --pct on a context tier).",
      "--loop": "Create a new durable arm and beat in this process every 10 seconds; exit nonzero with its reason within one interval after stand-down, supersession or a refused write.",
      "--arm-id <identity>": "Name a newly created arm; with --pct, identify the context observation arm. Never refuses a tick.",
      "--pct <0..100>": "Report current context consumption percentage.",
      "--threshold-pct <0..100>": "Set the context warning threshold (default 75).",
      "--stand-down": "Record an explicit handoff and stand down this tier. A later one-shot tick on the old arm exits non-zero; context observations still raise and discharge the clear duty. With the recorded seat it is the legacy migration step start prints — it reclaims a claim the stopped writer died holding, never a live one; then start owns the tier.",
      "--status": "Legacy spelling of beat status <tier>: the same read-only result, writing nothing.",
    }, examples: [
      "beat start overseer --seat supervisor", "beat status overseer --seat supervisor", "beat stop overseer --seat supervisor",
      "beat overseer --seat supervisor", "beat overseer --seat supervisor --loop", "beat overseer --seat supervisor --stand-down",
      "beat overseer --seat supervisor --new-arm", "beat overseer --status",
    ],
  },
  version: {
    usage: "version [--dist]", description: "Print the installed package version. Top-level aliases: --version and -v.",
    options: { "--dist": "Also print the resolved build directory and distribution fingerprint." },
    examples: ["version", "version --dist"],
  },
  verify: {
    usage: "verify [--base <ref>] [--criteria <file> | --task <id>] [options]",
    description: "Verify the committed merge-base(base, HEAD)..HEAD diff without a daemon or retries. The verdict and JSON result are written to stdout; progress and diagnostics are written to stderr. Do not merge stdout and stderr (2>&1 corrupts the verdict stream).",
    options: {
      "--base <ref>": "Compare against merge-base(ref, HEAD); default main.",
      "--criteria <file>": "Read acceptance criteria from a file; use this or --task.",
      "--task <id>": "Read acceptance criteria and default file scope from a compiled task.",
      "--files <glob>": "Declare file scope; repeat for multiple globs (overrides task scope).",
      "--author <adapter:model>": "Identify the author channel for independent reviewer selection.",
      "--baseline <path>": "Read an existing baseline JSON file instead of capturing one.",
      "--record <run-id>": "Append verification results to the named run journal.",
      "--json": "Print a machine-readable verdict on stdout.",
      "--no-review": "Disable semantic review; deterministic gates remain mandatory.",
      "--no-acceptance": "Disable semantic acceptance even when criteria are supplied.",
    }, examples: ["verify --base main --task T1 --files 'src/**' --files 'tests/**' --author fake:fake-1 --json", "verify --base main --baseline baseline.json --record run-example --no-review --no-acceptance"],
  },
  eval: {
    usage: "eval [<fixtures-root>]", description: "Discover and validate fixture start/solution directories, seed valid fixtures into temporary git repositories, then clean them up. Defaults to fixtures/eval in the current directory.",
    options: {}, examples: ["eval", "eval ./fixtures", "eval -- --help"],
  },
} satisfies Record<RegisteredCommand, Help>;

export const PROFILE_HELP: Record<string, Help> = {
  reset: {
    usage: "profile reset", description: "Move the learned-history cursor to the latest run. Writes .tickmarkr/profile-since; preserves all telemetry. Help never resets it.",
    options: {}, examples: ["profile reset"],
  },
  discount: {
    usage: "profile discount <run-id> [<task-id>] --weight <0|0.5> --reason <text>", description: "Append an evidence discount to .tickmarkr/profile-discounts. Omitting the task ID discounts the entire run.",
    options: { "--weight <0|0.5>": "Required evidence weight.", "--reason <text>": "Required nonempty reason for the evidence claim." },
    examples: ["profile discount run-example T1 --weight 0.5 --reason 'infra incident'"],
  },
  discounts: {
    usage: "profile discounts", description: "List recorded evidence discounts without modifying them.", options: {}, examples: ["profile discounts"],
  },
};

export function hasHelpFlag(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

export function commandHelp(command: string, argv: readonly string[] = []): string {
  const operation = argv.find((arg) => arg !== "--help" && arg !== "-h");
  const nested = command === "profile" && operation && Object.hasOwn(PROFILE_HELP, operation) ? PROFILE_HELP[operation] : undefined;
  const help = nested ?? (Object.hasOwn(COMMAND_HELP, command) ? COMMAND_HELP[command as RegisteredCommand] : undefined);
  if (!help) return `usage: tickmarkr ${command}\n  --help, -h  Show help without running the command.`;
  return [
    `usage: tickmarkr ${help.usage}`, help.description, "", "Options:",
    ...Object.entries(help.options).map(([flag, description]) => `  ${flag}  ${description}`),
    "  --help, -h  Show help without running the command.",
    "", "Examples:", ...help.examples.map((example) => `  tickmarkr ${example}`),
    "", "Help flags are recognized only before --; arguments after -- are literal data.",
  ].join("\n");
}
