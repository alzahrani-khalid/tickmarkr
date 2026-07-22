import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TickmarkrConfig } from "../config/config.js";
import type { Task } from "../graph/schema.js";
import { probeVersion } from "./claude-code.js";
import { parseWorkerResult } from "./prompt.js";
import { type Assignment, type BillingChannel, channelsFromConfig, type Invocation, MODEL_ID_RE, shq, type WorkerAdapter } from "./types.js";

// GROK-03: collectUsage is DELIBERATELY ABSENT — documented won't-implement, consistent with the
// metering-honesty invariant (adapters/types.ts:65-67: "harness-emitted structured usage ONLY, read
// POST-HOC from the CLI's own cwd-keyed store"). Five-way diagnosis (all [LIVE-RES] 2026-07-11,
// grok 0.2.93, evidence in .planning/phases/40-native-grok-adapter/40-RESEARCH.md F-4):
// (1) Session store ~/.grok/sessions/<percent-encoded-realpath>/<uuid>/ (chat_history.jsonl,
//     events.jsonl, summary.json, …) — zero matches for input_tokens|output_tokens|total_tokens|
//     "usage"|"cost" across every file, re-verified on a fresh session.
// (2) No `grok usage` subcommand (full subcommand list captured: agent, completions, dashboard,
//     export, help, import, inspect, leader, login, logout, mcp, memory, models, plugin, sessions,
//     setup, trace, update, version, worktree, wrap).
// (3) No newer CLI — `grok update --check --json` → {"updateAvailable":false,…}.
// (4) `grok trace <id> --local` export and ~/.grok/logs/unified.jsonl (1,447 lines) — zero counters.
// (5) --debug-file traces DO carry real per-turn input_tokens=… output_tokens=… cache_read_tokens=…
//     — a REAL source, REJECTED for stated reasons:
//     (a) it exists ONLY because tickmarkr would inject --debug-file into every dispatch — a side-channel
//         tickmarkr creates, not a record the CLI keeps (same class as cursor's rejected --print --trust
//         stdout tee, cursor-agent.ts:25-28);
//     (b) DECISIVE: at DEBUG level the log verbatim-dumps the full OIDC bearer JWT and every MCP server
//         env secret — an actual plaintext SUPABASE_ACCESS_TOKEN was observed — tickmarkr forcing a
//         per-attempt secret-spilling file onto disk to meter a sub channel fails its own security
//         posture;
//     (c) it is tracing diagnostics text with no format contract (xAI can reshape it in any patch).
// Consequence: grok channels report honestly `unmetered` — daemon.ts's optional-chaining on the
// absent method and report.ts's "unmetered (adapter reports no usage)" line render it by construction
// with ZERO changes to daemon/journal/report (they already handle absence; SPEND-11 proved a silent
// zero is worse than an honest nothing). Revisit if grok ships a usage block in the
// `-p --output-format json` envelope or a counter in the session store — re-probe is one
// `grok -p` + one grep away. This comment is the defense against a future maintainer "helpfully"
// wiring up the secret-spilling trace path and writing the operator's credentials to disk.

// ponytail: grok loads the operator's global Claude-Code-compat config — a 165-char prompt measured
// input_tokens=82874 (orchestrator research, 2026-07-11); no --strict-mcp-config analog in 0.2.93.
// 40-02 checks grok --help / ~/.grok/config.toml for a documented compat toggle; re-MEASUREMENT is
// deferred to an operator-run step (the only token counter is the rejected DEBUG trace — see above).

// GROK-01. Auth verdict from ~/.grok/auth.json ONLY. NEVER consult `grok models`: its banner is
// live-proven WRONG in both directions ("You are not authenticated." while authed 2026-07-11 AM
// [40-CONTEXT D-03]; "You are logged in with grok.com." hours later same token [40-RESEARCH F-1];
// suspected leader-process staleness via ~/.grok/leader.sock). An entry is authed iff it has a
// non-empty refresh_token OR an unexpired expires_at — refresh_token alone suffices because the CLI
// auto-refreshes an expired access key (observed in the DEBUG trace: authenticate method=cached_token
// → set api_key). Gating on expires_at alone reintroduces the false-negative class GROK-01 exists to
// kill. Missing/unreadable/empty file ⇒ authed:false (truthful — `grok logout` clears the file).
// Nested shape { "<issuer>::<client_id>": { refresh_token?, expires_at?, … } } [40-RESEARCH F-2].
export function grokAuthed(authJsonText: string, nowMs: number): boolean {
  try {
    const j = JSON.parse(authJsonText) as Record<string, unknown>;
    return Object.values(j).some((e) => {
      if (!e || typeof e !== "object") return false;
      const { refresh_token, expires_at } = e as { refresh_token?: unknown; expires_at?: unknown };
      // refresh_token presence DOMINATES an expired expires_at — the CLI auto-refreshes (GROK-01 trap).
      if (typeof refresh_token === "string" && refresh_token.length > 0) return true;
      const exp = Date.parse(String(expires_at));
      return Number.isFinite(exp) && exp > nowMs;
    });
  } catch {
    return false; // missing/unreadable/empty/garbage ⇒ truthfully unauthed (HYG-05 polarity)
  }
}

