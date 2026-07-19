import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TickmarkrConfig } from "../config/config.js";
import type { Task } from "../graph/schema.js";
import { probeVersion } from "./claude-code.js";
import { parseWorkerResult } from "./prompt.js";
import { type Assignment, type BillingChannel, channelsFromConfig, type Invocation, MODEL_ID_RE, shq, type TokenUsage, TokenUsageSchema, type TrustVerdict, type WorkerAdapter } from "./types.js";

// SPEND-07: codex writes per-session JSONL to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — date-partitioned,
// NOT cwd-keyed. session_meta.payload.cwd is FILE-SCOPED (one codex exec per cwd). token_count events carry
// per-turn DELTAS in payload.info.last_token_usage; we read POST-HOC (never the pane, never the trailer).
// last_token_usage is the per-turn DELTA; total_token_usage is the session cumulative — reading it is the
// 3A+2B+C trap (arithmetic-verified 29-RESEARCH.md). Filter PER RECORD by top-level ISO timestamp >= sinceMs
// (this attempt's dispatch wall-clock). reasoning_output_tokens ⊂ output_tokens — omit reasoning entirely;
// report.ts total() cross-sums reasoning and populating it double-counts (claude reference impl also omits it).
// FAIL OPEN everywhere: missing dir / torn line / info:null / bad timestamp / cwd mismatch ⇒ undefined.
const MAX_SESSION_FILES = 20;
const MAX_SESSION_BYTES = 8_000_000;
const DAY_MS = 86_400_000;

function codexSessionDayDirs(sessions: string, sinceMs: number): string[] {
  const out: string[] = [];
  let years: string[];
  try {
    years = readdirSync(sessions);
  } catch {
    return [];
  }
  for (const y of years) {
    if (!/^\d{4}$/.test(y)) continue;
    const yPath = join(sessions, y);
    let months: string[];
    try { months = readdirSync(yPath); } catch { continue; }
    for (const m of months) {
      if (!/^\d{2}$/.test(m)) continue;
      const mPath = join(yPath, m);
      let days: string[];
      try { days = readdirSync(mPath); } catch { continue; }
      for (const d of days) {
        if (!/^\d{2}$/.test(d)) continue;
        if (Date.UTC(Number(y), Number(m) - 1, Number(d)) + 2 * DAY_MS > sinceMs) out.push(join(y, m, d));
      }
    }
  }
  return out;
}

// v1.5 MODEL-01: codex has NO list subcommand (verified 2026-07-10 — `codex models` errors); its
// own ~/.codex/models_cache.json is a timestamped JSON cache. File read, zero subprocess/network.
// Fails OPEN to { models: [] } on missing/corrupt cache. Version drift observed (installed CLI
// 0.143.0 vs cache client_version 0.144.0, 2026-07-10) — hence the defensive try/catch and no shape
// assumptions. CODEX_HOME is codex's own relocation env. fetchedAt is the honest codex knowledge age.
export function readCodexModelsCache(path?: string): { models: string[]; fetchedAt?: string } {
  const p = path ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json");
  try {
    const d = JSON.parse(readFileSync(p, "utf8"));
    const models = (d.models ?? [])
      .filter((m: any) => m?.visibility === "list" && typeof m.slug === "string" && m.slug.length > 0)
      .map((m: any) => m.slug as string)
      .filter((id: string) => MODEL_ID_RE.test(id));
    return { models, fetchedAt: typeof d.fetched_at === "string" ? d.fetched_at : undefined };
  } catch {
    return { models: [] };
  }
}

// tickmarkr worktrees keep their gitdir under the MAIN repo's .git/worktrees/<name> — outside the
// workspace-write sandbox root — so git commit dies on index.lock (incident run-20260709-104447
// P87-08: "Unable to create …/.git/worktrees/…/index.lock"). Expanded by the pane shell at the
// worktree cwd; in a plain repo it resolves to ./.git (already writable, harmless).
const GITDIR_WRITABLE = `-c "sandbox_workspace_write.writable_roots=[\\"$(git rev-parse --path-format=absolute --git-common-dir)\\"]"`;

