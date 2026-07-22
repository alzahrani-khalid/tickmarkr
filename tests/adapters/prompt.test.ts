import { describe, expect, test } from "vitest";
import { buildTaskPrompt, classifyDeadChannel, parseWorkerResult, trailerPattern } from "../../src/adapters/prompt.js";
import { validateGraph } from "../../src/graph/schema.js";

const N = "testnonce"; // fixed nonce for direct-call tests; the daemon uses a random per-run one

const task = validateGraph({
  version: 1,
  spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{
    id: "T1", title: "add refresh", goal: "401s retried once", shape: "implement",
    complexity: 5, files: ["src/auth/**"], context: ["specs/auth.md#refresh"],
    acceptance: ["retries once with refreshed token"],
  }],
}).tasks[0];

describe("buildTaskPrompt", () => {
  test("contains task fields, rules, and the trailer contract", () => {
    const p = buildTaskPrompt(task, "", N);
    expect(p).toContain("T1: add refresh");
    expect(p).toContain("retries once with refreshed token");
    expect(p).toContain("src/auth/**");
    expect(p).toContain("specs/auth.md#refresh");
    expect(p).toMatch(/atomic.*commit/i);
    expect(p).toMatch(/never push/i);
    expect(p).toContain(`TICKMARKR_RESULT_${N} {"ok"`);
    expect(p).not.toContain("Previous attempt");
  });

  test("feedback appears in retry prompts", () => {
    expect(buildTaskPrompt(task, "scope gate failed: touched README.md", N)).toContain("touched README.md");
  });

  // v1.19: typed acceptance oracles render as text via the shared renderAcceptanceItem helper.
  test("typed acceptance items render as text (command/test/judge + plain)", () => {
    const t = validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T9", title: "t", goal: "g", shape: "implement", complexity: 3,
        acceptance: [
          { oracle: "command", command: "npm test" },
          { oracle: "test", test: "auth suite" },
          { oracle: "judge", text: "behaves under load" },
          "plain criterion",
        ] }],
    }).tasks[0];
    const p = buildTaskPrompt(t, "", N);
    expect(p).toContain("$ npm test");
    expect(p).toContain("test: auth suite");
    expect(p).toContain("behaves under load");
    expect(p).toContain("plain criterion");
    expect(p).not.toContain("[object Object]");
  });
});

describe("parseWorkerResult", () => {
  test("extracts last trailer (new TICKMARKR_RESULT marker)", () => {
    const raw = `blah\nTICKMARKR_RESULT_${N} {"ok":false,"summary":"first"}\nmore\nTICKMARKR_RESULT_${N} {"ok":true,"summary":"done","deviations":["touched ci.yml"]}\n`;
    const r = parseWorkerResult(raw, N);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("done");
    expect(r.deviations).toEqual(["touched ci.yml"]);
    expect(r.raw).toBe(raw);
  });

  test("fail-closed on missing or garbled trailer", () => {
    const missing = parseWorkerResult("no trailer here", N);
    expect(missing.ok).toBe(false);
    expect(missing.summary).toBe("worker produced no TICKMARKR_RESULT trailer");
    const garbled = parseWorkerResult(`TICKMARKR_RESULT_${N} {not json`, N);
    expect(garbled.ok).toBe(false);
    expect(garbled.summary).toBe("unparseable TICKMARKR_RESULT trailer");
  });
});

// v1.2: interactive TUIs echo the prompt (which contains the trailer TEMPLATE) and redraw lines —
// the parser must survive both without weakening fail-closed.
const TEMPLATE = `TICKMARKR_RESULT_${N} {"ok":true|false,"summary":"<one sentence>","deviations":["<path or reason>"]}`;

describe("parseWorkerResult v1.2 hardening (interactive transcripts)", () => {
  test("template echo after the real trailer does not clobber it", () => {
    const r = parseWorkerResult(`did work\nTICKMARKR_RESULT_${N} {"ok":true,"summary":"real"}\n${TEMPLATE}\n`, N);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("real");
  });

  test("last parseable trailer wins across redraw duplicates and trailing garbage", () => {
    const raw = `TICKMARKR_RESULT_${N} {"ok":false,"summary":"stale"}\nTICKMARKR_RESULT_${N} {"ok":true,"summary":"final"}\nTICKMARKR_RESULT_${N} {"ok":garb\n`;
    const r = parseWorkerResult(raw, N);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("final");
  });

  test("template echo alone fails closed", () => {
    const r = parseWorkerResult(`prompt says:\n${TEMPLATE}\n`, N);
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("unparseable TICKMARKR_RESULT trailer");
  });

  // v1.5 pi live check (2026-07-10, pi 0.80.3): pi renders NON-BLOCKING update banners in its
  // output — banner chrome surrounding the trailer must not break extraction.
  test("update-banner chrome around the trailer does not break extraction (pi render)", () => {
    const raw = `╭──────────────────────────────╮\n│ Update available: pi 0.81.0  │\n│ Run: npm i -g @pi/cli        │\n╰──────────────────────────────╯\nwork done\nTICKMARKR_RESULT_${N} {"ok":true,"summary":"bannered","deviations":[]}\n│ pi 0.81.0 is available │\n`;
    const r = parseWorkerResult(raw, N);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("bannered");
  });

  test("TUI box chrome around the trailer is stripped (leading and trailing)", () => {
    const r = parseWorkerResult(`work...\n│ TICKMARKR_RESULT_${N} {"ok":true,"summary":"boxed"} │\n`, N);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("boxed");
  });

  // v1.2 live check regression: cursor's renderer HARD-wraps the trailer JSON across terminal
  // lines with a left margin — recent-unwrapped cannot rejoin hard newlines.
  test("hard-wrapped multi-line trailer with per-line margins parses (cursor render)", () => {
    const raw = `work...\n  TICKMARKR_RESULT_${N} {"ok":true,"summ\n  ary":"implemented capitalize a\n  nd tests","deviations":[]}\n`;
    const r = parseWorkerResult(raw, N);
    expect(r.ok).toBe(true);
    expect(r.deviations).toEqual([]);
  });

  test("hard-wrapped template echo still fails closed; later wrapped real trailer wins", () => {
    const wrappedTemplate = `  TICKMARKR_RESULT_${N} {"ok":true|false,"su\n  mmary":"<one sentence>","deviation\n  s":["<path or reason>"]}`;
    expect(parseWorkerResult(`${wrappedTemplate}\n`, N).ok).toBe(false);
    const r = parseWorkerResult(`${wrappedTemplate}\nwork\n  TICKMARKR_RESULT_${N} {"ok":false,"summary\n  ":"tests failing"}\n`, N);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("tests failing");
  });
});

