import { ARTIFICIAL_ANALYSIS_KEY_NAME } from "../adapters/catalog-remote.js";
import { shq } from "../adapters/types.js";

// Queue row 367 (its child-environment clause); D-2187 add.21 (2), cross-read M9. The Artificial Analysis key belongs
// to the parent: its lookup and in-process catalog fetch read it, and no AGENT child ever receives it — a worker (the
// subprocess seal and the pane shell prefix), a judge, review or consult seat (an agent or seat shell), doctor's model
// probes and the Kimi doctor turn. Payload shells (build, test, lint, oracles) run the user's own project, so outside a
// run they keep the user's environment untouched; inside one the daemon has already dropped the key (row 407, below).
// A separate rule from host-env.ts (row 390), so neither list restates the other.
export const AGENT_WITHHELD_VARS = [ARTIFICIAL_ANALYSIS_KEY_NAME] as const;

/**
 * Queue row 407; D-2187 add.35, which revises add.21 (2)'s payload bound inside a run. runDaemon calls this as its first
 * statement, before it spawns anything, so no child of a run or resume (payload shells included) inherits the key from
 * tickmarkr. It deletes this one variable from the daemon's own environment whatever its value, adds nothing, and never
 * reads or keeps the value: no function the run or resume path calls reads the key (its only reader is the catalog
 * refresh doctor and fleet run), so the daemon needs no copy of it.
 */
export function stripArtificialAnalysisKeyFromDaemon(): void {
  delete process.env[ARTIFICIAL_ANALYSIS_KEY_NAME];
}

// The copies agentEnv() made: a shell handed one is an agent child even without the agent or seat option (doctor's
// model probes and the Kimi turn), so it also gets agentShellCommand. Weak, so a finished child's copy is collectable.
const agentEnvs = new WeakSet<NodeJS.ProcessEnv>();

/** A copy of `env` without the variables no agent child receives; the input (the daemon's process.env) is never mutated. */
export function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of AGENT_WITHHELD_VARS) delete out[k];
  agentEnvs.add(out);
  return out;
}

/** Whether `env` is a copy agentEnv() made — the shell that runs it launches an agent. */
export const isAgentEnv = (env: NodeJS.ProcessEnv | undefined): boolean => env !== undefined && agentEnvs.has(env);

// Proof that a child of this shell starts without the key: the env program lists the environment a child receives, and
// grep must count 0 of it. An env or grep that cannot run never counts 0, so the proof fails closed. The value crosses
// only that pipe, never an expansion, so a startup file's xtrace cannot print it.
const CLEAN = `[ "$( { command env || echo ${AGENT_WITHHELD_VARS[0]}=; } 2>/dev/null | command grep -c ` +
  `${AGENT_WITHHELD_VARS.map((k) => `-e ${shq(`^${k}=`)}`).join(" ")} 2>/dev/null )" = 0 ]`;
const refuse = (why: string): string =>
  `{ printf '%s\\n' ${shq(`tickmarkr: ${why}, so the agent does not start (queue row 367)`)} >&2; exit 126; }`;

/**
 * The prefix every agent shell runs before its agent command, after all its startup files (~/.bash_profile,
 * ~/.bash_login or ~/.profile, then $BASH_ENV), any of which may export the key, readonly or not (D-2187 add.21 (2)).
 * It runs in the agent's own shell, so every function, alias, option and variable a startup file defined still resolves
 * exactly as at the base. `typeset +x` stops exporting the key even when it is readonly (bash 3.2 and 5, zsh), and the
 * `unset` then drops a key that is not readonly (a subshell tries first: zsh exits on a readonly unset). The agent starts
 * only once env proves the key absent; otherwise the shell exits 126 — in a pane's own shell (a typed seed) too, so
 * nothing typed later starts. No variable but the key is touched: BASH_ENV itself is never stripped.
 * ponytail: a key a user startup file sets itself ($BASH_ENV, ~/.bash_profile, ~/.profile, ~/.zshenv, ~/.zprofile) in a
 * shell the agent starts later (a dispatch script, a `#!/bin/bash` CLI shim, the agent's own tool shells) comes from the
 * user's own configuration and is not defeated or probed (T9 outOfScope, D-2187 add.45): an agent with any BASH_ENV
 * starts exactly as at the base.
 */
export const agentEnvShellPrefix = (): string =>
  AGENT_WITHHELD_VARS.map((k) => `typeset +x ${k} 2>/dev/null || :; ( unset ${k} ) 2>/dev/null && unset ${k}; `).join("") +
  `${CLEAN} || ${refuse("the Artificial Analysis key is still in the agent's environment")}; `;

/** An agent's command as its login shell runs it: the prefix above, then the command, verbatim. */
export const agentShellCommand = (cmd: string): string => `${agentEnvShellPrefix()}${cmd}`;
