import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";

const { mockCreateInterface } = vi.hoisted(() => {
  const mockQuestion = vi.fn();
  const mockCreateInterface = vi.fn(() => ({ question: mockQuestion, close: vi.fn() }));
  return { mockCreateInterface };
});

vi.mock("node:readline/promises", () => ({ createInterface: mockCreateInterface }));

import * as registry from "../../src/adapters/registry.js";
import { BANNER, legend, rule, statusRow, title } from "../../src/brand.js";
import { init } from "../../src/cli/commands/init.js";
import { configTemplate, loadConfig, renderFleetOverlayWrite, type FleetEditable } from "../../src/config/config.js";
import { tickmarkrDir, stateDirName } from "../../src/graph/graph.js";
import { Journal } from "../../src/run/journal.js";
import { acquireRunLock, releaseRunLock } from "../../src/run/lock.js";
import { makeRepo } from "../helpers/tmprepo.js";

const ROOT = join(import.meta.dirname, "../..");
const skill = (name: string) => readFileSync(join(ROOT, "skills", name, "SKILL.md"));
const runInit = (repo: string, ...args: string[]) =>
  init(["--global-dir", mkdtempSync(join(tmpdir(), "tickmarkr-init-global-")), ...args], repo);

const KEY = { down: "\x1b[B", left: "\x1b[D", enter: "\r", space: " ", esc: "\x1b" };
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

type TestInput = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => TestInput;
  unref: () => TestInput;
};

// Adapted from tests/cli/fleet.test.ts makeIO: a plain PassThrough decoded by node's own
// emitKeypressEvents (the production path), split one key sequence per event because Ink
// treats a multi-character write as a paste. Output collects frames for assertions.
const makeIO = () => {
  const input = new PassThrough() as TestInput;
  input.isTTY = true;
  input.setRawMode = () => {};
  input.ref = () => input;
  input.unref = () => input;
  const directWrite = input.write.bind(input);
  const pendingWrites: string[] = [];
  let pumping = false;
  const pump = () => {
    const chunk = pendingWrites.shift();
    if (chunk === undefined) {
      pumping = false;
      return;
    }
    directWrite(chunk);
    setImmediate(pump);
  };
  input.write = ((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    pendingWrites.push(...(text.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? []));
    if (!pumping) {
      pumping = true;
      setImmediate(pump);
    }
    return true;
  }) as typeof input.write;
  const writes: string[] = [];
  const frameWaiters: Array<{ marker: string; resolve: () => void }> = [];
  const output = {
    isTTY: true,
    columns: 120,
    rows: 60,
    write: (chunk: string) => {
      if (chunk === "" || chunk === "\x1b[?25l" || chunk === "\x1b[?25h") return true;
      if (writes.at(-1) === chunk) return true;
      writes.push(chunk);
      for (let i = frameWaiters.length - 1; i >= 0; i--) {
        if (strip(chunk).includes(frameWaiters[i]!.marker)) frameWaiters.splice(i, 1)[0]!.resolve();
      }
      return true;
    },
    on: () => {},
    off: () => {},
    removeListener: () => {},
  };
  // Event-driven, no wall clock: resolves on the write that renders the marker; a frame that
  // never renders fails at vitest's own test timeout, pointing at the awaiting line.
  const whenFrame = (marker: string) => {
    if (writes.some((w) => strip(w).includes(marker))) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    frameWaiters.push({ marker, resolve });
    return promise;
  };
  return { input, output, writes, whenFrame };
};

// Drive the consolidated init: wizard bytes first (buffered until act 1 mounts), then quit the
// act-3 fleet editor once its browser renders — v1.92 opens on the models view (no preset
// overlay at launch); Esc is HOME to the preset overlay and Esc there quits.
const driveInit = async (repo: string, wizardBytes: string, ...args: string[]) => {
  const io = makeIO();
  const p = init(
    ["--global-dir", mkdtempSync(join(tmpdir(), "tickmarkr-init-global-")), ...args],
    repo,
    { input: io.input as unknown as NodeJS.ReadStream, output: io.output as unknown as NodeJS.WriteStream },
  );
  if (wizardBytes) io.input.write(wizardBytes);
  await io.whenFrame("All models");
  io.input.write(KEY.esc);
  await io.whenFrame("routing preset");
  io.input.write(KEY.esc);
  return { out: await p, io };
};

