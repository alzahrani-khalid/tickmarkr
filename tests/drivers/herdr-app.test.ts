import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { declareInputBox } from "../../src/adapters/types.js";
import { HcClient, HcError } from "../../src/drivers/hc-client.js";
import { HC_KEYS, HcUnavailableError, HerdrAppDriver, OWNER_LABEL, REPO_LABEL, terminalPayload, type HerdrAppDriverOpts, type HerdrAppTime } from "../../src/drivers/herdr-app.js";
import { HERDR_CONTROL_VARS } from "../../src/drivers/subprocess.js";
import { formatOwnedName, type Slot, type SlotOpts } from "../../src/drivers/types.js";
import { FakeHerdrApp, type FakeRule, type FakeState, type FakeTerm, hcAddress } from "../helpers/fake-herdr-app.js";
import { makeRepo, makeTestTempDir, reapTestTempDirs } from "../helpers/tmprepo.js";

// Queue row 340; D-2180 — contract J and L over executable fakes resolved to explicit paths; every response body that
// stands for real hc/herdr-app output is a verbatim capture. The bytes load from tests/fixtures/herdr-app (the public
// export omits specs/); the J test pins them equal to specs/v2.20.0-herdr-app-captures.json wherever that exists.

afterAll(() => reapTestTempDirs());

type Capture = { output: string; stdout?: string; stderr?: string; exit: number };
const loadCaptures = (url: URL): Record<string, Capture> => (JSON.parse(readFileSync(url, "utf8")) as { captures: Record<string, Capture> }).captures;
const CAPTURES = loadCaptures(new URL("../fixtures/herdr-app/captures.json", import.meta.url));
const SPEC_CAPTURES = new URL("../../specs/v2.20.0-herdr-app-captures.json", import.meta.url);
/** The captured stdout bytes (R1 captures record stdout separately from the merged output). */
const cap = (key: string): string => CAPTURES[key].stdout ?? CAPTURES[key].output;
const capJson = (key: string): Record<string, unknown> => JSON.parse(cap(key)) as Record<string, unknown>;

function fake(init: Partial<FakeState> = {}): FakeHerdrApp { return new FakeHerdrApp(makeTestTempDir("hcapp-"), init); }
function driver(f: FakeHerdrApp, over: HerdrAppDriverOpts = {}): HerdrAppDriver {
  return new HerdrAppDriver({ hcBin: f.hc, appBin: f.app, env: { PATH: process.env.PATH }, pollMs: 50, readinessMs: 1_500, confirmMs: 1_000, ...over });
}
const readOf = (key: string): FakeTerm["screen"] => {
  const r = capJson(key) as { text: string; complete: boolean; how: string; why?: string };
  return { text: r.text, complete: r.complete, how: r.how, ...(r.why ? { why: r.why } : {}) };
};
/** One owned terminal bound through the real creation path, with the fake's spawn defaults applied. */
async function bound(f: FakeHerdrApp, d: HerdrAppDriver, repo: string, spawn: Partial<FakeTerm>, name = "T1-worker-fake-a0-20261104-tag", opts?: SlotOpts): Promise<{ slot: Slot; address: string }> {
  f.update((s) => { s.spawn = spawn; });
  const slot = await d.slot(repo, name, opts);
  await d.run(slot, "true");
  const address = f.hcCalls("run").length ? hcAddress(f.read().next) : "";
  return { slot, address };
}
const repoId = (repo: string): string => realpathSync(join(repo, ".git"));
/** The fake's own `hc get` record for a terminal, patched: a scripted response that answers for the real slot. */
const recordOf = (f: FakeHerdrApp, address: string, patch: Partial<FakeTerm> = {}): string => {
  const r: Record<string, unknown> = { cols: 200, rows: 120, rm: false, title: "", ...f.term(address), ...patch };
  for (const k of ["screen", "history", "onSend", "echo"]) delete r[k];
  return JSON.stringify(r) + "\n";
};
const readBody = (text: string, complete = true, how = "screen"): string => JSON.stringify({ text, complete, how }) + "\n";
/** A clock running `k` times faster than real time: a call's evidence lands past an injected deadline. */
function fastClock(k: number): HerdrAppTime {
  const t0 = Date.now();
  return { now: () => t0 + (Date.now() - t0) * k, sleep: (ms) => new Promise((r) => setTimeout(r, ms / k)) };
}

interface Family {
  family: string; tool: "hc" | "herdr-app"; valid: string[];
  call: (c: HcClient, address: string) => Promise<unknown>;
  missing: string; wrong: [string, unknown];
}
const FAMILIES: Family[] = [
  { family: "status", tool: "hc", valid: ["C6", "R1-private-start", "R1-clean-core-identity"], call: (c) => c.status(), missing: "version", wrong: ["pid", 0] },
  { family: "run", tool: "hc", valid: ["Q1-create", "R1-env-run", "R1-alt-exit-run"], call: (c) => c.run(["--bg", "--", "true"]), missing: "address", wrong: ["state", "exited"] },
  { family: "ls", tool: "hc", valid: ["Q3-list", "R1-clean-list"], call: (c) => c.list(), missing: "hidden_finished", wrong: ["terminals", {}] },
  { family: "terminal", tool: "hc", valid: ["Q4-split-get", "Q3-status-get", "Q3-status-working-get", "Q1-value-charset", "CLEAN-real-split-kill", "R1-env-get", "R1-alt-exit-get"], call: (c, a) => c.get(a), missing: "labels", wrong: ["reported", "false"] },
  { family: "read", tool: "hc", valid: ["Q3-direct-read", "Q3-tui-read", "Q3-tui-screen", "Q3-status-working-read", "R1-env-read", "R1-alt-exit-screen", "R1-alt-exit-history"], call: (c) => c.read("t1", 100), missing: "complete", wrong: ["how", "stream"] },
  { family: "send", tool: "hc", valid: ["Q2-send", "Q3-status-working"], call: (c) => c.send("t1", "hello"), missing: "turn", wrong: ["turn", -1] },
  { family: "keys", tool: "hc", valid: ["Q3-keys"], call: (c) => c.keys("t1", ["enter"]), missing: "turn", wrong: ["status", 3] },
  { family: "wait", tool: "hc", valid: ["Q2-wait", "Q3-status-idle", "R1-env-wait"], call: (c) => c.wait("t1", 200), missing: "ended", wrong: ["children", null] },
  { family: "rm", tool: "hc", valid: ["CLEAN-real-split-rm", "R1-clean-t1-rm"], call: (c, a) => c.rm(a), missing: "removed", wrong: ["removed", 8] },
  { family: "app-ls", tool: "herdr-app", valid: ["Q4-split-layout", "CLEAN-real-layout"], call: (c) => c.app("app-ls", ["ls"]), missing: "spaces", wrong: ["spaces", {}] },
  { family: "pane-split", tool: "herdr-app", valid: ["Q4-split"], call: (c) => c.app("pane-split", ["do", "pane.split"]), missing: "terminal", wrong: ["pane", ""] },
  { family: "tab-rename", tool: "herdr-app", valid: ["Q4-rename"], call: (c) => c.app("tab-rename", ["do", "tab.rename"]), missing: "ok", wrong: ["ok", "true"] },
];
const addressIn = (body: string): string => {
  const o = JSON.parse(body) as Record<string, unknown>;
  return String(o.address ?? o.removed ?? "t1");
};

