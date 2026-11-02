import { existsSync, mkdirSync, realpathSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import * as registry from "../../src/adapters/registry.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import type { AuthHealth } from "../../src/adapters/types.js";
import { statusRow, type Verdict } from "../../src/brand.js";
import { init } from "../../src/cli/commands/init.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const MORE = "more: tickmarkr doctor prints the full capability matrix, model notes and host checks";
const NEXT = 'next: tickmarkr start "<what you want built>" — or edit tickmarkr.spec.md, then tickmarkr compile tickmarkr.spec.md && tickmarkr plan && tickmarkr run';
const HINT = "guided setup skipped (no interactive terminal): run `! tkr init` yourself, or in a visible pane";
const USING = "using probe results from 5m ago — run tickmarkr doctor to refresh (or init --fresh)";
const FAKE_READY = "ready: fake (1 of 1 installed agent CLIs)";
const TRUST_FAILED = "action: fake trust — check failed: trust store unreadable; run tickmarkr doctor";
// Rows only the doctor report (fresh) or its cached formatter (reuse) ever printed.
const DOCTOR_REPORT = /capability matrix:|attention \(|model drift|workspace trust:|trust: n\/a|[✓✗] (?:fake|kimi|herdr)\b/;

const healthy = (): AuthHealth => ({
  installed: true, authed: true, version: "fake", models: ["fake-1", "fake-unclassified"],
  modelAuth: { "fake-1": { authed: true, probedAt: new Date().toISOString() } },
});
const kimiUnauthed = (): AuthHealth => ({ installed: true, authed: false, version: "1.5", models: [] });

function fixture(ids: string[], files: Record<string, string> = {}) {
  const repo = makeRepo({ "keep.txt": "x", ...files });
  writeFileSync(join(tickmarkrDir(repo), "config.yaml"), "judge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1 }\n");
  const script = join(makeTestTempDir("init-ready-script-"), "fake.json");
  writeFileSync(script, JSON.stringify({ tasks: {} }));
  const adapters = ids.map((id) => Object.assign(new FakeAdapter(script), { id }));
  vi.spyOn(registry, "allAdapters").mockReturnValue(adapters);
  return { repo, adapters };
}

/** Fresh path: doctor probes and records this health. Reuse path: it is already recorded, 5 minutes old. */
function recordHealth(repo: string, health: Record<string, AuthHealth>, path: "fresh" | "reuse") {
  const probeAll = vi.spyOn(registry, "probeAll").mockImplementation(async () => structuredClone(health));
  if (path === "reuse") {
    registry.writeDoctor(repo, health);
    const when = new Date(Date.now() - 5 * 60_000);
    utimesSync(join(tickmarkrDir(repo), "doctor.json"), when, when);
  }
  return probeAll;
}

const throwingTrust = () => { throw new Error("trust store unreadable"); };
const runInit = (repo: string, ...args: string[]) => init(["--global-dir", makeTestTempDir("init-ready-global-"), ...args], repo);

async function withStreams<T>(stdin: boolean, stdout: boolean, noColor: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = [process.stdin, process.stdout].map((s) => Object.getOwnPropertyDescriptor(s, "isTTY"));
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdin });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdout });
  if (noColor === undefined) vi.stubEnv("NO_COLOR", undefined);
  else vi.stubEnv("NO_COLOR", noColor);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    return await fn();
  } finally {
    [process.stdin, process.stdout].forEach((s, i) => {
      if (saved[i]) Object.defineProperty(s, "isTTY", saved[i]!);
      else delete (s as { isTTY?: boolean }).isTTY;
    });
  }
}
const withoutTTY = <T>(fn: () => Promise<T>) => withStreams(false, false, undefined, fn);

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** A TTY input that feeds Ink one key per tick, and a TTY output that records frames (from init.test.ts). */
function makeIO() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} }) as PassThrough & { isTTY: boolean; setRawMode: () => void; ref: () => unknown; unref: () => unknown };
  input.ref = () => input;
  input.unref = () => input;
  const direct = input.write.bind(input);
  input.write = ((chunk: string) => {
    for (const key of chunk.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? []) setImmediate(() => direct(key));
    return true;
  }) as typeof input.write;
  const writes: string[] = [];
  const waiters: { marker: string; resolve: () => void }[] = [];
  const output = {
    isTTY: true, columns: 120, rows: 60, on: () => {}, off: () => {}, removeListener: () => {},
    write: (chunk: string) => {
      writes.push(chunk);
      for (let i = waiters.length - 1; i >= 0; i--) if (strip(chunk).includes(waiters[i]!.marker)) waiters.splice(i, 1)[0]!.resolve();
      return true;
    },
  };
  const whenFrame = (marker: string) => writes.some((w) => strip(w).includes(marker))
    ? Promise.resolve()
    : new Promise<void>((resolve) => { waiters.push({ marker, resolve }); });
  return { input, output, writes, whenFrame };
}