const stampDoctor = (repo: string, ageMs: number) => {
  registry.writeDoctor(repo, { fake: { installed: true, authed: true, models: [] } });
  const when = new Date(Date.now() - ageMs);
  utimesSync(join(tickmarkrDir(repo), "doctor.json"), when, when);
};

afterEach(() => vi.restoreAllMocks());

const withTTY = async (fn: () => Promise<void>) => {
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const noColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    await fn();
  } finally {
    if (noColor !== undefined) process.env.NO_COLOR = noColor;
    else delete process.env.NO_COLOR;
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
};

const withoutTTY = async (fn: () => Promise<void>) => {
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  try {
    await fn();
  } finally {
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
};


describe("tickmarkr init doctor.json reuse (T1)", () => {
  test("reuses a doctor.json stamped 5 minutes ago and skips model probes", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const probeModelsSpy = vi.spyOn(registry, "probeModels").mockResolvedValue();
    const probeAllSpy = vi.spyOn(registry, "probeAll");
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);

    const out = await runInit(repo);

    expect(probeModelsSpy).not.toHaveBeenCalled();
    expect(probeAllSpy).not.toHaveBeenCalled();
    expect(out).toMatch(/using probe results from 5m ago — run tickmarkr doctor to refresh \(or init --fresh\)/);
    expect(out).toContain("tickmarkr doctor — capability matrix:");
    // fresh repo ⇒ active state dir is .tickmarkr; doctor output must never name the legacy state dir
    expect(out).toContain(".tickmarkr");
    expect(out).not.toContain(`.${["dro", "vr"].join("")}`);
  });

  test("init --fresh probes even with a fresh doctor.json", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const probeModelsSpy = vi.spyOn(registry, "probeModels").mockResolvedValue();
    vi.spyOn(registry, "probeAll").mockResolvedValue({});
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);

    await runInit(repo, "--fresh");

    expect(probeModelsSpy).toHaveBeenCalled();
  });

  test("init with doctor.json older than 60 minutes re-probes", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const probeModelsSpy = vi.spyOn(registry, "probeModels").mockResolvedValue();
    vi.spyOn(registry, "probeAll").mockResolvedValue({});
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 70 * 60 * 1000);

    await runInit(repo);

    expect(probeModelsSpy).toHaveBeenCalled();
  });
});

describe("tickmarkr init", () => {
  test("test: init in a repository whose package.json name is tickmarkr exits non-zero naming OBS-584 before writing any file even under --agent --force while a repository named anything else proceeds whereas an init that scaffolds there fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const blocked = makeRepo({ "package.json": JSON.stringify({ name: "tickmarkr" }) });
    const blockedGlobal = join(tmpdir(), `tickmarkr-init-global-blocked-${process.pid}-${Date.now()}`);

    await expect(init(["--global-dir", blockedGlobal, "--agent", "--force"], blocked)).rejects.toThrow(/OBS-584/);

    expect(existsSync(blockedGlobal)).toBe(false);
    expect(existsSync(join(blocked, ".tickmarkr"))).toBe(false);
    expect(existsSync(join(blocked, "tickmarkr.spec.md"))).toBe(false);
    expect(existsSync(join(blocked, ".agents"))).toBe(false);

    const allowed = makeRepo({ "package.json": JSON.stringify({ name: "consumer" }) });
    const out = await runInit(allowed);
    expect(out).toContain(`wrote ${join(allowed, "tickmarkr.spec.md")}`);
    expect(existsSync(join(allowed, ".tickmarkr", "config.yaml"))).toBe(true);
  });

  test("writes tickmarkr.spec.md when only a legacy spec filename exists", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const legacySpec = `${["dro", "vr"].join("")}.spec.md`;
    const legacy = "<!-- tickmarkr:spec -->\n## T1: kept\n- acceptance:\n  - kept\n";
    const repo = makeRepo({ [legacySpec]: legacy });

    const out = await runInit(repo);

    expect(existsSync(join(repo, "tickmarkr.spec.md"))).toBe(true);
    expect(readFileSync(join(repo, "tickmarkr.spec.md"), "utf8")).toMatch(/^<!-- tickmarkr:spec -->/);
    expect(readFileSync(join(repo, legacySpec), "utf8")).toBe(legacy);
    expect(out).toContain(`wrote ${join(repo, "tickmarkr.spec.md")}`);
  });

  test("test: the spec file a fresh init writes tells an author to pin a literal a worker could otherwise choose, to quantify universally where a list could be incomplete, and to replay a recorded incident for a prose artefact", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });

    await runInit(repo);

    const spec = readFileSync(join(repo, "tickmarkr.spec.md"), "utf8");
    expect(spec).toContain("PICK THE CRITERION FORM FROM WHO COULD BE WRONG");
    expect(spec).toMatch(/WORKER could be wrong[^.]*pin the exact\s+literal/s);
    expect(spec).toMatch(/AUTHOR could be wrong by omitting a member from a list[^;]*quantify universally/s);
    expect(spec).toMatch(/REVIEWER could be wrong about a prose artefact[^;]*replay a recorded incident/s);
  });

  test("test: the spec file a fresh init writes tells an author that a text sweep produces a candidate list and only running the change enumerates the real blocker set", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });

    await runInit(repo);

    const spec = readFileSync(join(repo, "tickmarkr.spec.md"), "utf8");
    expect(spec).toContain("A text sweep produces a candidate list; only running the change enumerates the real blocker set.");
  });
});

