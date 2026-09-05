import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TickmarkrConfig } from "../config/config.js";
import type { Task } from "../graph/schema.js";
import { parseWorkerResult } from "./prompt.js";
import { type Assignment, type AuthHealth, type BillingChannel, channelsFromConfig, type ContextUsage, declareInputBox, type Invocation, MODEL_ID_RE, promptFitsArgv, type SessionRef, shq, type TokenUsage, TokenUsageSchema, type TrustDialog, type WorkerAdapter } from "./types.js";

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

// OBS-145: these aliases float at the Claude CLI layer, while their tier/pricing decisions were
// made for the dated identities below (claude-code seeds stamped 2026-07-09 — doctor's own lint).
// Updating a stamp is a deliberate benchmark-policy act; doctor only compares against it and never
// edits tiers, pricing, learned scores, or routing. `opus` is deliberately left at 4-8: the OBS-145
// drill probed the alias at claude-opus-4-8 matching its stamp, then captured it re-pointing to
// claude-opus-5 ~30 min later with zero events fired. The 2026-07-24 fit added an EXPLICIT
// claude-opus-5 channel to the repo overlay — it did not re-date this alias's stamps, so the
// alias channel still carries 4-8-dated tier/pricing while serving 5. That warning is true.
export const CLAUDE_ALIAS_IDENTITY_STAMPS = {
  // OBS-871, 2026-09-03: Fable's floating alias now resolves to the 5.1 benchmark identity.
  fable: "claude-fable-5-1",
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
} as const;
export type ClaudeAlias = keyof typeof CLAUDE_ALIAS_IDENTITY_STAMPS;
export type ClaudeAliasIdentityProbe = (cwd: string, alias: ClaudeAlias) => string | undefined;

// v1.75 T2 / OBS-137: current Claude Code workspace-trust prompt (2.1.218). The full question
// distinguishes this startup gate from routine agent text; Enter accepts the selected trust option.
export const CLAUDE_TRUST_DIALOG: TrustDialog = {
  fingerprint: "Quick safety check: Is this a project you created or one you trust?",
  key: "Enter",
};