describe("HerdrAppDriver — hc JSON client (contract J)", () => {
  it("each JSON response family satisfies the closed FORMAT failure table while captured valid responses succeed", async () => {
    // The exported fixture is the spec's capture bytes, verbatim (checked wherever the spec history exists).
    if (existsSync(SPEC_CAPTURES)) {
      const spec = loadCaptures(SPEC_CAPTURES);
      for (const [key, body] of Object.entries(CAPTURES)) expect(body, key).toEqual(spec[key]);
    }
    await Promise.all(FAMILIES.map(async (fam) => {
      const f = fake();
      const client = new HcClient({ hcBin: f.hc, appBin: f.app, env: { PATH: process.env.PATH }, timeoutMs: 10_000, outputCap: 64 * 1024 });
      const quick = new HcClient({ hcBin: f.hc, appBin: f.app, env: { PATH: process.env.PATH }, timeoutMs: 700, placementTimeoutMs: 700 });
      const once = (r: Omit<FakeRule, "match" | "once" | "tool">): void => { f.clearRules(); f.rule({ tool: fam.tool, match: [], once: true, ...r }); };
      // Base case first: every captured valid body for the family succeeds.
      for (const key of fam.valid) {
        once({ output: cap(key), ...(CAPTURES[key].stderr ? { stderr: CAPTURES[key].stderr } : {}) }); // stderr beside exit 0 is diagnostic only
        await expect(fam.call(client, addressIn(cap(key))), `${fam.family} ${key}`).resolves.toBeTruthy();
      }
      const base = cap(fam.valid[0]);
      const at = addressIn(base);
      const o = JSON.parse(base) as Record<string, unknown>;
      const missing = { ...o }; delete missing[fam.missing];
      const rows: [string, Omit<FakeRule, "match" | "once" | "tool">, HcClient][] = [
        ["missing consumed field", { output: JSON.stringify(missing) }, client],
        ["wrong consumed field type", { output: JSON.stringify({ ...o, [fam.wrong[0]]: fam.wrong[1] }) }, client],
        ["truncated JSON", { output: base.slice(0, Math.floor(base.length / 2)) }, client],
        ["malformed JSON", { output: "{not json}\n" }, client],
        ["empty output", { output: "" }, client],
        ["non-JSON stderr is never a success parser", { stderr: "hc: diagnostic only\n" }, client],
        ["error body on exit 0", { output: JSON.stringify({ error: { kind: "refused", message: "no" } }) }, client],
        ["plausible success body on a nonzero exit", { output: base, exit: 1 }, client],
        ["timeout", { output: base, sleepMs: 5_000 }, quick],
        ["signal", { output: base, signal: "SIGTERM" }, client],
        ["output cap", { output: base + " ".repeat(70 * 1024) }, client],
      ];
      for (const [row, rule, c] of rows) {
        once(rule);
        const err = await fam.call(c, at).then(() => undefined, (e: unknown) => e);
        expect(err, `${fam.family}: ${row}`).toBeInstanceOf(HcError);
        expect((err as HcError).message, `${fam.family}: ${row}`).toContain(`${fam.family} response family failed`);
        if (row === "timeout") expect((err as HcError).diagnostics.timedOut).toBe(true);
        if (row === "signal") expect((err as HcError).diagnostics.signal).toBe("SIGTERM");
        if (row === "output cap") expect((err as HcError).reason).toContain("cap");
      }
      // --json is explicit on every hc family call.
      for (const call of f.calls().filter((x) => x.tool === "hc")) expect(call.argv).toContain("--json");
    }));

    // Error family: hc's structured stderr names the refusal; herdr-app's window-unreachable plain stderr is a NAMED
    // cosmetic failure, never a core-health success.
    const f = fake();
    const client = new HcClient({ hcBin: f.hc, appBin: f.app, timeoutMs: 10_000 });
    const failWith = async (rule: FakeRule, call: () => Promise<unknown>, kind: string): Promise<void> => {
      f.clearRules(); f.rule({ once: true, ...rule });
      const err = await call().then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(HcError);
      expect((err as HcError).kind).toBe(kind);
    };
    await failWith({ match: [], stderr: cap("Q2-finished-send"), exit: CAPTURES["Q2-finished-send"].exit }, () => client.send("t2", "x"), "finished");
    await failWith({ match: [], stderr: cap("Q3-missing-read"), exit: CAPTURES["Q3-missing-read"].exit }, () => client.read("t999999", 10), "not_found");
    await failWith({ tool: "herdr-app", match: [], stderr: cap("Q6-window-absent"), exit: CAPTURES["Q6-window-absent"].exit }, () => client.app("app-ls", ["ls"]), "window_unavailable");
    await failWith({ tool: "herdr-app", match: [], output: JSON.stringify({ error: "no such pane" }), exit: 1 }, () => client.app("pane-split", ["do", "pane.split"]), "app_error");
    // A pinned get/rm must answer for the same address.
    f.clearRules(); f.rule({ match: [], once: true, output: cap("Q4-split-get") });
    await expect(client.get("t1")).rejects.toThrow(/not the pinned t1/);
    f.rule({ match: [], once: true, output: cap("CLEAN-real-split-rm") });
    await expect(client.rm("t1")).rejects.toThrow(/not the targeted t1/);
    // A missing binary is an explicit failure, not an empty success.
    await expect(new HcClient({ hcBin: join(f.dir, "absent-hc") }).status()).rejects.toThrow(/could not be invoked/);
  }, 120_000);
});

describe("HerdrAppDriver — terminal addresses (queue row 340; D-2180)", () => {
  it("terminal addresses past the nineteenth follow the core's digits and consonants numbering while remote or malformed addresses stay refused", async () => {
    // Base case: the 45 addresses a private hc 0.1.18 core handed out, in order (measured 2026-11-05). The fake numbers
    // terminals the same way, so every fake-driven test runs on real address shapes.
    const measured = ("t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11 t12 t13 t14 t15 t16 t17 t18 t19 t1b t1c t1d t1f t1g t1h t1j t1k t1m " +
      "t1n t1p t1q t1r t1s t1t t1v t1w t1x t1y t1z t20 t21 t22 t23 t24 t25").split(" ");
    expect(measured.map((_, i) => hcAddress(i + 1))).toEqual(measured);

    // The client accepts every later local address and refuses anything else, in the run receipt it parses.
    const f = fake();
    const client = new HcClient({ hcBin: f.hc, appBin: f.app, env: { PATH: process.env.PATH }, timeoutMs: 10_000 });
    const receipt = (address: string): string => JSON.stringify({ address, agent: "bash", cwd: "/", state: "live", turn: 0 }) + "\n";
    for (const address of ["t1b", "t1z", "t20", "t100"]) {
      f.clearRules(); f.rule({ tool: "hc", match: ["run"], once: true, output: receipt(address) });
      await expect(client.run(["--bg", "--", "true"]), address).resolves.toMatchObject({ address });
    }
    for (const address of ["machine/t7", "tb", "T1", "t", "t1-b", "t1B", "t1 ", "t1b\n"]) {
      f.clearRules(); f.rule({ tool: "hc", match: ["run"], once: true, output: receipt(address) });
      await expect(client.run(["--bg", "--", "true"]), JSON.stringify(address)).rejects.toThrow(/is not a local terminal address/);
    }

    // The live failure: a core that has handed out nineteen terminals gives the next worker t1b. Creation, reads and
    // owned teardown all bind it (2.20.0's first live run failed that worker as "creation unconfirmed").
    const repo = makeRepo({ "a.txt": "a" });
    const g = fake({ next: 19 });
    const d = driver(g);
    const { slot, address } = await bound(g, d, repo, { state: "live" });
    expect(address).toBe("t1b");
    expect(g.term("t1b")).toMatchObject({ address: "t1b", state: "live" });
    g.clearCalls();
    await d.close(slot);
    expect([...g.hcCalls("kill"), ...g.hcCalls("rm")]).toEqual([["kill", "t1b", "--json"], ["rm", "t1b", "--json"]]);
    expect(g.term("t1b")).toBeUndefined();
  }, 60_000);
});

