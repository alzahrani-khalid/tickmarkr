// v1.70 T4: pure proof-packet builder for `tickmarkr report --bundle <path>`.
// One portable, schema-versioned snapshot of a run — task outcomes, judge evidence
// citations, environment identity, content hashes — secrets redacted via the shared
// redactSecrets seam. No I/O and no network: the caller (report CLI) owns the write.
import { createHash } from "node:crypto";
import type { EvidenceCitation } from "../gates/acceptance.js";
import type { RunEnvironment } from "../run/environment.js";
import type { JournalEvent } from "../run/journal.js";
import { redactSecrets } from "../run/redact.js";
import { recordedEnvironment } from "./compare.js";

// Bump when the packet shape changes in a way a future reader must branch on before parsing.
export const BUNDLE_SCHEMA_VERSION = 1;

// Plain-language known limits — the packet is a journal snapshot, not an unconditional proof.
export const KNOWN_LIMITS: readonly string[] = [
  "This packet is a portable snapshot of journaled run facts, not an independent re-verification of the work or its gates.",
  "Judge evidence citations are copied from the journal as the judge recorded them; this packet does not re-validate citations against the judged diff.",
  "Content hashes bind this packet to the journal bytes used to build it; they do not prove the underlying gates, merges, or tip verification were correct.",
  "Secret-shaped strings are redacted by local pattern matching only; redaction is not a formal security audit.",
  "Producing this packet never contacts a network and never uploads anything.",
];

export type BundleEvidence = string | EvidenceCitation;

export interface BundleJudgeCriterion {
  criterion: string;
  met: boolean;
  reason: string;
  evidence: BundleEvidence;
}

export interface BundleGateResult {
  gate: string;
  pass: boolean;
  details: string;
}

export interface BundleTask {
  taskId: string;
  outcome: "done" | "failed" | "human" | "not-recorded";
  gates: BundleGateResult[];
  /** Judge criteria with evidence citations, when the journal recorded them structured. */
  judgeCriteria: BundleJudgeCriterion[];
}

export interface BundleContentHashes {
  /** sha256 of the canonical JSON of the source journal events used to build this packet. */
  journal: string;
  /** graphDefinitionHash from run-start when recorded. */
  graphDefinitionHash?: string;
}

export interface ProofBundle {
  /** Schema version a future reader must check before parsing the rest. */
  schemaVersion: number;
  runId: string;
  environment?: RunEnvironment;
  contentHashes: BundleContentHashes;
  tasks: BundleTask[];
  /** Plain-language known limits — this is not an unconditional proof of correctness. */
  knownLimits: string[];
}

function contentHash(events: JournalEvent[]): string {
  return createHash("sha256").update(JSON.stringify(events)).digest("hex");
}

function graphHash(events: JournalEvent[]): string | undefined {
  for (const e of events) {
    if (e.event !== "run-start") continue;
    const h = e.data.graphDefinitionHash;
    return typeof h === "string" ? h : undefined;
  }
  return undefined;
}

function taskIds(events: JournalEvent[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of events) {
    if (!e.taskId || seen.has(e.taskId)) continue;
    seen.add(e.taskId);
    out.push(e.taskId);
  }
  return out;
}

function outcomeFor(
  events: JournalEvent[],
  taskId: string,
  runEnd?: JournalEvent,
): BundleTask["outcome"] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.taskId !== taskId) continue;
    if (e.event === "task-done") return "done";
    if (e.event === "task-failed") return "failed";
    if (e.event === "task-human") return "human";
  }
  if (runEnd) {
    const d = runEnd.data;
    if (Array.isArray(d.done) && d.done.includes(taskId)) return "done";
    if (Array.isArray(d.failed) && d.failed.includes(taskId)) return "failed";
    if (Array.isArray(d.human) && d.human.includes(taskId)) return "human";
  }
  return "not-recorded";
}

// Parse a structured evidence citation without rewriting path/line — unaltered copy.
function parseEvidence(raw: unknown): BundleEvidence | undefined {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.path === "string" && typeof o.line === "number" && Number.isInteger(o.line)) {
    return { path: o.path, line: o.line };
  }
  return undefined;
}

// Structured judge criteria on an acceptance gate-result (when journaled). Evidence is copied
// unaltered so a future reader can match citations byte-for-byte to what the judge recorded.
function parseJudgeCriteria(data: Record<string, unknown>): BundleJudgeCriterion[] {
  const raw = data.criteria;
  if (!Array.isArray(raw)) return [];
  const out: BundleJudgeCriterion[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.criterion !== "string" || typeof r.met !== "boolean" || typeof r.reason !== "string") continue;
    const evidence = parseEvidence(r.evidence);
    if (evidence === undefined) continue;
    out.push({ criterion: r.criterion, met: r.met, reason: r.reason, evidence });
  }
  return out;
}

// Deep-walk string leaves through redactSecrets. Numbers/booleans/null stay as-is.
// Structured evidence citations keep path/line unaltered (redact only free-text string evidence).
function redactValue(v: unknown): unknown {
  if (typeof v === "string") return redactSecrets(v);
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(redactValue);
  const o = v as Record<string, unknown>;
  // Preserve structured {path, line} citations unaltered (criterion "unaltered").
  if (typeof o.path === "string" && typeof o.line === "number" && Object.keys(o).length === 2) {
    return { path: o.path, line: o.line };
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) out[k] = redactValue(val);
  return out;
}

/**
 * Build a schema-versioned proof packet from a run's journal events.
 * Pure: no filesystem, no network. Caller writes the result.
 */
export function buildProofBundle(runId: string, events: JournalEvent[]): ProofBundle {
  const runEnd = [...events].reverse().find((e) => e.event === "run-end");
  const environment = recordedEnvironment(events);
  const journalHash = contentHash(events);
  const gHash = graphHash(events);

  const tasks: BundleTask[] = taskIds(events).map((taskId) => {
    const gateEvents = events.filter((e) => e.taskId === taskId && e.event === "gate-result");
    const gates: BundleGateResult[] = [];
    const judgeCriteria: BundleJudgeCriterion[] = [];
    for (const g of gateEvents) {
      const gate = typeof g.data.gate === "string" ? g.data.gate : "unknown";
      const pass = g.data.pass === true;
      const details = typeof g.data.details === "string" ? g.data.details : "";
      gates.push({ gate, pass, details });
      if (gate === "acceptance") {
        for (const c of parseJudgeCriteria(g.data)) judgeCriteria.push(c);
      }
    }
    return {
      taskId,
      outcome: outcomeFor(events, taskId, runEnd),
      gates,
      judgeCriteria,
    };
  });

  const packet: ProofBundle = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    runId,
    ...(environment ? { environment } : {}),
    contentHashes: {
      journal: journalHash,
      ...(gHash ? { graphDefinitionHash: gHash } : {}),
    },
    tasks,
    knownLimits: [...KNOWN_LIMITS],
  };

  // Redact secret-shaped strings anywhere in the packet. Structured {path,line} citations stay intact.
  return redactValue(packet) as ProofBundle;
}