describe("trailerPattern (interactive completion anchor)", () => {
  test("matches real trailers in any key order; rejects the prompt template", () => {
    const re = new RegExp(trailerPattern(N));
    expect(re.test(`TICKMARKR_RESULT_${N} {"ok":true,"summary":"s"}`)).toBe(true);
    expect(re.test(`TICKMARKR_RESULT_${N} {"deviations":[],"ok":false}`)).toBe(true); // fake adapter key order
    expect(re.test(`TICKMARKR_RESULT_${N} {"ok": true, "summary":"spaced"}`)).toBe(true);
    expect(re.test(`TICKMARKR_RESULT_${N} {"ok":true}`)).toBe(true);
    expect(re.test(TEMPLATE)).toBe(false);
  });

  // IN-01: completion detection (daemon.ts:213/218/241) runs the raw anchor against the transcript
  // and does NOT strip box chrome — pi's banner/box lines must not defeat the finished-signal.
  test("tolerates pi's banner/box chrome on surrounding lines (pi render)", () => {
    const re = new RegExp(trailerPattern(N));
    expect(re.test(`│ TICKMARKR_RESULT_${N} {"ok":true,"summary":"x"} │`)).toBe(true);
    expect(re.test(`╭────────╮\n│ Update available: pi 0.81.0 │\n╰────────╯\nTICKMARKR_RESULT_${N} {"ok":false,"summary":"done"}`)).toBe(true);
  });
});

// v1.65 T1: typed dead-channel classification lives at THIS parsing boundary — the daemon consumes
// the returned type and never re-derives it from raw text.
describe("classifyDeadChannel (v1.65 T1)", () => {
  const dead = (raw: string) => classifyDeadChannel(parseWorkerResult(raw, N));

  test("auth signatures in no-trailer output classify auth-required", () => {
    expect(dead("Not logged in. Please run /login to authenticate.")).toBe("auth-required");
    expect(dead("Error: invalid API key provided")).toBe("auth-required");
  });

  test("setup signatures in no-trailer output classify setup-required", () => {
    expect(dead("zsh: command not found: codex")).toBe("setup-required");
    expect(dead("Error: spawn cursor-agent ENOENT")).toBe("setup-required");
  });

  test("provider-outage signatures in no-trailer output classify provider-outage", () => {
    expect(dead("committing…\nUnable to reach the model provider\n")).toBe("provider-outage");
    expect(dead("api error: overloaded_error")).toBe("provider-outage");
  });

  test("CLI-reported timeout signatures in no-trailer output classify timeout", () => {
    expect(dead("Error: request timed out after 120000ms")).toBe("timeout");
    expect(dead("fetch failed: ETIMEDOUT")).toBe("timeout");
  });

  test("a parseable trailer is the worker speaking — never a dead channel, even over matching text", () => {
    const okFalse = parseWorkerResult(`Not logged in mentioned during work\nTICKMARKR_RESULT_${N} {"ok":false,"summary":"tests failing"}`, N);
    expect(classifyDeadChannel(okFalse)).toBeUndefined();
    const okTrue = parseWorkerResult(`note: request timed out handled in code\nTICKMARKR_RESULT_${N} {"ok":true,"summary":"done"}`, N);
    expect(classifyDeadChannel(okTrue)).toBeUndefined();
  });

  test("a no-trailer failure without a dead-channel signature stays untyped", () => {
    expect(dead("still working on the diff...")).toBeUndefined();
  });
});

// v1.4 self-reference-premature-harvest regression: a worker editing tickmarkr's own source DISPLAYS
// literal TICKMARKR_RESULT/TICKMARKR_EXIT markers from the files/diffs it views. Without the run
// nonce the parser accepted those and harvested mid-task. With it, only the nonce'd trailer is honored.
describe("parseWorkerResult nonce guard (self-reference-premature-harvest regression)", () => {
  test("a displayed non-nonce'd trailer is NOT accepted; the nonce'd one is", () => {
    const displayed =
      '...worker viewed source... TICKMARKR_RESULT {"ok":true,"summary":"x"} ... TICKMARKR_EXIT:0 ...';
    const spoof = parseWorkerResult(displayed, "abc12345");
    expect(spoof.ok).toBe(false);
    expect(spoof.summary).toBe("worker produced no TICKMARKR_RESULT trailer");

    const real = parseWorkerResult('... TICKMARKR_RESULT_abc12345 {"ok":true,"summary":"done","deviations":[]} ...', "abc12345");
    expect(real.ok).toBe(true);
    expect(real.summary).toBe("done");
  });
});