beforeEach(() => {
  vi.spyOn(registry, "probeModels").mockResolvedValue();
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
  vi.spyOn(registry, "resolveShellBinary").mockReturnValue({ all: [] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  // A HOME with no protected folder around the fixture keeps the folders check out unless a test asks for it.
  vi.stubEnv("HOME", makeTestTempDir("init-ready-home-"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("init's non-interactive readiness card", () => {
  test("non-TTY init on the fresh-probe path, with and without --yes and with --agent or --fresh, prints the readiness card, then the next line and the environments footer, and no capability matrix header, attention section or model-classification overlay, so an init that still appends the doctor report fails", async () => {
    for (const args of [[], ["--yes"], ["--agent"], ["--fresh"]]) {
      const { repo } = fixture(["fake"]);
      const probeAll = recordHealth(repo, { fake: healthy() }, args.includes("--fresh") ? "reuse" : "fresh");
      const out = await withoutTTY(() => runInit(repo, ...args));
      const lines = out.split("\n");
      const at = lines.indexOf(FAKE_READY);
      const context = JSON.stringify(args);

      expect.soft(probeAll, context).toHaveBeenCalled();
      expect.soft(at, context).toBeGreaterThan(0);
      expect.soft(lines.slice(at, at + 3), context).toEqual([FAKE_READY, MORE, NEXT]);
      expect.soft(lines.slice(at + 3, -5), context).toEqual(args.includes("--yes") ? [] : [HINT]);
      expect.soft(lines.at(-5), context).toBe("environments:");
      expect.soft(out, context).not.toContain("using probe results");
      expect.soft(out, context).not.toMatch(DOCTOR_REPORT);
      expect.soft(out, context).not.toContain("paste-ready overlay");
    }
  });

  test("non-TTY init on the reuse path prints the single using-probe-results line, then the card from the recorded doctor.json and the next line, and none of the cached report's rows", async () => {
    const { repo } = fixture(["fake"]);
    const probeAll = recordHealth(repo, { fake: healthy() }, "reuse");

    const out = await withoutTTY(() => runInit(repo, "--yes"));

    expect(probeAll).not.toHaveBeenCalled();
    expect(out.split("\n").filter((line) => line.includes("using probe results"))).toEqual([USING]);
    expect(out).toContain([USING, FAKE_READY, MORE, NEXT].join("\n"));
    expect(out).not.toMatch(DOCTOR_REPORT);
    expect(out).not.toContain("paste-ready overlay");
  });

  test("a recorded doctor.json with an installed kimi that failed auth makes init's card list kimi as not ready on both the fresh and the reuse paths, where the cached report used to mark it passing", async () => {
    for (const path of ["fresh", "reuse"] as const) {
      const { repo } = fixture(["fake", "kimi"]);
      recordHealth(repo, { fake: healthy(), kimi: kimiUnauthed() }, path);

      const out = await withoutTTY(() => runInit(repo, "--yes"));

      expect.soft(registry.readDoctor(repo)?.kimi, path).toMatchObject({ installed: true, authed: false });
      expect.soft(out, path).toContain(["ready: fake (1 of 2 installed agent CLIs)", "not ready: kimi — 1.5", MORE, NEXT].join("\n"));
      expect.soft(out, path).not.toMatch(/✓ kimi/);
    }
  });

  test("an installed adapter with no authenticated routable model, a failing package manager, a protected folder and a trust hook that throws each surface as an action row in init's card, with the next line and footer still printed", async () => {
    const { repo: made, adapters } = fixture(["fake"], { "package.json": JSON.stringify({ name: "consumer", packageManager: "pnpm@9.0.0" }) });
    Object.assign(adapters[0]!, { trust: throwingTrust });
    // The repository lives in HOME/Desktop on a darwin host.
    const home = makeTestTempDir("init-ready-desktop-home-");
    mkdirSync(join(home, "Desktop"));
    const repo = join(home, "Desktop", "repo");
    renameSync(made, repo);
    vi.stubEnv("HOME", home);
    recordHealth(repo, { fake: { installed: true, authed: true, version: "fake", models: [] } }, "reuse");
    // Only git resolves, so the repo's pnpm cannot.
    const bin = makeTestTempDir("init-ready-bin-");
    const git = (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "git")).find((p) => existsSync(p));
    symlinkSync(git!, join(bin, "git"));
    vi.stubEnv("PATH", bin);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });

    let out: string;
    try {
      out = await withoutTTY(() => runInit(repo, "--yes"));
    } finally {
      Object.defineProperty(process, "platform", platform);
    }

    const desktop = join(realpathSync(home), "Desktop");
    const lines = out!.split("\n");
    const at = lines.indexOf(USING);
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at)).toEqual([
      USING,
      FAKE_READY,
      TRUST_FAILED,
      "action: workers — no authenticated routable worker model is available; run tickmarkr doctor, then tickmarkr fleet",
      "action: judge-model — fake:fake-1 has no passing recorded model probe — run tickmarkr doctor or remap judge",
      "action: consult-model — fake:fake-1 has no passing recorded model probe — run tickmarkr doctor or remap consult",
      `action: folders — macOS protected home folder ${desktop} contains the repository or its state directory; move the repository outside Desktop, Documents and Downloads, or grant the app running tickmarkr Full Disk Access`,
      "action: package-manager — repo uses pnpm but the binary does not resolve in this environment — every auto-detected gate command will die before running any suite (fix: corepack enable, or install pnpm on the daemon's PATH)",
      MORE,
      NEXT,
      "environments:",
      expect.stringMatching(/^ {2}herdr — /),
      expect.stringMatching(/^ {2}orca — /),
      expect.stringMatching(/^ {2}claude code — /),
      expect.stringMatching(/^ {2}anywhere — /),
    ]);
  });

  test("init with --yes on a terminal, and a terminal output with piped input, render every card row as a status row in the same order with no doctor report, NO_COLOR gives the plain rows, and the interactive wizard still shows its compact discovery", async () => {
    const plain = ["ready: fake (1 of 2 installed agent CLIs)", "not ready: kimi — 1.5", TRUST_FAILED, MORE];
    const verdicts: Verdict[] = ["pass", "fail", "warn", "neutral"];
    const cases = [
      { name: "--yes on a terminal", stdin: true, path: "fresh", args: ["--yes"] },
      { name: "terminal output, piped input", stdin: false, path: "reuse", args: [] },
      { name: "NO_COLOR", stdin: true, path: "reuse", args: ["--yes"], noColor: "1" },
    ] as const;
    for (const c of cases) {
      const { repo, adapters } = fixture(["fake", "kimi"]);
      Object.assign(adapters[0]!, { trust: throwingTrust });
      recordHealth(repo, { fake: healthy(), kimi: kimiUnauthed() }, c.path);
      const noColor = "noColor" in c ? c.noColor : undefined;

      const { out, rows } = await withStreams(c.stdin, true, noColor, async () => ({
        out: await runInit(repo, ...c.args),
        rows: plain.map((row, i) => `  ${statusRow(verdicts[i]!, row)}`),
      }));

      if (noColor) {
        expect.soft(out, c.name).toContain(plain.join("\n"));
        expect.soft(out, c.name).not.toMatch(/\x1b\[/);
      } else {
        expect.soft(rows.every((row) => row.includes("\x1b[")), c.name).toBe(true);
        expect.soft(out, c.name).toContain(rows.join("\n"));
      }
      expect.soft(out, c.name).not.toMatch(DOCTOR_REPORT);
    }

    // The interactive wizard path keeps its compact discovery between the acts and prints no card.
    const { repo } = fixture(["fake"]);
    recordHealth(repo, { fake: healthy() }, "reuse");
    const io = makeIO();
    const run = init(["--global-dir", makeTestTempDir("init-ready-global-")], repo, {
      input: io.input as unknown as NodeJS.ReadStream, output: io.output as unknown as NodeJS.WriteStream,
    });
    await io.whenFrame("All models");
    io.input.write("q");
    const out = await run;
    io.input.destroy();

    expect(io.writes.some((w) => strip(w).includes("using probe results from 5m ago — full matrix: tickmarkr doctor · refresh: init --fresh"))).toBe(true);
    expect(out).toContain("discovery shown above — full matrix any time with `tickmarkr doctor`");
    expect(out).not.toContain(FAKE_READY);
    expect(out).not.toContain(MORE);
  });
});
