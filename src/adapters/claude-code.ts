import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TickmarkrConfig } from "../config/config.js";
import type { Task } from "../graph/schema.js";
import { parseWorkerResult } from "./prompt.js";
import { type Assignment, type AuthHealth, type BillingChannel, channelsFromConfig, type ContextUsage, type Invocation, type SessionRef, shq, type TokenUsage, TokenUsageSchema, type WorkerAdapter } from "./types.js";

// SPEND-01/SPEND-11: claude writes a per-session JSONL to ~/.claude/projects/<slug>/ where slug is the
// realpath'd cwd with every non-alphanumeric char replaced by "-" (verified 114/114 — 36-DIAGNOSIS.md).
// The old `/`-only formula missed the "." in `.tickmarkr/worktrees/…` — ENOENT on every worktree dispatch.
// Each assistant message carries a per-record ISO `timestamp` and message.usage. We read it POST-HOC
// (never the pane, never the trailer) and sum
// tokens for records whose top-level cwd matches this task's worktree AND whose timestamp is at/after
// `sinceMs` (this attempt's dispatch wall-clock, from the daemon). The cursor makes a per-attempt fold
// correct even though this store ACCUMULATES across attempts under a stable slug — without it, folding
// gives 3A+2B+C (checker blocker). Filter PER RECORD by the record's own timestamp, never file mtime.
// FAIL OPEN everywhere: any missing dir / unreadable file / torn line / no match / unparseable
// timestamp ⇒ undefined ⇒ unmetered. A metering read must NEVER throw — it must never fail a task.
// SPEND-06: we sum ONLY the four token counts. message.usage may also carry a costUSD — a NOTIONAL
// list price (0.74 for a two-token sub reply, LIVE-CHECK finding 3); we never read it. Money is
// Phase 18's operator-price × tokens derivation, not a CLI claim.
const MAX_SESSION_FILES = 20; // newest-first; a long-lived project dir can hold many sessions
const MAX_SESSION_BYTES = 8_000_000; // per-file cap; a runaway JSONL cannot make the read unbounded

export function claudeSlug(real: string): string {
  return real.replace(/[^A-Za-z0-9]/g, "-");
}

export function probeVersion(bin: string): AuthHealth {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10000 });
  if (r.error || r.status !== 0) return { installed: false, authed: false, models: [] };
  return {
    installed: true,
    authed: true,
    version: (r.stdout || r.stderr).trim().split("\n")[0],
    models: [],
    note: "auth assumed; verified at dispatch (failover on auth/quota errors)",
  };
}

