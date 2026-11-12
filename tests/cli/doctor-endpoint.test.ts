// Row 417; D-2187 add.77: doctor's endpoint lines, through the production doctor command. Listeners are opened and
// closed by this file on 127.0.0.1; the codex config lives under a temporary CODEX_HOME.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { WorkerAdapter } from "../../src/adapters/types.js";
import { statusRow } from "../../src/brand.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { makeRepo } from "../helpers/tmprepo.js";

const dirs: string[] = [];
const servers: Server[] = [];
const stub = { id: "fixture", vendor: "x", probe: async () => ({ installed: true, authed: true, models: [] }) } as unknown as WorkerAdapter;
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "doctor-endpoint-"));
  dirs.push(d);
  return d;
};
const listen = async (): Promise<number> => {
  const server = createServer((s) => s.destroy());
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
};
const closed = async (): Promise<number> => {
  const port = await listen();
  await new Promise<void>((r) => servers.pop()!.close(() => r()));
  return port;
};
const codexHome = (baseUrl: string) => {
  const home = tmp();
  writeFileSync(join(home, "config.toml"), `model_provider = "cpa-gui"\n\n[model_providers.cpa-gui]\nbase_url = ${JSON.stringify(baseUrl)}\n`);
  vi.stubEnv("CODEX_HOME", home);
};
const noSettings = () => join(tmp(), "settings.json");
const endpointLines = (out: string) => out.split("\n").filter((l) => /endpoint (codex|claude-code):/.test(l));

beforeEach(() => {
  vi.stubEnv("XDG_CONFIG_HOME", tmp());
  for (const name of ["error", "warn", "log"] as const) vi.spyOn(console, name).mockImplementation(() => undefined);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("doctor prints a red endpoint line for a base url with nothing listening and a pass line for a listening one", async () => {
  const repo = makeRepo({ "keep.txt": "x" });
  const run = (gateway = { env: {}, settingsPath: noSettings() }) => doctor(["--"], repo, [stub], { banner: false, gateway, endpoint: gateway });

  // codex provider with nothing listening: one red line
  const dead = await closed();
  codexHome(`http://127.0.0.1:${dead}/v1`);
  const red = endpointLines(await run());
  expect(red).toHaveLength(1);
  expect(red[0]).toContain(`endpoint codex: http://127.0.0.1:${dead} down (ECONNREFUSED) — every codex seat will fail as transport until it answers`);
  expect(red[0]).toBe(`  ${statusRow("fail", `endpoint codex: http://127.0.0.1:${dead} down (ECONNREFUSED) — every codex seat will fail as transport until it answers`)}`);

  // control: the same with a listener this test opened — one pass line
  const live = await listen();
  codexHome(`http://127.0.0.1:${live}/v1`);
  const pass = endpointLines(await run());
  expect(pass).toHaveLength(1);
  expect(pass[0]).toContain(`endpoint codex: http://127.0.0.1:${live} listening`);
  expect(pass[0]).toBe(`  ${statusRow("pass", `endpoint codex: http://127.0.0.1:${live} listening`)}`);

  // a built-in provider with no table, and no config: no endpoint line (no default host is probed)
  const builtIn = tmp();
  writeFileSync(join(builtIn, "config.toml"), 'model_provider = "openai"\n');
  vi.stubEnv("CODEX_HOME", builtIn);
  expect(endpointLines(await run())).toEqual([]);
  vi.stubEnv("CODEX_HOME", tmp());
  expect(endpointLines(await run())).toEqual([]);

  // the Claude base URL with nothing listening: a red line beside the gateway line, which is unchanged
  const claudeDead = await closed();
  const out = await run({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${claudeDead}` }, settingsPath: noSettings() });
  expect(endpointLines(out)).toEqual([expect.stringContaining(`endpoint claude-code: http://127.0.0.1:${claudeDead} down (ECONNREFUSED)`)]);
  expect(out).toMatch(/gateway: /);

  // an unparseable base_url: a red line with reason unparseable, never a throw
  codexHome("not a url");
  expect(endpointLines(await run())).toEqual([expect.stringContaining("endpoint codex: <unparseable base_url> down (unparseable)")]);
}, 60_000);
