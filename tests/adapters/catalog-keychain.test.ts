// Queue row 367 Phase 2; D-2187 add.17 (2), add.18, add.20: the Artificial Analysis key lookup —
// environment first, then the darwin Keychain through `security find-generic-password` with only the
// service and account names in argv. Every test injects the reader AND the spawner; nothing real spawns.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";

const spawnSyncSpy = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawnSync: (...args: Parameters<typeof real.spawnSync>) => {
      spawnSyncSpy.calls.push(args);
      return real.spawnSync(...args);
    },
  };
});

import {
  ARTIFICIAL_ANALYSIS_CATALOG_URL,
  ARTIFICIAL_ANALYSIS_KEY_NAME,
  catalogCachePath,
  formatCatalogRefreshLegs,
  LIVEBENCH_CATEGORIES_URL,
  LIVEBENCH_TABLE_URL,
  lookupArtificialAnalysisKey,
  MODELS_DEV_CATALOG_URL,
  readKeychainKey,
  refreshCatalogCommand,
  type KeychainSpawnResult,
} from "../../src/adapters/catalog-remote.js";
import { makeRepo } from "../helpers/tmprepo.js";

afterEach(() => {
  vi.unstubAllEnvs();
  spawnSyncSpy.calls.length = 0;
});

const ACCOUNT = "row367-tester";
const MISSING_LINE = `no Artificial Analysis key: ARTIFICIAL_ANALYSIS_API_KEY unset and no Keychain item ARTIFICIAL_ANALYSIS_API_KEY for ${ACCOUNT} — set it with: security add-generic-password -a "$USER" -s ARTIFICIAL_ANALYSIS_API_KEY -w`;

const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

const MODELS_DEV = { anthropic: { id: "anthropic", models: { "fake-2": { id: "fake-2", cost: { input: 0, output: 0 }, limit: { context: 200_000, output: 32_000 } } } } };

const fetcherWith = (aa: () => ReturnType<typeof response> = () => response({ pagination: { has_more: false }, data: [] })) =>
  vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(MODELS_DEV_CATALOG_URL)) return response(MODELS_DEV);
    if (url.startsWith(LIVEBENCH_TABLE_URL)) return response("model,javascript\nfake-2,60\n");
    if (url.startsWith(LIVEBENCH_CATEGORIES_URL)) return response({ "Agentic Coding": ["javascript"], Coding: ["javascript"] });
    return aa();
  });

const aaKeyHeaders = (fetcher: ReturnType<typeof fetcherWith>): (string | null)[] =>
  fetcher.mock.calls
    .filter(([url]) => String(url).startsWith(ARTIFICIAL_ANALYSIS_CATALOG_URL))
    .map(([, init]) => new Headers(init?.headers).get("x-api-key"));

/** A fake `security` the production reader runs through; records every argv as `ps` would show it. */
const fakeSecurity = (result: KeychainSpawnResult | (() => KeychainSpawnResult)) => {
  const argv: string[][] = [];
  const spawner = vi.fn((command: "security", args: readonly string[]) => {
    argv.push([command, ...args]);
    return typeof result === "function" ? result() : result;
  });
  const reader = vi.fn((account: string) => readKeychainKey(account, spawner));
  return { argv, spawner, reader };
};

const darwin = (reader: (account: string) => ReturnType<typeof readKeychainKey>) =>
  ({ platform: "darwin" as const, account: ACCOUNT, keychainReader: reader });

const securitySpawns = () => spawnSyncSpy.calls.filter(([command]) => command === "security");

