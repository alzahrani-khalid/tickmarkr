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

// Newest-first by mtime, capped — mtime picks WHICH files to scan, never a record's cursor.
// Shared by collectUsage (spend) and readPiServedModels (v2.1.3 T7): same store, same bounds.
function sessionFileStats(dir: string): { f: string; m: number }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const path = join(dir, f);
      try {
        return { f: path, m: statSync(path).mtimeMs };
      } catch {
        return undefined; // a stat failure just drops that file
      }
    })
    .filter((x): x is { f: string; m: number } => x !== undefined);
}

function newestSessionFiles(entries: { f: string; m: number }[]): string[] {
  return [...entries].sort((a, b) => b.m - a.m).slice(0, MAX_SESSION_FILES).map((x) => x.f);
}

// v2.1.3 T7: pi records the model it was ACTUALLY served in message.responseModel, and writes that
// field ONLY where it differs from the pinned message.model (measured over this machine's whole
// store: 213 assistant records, 213 of them differing, zero agreeing — the field is the discrepancy).
// Nothing in the shipped tree read it, so a silent substitution (pinned zai/glm-5.2, served glm-5.3)
// reached tier, price and review-diversity decisions unremarked.
// The neighbouring wrong answer is cheap and green: reporting message.model as the served model
// agrees with every ordinary record and detects exactly nothing. The other one is worse — treating
// an ABSENT responseModel as a mismatch alarms on every ordinary turn in the store.
// FAIL OPEN everywhere (detection is advisory, like listModels — never fails a probe), and bound the
// scan the way collectUsage beside it bounds one: newest MAX_SESSION_FILES by mtime across the whole
// store, MAX_SESSION_BYTES per file. MODEL_ID_RE gates both names — they land in operator-facing text.
export interface ServedModelDrift {
  pinned: string;
  served: string;
}

// ponytail: three distinct pairs is the note's ceiling — raise it if a real store ever shows more.
const MAX_DRIFT_PAIRS = 3;

export function readPiServedModels(): ServedModelDrift[] {
  const root = join(homedir(), ".pi", "agent", "sessions");
  let files: string[];
  try {
    files = newestSessionFiles(
      readdirSync(root).flatMap((slug) => {
        try {
          return sessionFileStats(join(root, slug));
        } catch {
          return []; // not a directory / unreadable ⇒ skip
        }
      }),
    );
  } catch {
    return []; // no store ⇒ nothing to report
  }
  const out: ServedModelDrift[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8").slice(0, MAX_SESSION_BYTES);
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let recRaw: unknown;
      try {
        recRaw = JSON.parse(line);
      } catch {
        continue;
      }
      if (recRaw === null || typeof recRaw !== "object" || Array.isArray(recRaw)) continue;
      const rec = recRaw as { type?: unknown; message?: { role?: unknown; model?: unknown; responseModel?: unknown } };
      if (rec.type !== "message" || rec.message?.role !== "assistant") continue;
      const pinned = rec.message?.model;
      const served = rec.message?.responseModel;
      // absent responseModel === the two agree. Never a mismatch, never an alarm.
      if (typeof served !== "string" || typeof pinned !== "string" || served === pinned) continue;
      if (!MODEL_ID_RE.test(served) || !MODEL_ID_RE.test(pinned)) continue;
      const key = `${pinned}\u0000${served}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pinned, served });
      if (out.length >= MAX_DRIFT_PAIRS) return out;
    }
  }
  return out;
}

// The probe's note clause, or "" when the store reports no discrepancy at all.
export function servedModelNote(drifts: ServedModelDrift[] = readPiServedModels()): string {
  if (drifts.length === 0) return "";
  return `served-model drift: ${drifts.map((d) => `pinned ${d.pinned} served ${d.served}`).join(", ")}`;
}

const PI_PROVIDER_VENDORS: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  google: "google",
  openai: "openai",
  "openai-codex": "openai",
  xai: "xai",
  zai: "zhipu",
};

export function piModelVendor(model: string): string | undefined {
  return PI_PROVIDER_VENDORS[model.split("/", 1)[0]];
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
    // The store is local and independently useful: preserve its advisory even when the network/auth
    // capability call below fails. A failed model listing must not erase evidence of a substitution.
    const drift = servedModelNote();
    const r = spawnSync("pi", ["--list-models"], { encoding: "utf8", timeout: 15000 });
    if (r.error || r.status !== 0) {
      return drift ? { ...h, note: `${h.note ? `${h.note}; ` : ""}${drift}` } : h;
    }
    // v2.1.3 T7: the probe is the production caller that already reads this store, and doctor/fleet
    // already render its note — so the served-model discrepancy is reported where it is already read.
    const note = `auth verified via pi --list-models (free; auth-filtered by pi)${drift ? `; ${drift}` : ""}`;
    return { ...h, servable: parsePiModels(r.stdout || ""), note };
  },
  channels: (cfg: TickmarkrConfig): BillingChannel[] => channelsFromConfig("pi", cfg).map((channel) => ({
    ...channel,
    vendor: cfg.tiers.pi?.modelOverrides?.[channel.model]?.vendor ?? piModelVendor(channel.model) ?? channel.vendor,
  })),
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
  // v1.89 T1 / OBS-414: pi HAS a per-directory trust prompt, and both command builders above already
  // suppress it with --approve — a global option legal in both modes (pi --help 0.80.3), chosen for
  // exactly this reason. Live-checked 2026-07-10 in a fresh worktree: no trust prompt reached the
  // pane, so there is nothing captured, and a fingerprint here would be a guess about a dialog this
  // adapter never lets render.
  // FALSIFIER: drop --approve from interactiveCommand, dispatch into a fresh worktree, and capture
  // the prompt that appears — then this becomes {fingerprint, key} rather than a suppression claim.
  trustDialog: {
    kind: "none",
    reason: "pi 0.80.3's per-directory trust prompt is suppressed before it renders by --approve on both command builders (live-checked 2026-07-10, fresh worktree, no prompt); falsified by removing --approve and capturing the pane",
  },
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
      const files = newestSessionFiles(sessionFileStats(dir));

      let input = 0, output = 0, kept = false;
      let cacheRead: number | undefined, cacheWrite: number | undefined;
      for (const f of files) {
        let text: string;
        try {
          text = readFileSync(f, "utf8").slice(0, MAX_SESSION_BYTES);
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