// v1.22 T5 / OBS-16: codex keys trust on absolute path under [projects."<root>"] trust_level="trusted"
// in ~/.codex/config.toml (CODEX_HOME relocates the dir). Worktrees inherit parent-project trust when
// the REPO ROOT is trusted — seed the root once, cover every future worktree. Idempotent: a second
// call that finds the entry returns trusted without rewriting. configPath is the test seam.
export function seedCodexTrust(repoRoot: string, configPath?: string): TrustVerdict {
  let root: string;
  try {
    root = realpathSync(repoRoot);
  } catch {
    root = repoRoot;
  }
  const cfgPath = configPath ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  // TOML quoted-key form matches codex's own writer: [projects."/abs/path"]
  const header = `[projects.${JSON.stringify(root)}]`;
  const entry = `${header}\ntrust_level = "trusted"\n`;
  let text = "";
  try {
    text = readFileSync(cfgPath, "utf8");
  } catch {
    /* missing file — seed creates it */
  }
  if (hasCodexTrustedProject(text, root)) return { status: "trusted" };
  // exact one-time operator command if the write fails (readonly home, sandbox, etc.)
  const once = `mkdir -p ${shq(dirname(cfgPath))} && printf '\\n[projects.%s]\\ntrust_level = "trusted"\\n' ${shq(JSON.stringify(root))} >> ${shq(cfgPath)}`;
  try {
    mkdirSync(dirname(cfgPath), { recursive: true });
    const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    writeFileSync(cfgPath, `${base}\n${entry}`, { mode: 0o600 });
    return { status: "seeded" };
  } catch {
    return { status: "action-required", command: once };
  }
}

// Match [projects."/path"] or [projects.'/path'] then trust_level = "trusted" before the next section.
export function hasCodexTrustedProject(text: string, root: string): boolean {
  const esc = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    String.raw`\[projects\.(?:"${esc}"|'${esc}')\][^\[]*?trust_level\s*=\s*"trusted"`,
    "s",
  );
  return re.test(text);
}

// v1.57 T1 / OBS-82: first key segment after `mcp_servers.` — bare, "basic", or 'literal' TOML
// keys; sub-tables ([mcp_servers.x.env]) dedupe to their server name. Fails OPEN to [] on a
// missing/unreadable config (fresh install has none — base flags must still work).
export function codexConfigMcpServerNames(configPath?: string): string[] {
  const p = configPath ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const m of text.matchAll(/^[ \t]*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/gm)) {
    names.add((m[1] ?? m[2] ?? m[3]) as string);
  }
  return [...names];
}

// OBS-24 → OBS-82: -c 'mcp_servers={}' was codex's analog of claude's --strict-mcp-config, but
// codex ≥0.144 MERGES the empty inline table with config instead of replacing it (live probe
// 2026-07-18, codex-cli 0.144.5: `mcp list` identical with and without the override) — so a down
// operator-global MCP server wedges startup indefinitely again (OBS-82: 45m spinner). No global
// MCP kill switch exists (`codex features list` has nothing MCP-shaped), and plugin-bundled
// servers (~/.codex/plugins/cache) never appear under [mcp_servers.*], so suppression is
// two-pronged: --disable plugins kills plugin loading (incl. the OBS-82 sites-design-picker),
// per-name enabled=false overrides kill every server named in $CODEX_HOME/config.toml. The empty
// table stays for older codex (replace semantics there; harmless no-op under merge). The LIVE
// test in real-adapters.test.ts runs this exact builder against the real `codex mcp list`
// surface and asserts zero enabled servers — executable proof, not a comment claim. Scanned
// names reach the shell line ONLY through shq — config values flow into shells.
export function codexMcpSuppressionFlags(configPath?: string): string {
  const flags = ["--disable plugins", `-c 'mcp_servers={}'`];
  for (const name of codexConfigMcpServerNames(configPath)) {
    const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
    flags.push(`-c ${shq(`mcp_servers.${key}.enabled=false`)}`);
  }
  return flags.join(" ");
}