describe("HerdrAppDriver — stitched reads (queue row 340; D-2180)", () => {
  it("a stitched read of a full-screen app returns its text while it never proves drain", async () => {
    // hc 0.1.18's own schema (`hc schema` ReadResult): how is "screen", "history" or "stitched" — a full-screen app read
    // by scrolling it. The live answer carried a worker's prompt and a home path, so this body follows that schema.
    const body = JSON.stringify({ complete: true, how: "stitched", text: "line one\nline two\n" }) + "\n";
    const f = fake();
    const client = new HcClient({ hcBin: f.hc, appBin: f.app, env: { PATH: process.env.PATH }, timeoutMs: 10_000 });
    f.rule({ tool: "hc", match: ["read"], once: true, output: body });
    await expect(client.read("t1", 30)).resolves.toEqual({ complete: true, how: "stitched", text: "line one\nline two\n" });
    // Any other form stays a FORMAT failure.
    f.rule({ tool: "hc", match: ["read"], once: true, output: JSON.stringify({ complete: true, how: "scrolled", text: "x" }) + "\n" });
    await expect(client.read("t1", 30)).rejects.toThrow(/how is not screen\/history\/stitched/);

    // A finished worker whose final screen-only read answers stitched: drain is unproven, never closed. The same
    // terminal's complete screen answer still closes it.
    const repo = makeRepo({ "a.txt": "a" });
    const d = driver(f);
    const { slot, address } = await bound(f, d, repo, { state: "finished", exit_code: 0 });
    f.rule({ tool: "hc", match: ["read", address], once: true, output: body });
    await expect(d.transportState(slot)).rejects.toThrow(/drain unproven/);
    expect(await d.transportState(slot)).toEqual({ closed: true, exitCode: 0, signal: null });
  }, 60_000);
});