// GROK-04 listModels parse (MODEL-05 WR-02): anchor by CONTENT on the exact "Available models:" header
// — banner lines above it (whatever they claim about auth) never reach the parser BY CONSTRUCTION
// (40-RESEARCH F-1 verbatim fixture). Strip a leading "* "/"- " prefix and a trailing " (default)"
// suffix; drop empties; filter through MODEL_ID_RE. No header ⇒ [] (fail-open — listing is advisory).
export function parseGrokModels(raw: string): string[] {
  const lines = raw.split("\n");
  const headerIdx = lines.findIndex((l) => l.trim() === "Available models:");
  if (headerIdx === -1) return [];
  return lines.slice(headerIdx + 1)
    .map((l) => l.trim().replace(/^[*-]\s+/, "").replace(/\s+\(default\)$/, ""))
    .filter((id) => id.length > 0 && MODEL_ID_RE.test(id));
}

export const grok: WorkerAdapter = {
  id: "grok",
  // FLEET-04 cross-vendor honesty: xai is diversity-distinct from anthropic/openai/cursor/zhipu.
  // MUST equal tiers.grok.vendor (a test pins the equality).
  vendor: "xai",
  probeCwd: "neutral",
  probe: async () => {
    const h = probeVersion("grok");
    if (!h.installed) return h;
    let authed = false;
    try {
      authed = grokAuthed(readFileSync(join(homedir(), ".grok", "auth.json"), "utf8"), Date.now());
    } catch { /* missing/unreadable ⇒ truthfully unauthed */ }
    return authed
      ? { ...h, note: "auth verified via ~/.grok/auth.json (free, no network; `grok models` banner is state-flappy — never parsed for auth)" }
      : { ...h, authed: false, note: "no valid ~/.grok/auth.json entry (grok login to fix)" };
  },
  channels: (cfg: TickmarkrConfig): BillingChannel[] => channelsFromConfig("grok", cfg),
  // v1.65 T3: every flag the command builders below hardcode — verified in `grok --help` 2026-07-22.
  hardcodedFlags: { binary: "grok", flags: ["-p", "--model", "--permission-mode", "--output-format"] },
  // GROK-02 headless. --output-format plain is the default but pin it explicitly; live-verified
  // 2026-07-11 (40-RESEARCH F-3): trailer intact + unwrapped, exit 0. "$(cat file)" matches every
  // other adapter and is already quoting-proven. --permission-mode bypassPermissions is the
  // autonomous-worker analog of claude's --dangerously-skip-permissions. NEVER pass grok's
  // -w/--worktree flag — grok manages its OWN worktrees; a nested worktree inside tickmarkr's worktree
  // is scope-gate chaos (src/run/git.ts owns worktrees).
  headlessCommand: (promptFile: string, model: string) =>
    `grok -p "$(cat ${shq(promptFile)})" --model ${shq(model)} --permission-mode bypassPermissions --output-format plain`,
  // GROK-02 interactive. Positional prompt seeds the TUI (40-CONTEXT D-01). Same permission flag;
  // NEVER the -w/--worktree flag (see headless comment above — tickmarkr owns worktrees).
  interactiveCommand: (promptFile: string, model: string) =>
    `grok --model ${shq(model)} --permission-mode bypassPermissions "$(cat ${shq(promptFile)})"`,
  invoke(task: Task, _cwd: string, a: Assignment, ctx: { promptFile: string }): Invocation {
    return { command: this.headlessCommand(ctx.promptFile, a.model) };
  },
  parse: parseWorkerResult, // prompt.ts — last-valid-trailer, hard-wrap tolerant. No grok fork.
  // v1.5 MODEL-01: fail OPEN to [] (advisory detection, unlike gates). Parses the model LIST only —
  // the auth banner on line 1 is ignored BY CONSTRUCTION (parseGrokModels anchors on the header).
  // Advisory/doctor-only — never in the dispatch or auth path (types.ts:56-60).
  // Live-verified 2026-07-11 format, grok 0.2.93, 40-RESEARCH F-1.
  listModels: async () => {
    const r = spawnSync("grok", ["models"], { encoding: "utf8", timeout: 15000 });
    return r.error || r.status !== 0 ? [] : parseGrokModels(r.stdout || "");
  },
};
