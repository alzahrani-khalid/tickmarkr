#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { approve } from "./commands/approve.js";
import { beat } from "./commands/beat.js";
import { compile } from "./commands/compile.js";
import { doctor } from "./commands/doctor.js";
import { evalCommand } from "./commands/eval.js";
import { fleet } from "./commands/fleet.js";
import { init } from "./commands/init.js";
import { plan } from "./commands/plan.js";
import { profile } from "./commands/profile.js";
import { report } from "./commands/report.js";
import { resume } from "./commands/resume.js";
import { run } from "./commands/run.js";
import { scope } from "./commands/scope.js";
import { stats } from "./commands/stats.js";
import { status } from "./commands/status.js";
import { ui } from "./commands/ui.js";
import { unlock } from "./commands/unlock.js";
import { verify } from "./commands/verify.js";
import { version } from "./commands/version.js";
import { commandHelp, hasHelpFlag } from "./help.js";

export type CommandResult = string | { out: string; code: number };
export type CommandMap = Record<string, (argv: string[]) => Promise<CommandResult>>;

const normalize = (r: CommandResult): { out: string; code: number } =>
  typeof r === "string" ? { out: r, code: 0 } : r;

export const COMMANDS = {
  init, doctor, fleet, compile, scope, plan, run, status, stats, resume, report, profile, ui, unlock, approve, beat, version, verify, eval: evalCommand,
} satisfies CommandMap;
export type RegisteredCommand = keyof typeof COMMANDS;

const VERSION_FLAGS = new Set(["version", "--version", "-v"]);

const HELP_CMDS = new Set(["help", "-h", "--help"]);

import { BANNER } from "../brand.js";

export const USAGE = `tickmarkr — spec-driven orchestration harness for AI coding agents
usage: tickmarkr <command>
  init          guided setup + doctor; init --agent [--force] [--docs] adds agent skills/docs
  doctor        re-probe adapters, herdr, auth; print capability matrix (--fix writes the test-runner ignore when a safe edit exists)
  fleet         interactive fleet editor (fleet --print for CI drift checks)
  compile <src> spec → .tickmarkr/graph.json (fails without acceptance criteria)
  scope <intent> preview locally with --preview; draft after confirmation or --yes (--force to overwrite)
  plan          dry-run routing table + cost estimate + floor lints
  eval          discover and validate fixtures, seed isolated temp repos, then clean them up
  run           execute the graph (--concurrency N --driver auto|herdr|subprocess|orca --route-strict; orca runs only when named)
  status        live run state (--watch --events: JSON documents on stdout, keepalives on stderr; 2>&1 corrupts the stream)
  stats         all-run channel delivery, red, rescue, author and reviewer statistics
  verify        run the gate battery standalone against merge-base(--base, HEAD)..HEAD — verdict/JSON on stdout, progress on stderr; 2>&1 corrupts the verdict stream (--base main --criteria <file> | --task <id> [--files <glob>] [--author adapter:model] [--no-review] [--json])
  resume <id>   continue a run from its journal
  report <id>   cost/quality report (--md writes Markdown to stdout; redirect to save a record)
  profile       show learned routing profile (profile reset = forget history via cursor, keeps telemetry)
  ui            open Home, Run or Evidence (--view home|run|evidence; --setup <id> opens Run Parks)
  unlock        remove a stale/garbage run lock (refuses if the holder is alive)
  beat <tier>   record one supervision beat for orchestrator|orchestrator-context|overseer|overseer-context|watch, --seat <identity> required (--stand-down to hand off); a supervising seat's own watcher loop calls it, and status reads the tier STALE once the beats stop
  approve <id> <task>  release a park (--uphold sides with the reviewer and funds a fixed attempt; --by <name> --reason <text>); takes effect on resume
  version       print the installed version (--dist adds build location and fingerprint)

Use tickmarkr <command> --help (or -h) for all options and examples.
Use tickmarkr profile <operation> --help for nested profile help.`;

// pure, testable dispatcher: resolves a command, forwards argv, shapes the result — no side effects.
// unknown/missing cmd → USAGE (exit 1 if a cmd was typed, 0 for bare `tickmarkr`); a handler throw becomes
// a one-line `tickmarkr <cmd>: <message>` (never a raw stack) at exit 1.
export async function dispatch(
  cmd: string | undefined,
  argv: string[],
  commands: CommandMap = COMMANDS,
): Promise<{ out: string; code: number }> {
  const usage = process.stdout.isTTY ? BANNER + USAGE : USAGE;
  if (!cmd || HELP_CMDS.has(cmd)) return { out: usage, code: 0 };
  if (VERSION_FLAGS.has(cmd)) cmd = "version";
  const fn = Object.hasOwn(commands, cmd) ? commands[cmd] : undefined;
  if (!fn) return { out: usage, code: 1 };
  if (hasHelpFlag(argv)) return { out: commandHelp(cmd, argv), code: 0 };
  try {
    // These two legacy handlers scan the entire argv for help before parsing. Preserve their
    // direct-call API, but never let a literal positional turn back into help at the CLI boundary.
    // verify accepts no positionals; status accepts a run ID, which cannot start with a dash.
    const separator = argv.indexOf("--");
    const literalHelp = separator < 0 ? undefined : argv.slice(separator + 1).find((arg) => arg === "--help" || arg === "-h");
    if (literalHelp && (fn === verify || fn === status)) {
      throw new Error(`literal argument ${JSON.stringify(literalHelp)} after -- ${fn === verify ? "is not accepted: verify takes no positional arguments" : "is not a valid run ID"}`);
    }
    return normalize(await fn(argv));
  } catch (err) {
    return { out: `tickmarkr ${cmd}: ${(err as Error).message}`, code: 1 };
  }
}

/* v8 ignore start -- binary entry: printing + process.exit side effects, not unit-testable (ROADMAP crit 2) */
// node realpaths the main module (import.meta.url) but argv[1] keeps the symlink path —
// a globally-linked `tickmarkr` bin silently no-oped here (OBS-10); compare realpaths
const argv1Real = (() => { try { return process.argv[1] ? realpathSync(process.argv[1]) : ""; } catch { return ""; } })();
if (argv1Real && import.meta.url === pathToFileURL(argv1Real).href) {
  const [cmd, ...argv] = process.argv.slice(2);
  dispatch(cmd, argv).then(({ out, code }) => {
    // byte-identical streams: usage + success → stdout; a handler throw → stderr (original behavior)
    (code === 1 && !out.endsWith(USAGE) ? console.error : console.log)(out);
    if (code !== 0) process.exit(code);
  });
}
/* v8 ignore stop */
