import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TickmarkrConfig } from "../config/config.js";
import type { Task } from "../graph/schema.js";
import { probeVersion } from "./claude-code.js";
import { parseWorkerResult } from "./prompt.js";
import { type Assignment, type BillingChannel, channelsFromConfig, type Invocation, MODEL_ID_RE, shq, type TokenUsage, TokenUsageSchema, type WorkerAdapter } from "./types.js";

// v1.5 MODEL-01: pure parser for `opencode models` (one provider/model id per line, no header).
// Live-verified 2026-07-10, opencode 1.17.15. Lines are already the seed id format; drop blanks.
export function parseOpencodeModels(raw: string): string[] {
  return raw.trim().split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((id) => MODEL_ID_RE.test(id));
}

export const opencode: WorkerAdapter = {
  id: "opencode",
  vendor: "mixed",
  probeCwd: "neutral",
  probe: async () => probeVersion("opencode"),
  channels: (cfg: TickmarkrConfig): BillingChannel[] => channelsFromConfig("opencode", cfg),
  // v1.65 T3: every flag the command builders below hardcode (-m on run, --prompt on the TUI) —
  // per the 2026-07-10 live verification, opencode 1.17.15.
  hardcodedFlags: { binary: "opencode", flags: ["-m", "--prompt"] },
  headlessCommand: (promptFile: string, model: string) =>
    `opencode run -m ${shq(model)} "$(cat ${shq(promptFile)})"`,
  interactiveCommand: (promptFile: string, model: string) =>
    `opencode -m ${shq(model)} --prompt "$(cat ${shq(promptFile)})"`,
  invoke(task: Task, _cwd: string, a: Assignment, ctx: { promptFile: string }): Invocation {
    return { command: this.headlessCommand(ctx.promptFile, a.model) };
  },
  parse: parseWorkerResult,
  // v1.5 MODEL-01: fail OPEN to [] (advisory detection, unlike gates). Plain `models` (NOT --refresh):
  // opencode reads its own cache offline; --refresh adds an avoidable network dependency (RESEARCH
  // anti-pattern). Live-verified 2026-07-10, opencode 1.17.15.
  listModels: async () => {
    const r = spawnSync("opencode", ["models"], { encoding: "utf8", timeout: 15000 });
    return r.error || r.status !== 0 ? [] : parseOpencodeModels(r.stdout || "");
  },
  // SPEND-09: opencode 1.x writes per-message token deltas to SQLite opencode.db (NOT the dead 0.7.x
  // storage/message/*.json legacy — those files carry zero'd tokens forever). We read POST-HOC via
  // spawnSync sqlite3 -json, sum message-row tokens whose path.cwd matches this worktree AND whose
  // time.created (epoch-ms NUMBER) is at/after sinceMs. NEVER read session.tokens_* (session-cumulative
  // 3A+2B+C trap) and NEVER read rec.cost (opencode reports cost:0 on sub plans; money is the existing
  // v1.7 sub-channel subscription bucket). NEVER populate tokens.reasoning — it is ⊂ output and
  // report total() cross-sums reasoning, so setting it double-counts. FAIL OPEN everywhere.
  collectUsage(cwd: string, sinceMs: number): TokenUsage | undefined {
    try {
      const real = realpathSync(cwd);
      const dbPath = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db");
      const r = spawnSync("sqlite3", ["-json", dbPath, "SELECT data FROM message WHERE time_created >= " + Math.floor(sinceMs)], { encoding: "utf8", timeout: 10000 });
      if (r.error || r.status !== 0) return undefined;
      const raw = (r.stdout || "").trim();
      if (!raw) return undefined;
      let rows: unknown;
      try {
        rows = JSON.parse(raw);
      } catch {
        return undefined;
      }
      if (!Array.isArray(rows)) return undefined;

      let input = 0, output = 0, kept = false;
      let cacheRead: number | undefined, cacheWrite: number | undefined;
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const dataStr = (row as { data?: unknown }).data;
        if (typeof dataStr !== "string") continue;
        let recRaw: unknown;
        try {
          recRaw = JSON.parse(dataStr);
        } catch {
          continue;
        }
        const rec = recRaw as { path?: { cwd?: unknown }; time?: { created?: unknown }; tokens?: unknown };
        if (rec.path?.cwd !== real) continue;
        const created = rec.time?.created;
        if (typeof created !== "number" || !Number.isFinite(created) || created < sinceMs) continue;
        const t = rec.tokens;
        if (!t || typeof t !== "object") continue;
        const tt = t as Record<string, unknown>;
        const n = (k: string) => (typeof tt[k] === "number" ? (tt[k] as number) : 0);
        input += n("input");
        output += n("output");
        const cache = tt.cache;
        if (cache && typeof cache === "object") {
          const cc = cache as Record<string, unknown>;
          if ("read" in cc) cacheRead = (cacheRead ?? 0) + (typeof cc.read === "number" ? cc.read : 0);
          if ("write" in cc) cacheWrite = (cacheWrite ?? 0) + (typeof cc.write === "number" ? cc.write : 0);
        }
        kept = true;
      }
      if (!kept) return undefined;
      const out: TokenUsage = { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
      const p = TokenUsageSchema.safeParse(out);
      return p.success ? p.data : undefined;
    } catch {
      return undefined;
    }
  },
};
