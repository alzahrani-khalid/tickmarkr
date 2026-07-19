import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TickmarkrConfig } from "../config/config.js";
import type { Task } from "../graph/schema.js";
import { probeVersion } from "./claude-code.js";
import { parseWorkerResult } from "./prompt.js";
import { type Assignment, type BillingChannel, channelsFromConfig, type Invocation, MODEL_ID_RE, shq, type TokenUsage, TokenUsageSchema, type WorkerAdapter, type WorkerResult } from "./types.js";

// KIMI-03 → v1.58 T5: the "no harness-readable counter" block (research F-6, 2026-07-17) is
// LIFTED for collectUsage — kimi 0.27.0 writes a wire journal per agent at
// ~/.kimi-code/sessions/<wd>/session_<uuid>/agents/<agent>/wire.jsonl, and ~/.kimi-code/
// workspaces.json maps each wd_* dir to its realpath'd workspace root. Field mapping pinned ONLY
// after live verification of the real store (2026-07-18, 53 wire files / 178 usage rows, zero
// tokens spent):
//   - the canonical row is top-level `{"type":"usage.record","usage":{...},"usageScope":"turn",
//     "time":<epoch ms>}` — 178/178 rows carried scope "turn" and the identical key set
//     {inputOther, output, inputCacheRead, inputCacheCreation};
//   - per-turn DELTA semantics verified arithmetically: each turn's inputCacheRead ≈ prior
//     inputCacheRead + inputOther + output (the grown context re-read from cache — claude's
//     per-message convention), and inputOther/output are non-monotonic per-turn counts, so
//     SUMMING rows is the correct fold (never a cumulative 3A+2B+C trap);
//   - the SAME usage object is echoed inside the step.end loop event
//     (`type:"context.append_loop_event"`, event.usage) — folding anything but usage.record
//     rows double-counts every turn, hence the exact type+scope pin below;
//   - mapping: inputOther→input, output→output, inputCacheRead→cacheRead,
//     inputCacheCreation→cacheWrite (creation observed live only as 0; mapped by name).
// Absent or ambiguous usage resolves to UNMETERED, never an invented count: unknown usageScope,
// non-numeric core fields, torn lines, or no post-cursor row all skip/return undefined — the
// "?? 0" poisoning class stays banned. contextUsage remains absent (resumeUnknownContext below).
const MAX_SESSION_FILES = 20;
const MAX_SESSION_BYTES = 8_000_000;

const CREDENTIALS_PATH = join(homedir(), ".kimi-code", "credentials", "kimi-code.json");

// KIMI-01. Auth verdict from ~/.kimi-code/credentials/kimi-code.json ONLY — flat JSON, never a
// network call. expires_at is epoch SECONDS (not ISO like grok). Non-empty refresh_token dominates
// an expired expires_at (device-code flow auto-refreshes). Missing/unreadable/garbage ⇒ authed:false.
export function kimiAuthed(credentialsText: string, nowMs: number): boolean {
  try {
    const j = JSON.parse(credentialsText) as { refresh_token?: unknown; expires_at?: unknown };
    if (typeof j.refresh_token === "string" && j.refresh_token.length > 0) return true;
    const exp = typeof j.expires_at === "number" ? j.expires_at * 1000 : Number(j.expires_at) * 1000;
    return Number.isFinite(exp) && exp > nowMs;
  } catch {
    return false;
  }
}

// KIMI-04 listModels parse: `kimi provider list --json` models map keys. Fail-open to [].
export function parseKimiModels(raw: string): string[] {
  try {
    const j = JSON.parse(raw) as { models?: Record<string, unknown> };
    if (!j.models || typeof j.models !== "object") return [];
    return Object.keys(j.models).filter((id) => id.length > 0 && MODEL_ID_RE.test(id));
  } catch {
    return [];
  }
}

// KIMI-02 parse: kimi -p text output prefixes thinking/answer lines with `• `. Strip before trailer
// scan so JSON.parse succeeds (research F-4 fixture). Resume line after the trailer is ignored by
// last-valid-trailer-wins in parseWorkerResult.
export function parseKimiResult(raw: string, nonce: string): WorkerResult {
  const stripped = raw.split("\n").map((l) => l.replace(/^[\s]*[•*-]\s+/, "")).join("\n");
  return parseWorkerResult(stripped, nonce);
}

// v1.53 T3: session-id capture from the run-output trailer — every `kimi -p` run (fresh or resumed)
// ends with `To resume this session: kimi -r session_<uuid>` (live probe 2026-07-18). Anchored full
// line only: prompt/model prose can contain lookalike text, and the anchored charset keeps a
// captured id shell-safe by construction (shq in resumeCommand is the second layer). Last valid
// line wins — a run may echo stale resume lines mid-transcript.
const RESUME_TRAILER_RE = /^\s*To resume this session: kimi -r (session_[0-9a-f-]+)\s*$/;
export function kimiSessionId(output: string): string | undefined {
  let id: string | undefined;
  for (const line of output.split("\n")) {
    const m = RESUME_TRAILER_RE.exec(line);
    if (m) id = m[1];
  }
  return id;
}