describe("tickmarkr init --agent", () => {
  test("installs both shipped skills byte-for-byte and appends marked CLAUDE.md docs with --docs", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const original = "# Consumer instructions\n\nKeep this text exactly.\n";
    const repo = makeRepo({ "CLAUDE.md": original });

    const out = await runInit(repo, "--agent", "--docs");

    expect(readFileSync(join(repo, ".agents/skills/tickmarkr-loop/SKILL.md"))).toEqual(skill("tickmarkr-loop"));
    expect(readFileSync(join(repo, ".agents/skills/tickmarkr-auto/SKILL.md"))).toEqual(skill("tickmarkr-auto"));
    const docs = readFileSync(join(repo, "CLAUDE.md"), "utf8");
    expect(docs.startsWith(original)).toBe(true);
    expect(docs).toContain("<!-- tickmarkr:agent-docs begin -->");
    expect(docs).toContain("<!-- tickmarkr:agent-docs end -->");
    expect(docs).toMatch(/tickmarkr compile.*tickmarkr plan.*tickmarkr run.*tickmarkr report/s);
    expect(docs).toMatch(/Never run two tickmarkr runs/);
    expect(docs).toMatch(/never trust a worker's completion claim/i);
    expect(out).toContain("appended tickmarkr agent docs");
  });

  // The control is the instance: this repo's own AGENTS.md kept "older on major.minor" — a preflight
  // rule superseded by the whole-version stop — through the release that fixed the tracked copy. The
  // file is gitignored, so no diff, no status, no review saw it, and a consultation ran under it.
  test("a guidance block that no longer matches the installed version is reported stale on a plain init, and --docs silences it by refreshing", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    await runInit(repo, "--agent", "--docs");
    const doc = join(repo, "AGENTS.md");

    // negative control: a freshly written block is NOT drift
    expect(await runInit(repo)).not.toContain("does not match this version");

    const fresh = readFileSync(doc, "utf8");
    expect(fresh).toContain("must agree on the entire version");
    writeFileSync(doc, fresh.replace("must agree on the entire version", "may be older on major.minor"));

    const stale = await runInit(repo);
    expect(stale).toContain("does not match this version");
    expect(stale).toContain(doc);
    expect(stale).toContain("tickmarkr init --agent --force");

    // the refresh path owns the fix and must not also nag about what it is fixing. `--docs` is NOT
    // that path: it governs only the append-a-missing-block case, so it must still report the drift.
    expect(await runInit(repo, "--docs")).toContain("does not match this version");
    expect(await runInit(repo, "--agent", "--force")).not.toContain("does not match this version");
    expect(readFileSync(doc, "utf8")).toContain("must agree on the entire version");
  });

  test("non-TTY keeps an existing skill and docs, installs the missing skill, and names opt-in flags", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({
      ".claude/skills/tickmarkr-loop/SKILL.md": "consumer-owned skill\n",
      "CLAUDE.md": "consumer-owned docs\n",
    });

    let out: string;
    await withoutTTY(async () => {
      out = await runInit(repo, "--agent");
    });

    expect(readFileSync(join(repo, ".claude/skills/tickmarkr-loop/SKILL.md"), "utf8")).toBe("consumer-owned skill\n");
    expect(readFileSync(join(repo, ".claude/skills/tickmarkr-auto/SKILL.md"))).toEqual(skill("tickmarkr-auto"));
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe("consumer-owned docs\n");
    expect(out!).toMatch(/skipped existing .*tickmarkr-loop\/SKILL\.md.*--force/);
    expect(out!).toMatch(/skipped agent docs .*CLAUDE\.md.*--docs/);
    expect(out!).toContain("tickmarkr doctor");
  });

  test("--force replaces existing skill files and --docs writes each host's paired guidance file", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const original = "# Agent instructions\n\nKeep this text exactly.\n";
    const repo = makeRepo({
      ".claude/skills/tickmarkr-auto/SKILL.md": "old skill\n",
      "AGENTS.md": original,
    });

    await runInit(repo, "--agent", "--force", "--docs");

    expect(readFileSync(join(repo, ".claude/skills/tickmarkr-loop/SKILL.md"))).toEqual(skill("tickmarkr-loop"));
    expect(readFileSync(join(repo, ".claude/skills/tickmarkr-auto/SKILL.md"))).toEqual(skill("tickmarkr-auto"));
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toMatch(/^# Agent instructions\n\nKeep this text exactly\.\n[\s\S]*tickmarkr:agent-docs begin/);
    // the claude host location was written, so its paired CLAUDE.md gets the guidance block too
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toContain("<!-- tickmarkr:agent-docs begin -->");
  });
});

