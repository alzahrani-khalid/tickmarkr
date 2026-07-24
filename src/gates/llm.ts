import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerAdapter } from "../adapters/types.js";
import { formatOwnedName, parseOwnedName, type ExecutorDriver, type Slot } from "../drivers/types.js";
import { bannerShell, paneDispatchCommand } from "../brand.js";
import { sh } from "../run/git.js";

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

// v1.64: scripted fake judge verdicts predate the required per-criterion evidence field — quote the
// first line of the prompt's own diff block into rows lacking one so zero-token fixtures keep their
// outcomes. Rows scripting an explicit evidence value pass through verbatim (tests exercise both paths).
function injectFakeEvidence(obj: Record<string, unknown>, prompt: string): Record<string, unknown> {
  if (!prompt.startsWith("TICKMARKR-JUDGE") || !Array.isArray(obj.criteria)) return obj;
  const line = /```diff\n([\s\S]*?)```/.exec(prompt)?.[1].split("\n").find((l) => l.trim());
  if (!line) return obj;
  const criteria = (obj.criteria as unknown[]).map((row) =>
    row && typeof row === "object" && !("evidence" in row) ? { ...row, evidence: line } : row);
  return { ...obj, criteria };
}

// ponytail: fake adapter serves static verdict JSON without nonce; append a bound copy for zero-token tests.
export function augmentFakeVerdictOutput(adapter: WorkerAdapter, out: string, nonce: string, prompt = ""): string {
  if (adapter.id !== "fake") return out;
  const obj = extractJson<Record<string, unknown>>(out);
  if (!obj || typeof obj !== "object" || obj.nonce === nonce) return out;
  if (typeof obj.nonce === "string") return out;
  return `${out}\n${JSON.stringify(injectFakeEvidence({ ...obj, nonce }, prompt))}`;
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
}

export interface GateVia {
  driver: ExecutorDriver;
  keep?: boolean;
  onSlot?: (slot: Slot) => void;
  nameFor: (role: "judge" | "review", adapter: string) => string;
  labelFor: (role: "judge" | "review") => string; // role-tab label, mirrors nameFor (SUP-01)
}

const llmOutputCapture = new AsyncLocalStorage<string[]>();

// OBS-132: acceptance.ts owns verdict parsing and is deliberately byte-untouched. This async-scoped
// recorder lets run-gates observe the exact output that acceptance parsed without changing runLlm's
// return value or leaking concurrent tasks into one another. Callers retain output only when the
// resulting verdict is a production failure; healthy output is discarded in memory.
export async function captureLlmOutput<T>(run: () => Promise<T>): Promise<{ value: T; outputs: string[] }> {
  const outputs: string[] = [];
  const value = await llmOutputCapture.run(outputs, run);
  return { value, outputs };
}

export async function runHeadless(
  adapter: WorkerAdapter,
  model: string,
  prompt: string,
  cwd: string,
  timeoutMs = 300000,
): Promise<string> {
  const pf = join(mkdtempSync(join(tmpdir(), "tickmarkr-llm-")), "prompt.md");
  writeFileSync(pf, prompt);
  const r = await sh(adapter.headlessCommand(pf, model), cwd, timeoutMs);
  const nonce = extractPromptNonce(prompt);
  let out = r.stdout + "\n" + r.stderr;
  if (nonce) out = augmentFakeVerdictOutput(adapter, out, nonce, prompt);
  return out;
}

// v1.1 default path: the same headless CLI call, but dispatched through the driver
// as a visible named agent (herdr pane), with the quote-split completion wrapper.
export async function runViaDriver(
  adapter: WorkerAdapter,
  model: string,
  prompt: string,
  cwd: string,
  via: LlmVia,
  timeoutMs = 300000,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-llm-"));
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
  const slot = await via.driver.slot(cwd, rolePaneNameFromPrompt(prompt, via.name), via.label ? { label: via.label } : undefined);
  via.onSlot?.(slot);
  await via.driver.run(slot, paneDispatchCommand(scriptPath));
  // nonce-suffixed exit only: a displayed bare "TICKMARKR_EXIT:" or another call's marker must not
  // false-complete — same guard the worker path uses (daemon.ts:330-331).
  await via.driver.waitOutput(slot, `TICKMARKR_EXIT_${nonce}:\\d`, timeoutMs, { regex: true });
  let out = await via.driver.read(slot, 400);
  if (!via.keep) await via.driver.close(slot);
  out = augmentFakeVerdictOutput(adapter, out, nonce, prompt);
  return dewrapPaneVerdict(out, nonce);
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
  const lines = out.split("\n");
  const start = lines.findIndex((line) => /^\s*(?:[•*-]\s+)?\{/.test(line));
  if (start < 0) return out;
  for (let end = start; end < lines.length; end++) {
    const joined = lines
      .slice(start, end + 1)
      .map((line, i) => (i === 0 ? line.replace(/^\s*(?:[•*-]\s+)?/, "") : line.replace(/^\s+/, "")))
      .join("")
      .trimEnd();
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
  return out;
}

export async function runLlm(
  adapter: WorkerAdapter,
  model: string,
  prompt: string,
  cwd: string,
  via?: LlmVia,
  timeoutMs = 300000,
): Promise<string> {
  const out = await (via
    ? runViaDriver(adapter, model, prompt, cwd, via, timeoutMs)
    : runHeadless(adapter, model, prompt, cwd, timeoutMs));
  llmOutputCapture.getStore()?.push(out);
  return out;
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
  let pos = raw.length - 1;
  while (pos >= 0) {
    const end = raw.lastIndexOf("}", pos);
    if (end === -1) return null;
    let depth = 1;
    let stepped = false;
    for (let i = end - 1; i >= 0; i--) {
      if (raw[i] === "}") depth++;
      else if (raw[i] === "{") {
        depth--;
        if (depth === 0) {
          stepped = true;
          try {
            const v = JSON.parse(raw.slice(i, end + 1));
            if (v && typeof v === "object" && v.nonce === nonce) {
              const { nonce: _n, ...rest } = v as { nonce?: string };
              return rest as T;
            }
          } catch {
            /* keep scanning */
          }
          pos = i - 1;
          break;
        }
      }
    }
    if (!stepped) return null;
  }
  return null;
}
