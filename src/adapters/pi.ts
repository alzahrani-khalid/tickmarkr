import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TickmarkrConfig } from "../config/config.js";
import type { Task } from "../graph/schema.js";
import { probeVersion } from "./claude-code.js";
import { parseWorkerResult } from "./prompt.js";
import { type Assignment, type BillingChannel, channelsFromConfig, type ContextUsage, type Invocation, MODEL_ID_RE, type SessionRef, shq, type TokenUsage, TokenUsageSchema, type WorkerAdapter } from "./types.js";

// SPEND-10: pi writes per-session JSONL to ~/.pi/agent/sessions/<slug>/ where slug is EMPIRICAL
// (reverse-engineered: "-" + realpath'd cwd with every "/" replaced by "-" + "--", 29-RESEARCH.md Pitfall 7).
// Session header (type:"session", version:3) carries cwd; assistant messages carry message.usage with
// per-record ISO `timestamp`. Read POST-HOC; cursor is per-record timestamp (never file mtime).
// Header cwd === realpath(cwd) guard makes slug-formula drift fail SAFE (unmetered, never mis-metered).
// FAIL OPEN everywhere: missing dir / unreadable file / torn line / no match ⇒ undefined.
// SPEND-10: sum ONLY input/output/cacheRead/cacheWrite. usage.reasoning ⊂ usage.output — omit it
// (report total() cross-sums reasoning; populating it double-counts). NEVER read usage.cost.
const MAX_SESSION_FILES = 20;
const MAX_SESSION_BYTES = 8_000_000;

// v1.5 MODEL-01: pure parser for `pi --list-models` (table: header row + provider/model/... columns).
// Live-verified 2026-07-10, pi 0.80.3. Columns 0-1 join to the seed id format.
// MODEL-05 WR-02: anchor on the header by CONTENT, not position — pi emits non-blocking update banners
// that can precede the table (see banner note below), so slice(1) would drop a banner and parse the real
// header row as a bogus provider/model id. Find the "provider model ..." header and parse rows after it;
// fail-open to [] if no header is found.
export function parsePiModels(raw: string): string[] {
  const lines = raw.trim().split("\n");
  const headerIdx = lines.findIndex((l) => /^provider\s+model\b/.test(l.trim()));
  if (headerIdx === -1) return [];
  return lines.slice(headerIdx + 1)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 2)
    .map(([provider, model]) => `${provider}/${model}`)
    .filter((id) => MODEL_ID_RE.test(id));
}