describe("fake Herdr app hygiene (queue row 340; D-2180)", () => {
  it("the fake reaps only real child processes so a failed spawn never signals the runner's process group", () => {
    const f = fake();
    // A failed spawn leaves no pid; state may also carry junk. Only a positive integer pid is ever signalled, as a group.
    f.update((s) => {
      s.spawnedPids = [null as unknown as number, 0, -5, Number.NaN, 2147483646];
      s.terminals.t9 = { address: "t9", spawned: true, pid: 0, state: "finished" } as unknown as FakeTerm;
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      f.reap();
      expect(kill.mock.calls.map((c) => c[0])).toEqual([-2147483646]);
    } finally {
      kill.mockRestore();
    }
  });
});

describe("HerdrAppDriver — creation, ownership and core-side environment (contract E/L-create)", () => {
  it("first-run creation satisfies the core-environment and canonical legacy-owner table while client-only exports and parented task-tab duplicates are rejected", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    const cwd = realpathSync(repo);
    const f = fake({ execute: true });
    f.update((s) => { s.coreEnv = { ...s.coreEnv, PATH: "/usr/bin:/bin", CORE_AUTH: "core-token", TERM_PROGRAM: "ghostty", HERDR_ENV: "1", ORCA_TERMINAL_HANDLE: "core-orca" }; });
    const env = { PATH: process.env.PATH, FOO: "client", HC_SCOPE: "launcher-scope-token", HC_TERMINAL_ID: "t0", HC_TERMINAL_SOCKET: f.read().socket, VITEST_MAX_FORKS: "3" };
    const exports = { CARRIED: "carried value; $x" };
    const d = driver(f, { env, exports });

    // Base case: a legacy worker slot is logical only until its first run, which creates exactly one terminal.
    const slot = await d.slot(repo, "T1-worker-fake-a0-20261104-tag");
    expect(slot.name).toBe("tickmarkr:worker:T1:0:run-20261104-tag");
    expect(f.calls()).toEqual([]);
    await d.run(slot, "env");
    const runs = f.hcCalls("run");
    expect(runs).toEqual([["run", "--bg", "--no-parent", "--no-notify", "--cwd", cwd,
      "--label", `${OWNER_LABEL}=${slot.name}`, "--label", `${REPO_LABEL}=${repoId(repo)}`,
      "--json", "--", "bash", "-lc", terminalPayload("env", env, exports)]]);
    expect(f.term("t1")).toMatchObject({ parent: null, die_with_parent: false, notify: false, cwd });

    // The terminal's environment is the CORE's plus hc's fresh pair/scope: client-only FOO never arrives, the
    // inherited launcher scope is not the terminal's, the fork cap and carried value cross only as explicit exports.
    const childEnv = Object.fromEntries((await d.read(slot, 200)).split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    expect(childEnv.FOO).toBeUndefined();
    expect(childEnv.HC_SCOPE).toBe("scope-own-t1");
    expect(childEnv.CORE_AUTH).toBe("core-token");
    expect(childEnv.TERM_PROGRAM).toBe("ghostty");
    expect(childEnv.VITEST_MAX_FORKS).toBe("3");
    expect(childEnv.CARRIED).toBe("carried value; $x");
    // The daemon's PATH crosses explicitly: an agent CLI it resolved from a shell-profile directory runs in the terminal.
    expect(childEnv.PATH).toBe(process.env.PATH);
    // ...but never an empty one, which would find no command: the core's PATH stays.
    expect(terminalPayload("true", { PATH: "" })).not.toContain("export PATH=");
    expect(terminalPayload("true", { PATH: "/opt/x/bin" })).toContain("export PATH='/opt/x/bin'; true");
    expect(childEnv.__tickmarkr_own_hc_scope).toBeUndefined();
    for (const k of HERDR_CONTROL_VARS) if (k !== ("HC_SCOPE" as string)) expect(childEnv[k], k).toBeUndefined();
    expect(await d.transportState(slot)).toEqual({ closed: true, exitCode: 0, signal: null });
    expect(() => terminalPayload("true", env, { "BAD-NAME": "x" })).toThrow(/not a shell variable name/);

    // Legacy scope names canonicalize under one stable invocation-local run identity; the label round-trips.
    const scopeA = await d.slot(repo, "scope · draft");
    const scopeB = await d.slot(repo, "scope · draft");
    expect(scopeA.name).toMatch(/^tickmarkr:other:scope · draft:0:run-local-[0-9a-f]+$/);
    expect(scopeB.name).toBe(scopeA.name);
    await d.run(scopeA, "true");
    expect(f.term("t2").labels[OWNER_LABEL]).toBe(scopeA.name);
    // A full owner with long ids round-trips byte-exact as a label; malformed explicit identities reject.
    const owned = { role: "review" as const, taskId: "T12-a-very-long-task-identifier-past-thirty-two", attempt: 2, runId: "run-20261104-093422-0000000000000814" };
    const long = await d.slot(repo, "short", { owned });
    await d.run(long, "true");
    expect(f.term("t3").labels).toMatchObject({ [OWNER_LABEL]: formatOwnedName(owned), [REPO_LABEL]: repoId(repo) });
    await expect(d.slot(repo, "x", { owned: { ...owned, taskId: "T1:x" } })).rejects.toThrow(/malformed owned identity/);
    await expect(d.slot(repo, "x", { owned: { ...owned, attempt: -1 } })).rejects.toThrow(/malformed owned identity/);

    // A CLI that parents the task terminal under its launcher (no-parent ignored) is rejected even though the command ran.
    f.update((s) => { s.forceParent = "t0"; s.execute = false; });
    const parented = await d.slot(repo, "T2-worker-fake-a0-20261104-tag");
    await expect(d.run(parented, "true")).rejects.toThrow(/launcher child/);
    await expect(d.run(parented, "true")).rejects.toThrow(/already issued/);
    await expect(d.read(parented, 10)).rejects.toThrow(HcUnavailableError);
    f.update((s) => { delete s.forceParent; });

    // A missing/ambiguous creation receipt is unconfirmed: no second run, no guessed kill, the unique owned orphan named.
    const lost = await d.slot(repo, "T3-worker-fake-a0-20261104-tag");
    f.rule({ match: ["run"], once: true, output: '{"address":', mutate: { t9: { cwd, labels: { [OWNER_LABEL]: lost.name, [REPO_LABEL]: repoId(repo) } } } });
    const before = f.hcCalls("run").length;
    await expect(d.run(lost, "true")).rejects.toThrow(/creation unconfirmed.*owned orphan t9/s);
    await expect(d.run(lost, "true")).rejects.toThrow(/already issued/);
    expect(f.hcCalls("run").length).toBe(before + 1);
    expect([...f.hcCalls("kill"), ...f.hcCalls("rm"), ...f.hcCalls("send")]).toEqual([]);
  }, 60_000);
});

describe("HerdrAppDriver — reads and transport closure (contract L-observe)", () => {
  it("live incomplete reads return text and finished screen-only reads prove drain despite incomplete history while unreadable screen output never proves closure", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    const f = fake();
    const d = driver(f);
    const TRAILER = 'TICKMARKR_RESULT_RONE {"ok":true}';

    // Base case: a live terminal's incomplete (working, full-screen) read is still its text.
    const working = readOf("Q3-status-working-read");
    const live = await bound(f, d, repo, { state: "live", history: working, screen: working });
    expect(await d.read(live.slot, 100)).toBe(working.text);
    expect(await d.waitOutput(live.slot, "ACK working", 1_000)).toBe(true);
    expect(await d.transportState(live.slot)).toEqual({ closed: false, exitCode: null, signal: null });

    // Finished alternate-screen exit: history incomplete, final screen-only read complete — trailer found, drain proven.
    for (const probe of ["alt-exit", "alt-return"]) {
      const s = await bound(f, d, repo, { state: "finished", exit_code: 0, reason: "exited", history: readOf(`R1-${probe}-history`), screen: readOf(`R1-${probe}-screen`) }, `T${probe.length}-worker-fake-a0-${probe}`);
      expect(await d.read(s.slot, 100)).toContain(TRAILER);
      expect(await d.waitOutput(s.slot, TRAILER, 1_000)).toBe(true);
      expect(await d.waitOutput(s.slot, 'TICKMARKR_RESULT_RONE \\{"ok":true\\}', 1_000, { regex: true })).toBe(true);
      expect(await d.transportState(s.slot)).toEqual({ closed: true, exitCode: 0, signal: null });
      const started = Date.now();
      expect(await d.waitOutput(s.slot, "TICKMARKR_RESULT_ABSENT", 5_000)).toBe(false); // drained: absence proven at once
      expect(Date.now() - started).toBeLessThan(4_000);
    }

    // A killed terminal's numeric signal maps to its OS name.
    const killed = await bound(f, d, repo, { state: "finished", exit_code: null, signal: 1, reason: "killed", history: readOf("R1-alt-return-history"), screen: readOf("R1-alt-return-screen") }, "T9-worker-fake-a0-killed");
    expect(await d.transportState(killed.slot)).toEqual({ closed: true, exitCode: null, signal: "SIGHUP" });

    // Finished but the final screen-only read is incomplete: text is still returned, closure never proven.
    const tui = readOf("Q3-tui-read");
    const unproven = await bound(f, d, repo, { state: "finished", exit_code: 0, reason: "exited", history: tui, screen: tui }, "T8-worker-fake-a0-unproven");
    expect(await d.read(unproven.slot, 100)).toBe(tui.text);
    await expect(d.transportState(unproven.slot)).rejects.toThrow(/drain unproven/);
    expect(await d.waitOutput(unproven.slot, "NEVER_PRINTED", 400)).toBe(false);
    // Drain is proven ONLY by a complete final screen-only read (review reproducer): over history completeness x the
    // first screen read's completeness, an incomplete screen keeps polling boundedly and finds a marker that a later
    // complete screen shows, even beside complete history; a complete screen proves absence and stops at once.
    // The --lines 0 answer proves drain only in the exact shape that request implies — complete AND how screen
    // (OBSERVER D-2180 add.4): a complete HISTORY answer to a screen-only read is unreadable for drain, so waitOutput
    // keeps polling (and finds the later TRAILER) and transportState never reports closed.
    const shapes = [[true, false, "screen"], [false, false, "screen"], [true, true, "history"], [false, true, "history"], [true, false, "history"],
      [true, true, "screen"], [false, true, "screen"]] as const;
    for (const [i, [historyComplete, screenComplete, how]] of shapes.entries()) {
      const row = `history complete ${historyComplete}, first --lines 0 answer complete ${screenComplete} how ${how}`;
      const proves = screenComplete && how === "screen";
      const s = await bound(f, d, repo, { state: "finished", exit_code: 0, reason: "exited", history: { text: "", complete: historyComplete }, screen: { text: "", complete: screenComplete } }, `T3${i}-worker-fake-a0-drain`);
      const screenOnly = ["read", s.address, "--lines", "0"];
      f.rule({ match: screenOnly, once: true, output: readBody("", screenComplete, how) }, { match: screenOnly, once: true, output: readBody(TRAILER) });
      expect(await d.waitOutput(s.slot, TRAILER, 3_000), row).toBe(!proves);
      expect(f.read().rules.length, row).toBe(proves ? 1 : 0); // the later screen was read only when owed
      f.clearRules();
      f.rule({ match: screenOnly, once: true, output: readBody("", screenComplete, how) });
      if (proves) expect(await d.transportState(s.slot), row).toEqual({ closed: true, exitCode: 0, signal: null });
      else await expect(d.transportState(s.slot), row).rejects.toThrow(/drain unproven/);
      f.clearRules();
    }
    // An unreadable (malformed) final screen read never proves closure either.
    f.rule({ match: ["read", unproven.address, "--lines", "0"], output: '{"text":"x","complete":tr' });
    await expect(d.transportState(unproven.slot)).rejects.toThrow(HcError);
    f.clearRules();
    // A missing or re-owned terminal is unavailable, never closed.
    f.update((s) => { s.terminals[killed.address].labels[OWNER_LABEL] = "tickmarkr:worker:OTHER:0:run-x"; delete s.terminals[unproven.address]; });
    await expect(d.transportState(killed.slot)).rejects.toThrow(/not this slot's terminal/);
    await expect(d.transportState(unproven.slot)).rejects.toThrow(/is gone/);
    await expect(d.read(unproven.slot, 10)).rejects.toThrow(HcUnavailableError);
  }, 120_000);
});

describe("HerdrAppDriver — agent status (contract L-observe)", () => {
  it("reported agent states satisfy the closed status-wait table while timeout message and exit wakeups cannot invent the requested state", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    const f = fake();
    const d = driver(f);
    const { slot, address } = await bound(f, d, repo, { state: "live", reported: true, status: { state: "working", app: "pi" } });

    // Base case: each reported state is returned exactly.
    for (const state of ["idle", "working", "done", "blocked", "error"]) {
      f.setTerm(address, { reported: true, status: { state, app: "pi" } });
      expect(await d.status(slot)).toBe(state);
    }
    // Unreported, null or unrecognized is unknown — never inferred.
    f.setTerm(address, { reported: false, status: { state: "idle" } });
    expect(await d.status(slot)).toBe("unknown");
    f.setTerm(address, { reported: true, status: null });
    expect(await d.status(slot)).toBe("unknown");
    f.setTerm(address, { reported: true, status: { state: "thinking" } });
    expect(await d.status(slot)).toBe("unknown");
    // A malformed envelope is an explicit unreadable failure.
    f.rule({ match: ["get", address], once: true, output: JSON.stringify({ ...capJson("Q3-status-get"), address, status: 5 }) });
    await expect(d.status(slot)).rejects.toThrow(HcError);

    // Wakeups for another settled state, a message, a timeout or an exit never invent the requested state.
    f.setTerm(address, { reported: true, status: { state: "working", app: "pi" } });
    const wake = (o: Record<string, unknown>): FakeRule => ({ match: ["wait", address], once: true, output: JSON.stringify({ ...o, terminal: address }) });
    f.rule(
      wake(capJson("Q3-status-idle")),
      wake({ children: [], ended: false, exit_code: null, reason: "message", signal: null, status: "working", turn: 0 }),
      wake({ children: [], ended: false, exit_code: null, reason: "timeout", signal: null, status: "working", turn: 0 }),
      wake(capJson("Q2-wait")),
    );
    expect(await d.waitAgentStatus(slot, "idle", 5_000)).toBe(false);
    expect(f.read().rules).toEqual([]); // every scripted wakeup was delivered and none decided the answer
    const waits = f.hcCalls("wait");
    expect(waits.length).toBeGreaterThanOrEqual(4);
    for (const w of waits) expect(Number(w[w.indexOf("--timeout") + 1])).toBeLessThanOrEqual(0.2);
    // The requested state is matched only when the authoritative get reports it.
    f.rule({ match: ["wait", address], once: true, output: cap("Q3-status-idle").replace('"t5"', `"${address}"`), mutate: { [address]: { status: { state: "idle", app: "pi" } } } });
    expect(await d.waitAgentStatus(slot, "idle", 3_000)).toBe(true);
    expect(await d.waitAgentStatus(slot, "working", 400)).toBe(false);
    // A finished terminal with no report is not done because it exited.
    f.setTerm(address, { state: "finished", exit_code: 7, reason: "exited", reported: false, status: null });
    expect(await d.waitAgentStatus(slot, "done", 1_000)).toBe(false);
    expect(await d.status(slot)).toBe("unknown");
  }, 60_000);
});

