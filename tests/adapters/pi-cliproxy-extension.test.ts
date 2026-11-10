// Queue row 392 R6 law 4 (D-2187 add.13, add.17 (5), add.21; cross-read M5, M8): the SHIPPED extension module,
// imported from the path the launch line names and invoked the way installed pi 1.5.0 loads it, through a
// registration-capturing API, with a synthetic environment and Claude settings file. No pi runs, no token is spent.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { apiRoot, detectGateway } from "../../src/adapters/cliproxy.js";
import { pi, piCliproxyExtensionPath } from "../../src/adapters/pi.js";

type Registration = { name: string; config: { name: string; baseUrl: string; apiKey: string; api: string; models: { type: string; id: string }[] } };

const scratch = () => mkdtempSync(join(tmpdir(), "tickmarkr-pi-ext-"));
const MISSING_SETTINGS = join(tmpdir(), "tickmarkr-pi-ext-no-such-dir", "settings.json");

function settingsFile(env: Record<string, string>): string {
  const path = join(scratch(), "settings.json");
  writeFileSync(path, JSON.stringify({ env }));
  return path;
}

// Installed pi 1.5.0, dist/core/extensions/loader.js: `jiti.import(path, { default: true })`, a module whose
// default is not a function is refused ("does not export a valid factory function"), then `await factory(api)`.
// Its registerProvider(name, config) throws when a name comes without a config.
async function loadLikePi(env: NodeJS.ProcessEnv, settingsPath = MISSING_SETTINGS): Promise<Registration[]> {
  const factory = (await import(pathToFileURL(piCliproxyExtensionPath).href)).default as unknown;
  if (typeof factory !== "function") throw new Error(`Extension does not export a valid factory function: ${piCliproxyExtensionPath}`);
  const registrations: Registration[] = [];
  const api = {
    registerProvider(providerOrName: unknown, config?: Registration["config"]) {
      if (typeof providerOrName === "string" && !config) throw new Error("Provider config is required when registering by name");
      registrations.push({ name: providerOrName as string, config: config! });
    },
  };
  await factory(api, { env, settingsPath });
  return registrations;
}

// Installed pi 1.5.0, dist/core/resolve-config-value.js: a leading "!" runs a command; in a template "$$" and "$!"
// are a literal "$" and "!", "${NAME}" and "$NAME" read env[NAME] || process.env[NAME], and a missing one is undefined.
function piResolve(config: string, env: NodeJS.ProcessEnv): { command: string } | { value: string | undefined } {
  if (config.startsWith("!")) return { command: config };
  const read = (name: string) => env[name] || process.env[name] || undefined;
  let out = "";
  let i = 0;
  while (i < config.length) {
    const d = config.indexOf("$", i);
    if (d < 0) {
      out += config.slice(i);
      break;
    }
    out += config.slice(i, d);
    const next = config[d + 1];
    if (next === "$" || next === "!") {
      out += next;
      i = d + 2;
      continue;
    }
    if (next === "{") {
      const end = config.indexOf("}", d + 2);
      if (end < 0) {
        out += "$";
        i = d + 1;
        continue;
      }
      const name = config.slice(d + 2, end);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        const v = read(name);
        if (v === undefined) return { value: undefined };
        out += v;
      } else out += config.slice(d, end + 1);
      i = end + 1;
      continue;
    }
    const m = config.slice(d + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (m) {
      const v = read(m[0]);
      if (v === undefined) return { value: undefined };
      out += v;
      i = d + 1 + m[0].length;
      continue;
    }
    out += "$";
    i = d + 1;
  }
  return { value: out };
}

const BASE = "http://127.0.0.1:8317";
const launchEnv = (model: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ TICKMARKR_CLIPROXY_BASE_URL: BASE, TICKMARKR_CLIPROXY_MODEL: model, ...extra });

afterEach(() => vi.restoreAllMocks());

