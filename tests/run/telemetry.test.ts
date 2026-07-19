import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { TokenUsageSchema } from "../../src/adapters/types.js";
import { TelemetryRowSchema } from "../../src/run/journal.js";

// TEL-01 (structural pin): the worker's TICKMARKR_RESULT self-report must never reach the reward signal.
// A behavioral test proves the reward is clean for the scripted path; this grep proves it for EVERY path.
// Read daemon.ts as text and assert no journal.telemetry(...) call site passes a `result` or a bare `ok`
// token — the outcome derives only from gates + merge, never from what the worker claimed.
describe("TEL-01 grep-assertion: no telemetry call site trusts the worker trailer", () => {
  const src = readFileSync(fileURLToPath(new URL("../../src/run/daemon.ts", import.meta.url)), "utf8");

  test("every journal.telemetry(...) arg carries no `result`/bare-`ok` token, across >= 3 call sites", () => {
    const re = /journal\.telemetry\(([^)]*)\)/g;
    let sites = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      sites++;
      const arg = m[1];
      expect(arg).not.toMatch(/result/); // never the parsed WorkerResult
      expect(arg).not.toMatch(/\bok\b/); // never result.ok; firstAttemptOk (capital O, no boundary) is fine
      expect(arg).not.toMatch(/\boutput\b/); // v1.7 SPEND-01: harvested pane text never rides telemetry
      expect(arg).not.toMatch(/tokens\s*:/); // v1.7: shorthand-only — an explicit `tokens:` expr is refused
    }
    // The count clause is load-bearing: without it a future reformat that splits a telemetry call across
    // two lines would defeat the regex, find zero sites, and this test would pass VACUOUSLY — green while
    // checking nothing. The >= 3 makes the grep fail loudly instead.
    expect(sites).toBeGreaterThanOrEqual(3);
  });

  // v1.7 (17-02 orchestrator finding): the `[^)]*` capture above stops at the FIRST `)`, which on two of
  // the three call sites is the one inside `durationMs: Date.now()`. Every argument after it — parkKind,
  // gateFails, consults, tokens — was therefore NEVER inspected. The clause guarding tickmarkr's founding
  // invariant ("gates never trust worker claims") has been vacuous over the tail of each call since v1.6.
  // Proven: injecting `sneaky: result.ok` after `durationMs` left all pins green.
  // This whole-physical-line check is immune to the paren truncation. It re-applies every ban above to the
  // WHOLE call site, not just its prefix. Keep both: the paren version pins arg shape, this pins the tail.
  test("the same bans hold on the WHOLE telemetry line, past the `Date.now()` paren (v1.6 pin was vacuous there)", () => {
    const lines = src.split("\n").filter((l) => l.includes("journal.telemetry("));
    expect(lines.length).toBeGreaterThanOrEqual(3); // vacuity guard — a reformat must fail loudly, not silently
    for (const l of lines) {
      const call = l.slice(l.indexOf("journal.telemetry(")); // whole tail, parens and all
      expect(call).not.toMatch(/result/); // never the parsed WorkerResult, anywhere in the call
      expect(call).not.toMatch(/\bok\b/); // never result.ok; firstAttemptOk (capital O) is fine
      expect(call).not.toMatch(/\boutput\b/); // harvested pane text never rides telemetry
    }
  });

  // v1.7 (SPEND-02, 17-02 Task-3 finding): the `[^)]*` capture above TRUNCATES at the `)` inside the
  // `durationMs: Date.now()` that precedes `tokens` on both metered rows — so the paren-scoped `tokens:`
  // ban never reaches the field it's meant to guard (vacuous, same class as 17-01's `driver?.read`).
  // This whole-physical-line check is immune to the truncation: `tokens` must ride telemetry as the
  // shorthand `tokens` only; an explicit `tokens: <expr>` (e.g. the `?? { input:0 }` zeroing drill) reddens.
  test("no journal.telemetry line spells an explicit `tokens:` — shorthand only, past the Date.now() paren", () => {
    const telemLines = src.split("\n").filter((l) => l.includes("journal.telemetry"));
    expect(telemLines.length).toBeGreaterThanOrEqual(3); // vacuity guard
    for (const l of telemLines) expect(l).not.toMatch(/tokens\s*:/); // `meteredAttempts: tokens ?` has no `tokens:`
  });
});

