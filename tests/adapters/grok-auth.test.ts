import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { grok, grokAuthed, parseGrokModels } from "../../src/adapters/grok.js";
import { parseWorkerResult } from "../../src/adapters/prompt.js";
import { validateGraph } from "../../src/graph/schema.js";

// G5 mocks node:child_process + node:fs so probe is observable without the real grok binary (zero-token).
// node:os homedir is pinned so the auth.json path is deterministic. The pure helper tests (G1-G4, G6,
// G7) never touch the mocks; G8 reuses the spawnSync mock for listModels.
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:os", () => ({ homedir: () => "/fake-home" }));
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// FIXTURE F-1 — verbatim `grok models` stdout, grok 0.2.93, 2026-07-11 [LIVE-RES, 40-RESEARCH F-1].
// The banner's FIRST line is live-proven state-flappy (printed "You are not authenticated." hours
// earlier on the SAME valid token) — the parser must anchor BELOW it on "Available models:".
const F1_CAPTURE = [
  "You are logged in with grok.com.",
  "",
  "Default model: grok-4.5",
  "",
  "Available models:",
  "  * grok-4.5 (default)",
  "  - grok-composer-2.5-fast",
].join("\n");

// FIXTURE F-2 — ~/.grok/auth.json shape (nested, keyed by "<issuer>::<client_id>"), values faked
// [LIVE-RES, 40-RESEARCH F-2]. An EXPIRED key + live refresh_token still works — the CLI auto-refreshes.
const F2_LIVE = JSON.stringify({
  "https://auth.x.ai::b1a00492-fake": {
    key: "eyJfake", auth_mode: "oidc", refresh_token: "PTfake",
    expires_at: "2099-01-01T00:00:00Z", user_id: "u", email: "e@x", team_id: "t",
  },
});

// FIXTURE F-3 — verbatim `grok -p … --output-format plain` stdout (113 bytes, exit 0; em-dash U+2014)
// [LIVE-RES, 40-RESEARCH F-3]. Trailer intact + unwrapped.
const F3_CAPTURE = "Understood \u2014 no tools used.\n\nTICKMARKR_RESULT_test7742 {\"ok\":true,\"summary\":\"live trailer probe\",\"deviations\":[]}";

// FIXTURE F-INT — verbatim `herdr pane read --source recent-unwrapped` capture of grok's DEFAULT
// (alt-screen) interactive TUI renderer, trimmed to the trailer region [LIVE, 40-02 P2, 2026-07-11].
// sessionId 019f50da-96ee-7e22-b021-82f25c2b6d49, dispatched from a real git worktree at
// /private/tmp/grok-live-wt-1783767686. The nonce p401783767686 is THIS run's, not a copy of F-3's.
// Load-bearing shape: (a) the trailer appears TWICE — first as the echoed-prompt line (7-space
// margin), then as grok's RESPONSE line (5-space margin + trailing timestamp chrome `2:05 PM`);
// parseWorkerResult's last-valid-trailer-wins must pick the RESPONSE; (b) leading margin + trailing
// chrome are stripped per-line; (c) the response trailer is COMPLETE, not hard-wrapped or
// `…`-truncated, on tickmarkr's emulated-screen read path. This is the SC-2 interactive-half pin: a
// future grok renderer that mangles the trailer beyond this shape reddens the test. Raw pty bytes
// from `--minimal`/`script` DO fragment this trailer (40-02 prior-attempt scar), but tickmarkr's
// SubprocessDriver is pipe-stdout (no TUI) and HerdrDriver reads `--source recent-unwrapped`
// (emulated screen) — neither reads raw pty bytes, so that fragmentation is a harness artifact.
const F_INT_CAPTURE = [
  "     TICKMARKR_RESULT_p401783767686 {\"ok\":true,\"summary\":\"interactive live probe\",\"deviations\":[]}",
  "",
  "",
  "     \u23af Thought for 0.0s",
  "",
  "     TICKMARKR_RESULT_p401783767686 {\"ok\":true,\"summary\":\"interactive live probe\",\"deviations\":[]}                                                                                                2:05 PM",
  "",
  "     Turn completed in 2.6s.",
].join("\n");

const nowMs = Date.parse("2026-07-11T16:00:00Z"); // fixed clock: F2_LIVE's 2099 expiry is clearly future

