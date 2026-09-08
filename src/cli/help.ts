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
    }, examples: ["init --yes", "init --agent --force --docs"],
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
      "--by <name>": "Name the actor (default: current OS user).",
      "--reason <text>": "Record the decision reason.",
      "--waive": "Waive only the identified failed gate.",
      "--uphold": "Uphold a review failure and fund a fixed attempt.",
      "--recheck": "Request rechecking an infra or failed-gate park; satisfies no gate.",
      "--review-rounds <N>": "Set a positive integer review-round ceiling with the decision.",
    }, examples: ["approve run-example T1 --by operator --reason 'ready to proceed'", "approve run-example T1 --recheck --reason 'infra recovered'"],
  },
  beat: {
    usage: "beat <orchestrator|orchestrator-context|overseer|overseer-context|watch> --seat <identity> [options]",
    description: "Write one supervision beat. The supervising seat's watcher loop repeats it; stopped beats become STALE.",
    options: {
      "--seat <identity>": "Required: identify the supervising pane or agent.",
      "--arm-id <identity>": "Identify this supervision arm.",
      "--pct <0..100>": "Report current context consumption percentage.",
      "--threshold-pct <0..100>": "Set the context warning threshold (default 75).",
      "--stand-down": "Record an explicit handoff and stand down this tier.",
    }, examples: ["beat overseer --seat supervisor", "beat overseer --seat supervisor --stand-down"],
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
