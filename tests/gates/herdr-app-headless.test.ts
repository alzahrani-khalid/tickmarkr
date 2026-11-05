import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { shq } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { HERDR_CONTROL_VARS, SEAT_MARKER_ENV } from "../../src/drivers/host-env.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { runLlm } from "../../src/gates/llm.js";
import { consult, type Dossier } from "../../src/run/consult.js";
import { sh } from "../../src/run/git.js";
import { makeTestTempDir, reapTestTempDirs } from "../helpers/tmprepo.js";

// Queue row 340; D-2180 — contract E/C: every agent CLI launched through runHeadlessDetailed (the default headless
// transport of runLlm: judge, review, and role-less callers such as the scope draft in src/plan/scope.ts) is sealed
// from the caller's host addressing whether or not a seat role can be read from its prompt. The environment is read
// in the agent's own process, never from a Node-side copy.

afterEach(() => vi.unstubAllEnvs());
afterAll(() => reapTestTempDirs());

test("every headless agent launch including role-less callers receives the explicit agent seal while non-agent shells retain their core addressing", async () => {
  const dir = makeTestTempDir("headless-seal-");
  // Injected terminal addressing (the hc pair and scope the daemon's terminal carries) plus imported caller controls.
  const inherited = {
    HC_TERMINAL_ID: "t4", HC_TERMINAL_SOCKET: "/tmp/hc-headless.sock", HC_SCOPE: "launcher-scope-token",
    HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", ORCA_TERMINAL_HANDLE: "term-x", ORCA_PANE_KEY: "pane-x", ORCA_TAB_ID: "tab-x",
  };
  for (const [k, v] of Object.entries(inherited)) vi.stubEnv(k, v);
  vi.stubEnv("HOME", dir); // login shells: keep the operator's profile out of the recorded environment
  vi.stubEnv("ANTHROPIC_API_KEY", "user-auth-value");
  vi.stubEnv(SEAT_MARKER_ENV, undefined);

  // The agent CLI: records its own environment, keyed by the prompt's first line, and prints a consult-shaped verdict.
  writeFileSync(join(dir, "script.json"), JSON.stringify({ tasks: {} }));
  const fake = new FakeAdapter(join(dir, "script.json"));
  fake.headlessCommand = (promptFile) => `${shq(process.execPath)} -e ${shq(`
    const fs = require('fs');
    const prompt = fs.readFileSync(process.argv[1], 'utf8');
    const label = prompt.split('\\n')[0].replace(/[^A-Za-z-]/g, '').slice(0, 40) || 'blank';
    fs.writeFileSync(require('path').join(process.argv[2], label + '.env.json'), JSON.stringify(process.env));
    const nonce = /VERDICT_NONCE: ([0-9a-f]+)/.exec(prompt)?.[1];
    console.log(JSON.stringify({ nonce, action: 'retry', notes: 'sealed' }));
  `)} ${shq(promptFile)} ${shq(dir)}`;
  const envOf = (label: string) => JSON.parse(readFileSync(join(dir, `${label}.env.json`), "utf8")) as Record<string, string | undefined>;
  const expectSealed = (env: Record<string, string | undefined>, label: string, seat: string | undefined) => {
    for (const k of HERDR_CONTROL_VARS) expect(env[k], `${label} ${k}`).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY, `${label} auth`).toBe("user-auth-value");
    expect(env[SEAT_MARKER_ENV], `${label} seat marker`).toBe(seat);
  };

  // Judge and review read a seat role from the prompt; the role-less callers (a scope draft, a free-form prompt, or a
  // prompt that only MENTIONS a seat prefix) have none — and are sealed all the same, with no fabricated marker.
  for (const [prefix, seat] of [
    ["TICKMARKR-JUDGE", "judge"], ["TICKMARKR-REVIEW", "review"], ["TICKMARKR-SCOPE", undefined],
    ["Draft a spec for this intent", undefined], ["ordinary draft mentioning TICKMARKR-JUDGE", undefined],
  ] as const) {
    await runLlm(fake, "fake-1", `${prefix}\n## Task T1: seal\nVERDICT_NONCE: abc12345`, dir, undefined, 10_000);
    expectSealed(envOf(prefix.replace(/[^A-Za-z-]/g, "").slice(0, 40)), prefix, seat);
  }
  // Consult's existing seat-tagged headless launch remains sealed.
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.visibility.llm = "headless";
  cfg.consult = { adapter: "fake", model: "fake-1", stallMinutes: 1 };
  const dossier: Dossier = { taskId: "T1", trigger: "gate-fail", journalTail: "", transcript: "", diff: "", gates: [] };
  await consult(dossier, cfg, [fake], new SubprocessDriver(), dir, dir);
  const consulted = readdirSync(dir).filter((f) => f.endsWith(".env.json")).map((f) => envOf(f.replace(/\.env\.json$/, "")))
    .filter((env) => env[SEAT_MARKER_ENV] === "consult");
  expect(consulted).toHaveLength(1);
  expectSealed(consulted[0]!, "consult", "consult");

  // A non-agent shell (an ordinary gate payload, the driver's hc client) keeps its core addressing and controls, so a
  // non-default session is never redirected to the default core.
  const plain = (await sh(`${shq(process.execPath)} -e ${shq("process.stdout.write(JSON.stringify(process.env))")}`, dir, 30_000)).stdout;
  const env = JSON.parse(plain) as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(inherited)) expect(env[k], `plain ${k}`).toBe(v);
  // The daemon's own environment is never mutated by any seal.
  for (const [k, v] of Object.entries(inherited)) expect(process.env[k], k).toBe(v);
}, 120_000);