describe("GROK-01 grokAuthed — the false-negative trap (refresh_token dominates expiry)", () => {
  // G1 — THE TRAP TEST. expired expires_at + live refresh_token ⇒ true. This is the exact live
  // false-negative state re-expressed: any future edit that gates the verdict on expiry alone (the
  // natural bug, and the `grok models` banner's own apparent logic) turns this test RED.
  test("G1: PAST expires_at + present refresh_token ⇒ true (expiry-only gate reddens)", () => {
    const expiredButRefreshable = JSON.stringify({
      "https://auth.x.ai::c": {
        key: "eyJexpired", auth_mode: "oidc", refresh_token: "PTlive",
        expires_at: "2020-01-01T00:00:00Z", // past
      },
    });
    expect(grokAuthed(expiredButRefreshable, nowMs)).toBe(true);
  });

  // G2 — unauthed honesty (HYG-05 polarity: never advertise what cannot be verified).
  test("G2: expired expires_at + NO refresh_token ⇒ false; empty/garbage/non-object entry ⇒ false", () => {
    const expiredNoRefresh = JSON.stringify({
      "https://auth.x.ai::c": { key: "k", expires_at: "2020-01-01T00:00:00Z" },
    });
    expect(grokAuthed(expiredNoRefresh, nowMs)).toBe(false);
    expect(grokAuthed("{}", nowMs)).toBe(false);
    expect(grokAuthed("", nowMs)).toBe(false);
    expect(grokAuthed("garbage", nowMs)).toBe(false);
    // entry value is a string, not an object ⇒ false
    expect(grokAuthed(JSON.stringify({ "https://auth.x.ai::c": "not-an-object" }), nowMs)).toBe(false);
  });

  // G3 — future expiry alone suffices (no refresh_token needed when the access key is still live).
  test("G3: future expires_at + NO refresh_token ⇒ true", () => {
    const futureNoRefresh = JSON.stringify({
      "https://auth.x.ai::c": { key: "k", expires_at: "2099-01-01T00:00:00Z" },
    });
    expect(grokAuthed(futureNoRefresh, nowMs)).toBe(true);
  });

  test("F2_LIVE fixture (future expiry + refresh_token) ⇒ true", () => {
    expect(grokAuthed(F2_LIVE, nowMs)).toBe(true);
  });
});

describe("GROK-04 parseGrokModels — content-anchored, banner-proof (MODEL-05 WR-02)", () => {
  test("G4: F-1 capture ⇒ exactly the two live ids; prefix * /- and (default) suffix stripped", () => {
    expect(parseGrokModels(F1_CAPTURE)).toEqual(["grok-4.5", "grok-composer-2.5-fast"]);
  });

  test("G4: empty input ⇒ []", () => {
    expect(parseGrokModels("")).toEqual([]);
  });

  test("G4: banner lines WITHOUT the 'Available models:' header ⇒ [] (auth text can never produce models)", () => {
    const bannerOnly = "You are not authenticated.\n\ngrok-4.5\ngrok-composer-2.5-fast";
    expect(parseGrokModels(bannerOnly)).toEqual([]);
  });
});