export const claudeCode: WorkerAdapter = {
  id: "claude-code",
  vendor: "anthropic",
  probeCwd: "neutral",
  probe: async () => probeVersion("claude"),
  channels: (cfg: TickmarkrConfig): BillingChannel[] => channelsFromConfig("claude-code", cfg),
  // --strict-mcp-config --mcp-config '{"mcpServers":{}}': pin the MCP surface to empty so fresh-worktree
  // workers/gates don't load project .mcp.json servers (herdr scrapes dialogs as idle — v1.4 incident,
  // memory tickmarkr-worker-mcp-dialog-stall). Live-verified 2026-07-10 on claude 2.1.205 (operator check):
  // headless (-p) fully suppressed — exit 0, no dialog. Interactive TUI STILL shows the project
  // MCP-enable dialog (project trust/enablement, not config loading); Esc dismisses it, and tickmarkr's
  // blocked/idle paging surfaces the pane to the operator (same path as cursor's trust dialog).
  // Gotchas (both bit the 2026-07-10 live check): bare '{}' is REJECTED ("mcpServers: expected record"),
  // and --mcp-config is VARIADIC — a positional after it is eaten as a config-file path, so another
  // flag must always follow the value, never the prompt.
  headlessCommand: (promptFile: string, model: string) =>
    `claude -p "$(cat ${shq(promptFile)})" --model ${shq(model)} --permission-mode bypassPermissions --strict-mcp-config --mcp-config '{"mcpServers":{}}' --output-format text`,
  // HYG-03: the residual first-entry dialog on an interactive TUI is the workspace TRUST dialog (not MCP
  // config loading) — CLI-imposed, no flag to pre-accept, only store is claude's global last-writer-wins
  // ~/.claude.json keyed on the exact path. Closed WON'T-FIX (decision B, 2026-07-10): tickmarkr writes nothing
  // to that file (a seed races claude's own writes, nondeterministically). Amortizes to one operator dismissal
  // per stable worktree path; blocked-pane paging surfaces it. Do NOT change this command to "fix" the dialog —
  // see .planning/REQUIREMENTS.md HYG-03 and 21-02-LIVE-CHECK.md. Revisit if upstream ships a --trust flag.
  interactiveCommand: (promptFile: string, model: string) =>
    `claude --model ${shq(model)} --strict-mcp-config --mcp-config '{"mcpServers":{}}' --permission-mode bypassPermissions "$(cat ${shq(promptFile)})"`,
  resumeCommand: (sessionId: string, promptFile: string, model: string) =>
    `claude -r ${shq(sessionId)} --model ${shq(model)} --strict-mcp-config --mcp-config '{"mcpServers":{}}' --permission-mode bypassPermissions "$(cat ${shq(promptFile)})"`,
  invoke(task: Task, _cwd: string, a: Assignment, ctx: { promptFile: string }): Invocation {
    return { command: this.headlessCommand(ctx.promptFile, a.model) };
  },
  parse: parseWorkerResult,
  collectUsage(cwd: string, sinceMs: number): TokenUsage | undefined {
    try {
      const real = realpathSync(cwd); // resolve symlinks (darwin /tmp → /private/tmp)
      const slug = claudeSlug(real);
      const dir = join(homedir(), ".claude", "projects", slug);
      // newest-first by mtime, bounded — mtime picks WHICH files to scan, never a record's cursor.
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          try {
            return { f, m: statSync(join(dir, f)).mtimeMs };
          } catch {
            return undefined; // a stat failure just drops that file
          }
        })
        .filter((x): x is { f: string; m: number } => x !== undefined)
        .sort((a, b) => b.m - a.m)
        .slice(0, MAX_SESSION_FILES);

      let input = 0, output = 0, kept = false;
      let cacheRead: number | undefined, cacheWrite: number | undefined;
      const seen = new Set<string>(); // message.id is globally unique across session files in one call
      for (const { f } of files) {
        let text: string;
        try {
          text = readFileSync(join(dir, f), "utf8").slice(0, MAX_SESSION_BYTES);
        } catch {
          continue; // unreadable file ⇒ skip
        }
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let recRaw: unknown;
          try {
            recRaw = JSON.parse(line); // torn final line / garbage ⇒ dropped
          } catch {
            continue;
          }
          const rec = recRaw as { cwd?: unknown; timestamp?: unknown; message?: { id?: unknown; usage?: unknown } };
          if (rec.cwd !== real) continue;
          const u = rec.message?.usage;
          if (!u || typeof u !== "object") continue;
          const ts = Date.parse(String(rec.timestamp));
          if (!Number.isFinite(ts) || ts < sinceMs) continue; // absent/unparseable/pre-cursor ⇒ skip
          // claude splits one assistant response across N records (one per content block), each
          // repeating the FULL message.usage; dedup after the cursor so a pre-sinceMs id cannot poison seen.
          const id = rec.message?.id;
          if (typeof id === "string") { if (seen.has(id)) continue; seen.add(id); }
          const uu = u as Record<string, unknown>;
          const n = (k: string) => (typeof uu[k] === "number" ? (uu[k] as number) : 0);
          input += n("input_tokens");
          output += n("output_tokens");
          if ("cache_read_input_tokens" in uu) cacheRead = (cacheRead ?? 0) + n("cache_read_input_tokens");
          if ("cache_creation_input_tokens" in uu) cacheWrite = (cacheWrite ?? 0) + n("cache_creation_input_tokens");
          kept = true;
        }
      }
      if (!kept) return undefined; // nothing matched ⇒ unmetered, never {input:0,…}
      const out: TokenUsage = { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
      const p = TokenUsageSchema.safeParse(out);
      return p.success ? p.data : undefined;
    } catch {
      return undefined; // missing dir / any throw ⇒ fail open
    }
  },
  // v1.23 T1: last-turn context fill from ~/.claude/projects/<slug>/<sessionId>.jsonl ONLY.
  // tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens of the LAST
  // assistant usage record (not a sum over turns — ctx-watch.sh class; overseer wake signal).
  // Disk read only: no claude spawn, no pane, no network. null = unknown.
  contextUsage(session: SessionRef): ContextUsage | null {
    try {
      const real = realpathSync(session.cwd);
      const slug = claudeSlug(real);
      // session id is a filename stem (herdr agent_session.value); refuse path traversal.
      const sid = session.id.replace(/\.jsonl$/i, "");
      if (!sid || sid.includes("/") || sid.includes("\\") || sid.includes("..")) return null;
      const file = join(homedir(), ".claude", "projects", slug, `${sid}.jsonl`);
      let text: string;
      try {
        text = readFileSync(file, "utf8").slice(0, MAX_SESSION_BYTES);
      } catch {
        return null;
      }
      let last: number | undefined;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let recRaw: unknown;
        try {
          recRaw = JSON.parse(line);
        } catch {
          continue;
        }
        const rec = recRaw as { message?: { usage?: unknown } };
        const u = rec.message?.usage;
        if (!u || typeof u !== "object") continue;
        const uu = u as Record<string, unknown>;
        const n = (k: string) => (typeof uu[k] === "number" ? (uu[k] as number) : 0);
        // last turn wins — overwrite, never accumulate (the sum-over-turns bug this API exists to avoid)
        last = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
      }
      if (last === undefined) return null;
      return { tokens: last };
    } catch {
      return null;
    }
  },
};