describe("tickmarkr init wizard (T4)", () => {
  test("wizard answers land as uncommented keys in the repo overlay and loadConfig resolves them", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);

    // driver auto→herdr · concurrency 3→5 (first digit replaces) · visibility headless→pane ·
    // clamp down onto Continue, Enter — then Esc the act-3 fleet editor (driveInit does that).
    await driveInit(
      repo,
      KEY.enter + KEY.down + "5" + KEY.down + KEY.enter + KEY.down.repeat(3) + KEY.enter,
    );

    const cfgText = readFileSync(join(tickmarkrDir(repo), "config.yaml"), "utf8");
    expect(cfgText).toMatch(/^concurrency: 5$/m);
    expect(cfgText).toMatch(/^driver: herdr$/m);
    expect(cfgText).toMatch(/^  llm: pane$/m);
    expect(loadConfig(repo)).toMatchObject({ concurrency: 5, driver: "herdr", visibility: { llm: "pane" } });
  });

  test("a yes to the skills question installs skills exactly as init --agent does; a no leaves the repo untouched", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const yesRepo = makeRepo({ "keep.txt": "x" });
    const noRepo = makeRepo({ "keep.txt": "x" });
    stampDoctor(yesRepo, 5 * 60 * 1000);
    stampDoctor(noRepo, 5 * 60 * 1000);

    // Space toggles skills (default off in a bare repo), Space on the next row toggles the
    // agent-docs append, Enter on Continue — the docs block lands without any readline ask.
    await driveInit(yesRepo, KEY.down + KEY.down + KEY.down + KEY.space + KEY.down + KEY.space + KEY.down + KEY.enter);
    expect(readFileSync(join(yesRepo, ".agents/skills/tickmarkr-loop/SKILL.md"))).toEqual(skill("tickmarkr-loop"));
    expect(readFileSync(join(yesRepo, ".agents/skills/tickmarkr-auto/SKILL.md"))).toEqual(skill("tickmarkr-auto"));
    expect(readFileSync(join(yesRepo, "AGENTS.md"), "utf8")).toContain("<!-- tickmarkr:agent-docs begin -->");

    // Untouched toggles = no: clamp down onto Continue.
    await driveInit(noRepo, KEY.down.repeat(9) + KEY.enter);
    expect(existsSync(join(noRepo, ".claude"))).toBe(false);
  });

  test("the skills question is not asked when the skills already exist at every applicable location", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo(Object.fromEntries(
      ["tickmarkr-loop", "tickmarkr-auto", "tickmarkr-overseer"].flatMap((s) => [
        [`.agents/skills/${s}/SKILL.md`, "installed\n"],
        [`.claude/skills/${s}/SKILL.md`, "installed\n"],
      ]),
    ));
    stampDoctor(repo, 5 * 60 * 1000);

    // With skills installed the row is absent: three downs land on Continue directly.
    const { io } = await driveInit(repo, KEY.down.repeat(3) + KEY.enter);

    expect(io.writes.some((w) => strip(w).includes("Install agent skills"))).toBe(false);
    expect(readFileSync(join(repo, ".agents/skills/tickmarkr-loop/SKILL.md"), "utf8")).toBe("installed\n");
  });

  test("non-TTY init writes the plain template, asks nothing, installs no skills (CI-safe)", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);
    mockCreateInterface.mockClear();

    await withoutTTY(async () => {
      await runInit(repo);
    });

    expect(readFileSync(join(tickmarkrDir(repo), "config.yaml"), "utf8")).toBe(configTemplate());
    expect(mockCreateInterface).not.toHaveBeenCalled();
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    // no pre-existing state dir ⇒ init scaffolds .tickmarkr, never .tickmarkr
    expect(stateDirName(repo)).toBe(".tickmarkr");
    expect(existsSync(join(repo, ".tickmarkr", "config.yaml"))).toBe(true);
  });

  test("init on a repo with an existing .tickmarkr/config.yaml keeps it byte-identical", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const overlay = "concurrency: 9\ndriver: subprocess\n";
    const repo = makeRepo({ ".tickmarkr/config.yaml": overlay });
    stampDoctor(repo, 5 * 60 * 1000);

    // Existing config skips act 1 entirely — init lands in the act-3 fleet browser.
    const { io } = await driveInit(repo, "");

    expect(readFileSync(join(repo, ".tickmarkr/config.yaml"), "utf8")).toBe(overlay);
    expect(io.writes.some((w) => strip(w).includes("Preferences"))).toBe(false);
    // interactive reuse branch stays compact — the matrix lives behind `tickmarkr doctor`
    expect(io.writes.some((w) => strip(w).includes("full matrix: tickmarkr doctor"))).toBe(true);
  });

  test("the act-3 presets overlay raises on the first Shapes entry, not at launch", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);
    const io = makeIO();
    const p = init(
      ["--global-dir", mkdtempSync(join(tmpdir(), "tickmarkr-init-global-"))],
      repo,
      { input: io.input as unknown as NodeJS.ReadStream, output: io.output as unknown as NodeJS.WriteStream },
    );
    io.input.write(KEY.down.repeat(9) + KEY.enter); // act 1: accept every default → act 3
    await io.whenFrame("All models");
    // NOT at launch: the browser opened on the models view with no preset overlay anywhere yet
    expect(io.writes.some((w) => strip(w).includes("routing preset"))).toBe(false);
    expect(io.writes.some((w) => strip(w).includes("routing mode"))).toBe(false);
    io.input.write(KEY.left + KEY.down + KEY.enter); // rail → Shapes → FIRST Shapes entry
    await io.whenFrame("routing mode"); // the presets overlay auto-raised
    io.input.write(KEY.esc); // Esc from it lands in the shapes list — never quits
    await io.whenFrame("Shapes  routed under");
    io.input.write(KEY.esc); // browser Esc → HOME preset overlay (init quit-safety)
    await io.whenFrame("routing preset");
    io.input.write(KEY.esc); // Esc there quits
    expect(await p).toContain("fleet: quit without writing");
  });

  test("wizard quit is one line — no probe, no report wall, no fleet act", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const probeAllSpy = vi.spyOn(registry, "probeAll");
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);

    const io = makeIO();
    const p = init(
      ["--global-dir", mkdtempSync(join(tmpdir(), "tickmarkr-init-global-"))],
      repo,
      { input: io.input as unknown as NodeJS.ReadStream, output: io.output as unknown as NodeJS.WriteStream },
    );
    io.input.write(KEY.esc);
    const out = await p;

    expect(out).toMatch(/^init: wizard quit — nothing further run/);
    expect(out).not.toContain("capability matrix");
    expect(out).not.toContain("next steps");
    expect(probeAllSpy).not.toHaveBeenCalled();
    expect(io.writes.some((w) => strip(w).includes("routing preset"))).toBe(false);
    expect(existsSync(join(repo, ".tickmarkr", "config.yaml"))).toBe(false);
  });

  test("test: the closing environments footer says auto picks orca inside an Orca terminal and the wizard seeds the driver as orca when both Orca markers are set and HERDR_ENV is unset whereas a footer saying auto never picks it or a seed of auto under the markers fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const oldHerdr = process.env.HERDR_ENV;
    const oldTerm = process.env.TERM_PROGRAM;
    const oldTermVersion = process.env.TERM_PROGRAM_VERSION;
    const oldOrca = process.env.ORCA_TERMINAL_HANDLE;
    delete process.env.HERDR_ENV;
    process.env.TERM_PROGRAM = "Orca";
    process.env.TERM_PROGRAM_VERSION = "1.4.195";
    process.env.ORCA_TERMINAL_HANDLE = "terminal-1";
    try {
      const footerRepo = makeRepo({ "keep.txt": "x" });
      stampDoctor(footerRepo, 5 * 60 * 1000);
      const out = await runInit(footerRepo);
      expect(out).toContain("auto picks it inside an Orca terminal");
      expect(out).not.toContain("auto never picks it");

      const wizardRepo = makeRepo({ "keep.txt": "x" });
      stampDoctor(wizardRepo, 5 * 60 * 1000);
      await driveInit(wizardRepo, KEY.down.repeat(9) + KEY.enter);
      expect(loadConfig(wizardRepo).driver).toBe("orca");
    } finally {
      if (oldHerdr !== undefined) process.env.HERDR_ENV = oldHerdr;
      else delete process.env.HERDR_ENV;
      if (oldTerm !== undefined) process.env.TERM_PROGRAM = oldTerm;
      else delete process.env.TERM_PROGRAM;
      if (oldTermVersion !== undefined) process.env.TERM_PROGRAM_VERSION = oldTermVersion;
      else delete process.env.TERM_PROGRAM_VERSION;
      if (oldOrca !== undefined) process.env.ORCA_TERMINAL_HANDLE = oldOrca;
      else delete process.env.ORCA_TERMINAL_HANDLE;
    }
  });

  test("pressing Enter through every default writes uncommented defaults", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);
    const herdr = process.env.HERDR_ENV;
    delete process.env.HERDR_ENV;

    try {
      // Over-pressing down clamps on Continue; Enter accepts every default untouched.
      await driveInit(repo, KEY.down.repeat(9) + KEY.enter);
      const cfg = loadConfig(repo);
      expect(cfg.concurrency).toBe(3);
      expect(cfg.driver).toBe("auto");
      expect(cfg.visibility.llm).toBe("headless");
    } finally {
      if (herdr !== undefined) process.env.HERDR_ENV = herdr;
    }
  });
});