declareInputBox("hcapp-probe", {
  fingerprint: "[composer:",
  emptyMatch: (text) => text.trimEnd().endsWith("[composer: empty]"),
  occupiedMatch: (text) => text.trimEnd().endsWith("[composer: draft]"),
});

describe("HerdrAppDriver — pinned input (contract L-keys)", () => {
  it("pinned input follows the closed key and readiness tables including Down mapped to down while unknown keys or replacement targets receive no input", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    const f = fake();
    const d = driver(f);
    const journal: [string, Record<string, unknown> | undefined][] = [];
    d.journalWith((event, _task, data) => journal.push([event, data]));
    const ready = { state: "live" as const, reported: true, status: { state: "idle" }, screen: { text: "probe\n[composer: empty]", complete: true } };
    const { slot, address } = await bound(f, d, repo, ready, "T5-worker-hcapp-probe-a0-tag");
    expect(f.hcCalls("send")).toEqual([]); // the initial command rode the creation argv

    // Base case: Down becomes `hc keys <owned> down` through the real driver and client; the table is closed.
    await d.sendKey(slot, "Down");
    expect(f.hcCalls("keys")).toEqual([["keys", address, "down", "--json"]]);
    for (const [logical, key] of Object.entries(HC_KEYS)) {
      f.clearCalls();
      await d.sendKey(slot, logical);
      expect(f.hcCalls("keys")).toEqual([["keys", address, key, "--json"]]);
    }
    expect(HC_KEYS).toEqual({ Enter: "enter", Down: "down", Up: "up", Esc: "esc", "ctrl+c": "ctrl+c" });
    f.clearCalls();
    for (const bad of ["Tab", "enter", "down", "ESC", "Ctrl+C", "\u001b", "\r", "Down Enter", "Down;rm -rf /", "$(reboot)", "", "toString", "__proto__"]) {
      await expect(d.sendKey(slot, bad), JSON.stringify(bad)).rejects.toThrow(/closed key set/);
    }
    expect(f.calls()).toEqual([]); // rejected before any hc call

    // Ready (declared empty composer): one hc send without --force, confirmed by the same terminal's read-back.
    await d.run(slot, "second message");
    expect(f.hcCalls("send")).toEqual([["send", address, "second message", "--json"]]);
    expect(f.calls().flatMap((c) => c.argv)).not.toContain("--force");
    // An occupied composer or a blocked dialog receives nothing.
    f.clearCalls();
    f.setTerm(address, { screen: { text: "probe\n[composer: draft]", complete: true } });
    await expect(d.run(slot, "third")).rejects.toThrow(/composer occupied/);
    f.setTerm(address, { status: { state: "blocked" }, screen: ready.screen });
    await expect(d.run(slot, "third")).rejects.toThrow(/blocked/);
    expect(f.hcCalls("send")).toEqual([]);
    // A zero-exit send without read-back evidence is not proof: run throws, nudge returns false with a diagnostic.
    f.setTerm(address, { status: { state: "idle" }, screen: ready.screen, echo: false });
    await expect(d.run(slot, "unechoed")).rejects.toThrow(/no read-back confirmed/);
    f.setTerm(address, { screen: ready.screen });
    expect(await d.nudge(slot, "nudge one")).toBe(false);
    expect(journal.at(-1)?.[0]).toBe("herdr-app-nudge-unconfirmed");
    // A reported working turn after the send is read-back proof.
    f.setTerm(address, { screen: ready.screen, onSend: { status: { state: "working" } } });
    expect(await d.nudge(slot, "nudge two")).toBe(true);
    // Stale evidence never confirms: an already-working terminal staying working, or a screen that already held the
    // message's first line with no new echo, leaves the send unconfirmed. A NEW echo beside old text still confirms.
    f.setTerm(address, { status: { state: "working" }, screen: ready.screen, echo: false, onSend: undefined });
    await expect(d.run(slot, "while working")).rejects.toThrow(/no read-back confirmed/);
    expect(await d.nudge(slot, "while working")).toBe(false);
    const stale = { text: "probe\nold message\n[composer: empty]", complete: true };
    f.setTerm(address, { status: { state: "idle" }, screen: stale, echo: false });
    await expect(d.run(slot, "old message")).rejects.toThrow(/no read-back confirmed/);
    expect(await d.nudge(slot, "old message")).toBe(false);
    f.setTerm(address, { screen: stale, echo: true });
    expect(await d.nudge(slot, "old message")).toBe(true);
    // Confirmation must be attributable to THIS submission (review reproducer): a working state reached before the
    // send — during the readiness read, or already reported by the send itself — never confirms it, with or without a
    // declared composer; only a transition after the send (control) does. Without a composer, a terminal that turned
    // working during the readiness read is no longer ready and receives nothing.
    const plainScreen = { text: "plain shell", complete: true };
    const plain = await bound(f, d, repo, { state: "live", reported: true, status: { state: "idle" }, screen: plainScreen, echo: false }, "T8-worker-fake-a0-tag");
    const turnedWorking = (at: string): Record<string, Partial<FakeTerm>> => ({ [at]: { status: { state: "working" } } });
    const attributable: [string, (at: string, text: string) => FakeRule[], boolean, number, number][] = [
      ["turned working during the readiness read", (at, text) => [{ match: ["read", at, "--lines", "0"], once: true, output: readBody(text), mutate: turnedWorking(at) }], false, 1, 0],
      ["send met an already-working agent", (at) => [{ match: ["send", at], once: true, output: JSON.stringify({ started: null, status: "working", turn: 0 }) + "\n", mutate: turnedWorking(at) }], false, 1, 1],
      ["turned working after the send (control)", () => [], true, 1, 1],
    ];
    for (const [composer, target, screen] of [["declared composer", { slot, address }, ready.screen], ["no declared composer", plain, plainScreen]] as const) {
      for (const [row, script, confirmed, sendsWithBox, sendsWithout] of attributable) {
        for (const via of ["nudge", "run"] as const) {
          const label = `${composer}: ${row} via ${via}`;
          f.setTerm(target.address, { status: { state: "idle" }, screen, echo: false, onSend: confirmed ? { status: { state: "working" } } : undefined });
          f.clearRules(); f.rule(...script(target.address, screen.text)); f.clearCalls();
          const outcome = via === "nudge" ? await d.nudge(target.slot, row) : await d.run(target.slot, row).then(() => true, () => false);
          expect(outcome, label).toBe(confirmed);
          expect(f.hcCalls("send").length, label).toBe(composer === "declared composer" ? sendsWithBox : sendsWithout);
        }
      }
    }
    f.clearRules();
    f.setTerm(address, { status: { state: "idle" }, screen: ready.screen, echo: true, onSend: undefined });
    // The adapter's composer follows opts.agent under a canonical owned name: reported idle + occupied draft → no send.
    const canon = await bound(f, d, repo, { ...ready, screen: { text: "probe\n[composer: draft]", complete: true } }, "tickmarkr:worker:T7:0:run-r", { agent: "hcapp-probe" });
    f.clearCalls();
    await expect(d.run(canon.slot, "into the draft?")).rejects.toThrow(/composer occupied/);
    expect(await d.nudge(canon.slot, "into the draft?")).toBe(false);
    expect(f.hcCalls("send")).toEqual([]);
    f.setTerm(address, { status: { state: "idle" }, screen: ready.screen, echo: true });

    // A replacement terminal carrying this owner elsewhere never receives input; the pinned one was re-owned.
    f.clearCalls();
    f.update((s) => {
      s.terminals.t77 = { ...s.terminals[address], address: "t77", status: { state: "idle" }, onSend: undefined };
      s.terminals[address].labels = { ...s.terminals[address].labels, [OWNER_LABEL]: "tickmarkr:worker:T5:0:run-someone-else" };
    });
    await expect(d.sendKey(slot, "Down")).rejects.toThrow(HcUnavailableError);
    expect(await d.nudge(slot, "to the replacement?")).toBe(false);
    await expect(d.run(slot, "to the replacement?")).rejects.toThrow(/not this slot's terminal/);
    // Gone or finished: no input either.
    f.update((s) => { delete s.terminals[address]; });
    await expect(d.sendKey(slot, "Enter")).rejects.toThrow(/is gone/);
    const done = await bound(f, d, repo, { state: "finished", exit_code: 0 }, "T6-worker-hcapp-probe-a0-tag");
    await expect(d.sendKey(done.slot, "Enter")).rejects.toThrow(/has finished/);
    expect([...f.hcCalls("keys"), ...f.hcCalls("send")]).toEqual([]);
  }, 120_000);
});

