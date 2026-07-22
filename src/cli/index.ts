#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { approve } from "./commands/approve.js";
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
import { status } from "./commands/status.js";
import { ui } from "./commands/ui.js";
import { unlock } from "./commands/unlock.js";
import { version } from "./commands/version.js";

export type CommandResult = string | { out: string; code: number };
export type CommandMap = Record<string, (argv: string[]) => Promise<CommandResult>>;

const normalize = (r: CommandResult): { out: string; code: number } =>
  typeof r === "string" ? { out: r, code: 0 } : r;

export const COMMANDS: CommandMap = {
  init, doctor, fleet, compile, scope, plan, run, status, resume, report, profile, ui, unlock, approve, version, eval: evalCommand,
};

const VERSION_FLAGS = new Set(["version", "--version", "-v"]);

const HELP_CMDS = new Set(["help", "-h", "--help"]);

import { BANNER } from "../brand.js";

export const USAGE = `tickmarkr — spec-driven orchestration harness for AI coding agents
usage: tickmarkr <command>
  init          guided setup + doctor; init --agent [--force] [--docs] adds agent skills/docs
  doctor        re-probe adapters, herdr, auth; print capability matrix
  fleet         interactive fleet editor (fleet --print for CI drift checks)
  compile <src> spec → .tickmarkr/graph.json (fails without acceptance criteria)
  scope <intent> draft a compiled native spec beside an answered intent (--force to overwrite)
  plan          dry-run routing table + cost estimate + floor lints
  eval          run checked-in fixtures against every channel in isolated temp repos
  run           execute the graph (--concurrency N --driver herdr|subprocess --route-strict)
  status        live run state
  resume <id>   continue a run from its journal
  report <id>   cost/quality report (--md for committable execution record)
  profile       show learned routing profile (profile reset = forget history via cursor, keeps telemetry)
  ui            open the Fleet Studio TUI (full-screen tabbed cockpit)
  unlock        remove a stale/garbage run lock (refuses if the holder is alive)
  approve <id> <task>  approve a parked human gate (--by <name> --reason <text>); takes effect on resume`;

// pure, testable dispatcher: resolves a command, forwards argv, shapes the result — no side effects.
// unknown/missing cmd → USAGE (exit 1 if a cmd was typed, 0 for bare `tickmarkr`); a handler throw becomes
// a one-line `tickmarkr <cmd>: <message>` (never a raw stack) at exit 1.
export async function dispatch(
  cmd: string | undefined,
  argv: string[],
  commands: CommandMap = COMMANDS,
): Promise<{ out: string; code: number }> {
  if (cmd && VERSION_FLAGS.has(cmd)) return { out: await version(argv), code: 0 };
  const usage = process.stdout.isTTY ? BANNER + USAGE : USAGE;
  if (!cmd || HELP_CMDS.has(cmd)) return { out: usage, code: 0 };
  const fn = commands[cmd];
  if (!fn) return { out: usage, code: 1 };
  try {
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