export const kimi: WorkerAdapter = {
  id: "kimi",
  vendor: "moonshot",
  probeCwd: "neutral",
  probe: async () => {
    const h = probeVersion("kimi");
    if (!h.installed) return h;
    let authed = false;
    try {
      authed = kimiAuthed(readFileSync(CREDENTIALS_PATH, "utf8"), Date.now());
    } catch { /* missing/unreadable ⇒ truthfully unauthed */ }
    return authed
      ? { ...h, note: "auth verified via ~/.kimi-code/credentials/kimi-code.json (free, no network)" }
      : { ...h, authed: false, note: "no valid ~/.kimi-code/credentials/kimi-code.json (kimi login to fix)" };
  },
  channels: (cfg: TickmarkrConfig): BillingChannel[] => channelsFromConfig("kimi", cfg),
  // KIMI-02 headless. -p prompt mode + explicit model, NO permission flag: kimi 0.26.0 rejects
  // -p combined with -y/--auto at argument parse time ("Cannot combine --prompt with --yolo",
  // OBS-67 — doctor probes all failed on it), and prompt mode is already non-interactive with
  // tool actions auto-approved (live-verified 2026-07-17: unattended file write succeeded).
  headlessCommand: (promptFile: string, model: string) =>
    `kimi -p "$(cat ${shq(promptFile)})" --model ${shq(model)} --output-format text`,
  // kimi 0.26.0 has NO TUI argv-seeding surface: a positional prompt parses as a subcommand
  // ("unknown command '…'", live-verified 2026-07-17, OBS-67) and -p is non-interactive-only.
  // null → the daemon's print fallback (types.ts:101) keeps kimi workers visible without a TUI.
  interactiveCommand: () => null,
  // v1.53 T3 resume — live-probed 2026-07-18: `-p` + `-S <id>` compose cleanly (no OBS-67-class
  // flag rejection) and the resumed session carries prior conversation state. `-S <id>` is the
  // deterministic form; `-c` rejected as primary — cwd-keyed, nondeterministic under worktree
  // recreation (probe finding 4). Never bare `-S` (it launches the interactive session picker).
  resumeCommand: (sessionId: string, promptFile: string, model: string) =>
    `kimi -S ${shq(sessionId)} -p "$(cat ${shq(promptFile)})" --model ${shq(model)} --output-format text`,
  sessionIdFrom: kimiSessionId,
  // KIMI-03: no contextUsage surface exists, so a known-context requirement would leave resume
  // dead code — declare the unknown-context opt-in the daemon retry seam enforces.
  resumeUnknownContext: true,
  invoke(task: Task, _cwd: string, a: Assignment, ctx: { promptFile: string }): Invocation {
    return { command: this.headlessCommand(ctx.promptFile, a.model) };
  },
  parse: parseKimiResult,
  collectUsage(cwd: string, sinceMs: number): TokenUsage | undefined {
    try {
      const real = realpathSync(cwd);
      const home = join(homedir(), ".kimi-code");
      const ws = JSON.parse(readFileSync(join(home, "workspaces.json"), "utf8")) as {
        workspaces?: Record<string, { root?: unknown }>;
      };
      // a recreated workspace gets a new wd_* hash for the same root — fold every match
      const wdDirs = Object.entries(ws.workspaces ?? {})
        .filter(([, v]) => v && typeof v === "object" && (v as { root?: unknown }).root === real)
        .map(([k]) => k);
      // newest-first by mtime, bounded — mtime picks WHICH files to scan, never a record's cursor
      const files: { path: string; m: number }[] = [];
      for (const wd of wdDirs) {
        const wdPath = join(home, "sessions", wd);
        let sessions: string[];
        try { sessions = readdirSync(wdPath); } catch { continue; }
        for (const s of sessions) {
          if (!s.startsWith("session_")) continue;
          const agentsPath = join(wdPath, s, "agents");
          let agents: string[];
          try { agents = readdirSync(agentsPath); } catch { continue; }
          for (const a of agents) {
            const p = join(agentsPath, a, "wire.jsonl");
            try { files.push({ path: p, m: statSync(p).mtimeMs }); } catch { continue; }
          }
        }
      }
      files.sort((a, b) => b.m - a.m);

      let input = 0, output = 0, kept = false;
      let cacheRead: number | undefined, cacheWrite: number | undefined;
      for (const { path: fp } of files.slice(0, MAX_SESSION_FILES)) {
        let text: string;
        try { text = readFileSync(fp, "utf8").slice(0, MAX_SESSION_BYTES); } catch { continue; }
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let recRaw: unknown;
          try { recRaw = JSON.parse(line); } catch { continue; }
          const rec = recRaw as { type?: unknown; usageScope?: unknown; time?: unknown; usage?: unknown };
          // exact type+scope pin: the step.end loop event ECHOES the same usage (double-count),
          // and any scope other than the live-verified "turn" has unknown fold semantics — skip
          if (rec.type !== "usage.record" || rec.usageScope !== "turn") continue;
          if (typeof rec.time !== "number" || !Number.isFinite(rec.time) || rec.time < sinceMs) continue;
          const u = rec.usage;
          if (!u || typeof u !== "object") continue;
          const uu = u as Record<string, unknown>;
          // ambiguous row (core fields missing/non-numeric) resolves to unmetered, never 0
          if (typeof uu.inputOther !== "number" || typeof uu.output !== "number") continue;
          input += uu.inputOther;
          output += uu.output;
          if (typeof uu.inputCacheRead === "number") cacheRead = (cacheRead ?? 0) + uu.inputCacheRead;
          if (typeof uu.inputCacheCreation === "number") cacheWrite = (cacheWrite ?? 0) + uu.inputCacheCreation;
          kept = true;
        }
      }
      if (!kept) return undefined; // nothing matched ⇒ unmetered, never {input:0,…}
      const out: TokenUsage = { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
      const p = TokenUsageSchema.safeParse(out);
      return p.success ? p.data : undefined;
    } catch {
      return undefined; // missing home/workspaces.json / any throw ⇒ fail open
    }
  },
  listModels: async () => {
    const r = spawnSync("kimi", ["provider", "list", "--json"], { encoding: "utf8", timeout: 15000 });
    return r.error || r.status !== 0 ? [] : parseKimiModels(r.stdout || "");
  },
};