describe("row 367 Phase 2: the Artificial Analysis key lookup", () => {
  test("an environment key is used and no keychain read is spawned", async () => {
    vi.stubEnv(ARTIFICIAL_ANALYSIS_KEY_NAME, "env-row367-key");
    const keychain = fakeSecurity({ status: 0, stdout: "keychain-row367-key\n" });

    expect(lookupArtificialAnalysisKey(darwin(keychain.reader))).toEqual({ ok: true, key: "env-row367-key", source: "environment" });

    const fetcher = fetcherWith();
    const result = await refreshCatalogCommand({ repoRoot: makeRepo({ "keep.txt": "x" }), fetcher, keyLookup: darwin(keychain.reader) });
    expect(result.legs).toContainEqual(expect.objectContaining({ leg: "Artificial Analysis", status: "updated" }));
    expect(aaKeyHeaders(fetcher)).toEqual(["env-row367-key"]);
    expect(keychain.reader).not.toHaveBeenCalled();
    expect(keychain.spawner).not.toHaveBeenCalled();
    expect(securitySpawns()).toEqual([]);
  });

  test("with the environment unset a keychain hit is used and its argv carries only the service and account names", async () => {
    vi.stubEnv(ARTIFICIAL_ANALYSIS_KEY_NAME, undefined);
    const keychain = fakeSecurity({ status: 0, stdout: "keychain-row367-key\n" });

    expect(lookupArtificialAnalysisKey(darwin(keychain.reader))).toEqual({ ok: true, key: "keychain-row367-key", source: "keychain" });

    const fetcher = fetcherWith();
    const result = await refreshCatalogCommand({ repoRoot: makeRepo({ "keep.txt": "x" }), fetcher, keyLookup: darwin(keychain.reader) });
    expect(result.legs).toContainEqual(expect.objectContaining({ leg: "Artificial Analysis", status: "updated" }));
    expect(aaKeyHeaders(fetcher)).toEqual(["keychain-row367-key"]);
    const namesOnly = ["security", "find-generic-password", "-s", "ARTIFICIAL_ANALYSIS_API_KEY", "-a", ACCOUNT, "-w"];
    expect(keychain.argv).toEqual([namesOnly, namesOnly]);
    expect(securitySpawns()).toEqual([]);
  });

  test("with no key in the environment or the keychain the artificial analysis leg prints the missing key line and is skipped", async () => {
    vi.stubEnv(ARTIFICIAL_ANALYSIS_KEY_NAME, "  ");
    // Closed cells: the darwin Keychain miss (exit 44), an empty stdout, off darwin (never read), and the
    // test runner's default (no reader injected: nothing spawned).
    const miss = fakeSecurity({ status: 44, stdout: "" });
    const empty = fakeSecurity({ status: 0, stdout: "\n" });
    const offDarwin = fakeSecurity({ status: 0, stdout: "never-read\n" });
    const cells = [
      darwin(miss.reader),
      darwin(empty.reader),
      { platform: "linux" as const, account: ACCOUNT, keychainReader: offDarwin.reader },
      { platform: "darwin" as const, account: ACCOUNT },
    ];
    for (const keyLookup of cells) {
      expect(lookupArtificialAnalysisKey(keyLookup)).toEqual({ ok: false, error: MISSING_LINE });
      const fetcher = fetcherWith();
      const result = await refreshCatalogCommand({ repoRoot: makeRepo({ "keep.txt": "x" }), fetcher, keyLookup });
      expect(result.legs).toContainEqual({
        leg: "Artificial Analysis", status: "skipped", detail: MISSING_LINE, retry: "retry when ARTIFICIAL_ANALYSIS_API_KEY is set",
      });
      expect(formatCatalogRefreshLegs(result.legs)).toContain(`Artificial Analysis skipped (${MISSING_LINE};`);
      expect(aaKeyHeaders(fetcher)).toEqual([]);
    }
    expect(miss.reader).toHaveBeenCalledTimes(2);
    expect(empty.reader).toHaveBeenCalledTimes(2);
    expect(offDarwin.reader).not.toHaveBeenCalled();
    expect(securitySpawns()).toEqual([]);
  });

  test("a failed keychain read prints the read failed line with its exit code and never throws", async () => {
    vi.stubEnv(ARTIFICIAL_ANALYSIS_KEY_NAME, undefined);
    const enoent = Object.assign(new Error("spawnSync security ENOENT"), { code: "ENOENT" });
    const cells: [KeychainSpawnResult | (() => KeychainSpawnResult), string][] = [
      [{ status: 51, stdout: "" }, "51"],
      [{ status: null, stdout: "", signal: "SIGTERM", error: { code: "ETIMEDOUT" } }, "ETIMEDOUT"],
      [{ status: null, stdout: "", signal: "SIGKILL" }, "SIGKILL"],
      [() => { throw enoent; }, "ENOENT"],
    ];
    for (const [spawned, exit] of cells) {
      const keychain = fakeSecurity(spawned);
      const line = `no Artificial Analysis key: Keychain read failed (exit ${exit})`;
      expect(() => lookupArtificialAnalysisKey(darwin(keychain.reader))).not.toThrow();
      expect(lookupArtificialAnalysisKey(darwin(keychain.reader))).toEqual({ ok: false, error: line });
      const fetcher = fetcherWith();
      const result = await refreshCatalogCommand({ repoRoot: makeRepo({ "keep.txt": "x" }), fetcher, keyLookup: darwin(keychain.reader) });
      expect(result.legs).toContainEqual(expect.objectContaining({ leg: "Artificial Analysis", status: "skipped", detail: line }));
      expect(aaKeyHeaders(fetcher)).toEqual([]);
    }
    expect(securitySpawns()).toEqual([]);
  });

  test("the key bytes appear in no spawned argv and in no output cache or error text of the lookup", async () => {
    vi.stubEnv(ARTIFICIAL_ANALYSIS_KEY_NAME, undefined);
    const key = "kc-SENTINEL-row367-bytes";
    const hit = fakeSecurity({ status: 0, stdout: `${key}\n` });
    const repo = makeRepo({ "keep.txt": "x" });

    const fetched = fetcherWith();
    const ok = await refreshCatalogCommand({ repoRoot: repo, fetcher: fetched, keyLookup: darwin(hit.reader) });
    expect(aaKeyHeaders(fetched)).toEqual([key]); // used in-process, as a request header only
    expect(ok.legs).toContainEqual(expect.objectContaining({ leg: "Artificial Analysis", status: "updated" }));

    const refused = await refreshCatalogCommand({
      repoRoot: repo,
      fetcher: fetcherWith(() => response({ error: "Forbidden", message: `bad key ${key}` }, 403)),
      keyLookup: darwin(hit.reader),
    });
    expect(refused.legs).toContainEqual(expect.objectContaining({ leg: "Artificial Analysis", status: "failed" }));

    // A failed read whose stdout still carries the bytes must not leak them into the typed line.
    const failed = fakeSecurity({ status: 1, stdout: `${key}\n` });
    const failedLookup = lookupArtificialAnalysisKey(darwin(failed.reader));
    const failedRefresh = await refreshCatalogCommand({ repoRoot: repo, fetcher: fetcherWith(), keyLookup: darwin(failed.reader) });

    const argv = [...hit.argv, ...failed.argv].map((args) => args.join(" "));
    expect(argv.length).toBeGreaterThan(0);
    for (const line of argv) expect(line).not.toContain(key);
    for (const run of [ok, refused, failedRefresh]) {
      expect(JSON.stringify({ legs: run.legs, warning: run.warning, catalog: run.catalog })).not.toContain(key);
      expect(formatCatalogRefreshLegs(run.legs)).not.toContain(key);
    }
    expect(JSON.stringify(failedLookup)).not.toContain(key);
    expect(readFileSync(catalogCachePath(repo), "utf8")).not.toContain(key);
    expect(securitySpawns()).toEqual([]);
  });
});