// ── v1.7 Phase 17 spend-metering pins (SPEND-01/03/06) ──
// These land in the RED commit, BEFORE the tokens field exists — zero history window where the field
// is unguarded. The profile/router pins stay green throughout (guards); their falsification is Task 3.
// The provenance + schema-shape pins are red until Task 2 wires the field + collect site.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("SPEND-01 provenance: the done-row tokens come only from the post-hoc disk collect", () => {
  const lines = read("../../src/run/daemon.ts").split("\n");

  // v1.7 (SPEND-02): the collect became a per-attempt fold. Two clauses now, extending the 17-01 pin:
  // (a) the `attemptUsage` assignment is the pinned cursor'd disk read — no pane text, no driver;
  // (b) every `tokens =` line is the guarded fold `addUsage(tokens, attemptUsage)`, never a raw collect.
  test("the attemptUsage collect line is the pinned cursor'd disk read — no pane text, no driver, >= 1 site", () => {
    const collectLines = lines.filter((l) => /\battemptUsage =/.test(l));
    // vacuity guard (same trick as TEL-01's >= 3 sites): zero lines pass the per-line loop trivially
    expect(collectLines.length).toBeGreaterThanOrEqual(1);
    for (const l of collectLines) {
      expect(l).toMatch(/adapter\.collectUsage\?\.\(wt, attemptStart\)/);
      expect(l).not.toMatch(/output/); // never the harvested pane text
      expect(l).not.toMatch(/driver/); // never a driver call
    }
  });

  test("every `tokens =` line is the guarded fold addUsage(tokens, attemptUsage) — never a raw collect", () => {
    const tokenLines = lines.filter((l) => /\btokens =/.test(l));
    expect(tokenLines.length).toBeGreaterThanOrEqual(1); // vacuity guard
    for (const l of tokenLines) expect(l).toMatch(/addUsage\(tokens, attemptUsage\)/);
  });

  test("collectUsage appears in daemon.ts ONLY as the pinned cursor'd disk read", () => {
    for (const l of lines.filter((l) => /collectUsage/.test(l))) {
      expect(l).toMatch(/adapter\.collectUsage\?\.\(wt, attemptStart\)/);
    }
  });
});

describe("SPEND-01 no-pane-scrape: no usage code sits within 400 chars of a driver.read", () => {
  const adaptersDir = fileURLToPath(new URL("../../src/adapters", import.meta.url));
  const files = [
    fileURLToPath(new URL("../../src/run/daemon.ts", import.meta.url)),
    ...readdirSync(adaptersDir).filter((f) => f.endsWith(".ts")).map((f) => join(adaptersDir, f)),
  ];

  // `driver\??\.read` catches BOTH `driver.read` and the optional-chained `driver?.read` — a bare
  // `driver\.read` lets a `driver?.read?.()` pane scrape slip the pin (found by the Task 3 drill).
  test("collectUsage and driver.read never co-occur within 400 chars, either direction", () => {
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toMatch(/collectUsage[\s\S]{0,400}driver\??\.read/);
      expect(text).not.toMatch(/driver\??\.read[\s\S]{0,400}collectUsage/);
    }
  });
});

describe("SPEND-03 route unreachability: profile.ts and router.ts stay token/cost-free", () => {
  test("profile.ts matches neither /token/i nor /cost/i", () => {
    const src = read("../../src/route/profile.ts");
    expect(src).not.toMatch(/token/i);
    expect(src).not.toMatch(/cost/i);
  });

  test("router.ts matches neither /token/i nor a `.cost` field read", () => {
    const src = read("../../src/route/router.ts");
    expect(src).not.toMatch(/token/i);
    expect(src).not.toMatch(/\.cost\b/); // marginalCostRank is a NAME reading config rank, not a field
  });
});

describe("SPEND-06 no-cost: neither schema can represent money; metering path reads no CLI cost", () => {
  test("TokenUsageSchema and TelemetryRowSchema carry no cost-like key", () => {
    for (const k of Object.keys(TokenUsageSchema.shape)) expect(k).not.toMatch(/cost|usd|price|dollar/i);
    for (const k of Object.keys(TelemetryRowSchema.shape)) expect(k).not.toMatch(/cost|usd|price|dollar/i);
  });

  test("daemon.ts/journal.ts/fake.ts read no CLI cost field", () => {
    for (const rel of ["../../src/run/daemon.ts", "../../src/run/journal.ts", "../../src/adapters/fake.ts"]) {
      expect(read(rel)).not.toMatch(/costUSD|cost\.total|part\.cost/);
    }
  });
});