describe("GROK-01 probe — auth.json ONLY, never `grok models` (the banner-rewire ban)", () => {
  const mockedSpawn = vi.mocked(spawnSync);
  const mockedReadFile = vi.mocked(readFileSync);

  beforeEach(() => {
    mockedSpawn.mockReset();
    mockedReadFile.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  test("G5: valid auth.json ⇒ authed:true; probe spawns --version, NEVER models", async () => {
    mockedSpawn.mockImplementation((() => ({ status: 0, stdout: "grok 0.2.93 (f00f96316d4b)\n", stderr: "" })) as typeof spawnSync);
    mockedReadFile.mockImplementation((p) => (String(p).endsWith(".grok/auth.json") ? F2_LIVE : (() => { throw new Error("ENOENT"); })()));
    const h = await grok.probe();
    expect(h.installed).toBe(true);
    expect(h.authed).toBe(true);
    const calls = mockedSpawn.mock.calls.map((c) => c[1]);
    expect(calls).toContainEqual(["--version"]);
    // THE BAN: probe must never shell out to `grok models` — its banner is state-flappy in both directions.
    expect(calls).not.toContainEqual(["models"]);
  });

  test("G5: readFileSync throws ⇒ authed:false, installed:true, no throw; still never models", async () => {
    mockedSpawn.mockImplementation((() => ({ status: 0, stdout: "grok 0.2.93\n", stderr: "" })) as typeof spawnSync);
    mockedReadFile.mockImplementation((() => { throw new Error("ENOENT"); }));
    const h = await grok.probe();
    expect(h.installed).toBe(true);
    expect(h.authed).toBe(false);
    expect(mockedSpawn.mock.calls.map((c) => c[1])).not.toContainEqual(["models"]);
  });
});

describe("GROK-02 command shapes — permission flag, shq quoting, NEVER the worktree flag", () => {
  test("G6: headless pins -p, --permission-mode bypassPermissions, --output-format plain, shq-quoted model+prompt", () => {
    const c = grok.headlessCommand("/tmp/p.md", "grok-4.5");
    expect(c).toContain("grok -p");
    expect(c).toContain("--permission-mode bypassPermissions");
    expect(c).toContain("--output-format plain");
    expect(c).toContain("\"$(cat '/tmp/p.md')\"");
    expect(c).toContain("--model 'grok-4.5'");
  });

  test("G6: interactive is positional-prompt (no -p), same permission flag", () => {
    const c = grok.interactiveCommand("/tmp/p.md", "grok-4.5") as string;
    expect(c).not.toMatch(/\s-p\s/);
    expect(c).toContain("--permission-mode bypassPermissions");
    expect(c).toContain("\"$(cat '/tmp/p.md')\"");
  });

  // G6 NEGATIVE — the never-pass trap: grok manages its OWN worktrees with -w/--worktree; passing it
  // nests a grok worktree inside tickmarkr's worktree (scope-gate chaos). A test reddens if either appears.
  test("G6: NEITHER command matches /--worktree/ or a bare -w flag (tickmarkr owns worktrees)", () => {
    const head = grok.headlessCommand("/tmp/p.md", "grok-4.5");
    const tui = grok.interactiveCommand("/tmp/p.md", "grok-4.5") as string;
    expect(head).not.toMatch(/--worktree|\s-w\s/);
    expect(tui).not.toMatch(/--worktree|\s-w\s/);
  });
});

describe("GROK-02 trailer shape — parseWorkerResult over the verbatim F-3 capture (no grok fork)", () => {
  test("G7: clean F-3 capture ⇒ ok:true, summary 'live trailer probe', deviations []", () => {
    const r = parseWorkerResult(F3_CAPTURE, "test7742");
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("live trailer probe");
    expect(r.deviations).toEqual([]);
  });

  test("G7: hard-wrapped variant (JSON split across lines) still parses — cursor-scar tolerance covers grok", () => {
    const wrapped =
      "Understood \u2014 no tools used.\n\n" +
      "TICKMARKR_RESULT_test7742 {\"ok\":true,\"summary\":\"hardwrap\n" +
      " probe\",\"deviations\":[]}";
    const r = parseWorkerResult(wrapped, "test7742");
    expect(r.ok).toBe(true);
  });

  test("parse is reused verbatim — grok.parse === parseWorkerResult (no grok-specific parser)", () => {
    expect(grok.parse).toBe(parseWorkerResult);
  });
});

describe("GROK-02 interactive TUI renderer — verbatim emulated-screen capture (40-02 live check)", () => {
  // SC-2 interactive half. This is the renderer-shape pin taken from the REAL default alt-screen
  // TUI as read by tickmarkr's HerdrDriver (pane read --source recent-unwrapped). See F-INT provenance.
  test("G7int: real interactive capture ⇒ ok:true, summary 'interactive live probe'", () => {
    const r = parseWorkerResult(F_INT_CAPTURE, "p401783767686");
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("interactive live probe");
    expect(r.deviations).toEqual([]);
  });

  // last-valid-trailer-wins: the echoed-prompt trailer (1st occurrence) and the response trailer
  // (2nd occurrence) are identical here; the parser must still settle on a single parseable JSON,
  // never double-count or harvest the prompt echo as a premature result.
  test("G7int: two-occurrence (echo + response) capture yields exactly one settled parse", () => {
    const r = parseWorkerResult(F_INT_CAPTURE, "p401783767686");
    expect(r.ok).toBe(true);
    // a mangled margin-only echo (no JSON) must not be mistaken for the result — grow the candidate
    const echoOnly = "     TICKMARKR_RESULT_p401783767686\n     TICKMARKR_RESULT_p401783767686 {\"ok\":true,\"summary\":\"resp\",\"deviations\":[]}  2:05 PM";
    expect(parseWorkerResult(echoOnly, "p401783767686").summary).toBe("resp");
  });
});

describe("GROK-04 listModels + invoke delegation (coverage-floor bite)", () => {
  const mockedSpawn = vi.mocked(spawnSync);

  beforeEach(() => mockedSpawn.mockReset());
  afterEach(() => vi.clearAllMocks());

  test("G8a: status 0 + F-1 stdout ⇒ the two live ids", async () => {
    mockedSpawn.mockImplementation((() => ({ status: 0, stdout: F1_CAPTURE, stderr: "" })) as typeof spawnSync);
    expect(await grok.listModels!()).toEqual(["grok-4.5", "grok-composer-2.5-fast"]);
  });

  test("G8b: non-zero exit ⇒ [] (fail-open, advisory detection never fails a healthy doctor)", async () => {
    mockedSpawn.mockImplementation((() => ({ status: 1, stdout: "", stderr: "err" })) as typeof spawnSync);
    expect(await grok.listModels!()).toEqual([]);
  });

  test("G8c: spawn error ⇒ [] (never throws)", async () => {
    mockedSpawn.mockImplementation((() => ({ error: new Error("ENOENT"), status: null, stdout: "", stderr: "" })) as typeof spawnSync);
    expect(await grok.listModels!()).toEqual([]);
  });

  test("G8d: invoke delegates to headlessCommand (delegation pin)", () => {
    const task = validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: ["a"] }],
    }).tasks[0];
    const inv = grok.invoke(task, "/cwd", { adapter: "grok", model: "grok-4.5", channel: "sub", tier: "mid" }, { promptFile: "/tmp/p.md" });
    expect(inv.command).toBe(grok.headlessCommand("/tmp/p.md", "grok-4.5"));
  });
});