describe("HerdrAppDriver — teardown, notify and worktree (contract L-close)", () => {
  it("owned terminal teardown satisfies the closed close table while foreign cleanup never succeeds and notification never types into the launcher", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    const f = fake();
    const d = driver(f);
    let n = 0;
    const live = { state: "live" as const };
    const fresh = (spawn: Partial<FakeTerm> = live) => bound(f, d, repo, spawn, `T${++n}-worker-fake-a0-close`);
    const mutations = (): string[][] => [...f.hcCalls("kill"), ...f.hcCalls("rm")];

    // Base case: exact pinned ownership → kill, rm, then proven absence. No tab or space is touched.
    const a = await fresh();
    f.clearCalls();
    await d.close(a.slot);
    expect(mutations()).toEqual([["kill", a.address, "--json"], ["rm", a.address, "--json"]]);
    expect(f.term(a.address)).toBeUndefined();
    expect(f.calls().some((c) => c.tool === "herdr-app")).toBe(false);
    // Already finished: ownership still checked, no kill, still removed.
    const b = await fresh({ state: "finished", exit_code: 0 });
    f.clearCalls();
    await d.close(b.slot);
    expect(f.hcCalls("get").length).toBeGreaterThan(0);
    expect(mutations()).toEqual([["rm", b.address, "--json"]]);
    // Already absent on a readable list: idempotent.
    const c = await fresh();
    f.update((s) => { delete s.terminals[c.address]; });
    f.clearCalls();
    await d.close(c.slot);
    expect(mutations()).toEqual([]);

    // Protected: unreadable list, foreign owner/repo/checkout, changed core — failure reported, nothing killed.
    const protectedCases: [string, (address: string) => void, RegExp | typeof HcError][] = [
      ["unreadable list", () => f.rule({ match: ["ls"], once: true, output: '{"terminals":[' }), HcError],
      ["foreign owner", (x) => f.update((s) => { s.terminals[x].labels[OWNER_LABEL] = "tickmarkr:worker:T1:0:run-foreign"; }), /owner label differs/],
      ["foreign repo", (x) => f.update((s) => { s.terminals[x].labels[REPO_LABEL] = "/elsewhere/.git"; }), /repo label differs/],
      ["wrong checkout", (x) => f.update((s) => { s.terminals[x].cwd = "/elsewhere"; }), /checkout differs/],
      ["changed core", () => f.update((s) => { s.core.id = "6cbddbb9ee1f3afcd9e3e7691515f5ca"; }), /core identity changed/],
    ];
    for (const [label, mutate, expected] of protectedCases) {
      const t = await fresh();
      mutate(t.address);
      f.clearCalls();
      await expect(d.close(t.slot), label).rejects.toThrow(expected);
      expect(mutations(), label).toEqual([]);
      expect(f.term(t.address), label).toBeDefined();
      f.update((s) => { s.core.id = "f191f9b1503d40cb5c557bf9f3701747"; s.rules = []; });
    }
    // Ownership lost between get and kill, visible in the kill receipt: protected, never rm'd, failure reported.
    const lostOwner = await fresh();
    const foreign = { [OWNER_LABEL]: "tickmarkr:worker:T1:0:run-foreign", [REPO_LABEL]: repoId(repo) };
    f.rule({ match: ["kill", lostOwner.address], once: true, mutate: { [lostOwner.address]: { labels: foreign, state: "finished", reason: "killed", signal: 1 } },
      output: recordOf(f, lostOwner.address, { labels: foreign, state: "finished", reason: "killed", signal: 1 }) });
    f.clearCalls();
    await expect(d.close(lostOwner.slot)).rejects.toThrow(/ownership lost during kill \(owner label differs\)/);
    expect(f.hcCalls("rm")).toEqual([]);
    expect(f.term(lostOwner.address)).toBeDefined();
    // kill/rm failure or a surviving target is not a successful close.
    const k = await fresh();
    f.rule({ match: ["kill", k.address], once: true, stderr: JSON.stringify({ error: { kind: "refused", message: "no" } }) + "\n", exit: 1 });
    await expect(d.close(k.slot)).rejects.toThrow(/terminal response family failed/);
    expect(f.hcCalls("rm").filter((x) => x[1] === k.address)).toEqual([]);
    const r = await fresh({ state: "finished", exit_code: 0 });
    f.rule({ match: ["rm", r.address], once: true, stderr: JSON.stringify({ error: { kind: "refused", message: "no" } }) + "\n", exit: 1 });
    await expect(d.close(r.slot)).rejects.toThrow(/rm response family failed/);
    const s = await fresh({ state: "finished", exit_code: 0 });
    f.rule({ match: ["rm", s.address], once: true, output: JSON.stringify({ removed: s.address }) });
    await expect(d.close(s.slot)).rejects.toThrow(/survived/);
    // Absence is proven only by an EXHAUSTIVE listing (hidden_finished 0; OBSERVER D-2180 add.4), before removal and
    // after a successful rm receipt alike. A listing that hides any terminal leaves absence unproven: close throws,
    // the slot is kept (a later exhaustive close takes it back) and the target survives; hidden 0 is the control.
    const listing = (hidden: number, rows: { address: string; cwd: string; state: string }[] = []): string => JSON.stringify({ hidden_finished: hidden, terminals: rows }) + "\n";
    for (const phase of ["before removal", "after a successful rm receipt"] as const) {
      for (const hidden of [1, 0]) {
        const label = `${phase}, hidden_finished ${hidden}`;
        const x = await fresh();
        f.clearRules();
        if (phase === "before removal") f.rule({ match: ["ls"], once: true, output: listing(hidden) });
        else f.rule({ match: ["ls"], once: true, output: listing(0, [{ address: x.address, cwd: realpathSync(repo), state: "live" }]) },
          { match: ["rm", x.address], once: true, output: JSON.stringify({ removed: x.address }) + "\n" }, { match: ["ls"], once: true, output: listing(hidden) });
        f.clearCalls();
        const removal = phase === "before removal" ? [] : [["kill", x.address, "--json"], ["rm", x.address, "--json"]];
        if (hidden) {
          await expect(d.close(x.slot), label).rejects.toThrow(/absence unproven/);
          expect(mutations(), label).toEqual(removal);
          expect(f.term(x.address), label).toBeDefined();
          await d.close(x.slot); // kept: the default listing is exhaustive, so the retry removes it
          expect(f.term(x.address), label).toBeUndefined();
        } else {
          await d.close(x.slot);
          expect(mutations(), label).toEqual(removal);
          await expect(d.close(x.slot), label).rejects.toThrow(/unknown slot/); // released: the listing was believed
        }
      }
    }
    f.clearRules();

    // Creation outcomes (review reproducers). A never-issued slot closes as a logical no-op. An issued creation with no
    // receipt is unresolved: close fails every time, keeps the slot, kills nothing and the owned orphan survives for
    // reconciliation. A receipt-bound but unconfirmed creation is re-verified at its receipt address on the same core
    // and taken back only while still owned; otherwise close fails and the terminal survives.
    const idle = await d.slot(repo, `T${++n}-worker-fake-a0-close`);
    f.clearCalls();
    await d.close(idle);
    expect(f.calls()).toEqual([]);
    const cwd = realpathSync(repo);
    const ours = (slot: Slot): Record<string, string> => ({ [OWNER_LABEL]: slot.name, [REPO_LABEL]: repoId(repo) });
    const receipt = (address: string, term: Partial<FakeTerm>, extra: Partial<FakeRule> = {}): FakeRule => ({
      match: ["run"], once: true, output: JSON.stringify({ address, agent: "bash", cwd, name: null, state: "live", turn: 0 }) + "\n",
      mutate: { [address]: { address, cwd, ...term } }, ...extra,
    });
    const refused = JSON.stringify({ error: { kind: "refused", message: "no" } }) + "\n";
    const creations: [string, (slot: Slot) => FakeRule[], RegExp, RegExp | typeof HcError | null, string | null][] = [
      ["malformed receipt, unique owned orphan", (sl) => [{ match: ["run"], once: true, output: '{"address":', mutate: { t901: { address: "t901", cwd, labels: ours(sl) } } }],
        /creation unconfirmed.*owned orphan t901/s, /creation unconfirmed.*owned orphan t901/s, "t901"],
      // Uniqueness is absence of any other owned terminal, so a listing that hides one cannot name the orphan.
      ["malformed receipt, orphan behind a hiding listing", (sl) => [{ match: ["run"], once: true, output: '{"address":', mutate: { t907: { address: "t907", cwd, labels: ours(sl) } } },
        { match: ["ls"], once: true, output: listing(1, [{ address: "t907", cwd, state: "live" }]) }],
        /creation unconfirmed(?![\s\S]*owned orphan)/, /creation unconfirmed(?![\s\S]*owned orphan)/, "t907"],
      ["refused receipt", () => [{ match: ["run"], once: true, stderr: refused, exit: 1 }], /creation unconfirmed/, /creation unconfirmed/, null],
      ["malformed confirmation get", (sl) => [receipt("t902", { labels: ours(sl) }), { match: ["get", "t902"], once: true, output: '{"address":' }],
        /t902 creation unconfirmed/, null, "t902"],
      ["unreadable get at confirmation and close", (sl) => [receipt("t903", { labels: ours(sl) }), { match: ["get", "t903"], output: '{"address":' }],
        /t903 creation unconfirmed/, HcError, "t903"],
      ["parented duplicate", (sl) => [receipt("t904", { labels: ours(sl), parent: "t0", die_with_parent: true })], /launcher child/, null, "t904"],
      ["receipt for a foreign terminal", () => [receipt("t905", { labels: { [OWNER_LABEL]: "tickmarkr:worker:T1:0:run-foreign", [REPO_LABEL]: repoId(repo) } })],
        /owner label differs/, /owner label differs/, "t905"],
      ["core changed during creation", (sl) => [receipt("t906", { labels: ours(sl) }, { coreId: "6cbddbb9ee1f3afcd9e3e7691515f5ca" })],
        /core identity changed during creation/, /core identity changed/, "t906"],
    ];
    for (const [label, script, runErr, closeErr, at] of creations) {
      const slot = await d.slot(repo, `T${++n}-worker-fake-a0-close`);
      f.rule(...script(slot));
      await expect(d.run(slot, "true"), label).rejects.toThrow(runErr);
      f.clearCalls();
      if (closeErr) {
        await expect(d.close(slot), label).rejects.toThrow(closeErr);
        await expect(d.close(slot), label).rejects.toThrow(closeErr); // the slot is kept and still reported
        expect([...mutations(), ...f.hcCalls("send"), ...f.hcCalls("run")], label).toEqual([]);
        if (at) expect(f.term(at), label).toBeDefined();
      } else {
        await d.close(slot);
        expect(mutations(), label).toEqual([["kill", at, "--json"], ["rm", at, "--json"]]);
        expect(f.term(at!), label).toBeUndefined();
      }
      f.update((st) => { st.core.id = "f191f9b1503d40cb5c557bf9f3701747"; st.rules = []; });
    }

    // notify is the console/OS fallback: never an hc send or key into the launcher (or anything else).
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      f.clearCalls();
      await d.notify("park: T1 needs a decision", { tier: "attention" });
      await d.notify("routine beat", { tier: "routine" });
      expect(f.calls()).toEqual([]);
      expect(log.mock.calls).toEqual([["[tickmarkr] park: T1 needs a decision"]]);
    } finally { log.mockRestore(); }
    // worktree is tickmarkr's own createWorktree, never a Herdr command.
    const wt = await d.worktree(repo, "tkr-hcapp-worktree", "HEAD");
    expect(existsSync(join(wt, "a.txt"))).toBe(true);
    expect(f.calls()).toEqual([]);
  }, 120_000);
});