test("the shipped extension factory registers the cliproxy provider with the openai completions api and the bare proxy id", async () => {
  for (const id of ["gemini-2.5-pro", "gpt-5.5", "codex-mini-latest", "grok-4"]) {
    const registrations = await loadLikePi(launchEnv(id, { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: "tok" }));
    expect(registrations).toHaveLength(1);
    const [{ name, config }] = registrations;
    expect(name).toBe("cliproxy");
    expect(config.api).toBe("openai-completions");
    expect(config.baseUrl).toBe(`${BASE}/v1`);
    // exactly one chat model whose id is the BARE proxy id: pi selects cliproxy/<id> and sends model.id on the wire
    expect(config.models).toHaveLength(1);
    expect(config.models[0]).toMatchObject({ type: "chat", id });
    expect(config.models[0].id).not.toContain("cliproxy/");
    expect(pi.headlessCommand("/tmp/p.md", `${name}/${config.models[0].id}`)).toContain(`--model 'cliproxy/${id}'`);
  }
  // no base URL (no confirmed gateway record) or no proxy id: the factory refuses to load and registers nothing
  for (const env of [launchEnv("gemini-2.5-pro", { TICKMARKR_CLIPROXY_BASE_URL: "" }), { TICKMARKR_CLIPROXY_BASE_URL: BASE }, launchEnv("bad id")]) {
    await expect(loadLikePi(env)).rejects.toThrow(/TICKMARKR_CLIPROXY_BASE_URL and TICKMARKR_CLIPROXY_MODEL/);
  }
});

test("an unsuffixed and a version suffixed base with or without a trailing slash register the same api root the gateway listing uses", async () => {
  const bases = ["http://h:8317", "http://h:8317/", "http://h:8317/v1", "http://h:8317/v1/"];
  for (const base of bases) {
    const [{ config }] = await loadLikePi(launchEnv("gemini-2.5-pro", { TICKMARKR_CLIPROXY_BASE_URL: base }));
    expect(config.baseUrl).toBe("http://h:8317/v1"); // never /v1/v1, never a trailing slash
    expect(config.baseUrl).toBe(apiRoot(base)); // the one shared helper
    // the gateway listing detection makes from the same base URL goes to <the same root>/models
    const target = detectGateway({}, { env: { ANTHROPIC_BASE_URL: base }, settingsPath: MISSING_SETTINGS });
    expect(target && "modelsUrl" in target ? target.modelsUrl : undefined).toBe(`${config.baseUrl}/models`);
  }
});

test("the factory takes the credential from the environment before the claude settings and passes it literally against dollar and bang config values", async () => {
  const resolved = async (env: NodeJS.ProcessEnv, settingsPath?: string) => {
    const [{ config }] = await loadLikePi(env, settingsPath);
    return piResolve(config.apiKey, env);
  };
  const settings = settingsFile({ ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: "settings-token", ANTHROPIC_API_KEY: "settings-key" });
  const id = "gemini-2.5-pro";
  // the environment names the base URL → its token, then its key; the settings never override it
  expect(await resolved(launchEnv(id, { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: "env-token", ANTHROPIC_API_KEY: "env-key" }), settings)).toEqual({ value: "env-token" });
  expect(await resolved(launchEnv(id, { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_API_KEY: "env-key" }), settings)).toEqual({ value: "env-key" });
  // no base URL in the environment → the Claude settings env, token before key
  expect(await resolved(launchEnv(id), settings)).toEqual({ value: "settings-token" });
  expect(await resolved(launchEnv(id), settingsFile({ ANTHROPIC_BASE_URL: BASE, ANTHROPIC_API_KEY: "settings-key" }))).toEqual({ value: "settings-key" });
  // an api.anthropic.com endpoint is not a gateway: its key never travels to the proxy
  const direct = await resolved(launchEnv(id, { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "anthropic-key" }), settings);
  expect(direct).not.toEqual({ value: "anthropic-key" });
  expect("value" in direct && typeof direct.value === "string" && direct.value !== "").toBe(true);

  // pi's config-value syntax: each credential below would be executed or expanded if passed raw
  const env = { HOME: "/home/expanded", NAME: "expanded-name", ANTHROPIC_BASE_URL: BASE };
  const reinterpreted = ["!touch /tmp/pwned", "$HOME", "${NAME}", "sk-$NAME-x", "a$$b", "$!lead", "!", "!$HOME$$"];
  const survivesRaw = ["$", "trail$", "sk-plain-0123"]; // controls: pi would leave these alone even raw
  for (const credential of [...reinterpreted, ...survivesRaw]) {
    const viaEnv = await resolved(launchEnv(id, { ...env, ANTHROPIC_AUTH_TOKEN: credential }), settings);
    expect(viaEnv).toEqual({ value: credential });
    const viaSettings = await resolved(launchEnv(id, { HOME: env.HOME, NAME: env.NAME }), settingsFile({ ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: credential }));
    expect(viaSettings).toEqual({ value: credential });
    // bait: the same credential passed raw is executed or expanded by pi
    if (reinterpreted.includes(credential)) expect(piResolve(credential, env)).not.toEqual({ value: credential });
  }
});

