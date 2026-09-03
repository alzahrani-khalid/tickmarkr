import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesTrustDialog, type WorkerAdapter } from "../adapters/types.js";
import { formatOwnedName, parseOwnedName, type ExecutorDriver, type Slot } from "../drivers/types.js";
import { bannerShell, paneDispatchCommand } from "../brand.js";
import { sh } from "../run/git.js";
import {
  harvestCpuFlatWindowMs,
  normalizeStallSnapshot,
  WorkerTreeCpuAccountant,
} from "../run/stall.js";

export const GATE_PANE_SEP = " · ";

// v1.64 gate-integrity (repo-scan Tier A·1): the concrete completion-faking shortcuts every
// judge/review verdict must hunt for. Shared verbatim by the acceptance judge and review prompts.
export const COMPLETION_FAKING_CHECKLIST = `## Completion-faking checklist
Hunt for these concrete completion-faking shortcuts before ruling on any criterion:
- hardcoded-result: output or fixture hardcoded to satisfy the stated criterion instead of real logic
- test-weakening: tests skipped, deleted, or assertions loosened until failing behavior looks green
- vacuous-assertion: a test that cannot fail (asserts a constant, asserts its own setup, no assertion)
- fixture-overfit: implementation narrowed to the exact test inputs rather than the described behavior
- echo-not-implement: criterion text echoed in names, comments, or strings without the behavior itself
- stub-left-behind: TODO, throw, or no-op stub where the real implementation should be
- error-swallowing: catch or fallback that hides failures instead of handling them
- self-mocking: the code under test mocked or faked so the test exercises the mock
- check-bypass: lint, type, or CI checks disabled, relaxed, or excluded to get green
- rename-as-work: code moved or renamed and presented as the requested change
- scope-padding: unrelated edits padding the diff while the criterion's behavior is untouched
When a criterion fails, the verdict MUST name which shortcut above it matches, or state that none does.`;

/** Fable F3: per-call nonce echoed in verdict JSON and gate exit markers. */
export function generateVerdictNonce(): string {
  return randomBytes(4).toString("hex");
}

export interface AnchoredComment {
  path: string;
  line: number;
  body: string;
}

// v1.79 T5: comments are an optional side channel on an otherwise authoritative verdict. The whole
// block is accepted only when every row names one actionable path:line; absent or malformed input
// becomes no comments and therefore preserves the pre-comments prose bytes and verdict semantics.
export function parseAnchoredComments(verdict: unknown): AnchoredComment[] {
  if (!verdict || typeof verdict !== "object") return [];
  const raw = (verdict as Record<string, unknown>).comments;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const comments: AnchoredComment[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") return [];
    const { path, line, body } = row as Record<string, unknown>;
    const cleanPath = typeof path === "string" ? path.trim() : "";
    const cleanBody = typeof body === "string" ? body.trim() : "";
    if (!cleanPath || /[\r\n]/.test(cleanPath) || !Number.isInteger(line) || (line as number) < 1 || !cleanBody) {
      return [];
    }
    comments.push({ path: cleanPath, line: line as number, body: cleanBody });
  }
  return comments;
}

export function renderAnchoredReview(verdict: unknown): string {
  const comments = parseAnchoredComments(verdict);
  if (comments.length === 0) return "";
  return `## Anchored review\n${comments.map((c) => `- ${c.path}:${c.line} — ${c.body}`).join("\n")}`;
}

export function appendAnchoredReview(prose: string, verdict: unknown): string {
  const block = renderAnchoredReview(verdict);
  return block ? `${prose}\n\n${block}` : prose;
}

export function verdictNonceLine(nonce: string): string {
  return `VERDICT_NONCE: ${nonce}`;
}

export function extractPromptNonce(prompt: string): string | null {
  return /VERDICT_NONCE:\s*([0-9a-f]+)/i.exec(prompt)?.[1] ?? null;
}

export function gateExitTrailer(nonce: string): string {
  return `printf '\\nTICKMARKR_''EXIT_${nonce}:%s\\n' $?`;
}

export type GatePaneRole = "judge" | "review" | "consult";

/** T8: role-first pane name for fleet visibility — judge · T4, review · T3, consult · T2. */
export function gatePaneName(role: GatePaneRole, taskId: string, suffix = ""): string {
  return `${role}${GATE_PANE_SEP}${taskId}${suffix}`;
}

