// T31 (F1 + Q18's producer half): ONE vocabulary for what a gate phase actually did, and ONE
// normalizer that reads every shape the shipped record already writes into it.
//
// This module is a PRODUCER ONLY. It is a new file with no imports and no writes: nothing it exports
// replaces or re-types an existing symbol, so capture.ts, demo.ts, live.ts, run-cockpit.tsx and
// setup-cockpit.tsx — and every other current caller — compile exactly as before. It adds no general
// reducer and no dual-write. The read-side wiring of status, the Markdown report, the proof bundle and
// the retained derive projection is T41's; the typed writer half is T40's.
//
// Why a vocabulary at all. The legacy record spells a gate's NON-FAILURE across four disjoint fields —
// `pass`, `skipped`, `verdict` and `infra` — and a row may state NONE of them: daemon.ts:1376 omits
// `pass` entirely for a decline, because a review that did not run has no verdict to state. Every
// consumer therefore re-derived the same question from raw fields, and each one that got it wrong read
// a non-failure as a green. The union below makes that collapse unrepresentable: a gate that did not
// run cannot be spelled `passed`, and a row nobody can read cannot be spelled clean.

/**
 * What a gate phase did, closed. `passed` and `failed` are verdicts and carry nothing else; every
 * other member is a NON-VERDICT and must say why, so no arm of this union can be produced without the
 * reason a reader needs to act on it.
 */
export type GateOutcome =
  | { kind: "passed" }
  | { kind: "failed" }
  /** The gate had nothing to run — the repository configures no such command (baseline.ts:262). */
  | { kind: "skipped"; reason: string }
  /** A policy declined to run the gate that was configured (review.ts:411). */
  | { kind: "declined"; reason: string }
  /** A green that is not yet the verdict — a screen the full suite has not superseded. */
  | { kind: "held"; reason: string }
  /** The outcome could not be read at all. Never clean, never a pass. */
  | { kind: "unavailable"; reason: string }
  /** The runner died on the machine, so the gate verified nothing whatever it reported. */
  | { kind: "infra"; reason: string; retryable: boolean };

/** The closed table, as data — a consumer can range over the vocabulary without re-listing it. */
export const GATE_OUTCOME_KINDS = [
  "passed", "failed", "skipped", "declined", "held", "unavailable", "infra",
] as const satisfies readonly GateOutcome["kind"][];

export type GateOutcomeKind = (typeof GATE_OUTCOME_KINDS)[number];

// Closed in BOTH directions, at compile time. The `satisfies` above rejects a table entry the union
// does not carry; the alias below rejects a union member the table omits — Exclude then resolves to a
// live string literal, which does not satisfy `extends never`, and this file stops compiling.
type AssertNever<T extends never> = T;
export type UntabledGateOutcomeKind = AssertNever<Exclude<GateOutcome["kind"], GateOutcomeKind>>;

const stated = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/**
 * Every reason the row states, in the order the record writes them. A declined review populates BOTH
 * fields with different facts — `reason` is the policy's reason, `details` the operator-facing
 * sentence — so preferring either one alone would silently drop the other.
 */
function reasonOf(row: Record<string, unknown>, fallback: string): string {
  const reasons = [...new Set([stated(row.reason), stated(row.details)])].filter(
    (r): r is string => r !== undefined,
  );
  return reasons.join(" — ") || fallback;
}

// Presence, not truthiness, is the boundary: a canonical outcome and any one of the four fields that
// spell legacy truth would be a dual-write. Treating even a consistent-looking pair as canonical
// would let a contradictory legacy field become clean as soon as producers drifted apart.
const LEGACY_OUTCOME_DISCRIMINATORS = ["pass", "skipped", "verdict", "infra"] as const;

const hasOwn = (row: Record<string, unknown>, field: string): boolean =>
  Object.prototype.hasOwnProperty.call(row, field);

function legacyDiscriminatorsOf(row: Record<string, unknown>): string[] {
  return LEGACY_OUTCOME_DISCRIMINATORS.filter((field) => hasOwn(row, field));
}

/** The gates the baseline battery runs (run-gates.ts:203) — the only producer of a command-absent skip. */
const BASELINE_GATES = new Set(["build", "test", "lint"]);

/**
 * The oldest declines predate the `skipped` field entirely and state the decline only in the details
 * prefix ("skipped — complexity 4 < threshold 7"). This compatibility branch is limited to that
 * historical shape: a review carrying the old `pass: true` encoding and neither modern decline
 * discriminator. The ^ anchor is load-bearing too: a review that genuinely RAN can mention a skipped
 * something mid-body, and a failed non-review gate can begin its diagnostic with that word.
 */
const declinedByDetails = (row: Record<string, unknown>): boolean =>
  row.gate === "review"
  && row.pass === true
  && !hasOwn(row, "skipped")
  && !hasOwn(row, "verdict")
  && /^skipped\b/.test(String(row.details ?? ""));

/**
 * Already-canonical input, validated arm by arm. This is what makes the normalizer idempotent over the
 * vocabulary: T40 will publish typed outcomes while pre-T40 journals still hold legacy rows, and a
 * projection must be able to call this on either without asking which era it is reading.
 */