// Acceptance criterion titles must match the graph oracle filters EXACTLY (vitest -t is a regex;
// do not put glob/regex metacharacters like specs/*.spec.md into the title).
describe("T4 init closing block", () => {
  test("init names the spec file it actually wrote or kept in its closing block", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const wroteRepo = makeRepo({ "keep.txt": "x" });
    stampDoctor(wroteRepo, 5 * 60 * 1000);
    const wroteOut = await runInit(wroteRepo);
    expect(wroteOut).toMatch(/next: edit tickmarkr\.spec\.md, then tickmarkr compile tickmarkr\.spec\.md/);
    expect(wroteOut).toContain(`wrote ${join(wroteRepo, "tickmarkr.spec.md")}`);

    const keptRepo = makeRepo({
      "tickmarkr.spec.md": "<!-- tickmarkr:spec -->\n## T1: kept\n- acceptance:\n  - kept\n",
    });
    stampDoctor(keptRepo, 5 * 60 * 1000);
    const keptOut = await runInit(keptRepo);
    expect(keptOut).toMatch(/next: edit tickmarkr\.spec\.md, then tickmarkr compile tickmarkr\.spec\.md/);
    expect(keptOut).toContain(`kept existing ${join(keptRepo, "tickmarkr.spec.md")}`);
  });

  test("init points at existing specs when spec files already exist", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({
      "specs/v1.0-feature.spec.md": "<!-- tickmarkr:spec -->\n## T1: x\n- acceptance:\n  - x\n",
      "specs/v1.1-other.spec.md": "<!-- tickmarkr:spec -->\n## T1: y\n- acceptance:\n  - y\n",
    });
    stampDoctor(repo, 5 * 60 * 1000);

    const out = await runInit(repo);

    expect(out).toMatch(/next: existing specs under specs\//);
    expect(out).toContain("specs/v1.0-feature.spec.md");
    expect(out).toContain("specs/v1.1-other.spec.md");
    expect(out).toMatch(/tickmarkr compile <spec>/);
    expect(out).not.toMatch(/next: edit tickmarkr\.spec\.md/);
  });

  test("init with an active run prints the run id with a status suggestion and no compile suggestion", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);
    const runId = "run-20260717-120000";
    Journal.create(repo, runId).append("run-start", undefined, { pid: process.pid });
    acquireRunLock(repo, runId);
    let out = "";
    try {
      out = await runInit(repo);
    } finally {
      releaseRunLock(repo);
    }

    expect(out).toContain(`run ${runId} active — tickmarkr status`);
    expect(out).not.toMatch(/next:.*compile/);
    expect(out).not.toContain("tickmarkr compile");
  });

  test("the closing block prints the three-row environments footer", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);

    const out = await runInit(repo);

    expect(out).toContain("environments:");
    expect(out).toMatch(/herdr\s+—/);
    expect(out).toMatch(/orca\s+—/);
    expect(out).toMatch(/claude code\s+—/);
    expect(out).toMatch(/anywhere\s+—/);
    expect(out).toContain(
      "the full cockpit — every worker, judge, and consult is a visible pane you can watch and unblock · https://herdr.dev",
    );
    expect(out).toContain(
      "tickmarkr init --agent installs the /tkr skills + AGENTS.md so Claude Code (or any agent CLI) drives the loop natively",
    );
    expect(out).toContain("no herdr or Orca terminal? same fail-closed gates, headless subprocess driver");
  });

  test("the herdr footer row contains no npm install line", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);

    const out = await runInit(repo);
    const herdrLine = out.split("\n").find((l) => /^\s*herdr\s+—/.test(l)) ?? "";

    expect(herdrLine).toBeTruthy();
    expect(herdrLine).not.toMatch(/npm\s+i(?:nstall)?/i);
    expect(out).not.toMatch(/npm\s+i(?:nstall)?\s+[-g\s]*herdr/i);
  });
});