export const pi: WorkerAdapter = {
  id: "pi",
  // FLEET-04: cross-vendor review honesty — GLM's provider (pi's own label is "zai"; either is
  // diversity-distinct from anthropic/openai/cursor/mixed). Must equal tiers.pi.vendor.
  vendor: "zhipu",
  probeCwd: "neutral",
  probe: async () => {
    const h = probeVersion("pi");
    if (!h.installed) return h;
    const r = spawnSync("pi", ["--list-models"], { encoding: "utf8", timeout: 15000 });
    if (r.error || r.status !== 0) return h;
    return { ...h, servable: parsePiModels(r.stdout || ""), note: "auth verified via pi --list-models (free; auth-filtered by pi)" };
  },
  channels: (cfg: TickmarkrConfig): BillingChannel[] => channelsFromConfig("pi", cfg),
  // v1.65 T3: every flag the command builders below hardcode — verified in `pi --help` 2026-07-22.
  hardcodedFlags: { binary: "pi", flags: ["-p", "--approve", "--model"] },
  // --approve: pi's per-directory trust prompt would stall fresh worktrees (herdr scrapes the dialog
  // as idle — cursor/claude incident class, milestone PITFALLS #2). Global option, legal in BOTH modes
  // per pi --help v0.80.3 (2026-07-10) — NOT print-only like cursor's --trust. Chosen over the more
  // hermetic --no-approve so repo-local pi config behaves normally (research Pitfall 5 decision).
  // Live-checked 2026-07-10, pi 0.80.3 — headless trailer intact, interactive --approve accepted,
  // no trust prompt; non-blocking update banners render in output (trailer parse tolerates chrome).
  headlessCommand: (promptFile: string, model: string) =>
    `pi -p --approve --model ${shq(model)} "$(cat ${shq(promptFile)})"`,
  interactiveCommand: (promptFile: string, model: string) =>
    `pi --approve --model ${shq(model)} "$(cat ${shq(promptFile)})"`,
  invoke(task: Task, _cwd: string, a: Assignment, ctx: { promptFile: string }): Invocation {
    return { command: this.headlessCommand(ctx.promptFile, a.model) };
  },
  parse: parseWorkerResult,
  // v1.5 MODEL-01: fail OPEN to [] (detection is advisory — unlike gates' fail-closed posture).
  // spawnSync mirrors probeVersion; 15s timeout. Live-verified 2026-07-10, pi 0.80.3.
  listModels: async () => {
    const r = spawnSync("pi", ["--list-models"], { encoding: "utf8", timeout: 15000 });
    return r.error || r.status !== 0 ? [] : parsePiModels(r.stdout || "");
  },
  collectUsage(cwd: string, sinceMs: number): TokenUsage | undefined {
    try {
      const real = realpathSync(cwd);
      const slug = "-" + real.replaceAll("/", "-") + "--";
      const dir = join(homedir(), ".pi", "agent", "sessions", slug);
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          try {
            return { f, m: statSync(join(dir, f)).mtimeMs };
          } catch {
            return undefined;
          }
        })
        .filter((x): x is { f: string; m: number } => x !== undefined)
        .sort((a, b) => b.m - a.m)
        .slice(0, MAX_SESSION_FILES);

      let input = 0, output = 0, kept = false;
      let cacheRead: number | undefined, cacheWrite: number | undefined;
      for (const { f } of files) {
        let text: string;
        try {
          text = readFileSync(join(dir, f), "utf8").slice(0, MAX_SESSION_BYTES);
        } catch {
          continue;
        }
        let headerCwdOk = false;
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let recRaw: unknown;
          try {
            recRaw = JSON.parse(line);
          } catch {
            continue;
          }
          const rec = recRaw as { type?: unknown; cwd?: unknown; timestamp?: unknown; message?: { role?: unknown; usage?: unknown } };
          if (rec.type === "session") {
            headerCwdOk = rec.cwd === real;
            continue;
          }
          if (!headerCwdOk) continue;
          if (rec.type !== "message" || rec.message?.role !== "assistant") continue;
          const u = rec.message?.usage;
          if (!u || typeof u !== "object") continue;
          const ts = Date.parse(String(rec.timestamp));
          if (!Number.isFinite(ts) || ts < sinceMs) continue;
          const uu = u as Record<string, unknown>;
          const n = (k: string) => (typeof uu[k] === "number" ? (uu[k] as number) : 0);
          input += n("input");
          output += n("output");
          if ("cacheRead" in uu) cacheRead = (cacheRead ?? 0) + n("cacheRead");
          if ("cacheWrite" in uu) cacheWrite = (cacheWrite ?? 0) + n("cacheWrite");
          kept = true;
        }
      }
      if (!kept) return undefined;
      const out: TokenUsage = { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
      const p = TokenUsageSchema.safeParse(out);
      return p.success ? p.data : undefined;
    } catch {
      return undefined;
    }
  },
  // v1.23 T1: last-turn context fill from ~/.pi/agent/sessions/<slug>/<sessionId>.jsonl ONLY.
  // tokens = input + cacheWrite + cacheRead of the LAST assistant usage record (not a sum over turns).
  // Disk read only: no pi spawn, no pane, no network. null = unknown.
  contextUsage(session: SessionRef): ContextUsage | null {
    try {
      const real = realpathSync(session.cwd);
      const slug = "-" + real.replaceAll("/", "-") + "--";
      const sid = session.id.replace(/\.jsonl$/i, "");
      if (!sid || sid.includes("/") || sid.includes("\\") || sid.includes("..")) return null;
      const file = join(homedir(), ".pi", "agent", "sessions", slug, `${sid}.jsonl`);
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
        const rec = recRaw as { type?: unknown; message?: { role?: unknown; usage?: unknown } };
        if (rec.type !== "message" || rec.message?.role !== "assistant") continue;
        const u = rec.message?.usage;
        if (!u || typeof u !== "object") continue;
        const uu = u as Record<string, unknown>;
        const n = (k: string) => (typeof uu[k] === "number" ? (uu[k] as number) : 0);
        // last turn wins — overwrite, never accumulate
        last = n("input") + n("cacheWrite") + n("cacheRead");
      }
      if (last === undefined) return null;
      return { tokens: last };
    } catch {
      return null;
    }
  },
};