test("the credential appears in no argv and in no captured stream of the factory or launch", async () => {
  const CREDENTIAL = "sk-cliproxy-SECRET-$HOME-!x-9b2d";
  const writes: string[] = [];
  const capture = (...args: unknown[]) => {
    writes.push(args.map(String).join(" "));
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(capture as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(capture as typeof process.stderr.write);
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) vi.spyOn(console, method).mockImplementation(capture);
  const argvBefore = [...process.argv];

  // the factory, with the credential in the environment and in the Claude settings
  await loadLikePi(launchEnv("gemini-2.5-pro", { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: CREDENTIAL }));
  await loadLikePi(launchEnv("gpt-5.5"), settingsFile({ ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: CREDENTIAL }));
  const refused = await loadLikePi(launchEnv("gemini-2.5-pro", { TICKMARKR_CLIPROXY_BASE_URL: "", ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: CREDENTIAL })).catch((e: Error) => e);
  expect(refused).toBeInstanceOf(Error);
  expect(String((refused as Error).message)).not.toContain(CREDENTIAL);
  expect(process.argv).toEqual(argvBefore);
  vi.restoreAllMocks();
  expect(writes.filter((w) => w.includes(CREDENTIAL))).toEqual([]);

  // the launch: built against a doctor cache, then run through a real shell with a stand-in pi that records its argv
  const repo = scratch();
  mkdirSync(join(repo, ".tickmarkr"));
  writeFileSync(join(repo, ".tickmarkr", "doctor.json"), JSON.stringify({ gateway: { host: "127.0.0.1", baseUrl: BASE, source: "env", listing: { status: "succeeded", checkedAt: "2026-11-08T00:00:00.000Z" }, models: [{ id: "gemini-2.5-pro", vendor: "google" }] } }));
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  const headless = pi.headlessCommand(join(repo, "prompt.md"), "cliproxy/gemini-2.5-pro");
  const interactive = pi.interactiveCommand(join(repo, "prompt.md"), "cliproxy/gemini-2.5-pro", undefined, { cwd: repo, branch: "b", repoRoot: repo })!;
  vi.restoreAllMocks();
  for (const line of [headless, interactive]) expect(line).not.toContain(CREDENTIAL);

  const bin = scratch();
  writeFileSync(join(bin, "pi"), [
    "#!/bin/sh",
    `for a in "$@"; do printf '%s\\n' "$a"; done > "$ARGV_OUT"`,
    `printf '%s\\n' "$TICKMARKR_CLIPROXY_BASE_URL" "$TICKMARKR_CLIPROXY_MODEL" > "$ENV_OUT"`,
    "echo stub-pi-stdout; echo stub-pi-stderr >&2",
  ].join("\n"));
  chmodSync(join(bin, "pi"), 0o755);
  writeFileSync(join(repo, "prompt.md"), "do the task");
  for (const line of [headless, interactive]) {
    const out = { argv: join(scratch(), "argv"), env: join(scratch(), "env") };
    const r = spawnSync("/bin/sh", ["-c", line], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, ARGV_OUT: out.argv, ENV_OUT: out.env, ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: CREDENTIAL },
    });
    expect(r.status).toBe(0);
    const argv = readFileSync(out.argv, "utf8").trimEnd().split("\n");
    expect(argv).toEqual([...(line === headless ? ["-p"] : []), "--approve", "-e", piCliproxyExtensionPath, "--model", "cliproxy/gemini-2.5-pro", "do the task"]);
    expect(readFileSync(out.env, "utf8")).toBe(`${BASE}\ngemini-2.5-pro\n`);
    for (const text of [...argv, r.stdout, r.stderr]) expect(text).not.toContain(CREDENTIAL);
  }
});