describe("T3 brand banner (TTY gate)", () => {
  test("TTY stdout emits the banner before the first wizard frame (wizard path)", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);
    // One shared sequence across BOTH streams: the banner rides process.stdout while wizard
    // frames ride the injected io — ordering is only provable on a merged log.
    const seq: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      seq.push(`stdout:${String(chunk)}`);
      return true;
    });

    try {
      await withTTY(async () => {
        const io = makeIO();
        const inkWrite = io.output.write;
        io.output.write = (chunk: string) => {
          seq.push(`ink:${chunk}`);
          return inkWrite(chunk);
        };
        const p = init(
          ["--global-dir", mkdtempSync(join(tmpdir(), "tickmarkr-init-global-"))],
          repo,
          { input: io.input as unknown as NodeJS.ReadStream, output: io.output as unknown as NodeJS.WriteStream },
        );
        io.input.write(KEY.down.repeat(9) + KEY.enter);
        await io.whenFrame("All models"); // v1.92: act 3 opens in the browser, not on presets
        io.input.write(KEY.esc);
        await io.whenFrame("routing preset"); // Esc is HOME to the preset overlay
        io.input.write(KEY.esc);
        await p;
      });
    } finally {
      writeSpy.mockRestore();
    }

    const bannerIdx = seq.findIndex((w) => w.startsWith("stdout:") && w.includes("spec in, verified work out."));
    const firstFrameIdx = seq.findIndex((w) => w.startsWith("ink:"));
    expect(bannerIdx).toBeGreaterThanOrEqual(0);
    expect(firstFrameIdx).toBeGreaterThan(bannerIdx);
  });

  test("TTY stdout emits the banner at start when the wizard is skipped", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const overlay = "concurrency: 9\ndriver: subprocess\n";
    const repo = makeRepo({ ".tickmarkr/config.yaml": overlay });
    stampDoctor(repo, 5 * 60 * 1000);

    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    let out: string;
    try {
      await withTTY(async () => {
        out = (await driveInit(repo, "")).out;
      });
    } finally {
      writeSpy.mockRestore();
    }

    expect(writes.some((w) => w.includes("spec in, verified work out."))).toBe(true);
    expect(out!.startsWith(BANNER)).toBe(false); // the start write is the single emission — body stays banner-free
    expect(out!).toContain("wrote");
  });

  test("doctor and init read as the same visual system as the fleet editor with chrome dim and verdicts emphasized", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ ".tickmarkr/config.yaml": "concurrency: 3\n" });
    stampDoctor(repo, 5 * 60 * 1000);
    let out = "";
    let shared = { initTitle: "", notesLegend: "", frameRule: "", note: "", nextTitle: "" };

    await withTTY(async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        out = (await driveInit(repo, "")).out;
        shared = {
          initTitle: title("tickmarkr init"),
          notesLegend: legend("· setup notes"),
          frameRule: rule(),
          note: statusRow("pass", `wrote ${join(repo, "tickmarkr.spec.md")}`),
          nextTitle: title("next steps"),
        };
      } finally {
        writeSpy.mockRestore();
      }
    });

    expect(out.startsWith(`${shared.initTitle}\n${shared.notesLegend}\n${shared.frameRule}`)).toBe(true);
    expect(out).toContain(shared.note);
    expect(out).toContain(`${shared.nextTitle}\n`);
    expect(out.split(shared.frameRule)).toHaveLength(3);
    expect(out).toContain("the full cockpit — every worker, judge, and consult is a visible pane you can watch and unblock · https://herdr.dev");
  });

  test("test: init non-tty output is byte-identical to before this change", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);

    let out: string;
    await withoutTTY(async () => {
      out = await runInit(repo);
    });

    expect(out!.startsWith(BANNER)).toBe(false);
    expect(out!).toMatch(/^wrote /);
    expect(out!).toContain("tickmarkr doctor — capability matrix:");
    expect(out!).not.toMatch(/\x1b\[/);
  });
});