// T8: gate prompts carry ## Task <id>: — derive the role-first pane name from the marker + header;
// via.name remains the fallback for non-gate runViaDriver callers and carries -r1 retry suffixes.
// T2 ownership contract: a canonical owned fallback (the daemon's nameFor now emits one) passes
// through untouched; run-gates' "-r1" judge-retry suffix becomes attempt+1 so the retry pane's name
// stays contract-parseable (tickmarkr:judge:<task>:1:<runId>) instead of a corrupted-runId shape.
export function rolePaneNameFromPrompt(prompt: string, fallback: string): string {
  const retry = fallback.endsWith("-r1");
  const base = retry ? fallback.slice(0, -3) : fallback;
  const owned = parseOwnedName(base);
  if (owned) return retry ? formatOwnedName({ ...owned, attempt: owned.attempt + 1 }) : base;
  const id = prompt.match(/## Task ([^\n:]+):/)?.[1];
  if (!id) return fallback;
  if (prompt.startsWith("TICKMARKR-JUDGE")) return gatePaneName("judge", id, retry ? "-r1" : "");
  if (prompt.startsWith("TICKMARKR-REVIEW")) return gatePaneName("review", id, retry ? "-r1" : "");
  return fallback;
}

export interface LlmVia {
  driver: ExecutorDriver;
  name: string; // fallback slot name; gate panes resolve to gatePaneName via rolePaneNameFromPrompt
  label?: string; // dedicated role-tab label (SUP-01), e.g. "REVIEW T2"; undefined → tab named after the slot
  keep?: boolean; // true → leave the pane open after reading (visibility.keepPanes)
  onSlot?: (slot: Slot) => void; // lets the daemon register kept slots for run-end cleanup
  // The inactivity policy is transport provenance, not responder text. Gate callers that need to
  // classify a no-answer result receive it through this callback, so a reviewer cannot forge the
  // infrastructure marking by printing a magic string in its own output.
  onInactivity?: () => void;
}

export interface GateVia {
  driver: ExecutorDriver;
  keep?: boolean;
  onSlot?: (slot: Slot) => void;
  nameFor: (role: "judge" | "review", adapter: string) => string;
  labelFor: (role: "judge" | "review") => string; // role-tab label, mirrors nameFor (SUP-01)
}

const llmOutputCapture = new AsyncLocalStorage<string[]>();

// v2.0 T1 (OBS-555): the empirical healthy-duration p95 is 10.6 minutes. The smallest whole
// minute above it plus the specified one-minute margin is twelve minutes. This default remains
// strictly below BOTH unchanged 900_000ms production dispatch timeouts: JUDGE_TIMEOUT_MS in
// acceptance.ts and reviewGate's literal timeout in review.ts. Scope's 300_000ms call is not a
// verdict gate and retains its existing one-wait behavior.
export const GATE_INACTIVITY_WINDOW_MS = 12 * 60_000;
const GATE_WAIT_SLICE_MS = 30_000;
let gateInactivityWindowMs = GATE_INACTIVITY_WINDOW_MS;

/** Test seam — shrink only the calibrated inactivity window; production always reads 12 minutes. */
export function setGateInactivityWindowMsForTests(ms: number): void {
  gateInactivityWindowMs = ms;
}

export function resetGateInactivityWindowMsForTests(): void {
  gateInactivityWindowMs = GATE_INACTIVITY_WINDOW_MS;
}

export interface GateCpuAccountant {
  start(): Promise<void>;
  read(): { cpu: { ms: number; resolutionMs: number } | undefined; gaps: number };
  stop(): Promise<void>;
}

export type GateCpuAccountantFactory = (marker: string, cwd: string) => GateCpuAccountant;
const productionGateCpuAccountant: GateCpuAccountantFactory =
  (marker, cwd) => new WorkerTreeCpuAccountant(marker, cwd);
let gateCpuAccountantFactory = productionGateCpuAccountant;

/** Test seam for deterministic measurable/activity/gap samples without platform-specific ps output. */
export function setGateCpuAccountantFactoryForTests(factory: GateCpuAccountantFactory): void {
  gateCpuAccountantFactory = factory;
}

export function resetGateCpuAccountantFactoryForTests(): void {
  gateCpuAccountantFactory = productionGateCpuAccountant;
}

// OBS-132: acceptance.ts owns verdict parsing and is deliberately byte-untouched. This async-scoped
// recorder lets run-gates observe the exact output that acceptance parsed without changing runLlm's
// return value or leaking concurrent tasks into one another. Callers retain output only when the
// resulting verdict is a production failure; healthy output is discarded in memory.
export async function captureLlmOutput<T>(run: () => Promise<T>): Promise<{ value: T; outputs: string[] }> {
  const outputs: string[] = [];
  const value = await llmOutputCapture.run(outputs, run);
  return { value, outputs };
}

export interface LlmRunResult {
  output: string;
  exitCode?: number;
  timedOut: boolean;
}

async function runHeadlessDetailed(
  adapter: WorkerAdapter,
  model: string,
  prompt: string,
  cwd: string,
  timeoutMs = 300000,
): Promise<LlmRunResult> {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-llm-"));
  try {
    const pf = join(dir, "prompt.md");
    writeFileSync(pf, prompt);
    const r = await sh(adapter.headlessCommand(pf, model), cwd, timeoutMs);
    return { output: r.stdout + "\n" + r.stderr, exitCode: r.code, timedOut: r.timedOut === true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runHeadless(
  adapter: WorkerAdapter,
  model: string,
  prompt: string,
  cwd: string,
  timeoutMs = 300000,
): Promise<string> {
  return (await runHeadlessDetailed(adapter, model, prompt, cwd, timeoutMs)).output;
}

// v1.1 default path: the same headless CLI call, but dispatched through the driver
// as a visible named agent (herdr pane), with the quote-split completion wrapper.
async function runViaDriverDetailed(
  adapter: WorkerAdapter,
  model: string,
  prompt: string,
  cwd: string,
  via: LlmVia,
  timeoutMs = 300000,
): Promise<LlmRunResult> {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-llm-"));
  let slot: Slot | undefined;
  let accountant: GateCpuAccountant | undefined;
  try {
    const pf = join(dir, "prompt.md");
    writeFileSync(pf, prompt);
    const scriptPath = join(dir, "dispatch.sh");
    // OBS-50: bootstrap in a script beside the prompt — pane sees one short bash line + banner, not the raw inline command
    const nonce = extractPromptNonce(prompt) ?? generateVerdictNonce();
    writeFileSync(scriptPath, [
      "export BASH_SILENCE_DEPRECATION_WARNING=1",
      bannerShell(),
      adapter.headlessCommand(pf, model),
      gateExitTrailer(nonce),
    ].join("\n"));
    slot = await via.driver.slot(cwd, rolePaneNameFromPrompt(prompt, via.name), via.label ? { label: via.label } : undefined);
    via.onSlot?.(slot);
    await via.driver.run(slot, paneDispatchCommand(scriptPath));
    if (via.driver.sendKey) {
      try {
        if (matchesTrustDialog(await via.driver.read(slot, 400), adapter.trustDialog)) {
          await via.driver.sendKey(slot, adapter.trustDialog.key);
        }
      } catch {
        /* a failed pre-wait read must not replace the verdict wait */
      }
    }
    // nonce-suffixed exit only: a displayed bare "TICKMARKR_EXIT:" or another call's marker must not
    // false-complete — same guard the worker path uses (daemon.ts:330-331).
    const exitPattern = `TICKMARKR_EXIT_${nonce}:\\d`;
    let out: string;
    let timedOut = false;
    const gatePrompt = prompt.startsWith("TICKMARKR-JUDGE") || prompt.startsWith("TICKMARKR-REVIEW");
    if (!gatePrompt) {
      await via.driver.waitOutput(slot, exitPattern, timeoutMs, { regex: true });
      out = await via.driver.read(slot, 400);
    } else {
      // Review and judge waits are sliced so the two-leg inactivity policy can observe the pane and
      // the exact dispatch script's process tree between waits. The accountant retains short-lived
      // descendants with the same semantics as daemon workers; llm.ts depends only on stall.ts.
      accountant = gateCpuAccountantFactory(scriptPath, cwd);
      await accountant.start();
      const startedAt = Date.now();
      out = await via.driver.read(slot, 400);
      let priorSnapshot = normalizeStallSnapshot(out);
      const anchoredAt = Date.now();
      let quietSince = anchoredAt;
      const initialCpu = accountant.read();
      let priorCpuMs = initialCpu.cpu?.ms;
      let priorGaps = initialCpu.gaps;
      let cpuFlatSince = initialCpu.cpu === undefined ? undefined : anchoredAt;
      while (Date.now() - startedAt < timeoutMs) {
        const remaining = timeoutMs - (Date.now() - startedAt);
        // The adaptive test-window arm keeps a seam-adjusted case sliced too; production stays 30s.
        const sliceMs = Math.max(1, Math.min(GATE_WAIT_SLICE_MS, Math.ceil(gateInactivityWindowMs / 4), remaining));
        const matched = await via.driver.waitOutput(slot, exitPattern, sliceMs, { regex: true });
        const raw = await via.driver.read(slot, 400);
        out = raw;
        // waitOutput is the driver's authoritative marker match. The raw check covers drivers whose
        // wait timed out at the same boundary the marker landed; either way a trailer completes
        // normally and is never mistaken for inactivity.
        if (matched || new RegExp(exitPattern).test(raw)) break;

        const now = Date.now();
        const snapshot = normalizeStallSnapshot(raw);
        if (snapshot !== priorSnapshot) {
          priorSnapshot = snapshot;
          quietSince = now;
        }

        const observation = accountant.read();
        const cpu = observation.cpu;
        if (observation.gaps !== priorGaps || cpu === undefined) {
          // Missing evidence is a hold-open signal, never guessed inactivity. A later measurable
          // sample starts a fresh complete window rather than inheriting quiet time across the gap.
          priorGaps = observation.gaps;
          priorCpuMs = undefined;
          cpuFlatSince = undefined;
          quietSince = now;
          continue;
        }
        if (priorCpuMs === undefined || cpu.ms !== priorCpuMs) {
          // Any process-tree CPU movement holds the call open and re-arms both clocks. Equality only
          // becomes "flat" after the existing resolution-aware quantum window has elapsed.
          priorCpuMs = cpu.ms;
          cpuFlatSince = now;
          quietSince = now;
          continue;
        }
        const cpuFlatFor = now - (cpuFlatSince ?? now);
        const snapshotQuietFor = now - quietSince;
        if (cpuFlatFor >= harvestCpuFlatWindowMs(cpu.resolutionMs)
          && snapshotQuietFor >= gateInactivityWindowMs) {
          via.onInactivity?.();
          break;
        }
      }
      timedOut = Date.now() - startedAt >= timeoutMs && !new RegExp(exitPattern).test(out);
    }
    const exitCode = Number(new RegExp(`TICKMARKR_EXIT_${nonce}:(\\d+)`).exec(out)?.[1]);
    return {
      output: dewrapPaneVerdict(out, nonce),
      ...(Number.isFinite(exitCode) ? { exitCode } : {}),
      timedOut,
    };
  } finally {
    try {
      await accountant?.stop();
      if (slot && !via.keep) await via.driver.close(slot);
    } finally {
      // Unconditional and synchronous: a stop/close failure must not leak this call's prompt and script.
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export async function runViaDriver(
  adapter: WorkerAdapter,
  model: string,
  prompt: string,
  cwd: string,
  via: LlmVia,
  timeoutMs = 300000,
): Promise<string> {
  return (await runViaDriverDetailed(adapter, model, prompt, cwd, via, timeoutMs)).output;
}

// OBS-155: a TUI renders the verdict as a bullet and HARD-wraps it at pane width with a 2-space
// continuation indent, splitting words mid-token — so literal newlines land inside JSON string
// literals and ZERO lines begin with `{`. `--source recent-unwrapped` cannot undo it: the wrap is
// the TUI's own rendering, not a terminal soft wrap (driver.read already requests that source, and
// the captured k3 transcript arrived wrapped anyway). A perfect verdict was therefore scored a
// flake and rescued by a retry on another channel — 70 such judge-retries are on record across
// k3, fable AND sol, so this is a width-dependent flake generator under every pane-mode gate.
//
// Fail-closed by construction, per the overseer's constraints: reconstruction is bounded to the
// brace-delimited region, the rejoined text must PARSE, and it must carry THIS call's nonce.
// Anything else returns the bytes untouched, so an unparseable verdict stays a failure. The
// reconstruction is APPENDED, never substituted: extractJson takes the last balanced object, so
// the good copy wins while the original rendering survives verbatim for the evidence capture.
export function dewrapPaneVerdict(out: string, nonce: string): string {
  if (!out.includes(nonce)) return out;
  // Preserve already-readable responder bytes; only a genuinely wrapped verdict needs reconstruction.
  if (extractVerdictJson<Record<string, unknown>>(out, nonce)) return out;
  const lines = out.split("\n");
  // OBS-209: EVERY brace-start is a candidate, scanned newest-first. findIndex took only the first,
  // so any earlier line beginning with `{` — a quoted snippet, a lone brace in the reviewer's own
  // reasoning — captured the scan, and the real verdict below it was unreachable no matter how far
  // the join extended. Measured on run-20260728-110135 T1: kimi's nonce-bound APPROVAL sat at line
  // 382 behind a bare `{` at line 189, so a passing review was recorded `malformed-verdict` and
  // parked the task. Newest-first matches extractJson, which takes the LAST balanced object.
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:[•*-]\s+)?\{/.test(lines[i]!)) starts.push(i);
  }
  for (let si = starts.length - 1; si >= 0; si--) {
    const start = starts[si]!;
    for (let end = start; end < lines.length; end++) {
      const joined = lines
        .slice(start, end + 1)
        .map((line, i) => (i === 0 ? line.replace(/^\s*(?:[•*-]\s+)?/, "") : line.replace(/^\s+/, "")))
        .join("")
        .trimEnd();
      // ponytail: no verdict is a megabyte; abandon a runaway candidate rather than rejoin the
      // whole transcript once per brace-start. Raise the ceiling if a real verdict ever exceeds it.
      if (joined.length > 1_000_000) break;
      if (!joined.endsWith("}")) continue;
      try {
        const parsed: unknown = JSON.parse(joined);
        // the nonce IS the acceptance test — never reconstruct a verdict this call did not ask for
        if (parsed && typeof parsed === "object" && (parsed as { nonce?: unknown }).nonce === nonce) {
          return `${out}\n${joined}`;
        }
      } catch {
        /* not yet a complete object — keep extending within the bounded region */
      }
    }
  }
  return out;
}

export async function runLlmDetailed(
  adapter: WorkerAdapter,
  model: string,
  prompt: string,
  cwd: string,
  via?: LlmVia,
  timeoutMs = 300000,
): Promise<LlmRunResult> {
  const result = await (via
    ? runViaDriverDetailed(adapter, model, prompt, cwd, via, timeoutMs)
    : runHeadlessDetailed(adapter, model, prompt, cwd, timeoutMs));
  llmOutputCapture.getStore()?.push(result.output);
  return result;
}

export async function runLlm(
  adapter: WorkerAdapter,
  model: string,
  prompt: string,
  cwd: string,
  via?: LlmVia,
  timeoutMs = 300000,
): Promise<string> {
  return (await runLlmDetailed(adapter, model, prompt, cwd, via, timeoutMs)).output;
}

export function extractJson<T>(raw: string): T | null {
  const fenced = [...raw.matchAll(/```json\s*\n([\s\S]*?)```/g)].at(-1);
  if (fenced) {
    try {
      const v = JSON.parse(fenced[1]);
      if (v && typeof v === "object") return v as T;
    } catch {
      /* fall through to bare objects */
    }
  }
  // Find the last balanced {...} object by scanning backwards from the last }
  let pos = raw.length - 1;
  while (pos >= 0) {
    const end = raw.lastIndexOf("}", pos);
    if (end === -1) return null;
    let depth = 1;
    for (let i = end - 1; i >= 0; i--) {
      if (raw[i] === "}") depth++;
      else if (raw[i] === "{") {
        depth--;
        if (depth === 0) {
          try {
            const v = JSON.parse(raw.slice(i, end + 1));
            if (v && typeof v === "object") return v as T;
          } catch {
            /* keep scanning */
          }
          pos = i - 1;
          break;
        }
      }
    }
    if (depth !== 0) return null; // No matching brace found
  }
  return null;
}

/** Fable F3: verdict JSON must echo the call nonce — skip unbound or mismatched objects. */
export function extractVerdictJson<T>(raw: string, nonce: string): T | null {
  const fenced = [...raw.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  for (let fi = fenced.length - 1; fi >= 0; fi--) {
    try {
      const v = JSON.parse(fenced[fi]![1]);
      if (v && typeof v === "object" && v.nonce === nonce) {
        const { nonce: _n, ...rest } = v as { nonce?: string };
        return rest as T;
      }
    } catch {
      /* fall through */
    }
  }
  for (let start = raw.lastIndexOf("{"); start >= 0;) {
    const nextStart = start === 0 ? -1 : raw.lastIndexOf("{", start - 1);
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < raw.length; i++) {
      const char = raw[i]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try {
          const v = JSON.parse(raw.slice(start, i + 1));
          if (v && typeof v === "object" && v.nonce === nonce) {
            const { nonce: _n, ...rest } = v as { nonce?: string };
            return rest as T;
          }
        } catch {
          /* keep scanning */
        }
        break;
      }
    }
    start = nextStart;
  }
  return null;
}