export const codex: WorkerAdapter = {
  id: "codex",
  vendor: "openai",
  // OBS-72: codex probes self-contend in one repo (v1.33.5: 4 concurrent → all 4 timed out;
  // 2026-07-18: gpt-5.5 lost the concurrent pair every doctor sweep) — probe one model at a time.
  probeConcurrency: 1,
  probe: async () => probeVersion("codex"),
  channels: (cfg: TickmarkrConfig): BillingChannel[] => channelsFromConfig("codex", cfg),
  // --sandbox workspace-write is the autonomous sandbox mode (codex v0.144.1+)
  // MCP suppression built per dispatch (config can change between runs) — see codexMcpSuppressionFlags.
  headlessCommand: (promptFile: string, model: string) =>
    `codex exec --sandbox workspace-write ${codexMcpSuppressionFlags()} ${GITDIR_WRITABLE} --model ${shq(model)} "$(cat ${shq(promptFile)})"`,
  // TUI uses expanded -a never -s workspace-write (exec-only flags do not apply)
  // (--help 2026-07-09: valid approval policies are untrusted|on-request|never; the previously
  // used `on-failure` is invalid and made codex exit 2 pre-inference)
  interactiveCommand: (promptFile: string, model: string) =>
    `codex -a never -s workspace-write ${codexMcpSuppressionFlags()} ${GITDIR_WRITABLE} --model ${shq(model)} "$(cat ${shq(promptFile)})"`,
  invoke(task: Task, _cwd: string, a: Assignment, ctx: { promptFile: string }): Invocation {
    return { command: this.headlessCommand(ctx.promptFile, a.model) };
  },
  parse: parseWorkerResult,
  // v1.22 T5: seed [projects."<repoRoot>"] trust_level="trusted" so fresh worktrees never stall on
  // "Do you trust this directory?" (OBS-16). doctor-only side effect.
  trust: (repoRoot: string) => seedCodexTrust(repoRoot),
  // v1.5 MODEL-01: file read only (no `codex models` subcommand exists, verified 2026-07-10).
  // Already fails OPEN to [] internally — advisory detection, unlike gates' fail-closed.
  listModels: async () => readCodexModelsCache().models,
  // v1.5 MODEL-05: codex reads an offline cache, so "now" would re-stamp an ancient cache fresh and the
  // 30-day staleness lint could never fire. Surface the cache's own fetched_at so doctor stamps the real age.
  listModelsFetchedAt: () => readCodexModelsCache().fetchedAt,
  collectUsage(cwd: string, sinceMs: number): TokenUsage | undefined {
    try {
      const real = realpathSync(cwd);
      const sessions = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
      const dayDirs = codexSessionDayDirs(sessions, sinceMs);
      const files: { path: string; m: number }[] = [];
      for (const dayDir of dayDirs) {
        const fullDay = join(sessions, dayDir);
        let names: string[];
        try {
          names = readdirSync(fullDay);
        } catch {
          continue;
        }
        for (const f of names) {
          if (!f.endsWith(".jsonl")) continue;
          const p = join(fullDay, f);
          try {
            files.push({ path: p, m: statSync(p).mtimeMs });
          } catch {
            continue;
          }
        }
      }
      files.sort((a, b) => b.m - a.m);
      const bounded = files.slice(0, MAX_SESSION_FILES);

      let input = 0, output = 0, kept = false;
      let cacheRead: number | undefined;
      for (const { path: fp } of bounded) {
        let text: string;
        try {
          text = readFileSync(fp, "utf8").slice(0, MAX_SESSION_BYTES);
        } catch {
          continue;
        }
        const lines = text.split("\n");
        let fileCwd: string | undefined;
        for (const line of lines) {
          if (!line.trim()) continue;
          let recRaw: unknown;
          try {
            recRaw = JSON.parse(line);
          } catch {
            continue;
          }
          const rec = recRaw as { type?: unknown; payload?: Record<string, unknown> };
          if (rec.type === "session_meta") {
            const pcwd = (rec.payload as { cwd?: unknown } | undefined)?.cwd;
            fileCwd = typeof pcwd === "string" ? pcwd : undefined;
            break;
          }
        }
        if (fileCwd !== real) continue;
        for (const line of lines) {
          if (!line.trim()) continue;
          let recRaw: unknown;
          try {
            recRaw = JSON.parse(line);
          } catch {
            continue;
          }
          const rec = recRaw as { type?: unknown; timestamp?: unknown; payload?: Record<string, unknown> };
          if (rec.type === "session_meta") continue;
          if (rec.type !== "event_msg") continue;
          const payload = rec.payload;
          if (!payload || payload.type !== "token_count") continue;
          const info = payload.info;
          if (!info || typeof info !== "object") continue;
          const ts = Date.parse(String(rec.timestamp));
          if (!Number.isFinite(ts) || ts < sinceMs) continue;
          const last = (info as { last_token_usage?: unknown }).last_token_usage;
          if (!last || typeof last !== "object") continue;
          const u = last as Record<string, unknown>;
          const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
          const inTok = n("input_tokens"), cached = n("cached_input_tokens");
          input += Math.max(0, inTok - cached);
          output += n("output_tokens");
          if (cached > 0) cacheRead = (cacheRead ?? 0) + cached;
          kept = true;
        }
      }
      if (!kept) return undefined;
      const out: TokenUsage = { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}) };
      const p = TokenUsageSchema.safeParse(out);
      return p.success ? p.data : undefined;
    } catch {
      return undefined;
    }
  },
};