describe("D-1 documentation half: the AA key is advertised where the catalog is refreshed", () => {
  test("test: the written config template documents ARTIFICIAL_ANALYSIS_API_KEY beside the refresh-catalog command and a fleet overlay write onto that template preserves it verbatim, so an undocumented AA key or a template the overlay writer mangles fails", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);
    await withoutTTY(async () => {
      await runInit(repo);
    });
    const written = readFileSync(join(tickmarkrDir(repo), "config.yaml"), "utf8");

    // Beside, not merely somewhere: the key rides the same comment block as the command that
    // gates on it — an operator reading `--refresh-catalog` cannot miss why the AA leg is inert.
    const lines = written.split("\n");
    const start = lines.findIndex((l) => l.includes("tickmarkr doctor --refresh-catalog"));
    expect(start, written).toBeGreaterThanOrEqual(0);
    const block = lines.slice(start).findIndex((l) => !l.startsWith("#")) + start;
    const doc = lines.slice(start, block).join("\n");
    expect(doc).toContain("ARTIFICIAL_ANALYSIS_API_KEY");
    expect(doc.split("\n").every((l) => l.startsWith("#"))).toBe(true); // documentation, never a live key

    // OBS-505 law on the NEW template: a fleet write is still a pure append, byte-for-byte.
    const state: FleetEditable = { denyAdapters: [], denyModels: [], tiers: {}, map: {}, floors: {} };
    const after = renderFleetOverlayWrite(written, { initial: state, edited: state, mode: "staff-led" });
    expect(after.startsWith(written)).toBe(true);
    expect(after.split(doc).length - 1).toBe(1);
    expect(after).not.toMatch(/^ #/m);
    expect(parse(after).routing.mode).toBe("staff-led");
  });
});