describe("HerdrAppDriver — caller deadlines (contract J/L)", () => {
  it("evidence observed after a caller deadline is never accepted and no call outlives the deadline", async () => {
    const repo = makeRepo({ "a.txt": "a" });
    const idle = { state: "live" as const, reported: true, status: { state: "idle" }, screen: { text: "probe\n[composer: empty]", complete: true } };
    let n = 0;
    // Each row: a fresh fake whose ONE scripted call answers 1.5 s (real) late — past the 4 s deadline on a 4x clock,
    // inside the call bound that deadline grants — with exactly the evidence the loop is waiting for.
    const late = async (spawn: Partial<FakeTerm>, script: (f: FakeHerdrApp, address: string) => void, act: (d: HerdrAppDriver, slot: Slot) => Promise<unknown>) => {
      const f = fake();
      const d = driver(f, { time: fastClock(4), readinessMs: 4_000, confirmMs: 4_000, pollMs: 200 });
      const { slot, address } = await bound(f, d, repo, spawn, `T${++n}-worker-hcapp-probe-a0-late`);
      script(f, address);
      f.clearCalls();
      return { result: await act(d, slot).then((v) => v, (e: unknown) => e), f, address };
    };
    const lateScreen = (f: FakeHerdrApp, address: string, text: string) => f.rule({ match: ["read", address, "--lines", "0"], once: true, sleepMs: 1_500, output: readBody(text) });

    // deliver readiness: a ready screen that arrives late sends nothing.
    const r1 = await late(idle, (f, a) => lateScreen(f, a, idle.screen.text), (d, s) => d.run(s, "late ready"));
    expect(r1.result).toBeInstanceOf(HcUnavailableError);
    expect(r1.f.hcCalls("send")).toEqual([]);
    // deliver confirmation: an echo read back late never confirms the send.
    const r2 = await late(idle, (f, a) => {
      f.rule({ match: ["read", a, "--lines", "0"], once: true, output: readBody(idle.screen.text) });
      lateScreen(f, a, `${idle.screen.text}\nlate confirm`);
    }, (d, s) => d.run(s, "late confirm"));
    expect(r2.result).toBeInstanceOf(HcUnavailableError);
    expect(r2.f.hcCalls("send").length).toBe(1);
    // waitOutput: a history match, or a finished terminal's screen match, that arrives late is false.
    const r3 = await late({ state: "live" }, (f, a) => f.rule({ match: ["read", a, "--lines", "1000"], once: true, sleepMs: 1_500, output: readBody("LATE_MARK", true, "history") }),
      (d, s) => d.waitOutput(s, "LATE_MARK", 4_000));
    expect(r3.result).toBe(false);
    const r4 = await late({ state: "finished", exit_code: 0, history: { text: "", complete: false } }, (f, a) => lateScreen(f, a, "LATE_MARK"),
      (d, s) => d.waitOutput(s, "LATE_MARK", 4_000));
    expect(r4.result).toBe(false);
    // waitAgentStatus: the requested state reported by a late authoritative get is false.
    const r5 = await late({ ...idle, status: { state: "working" } }, (f, a) => f.rule({ match: ["get", a], once: true, sleepMs: 1_500, output: recordOf(f, a, { status: { state: "idle" } }) }),
      (d, s) => d.waitAgentStatus(s, "idle", 4_000));
    expect(r5.result).toBe(false);

    // Real clock: a hung wait slice is killed at the caller's remaining deadline, not after a fresh call ceiling.
    const f = fake();
    const d = driver(f);
    const { slot, address } = await bound(f, d, repo, { ...idle, status: { state: "working" } }, "T9-worker-hcapp-probe-a0-hung");
    f.rule({ match: ["wait", address], once: true, sleepMs: 4_000, output: cap("Q3-status-idle") });
    const started = Date.now();
    expect(await d.waitAgentStatus(slot, "idle", 800)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_500);
    // A spent deadline issues no call at all.
    f.clearCalls();
    expect(await d.waitOutput(slot, "x", 0)).toBe(false);
    expect(await d.waitAgentStatus(slot, "idle", 0)).toBe(false);
    expect(f.calls()).toEqual([]);
  }, 60_000);
});