function isGateOutcome(value: unknown): value is GateOutcome {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  if (legacyDiscriminatorsOf(o).length > 0) return false;
  switch (o.kind) {
    case "passed":
    case "failed":
      return true;
    case "skipped":
    case "declined":
    case "held":
    case "unavailable":
      return typeof o.reason === "string";
    case "infra":
      return typeof o.reason === "string" && typeof o.retryable === "boolean";
    default:
      return false;
  }
}

/**
 * Read one gate outcome — canonical or legacy — as a member of the closed vocabulary.
 *
 * Takes `unknown` deliberately: the malformed row is a real input class, not a caller error. A journal
 * row's `data` is `Record<string, unknown>` and a `GateResult`'s `{ ...meta }` spread is the same
 * shape, so both pass without a cast and neither needs its own entry point.
 */
export function normalizeGateOutcome(source: unknown): GateOutcome {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    const shape = source === null ? "null" : Array.isArray(source) ? "an array" : typeof source;
    return { kind: "unavailable", reason: `malformed gate result: expected an object, read ${shape}` };
  }
  const row = source as Record<string, unknown>;

  // A gate-result data wrapper states its canonical verdict in `outcome`. Consumers may pass either
  // the wrapper or the outcome itself; both must read the same kind even if stale bare fields remain.
  if (hasOwn(row, "outcome")) {
    if (isGateOutcome(row.outcome)) return row.outcome;
    return { kind: "unavailable", reason: reasonOf(row, "malformed gate result: invalid explicit outcome") };
  }

  // `kind` selects the canonical outcome object. It must validate as exactly one canonical arm without any
  // legacy truth discriminator; otherwise continuing through the legacy branches could reinterpret a
  // contradictory dual-write as passed, failed or infra. Mixed and malformed canonical rows stay
  // explicitly unavailable, retaining any reason/details the producer did manage to state.
  if (hasOwn(row, "kind")) {
    if (isGateOutcome(source)) return source;
    const legacyFields = legacyDiscriminatorsOf(row);
    const fallback = legacyFields.length > 0
      ? `malformed gate result: canonical kind cannot carry legacy discriminator(s): ${legacyFields.join(", ")}`
      : "malformed gate result: invalid canonical outcome";
    return { kind: "unavailable", reason: reasonOf(row, fallback) };
  }

  // Infra dominates every other field (daemon.ts:220): a runner that died on the machine verified
  // nothing, so this is checked before any clause that could read the same row as satisfied.
  // `retryable` defaults true because the one shipped producer of these rows (baseline.ts:277) is by
  // construction the retryable class — "the runner never completed a suite" — and a later producer
  // that knows its failure is terminal says so on the row rather than relying on this default.
  if (row.infra === true) {
    return {
      kind: "infra",
      reason: reasonOf(row, "the runner never completed a suite, so this gate verified nothing"),
      retryable: row.retryable !== false,
    };
  }

  // Two different facts wear the same `skipped: true` flag, and telling them apart is most of why this
  // vocabulary exists. The GATE IDENTITY is what separates them, not `pass` and not `verdict`: the
  // command-absent skip has exactly one producer, the baseline battery, which runs build/test/lint
  // only (run-gates.ts:203) and records a gate the repository never configured with `pass: true`
  // beside `skipped: true` (baseline.ts:262). Every OTHER skip is a policy declining a gate that WAS
  // configured. That distinction cannot be read off `pass`, because the review declines persisted in
  // pre-R3 journals carry `pass: true` too — R3 (daemon.ts:1386) only stopped writing a verdict for
  // NEW ones, and the old rows are still on disk. Reading them by field alone files a policy decline
  // as "no command detected", which is the same collapse in a quieter costume.
  if (row.skipped === true || row.verdict === "skipped" || declinedByDetails(row)) {
    const commandAbsent = BASELINE_GATES.has(String(row.gate))
      && row.pass === true
      && row.verdict !== "skipped";
    return commandAbsent
      ? { kind: "skipped", reason: reasonOf(row, "no command detected for this gate") }
      : { kind: "declined", reason: reasonOf(row, "a policy declined to run this gate") };
  }

  // A selected-test green is a SCREEN and never the merge verdict (journal.ts:1067). It reports
  // `pass: true`, so reading it by that field alone is exactly the collapse of a non-failure into a
  // pass — the full suite has not spoken yet.
  if (row.pass === true && Array.isArray(row.selectedTests) && row.fullSuite !== true) {
    return {
      kind: "held",
      reason: reasonOf(row, `${row.selectedTests.length} selected test(s) screened; the full suite has not spoken`),
    };
  }

  if (row.pass === true) return { kind: "passed" };
  if (row.pass === false) return { kind: "failed" };

  // Neither a verdict nor a stated non-run. Unknown is not clean: it stays non-passing and carries
  // whatever the row did say, so a reader can see why it could not be read.
  return {
    kind: "unavailable",
    reason: reasonOf(row, "gate result states no pass, skip, decline or infra verdict"),
  };
}