// OBS-201/262 nudge deliverability: claude-code is the ONLY member of NUDGEABLE_ADAPTERS, and the
// driver's deliverTyped pincer (readiness stable-frame → type → read-back → verified submit) needs a
// declared input box for any delivery whose command is not the adapter's own launch line — which a
// nudge never is. Without this declaration `requireInputBox` was false, readiness fell back to
// "the pane no longer echoes the command", and submission fell through to the positional fallback:
// the rescue that OBS-262 widened the gate for could not be verifiably delivered to the one adapter
// allowed to receive it.
//
// CAPTURED, not guessed (claude 2.1.220, tmux 120x30, 2026-08-03 — the state-to-PIXELS law):
//     ────────────────────────────────────────────  ← full-width rule
//     ❯ You are still assigned this task…       ← caret, NBSP, then the typed turn
//     ────────────────────────────────────────────  ← full-width rule
// Two findings the kimi-shaped guess would have got wrong, and both are fatal on their own:
//   1. claude's editor is NOT a bordered ╭─╮ box — it is one row FENCED BY TWO RULES, so a
//      `│ > ` fingerprint or a border-adjacency walk never fires.
//   2. the caret is padded with U+00A0, not a space. A `"❯ "` fingerprint with an ASCII space
//      matches nothing, ever — the OBS-152 failure mode exactly (six versions of "kimi is broken"
//      were all anchored matchers meeting a TUI that renders differently than assumed).
// `match` means THE EDITOR IS PAINTED and is deliberately true for an empty editor (readiness);
// `emptyMatch` is the stricter "painted AND carrying nothing", which is what proves a submit
// registered. Callers deciding submission must test emptyMatch first — see submissionRegistered.
const CLAUDE_ANSI_SGR_RE = /\u001B\[[0-9;]*m/g;
const CLAUDE_RULE_RE = /^─{8,}$/;
const CLAUDE_CARET_RE = /^❯\u00A0/;
const CLAUDE_CARET_EMPTY_RE = /^❯\u00A0\s*$/;
// A wrapped or multi-line turn grows the editor downward before the closing rule.
// ponytail: a fixed window, not a parser — raise it if a real capture ever shows a taller editor.
const CLAUDE_MAX_EDITOR_ROWS = 8;

function matchesClaudeEditor(paneText: string, empty: boolean): boolean {
  // Trim ASCII margins ONLY: String.trim() eats U+00A0, which would erase the very byte that
  // distinguishes claude's caret padding from an ordinary prompt line.
  const lines = paneText.replace(CLAUDE_ANSI_SGR_RE, "").split("\n").map((l) => l.replace(/^[ \t]+|[ \t]+$/g, ""));
  const caret = empty ? CLAUDE_CARET_EMPTY_RE : CLAUDE_CARET_RE;
  return lines.some((line, i) => {
    if (!caret.test(line)) return false;
    if (i === 0 || !CLAUDE_RULE_RE.test(lines[i - 1])) return false;
    for (let below = i + 1; below < lines.length && below <= i + CLAUDE_MAX_EDITOR_ROWS; below++) {
      if (CLAUDE_RULE_RE.test(lines[below])) return true;
    }
    return false;
  });
}

export const CLAUDE_INPUT_BOX = declareInputBox("claude-code", {
  fingerprint: "❯\u00A0",
  match: (paneText: string) => matchesClaudeEditor(paneText, false),
  emptyMatch: (paneText: string) => matchesClaudeEditor(paneText, true),
  // OBS-342: daemon-built launches carry intent through paneDispatchCommand; their wrapper bytes are
  // never re-parsed here. The first-delivery fact keeps direct driver consumers on the same honest
  // lifecycle: a fresh claude-code worker slot is a shell awaiting its launch, every later delivery
  // is a TUI turn awaiting this box. Both interactive and resume builders share that contract.
  firstDeliveryIsLaunch: true,
  // The 2026-08-03 capture reached a painted editor ~10s after the trust answer on a warm install.
  readinessTimeoutMs: 30_000,
} as Parameters<typeof declareInputBox>[1] & { firstDeliveryIsLaunch: true });

export function claudeSlug(real: string): string {
  return real.replace(/[^A-Za-z0-9]/g, "-");
}

// newest-first by mtime, bounded — mtime picks WHICH files to scan, never a record's cursor.
// Shared by collectUsage (spend) and readClaudeAliasIdentity (OBS-145): same store, same bounds.
function newestSessionFiles(dir: string): string[] {
  return readdirSync(dir)
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
    .slice(0, MAX_SESSION_FILES)
    .map((x) => x.f);
}

const belongsToAliasFamily = (identity: string, alias: ClaudeAlias): boolean =>
  identity === alias || identity.split(/[^A-Za-z0-9]+/).includes(alias);

// Zero-token first choice: Claude assistant records state the resolved message.model. The newest
// matching family record in this cwd wins. Every failure is advisory/unknown, never an exception.
export function readClaudeAliasIdentity(cwd: string, alias: ClaudeAlias): string | undefined {
  try {
    const real = realpathSync(cwd);
    const dir = join(homedir(), ".claude", "projects", claudeSlug(real));
    let newest: { identity: string; timestamp: number } | undefined;
    for (const f of newestSessionFiles(dir)) {
      let text: string;
      try {
        text = readFileSync(join(dir, f), "utf8").slice(0, MAX_SESSION_BYTES);
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        const rec = raw as { cwd?: unknown; timestamp?: unknown; message?: { model?: unknown } };
        if (rec.cwd !== real || typeof rec.message?.model !== "string") continue;
        const identity = rec.message.model;
        const timestamp = Date.parse(String(rec.timestamp));
        if (!MODEL_ID_RE.test(identity) || !belongsToAliasFamily(identity, alias) || !Number.isFinite(timestamp)) continue;
        if (!newest || timestamp > newest.timestamp) newest = { identity, timestamp };
      }
    }
    return newest?.identity;
  } catch {
    return undefined;
  }
}

// Store silence earns one minimal stated-identity turn. The output contract is intentionally strict:
// one safe model id from the requested alias family, otherwise unknown/fail-open. Vitest never spawns
// a real agent CLI; tests inject the probe callback at resolveClaudeAliasIdentity instead.
export function probeClaudeAliasIdentity(cwd: string, alias: ClaudeAlias): string | undefined {
  if (process.env.VITEST) return undefined;
  try {
    const r = spawnSync("claude", [
      "-p",
      "State the exact model identifier serving this request. Reply with only that identifier.",
      "--model", alias,
      "--permission-mode", "bypassPermissions",
      "--strict-mcp-config",
      "--mcp-config", '{"mcpServers":{}}',
      "--output-format", "text",
    ], { cwd, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error || r.status !== 0) return undefined;
    const identity = (r.stdout || "").trim();
    return MODEL_ID_RE.test(identity) && belongsToAliasFamily(identity, alias) ? identity : undefined;
  } catch {
    return undefined;
  }
}

export function resolveClaudeAliasIdentity(
  cwd: string,
  alias: ClaudeAlias,
  probe: ClaudeAliasIdentityProbe = probeClaudeAliasIdentity,
): string | undefined {
  return readClaudeAliasIdentity(cwd, alias) ?? probe(cwd, alias);
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
  // v1.65 T3: every flag the command builders below hardcode — doctor checks `claude --help` still
  // lists each (all present on claude 2.x, verified 2026-07-22). Advisory only, never routing.
  hardcodedFlags: { binary: "claude", flags: ["-p", "--model", "--permission-mode", "--strict-mcp-config", "--mcp-config", "--output-format", "-r", "--prompt-suggestions", "--settings"] },
  // --strict-mcp-config --mcp-config '{"mcpServers":{}}': pin the MCP surface to empty so fresh-worktree
  // workers/gates don't load project .mcp.json servers (herdr scrapes dialogs as idle — v1.4 incident,
  // memory tickmarkr-worker-mcp-dialog-stall). Live-verified 2026-07-10 on claude 2.1.205 (operator check):
  // headless (-p) fully suppressed — exit 0, no dialog. Interactive TUI STILL shows the project
  // MCP-enable dialog (project trust/enablement, not config loading); Esc dismisses it, and tickmarkr's
  // blocked/idle paging surfaces the pane to the operator (same path as cursor's trust dialog).
  // Gotchas (both bit the 2026-07-10 live check): bare '{}' is REJECTED ("mcpServers: expected record"),
  // and --mcp-config is VARIADIC — a positional after it is eaten as a config-file path, so another
  // flag must always follow the value, never the prompt.
  // The empty -p argument selects print mode while stdin carries the prompt, keeping its nonce out
  // of process argv. The redirect path is shell-quoted independently from the model.
  headlessCommand: (promptFile: string, model: string) =>
    `claude -p '' --model ${shq(model)} --permission-mode bypassPermissions --strict-mcp-config --mcp-config '{"mcpServers":{}}' --output-format text < ${shq(promptFile)}`,
  // HYG-03 / OBS-137: the residual first-entry dialog is workspace trust, not MCP config loading.
  // Claude's only store is global last-writer-wins ~/.claude.json, so tickmarkr still does not seed it;
  // the daemon safely answers only the exact adapter-declared dialog once per slot.
  //
  // v2.1.3 T7 --prompt-suggestions false: claude paints a PREDICTED next prompt into the editor after
  // a turn. On a pane it is pixel-identical to a seat's own unsubmitted draft, so every occupancy
  // reader downstream — the input-box occupiedMatch above, the stall watchdog that sweeps for a
  // parked turn — reads the vendor's ghost text as work in progress and waits out its window on a
  // worker that is idle. Suppressed at the SOURCE instead: the two builders that seed a real terminal
  // are exactly these (interactive, resume); the -p builder has no editor to paint into and is out of
  // scope. Live-checked against claude 2.1.246: the flag parses and `false` is an allowed choice
  // ("Allowed choices are true, false, 1, 0, yes, no, on, off").
  // Placement is NOT free: --mcp-config above is variadic and eats the next positional (2026-07-10
  // live check ate the prompt), and --prompt-suggestions takes an OPTIONAL value — appended directly
  // before the prompt it would swallow it the same way. So the setting's value is always followed by
  // another flag, never by the prompt positional.
  // OBS-931: the same ONE-argv-string hazard as codex (OBS-930) — over promptArgvCeiling() the TUI
  // launch would E2BIG on Linux, so it returns null → worker-mode-fallback → the headless form.
  // resumeCommand keeps the shape: its contract returns a string (composer delivery is 2.4.3 work).
  interactiveCommand: (promptFile: string, model: string) =>
    promptFitsArgv(promptFile)
      ? `claude --model ${shq(model)} --strict-mcp-config --mcp-config '{"mcpServers":{}}' --settings '{"promptSuggestionEnabled":false}' --prompt-suggestions false --permission-mode bypassPermissions "$(cat ${shq(promptFile)})"`
      : null,
  trustDialog: CLAUDE_TRUST_DIALOG,
  inputBox: CLAUDE_INPUT_BOX,
  // A resumed attempt lands in the same painted editor, so it carries the same ghost-text suppression
  // and the same value-then-flag placement.
  resumeCommand: (sessionId: string, promptFile: string, model: string) =>
    `claude -r ${shq(sessionId)} --model ${shq(model)} --strict-mcp-config --mcp-config '{"mcpServers":{}}' --settings '{"promptSuggestionEnabled":false}' --prompt-suggestions false --permission-mode bypassPermissions "$(cat ${shq(promptFile)})"`,
  invoke(task: Task, _cwd: string, a: Assignment, ctx: { promptFile: string }): Invocation {
    return { command: this.headlessCommand(ctx.promptFile, a.model) };
  },
  parse: parseWorkerResult,
  collectUsage(cwd: string, sinceMs: number): TokenUsage | undefined {
    try {
      const real = realpathSync(cwd); // resolve symlinks (darwin /tmp → /private/tmp)
      const slug = claudeSlug(real);
      const dir = join(homedir(), ".claude", "projects", slug);
      let input = 0, output = 0, kept = false;
      let cacheRead: number | undefined, cacheWrite: number | undefined;
      const seen = new Set<string>(); // message.id is globally unique across session files in one call
      for (const f of newestSessionFiles(dir)) {
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
