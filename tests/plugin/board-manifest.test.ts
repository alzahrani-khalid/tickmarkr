// T5 (queue rows 280, 331, 332): the shipped register, executed against a fake host and the real model.
// "claude-code" resolves only inside the Claude Code host, so the plugin tree is transpiled to CJS in memory and its
// host import answered from a fake module — these tests run the same register.tsx bytes the plugin ships.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { transformSync } from "esbuild";

const ROOT = resolve(import.meta.dirname, "../..");
const HOOKS = resolve(ROOT, "hooks/board");
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));

type Exports = Record<string, unknown>;
type Wire = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean };
type Rendered = { type: unknown; props: Record<string, unknown> };

/** One esbuild pass over a hooks file: the host's own JSX runtime choice (claude-code) and CJS for `new Function`. */
const compile = (file: string): string =>
  transformSync(readFileSync(file, "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic", jsxImportSource: "claude-code" }).code;

/** The host's atom store, as the plugin uses it: one slot per atom, whole-value writes. */
const makeAtoms = () => {
  const values = new Map<object, unknown>();
  const atoms: object[] = [];
  const claudeCode: Exports = {
    atom: (_id: unknown, initial: unknown) => {
      const created = { initial };
      values.set(created, initial);
      atoms.push(created);
      return created;
    },
    read: (_$: unknown, a: object) => Promise.resolve(values.get(a)),
    update: (_$: unknown, a: object, write: (current: unknown) => unknown) => {
      values.set(a, write(values.get(a)));
      return Promise.resolve();
    },
  };
  const element = (type: unknown, props: Record<string, unknown>): Rendered => ({ type, props });
  const jsxRuntime: Exports = { jsx: element, jsxs: element, Fragment: "Fragment" };
  return { claudeCode, jsxRuntime, values, atoms };
};

const NOW_S = Date.parse("2026-11-02T10:00:00.000Z") / 1000;
// the raw command carries an ESC byte, so a Copy that round-trips it proves the adapter hands Copy the RAW command
const RAW_CMD = "tickmarkr approve run-x T1 --waive --gate review\x1b";
const SNAPSHOT = {
  version: 1, runId: "run-x881", alive: true, pid: 4242, elapsedMin: 3, ended: null,
  tasks: [{
    id: "T1", title: "Park a review red", state: "parked", attempt: 0, dispatched: true, budget: 1, launches: 1,
    gates: { build: "pass", test: "fail" }, note: "", deps: [], blocks: [],
    worker: "codex:gpt-6.1", judge: "", reviewer: "", suiteWaiting: false,
    now: "waits on the review gate", nowSince: null,
    history: [{ att: 0, start: "09:57:00", parts: [{ text: "worker", tone: "pass" }, { text: "review", tone: "fail", reason: "red diff" }] }],
    startEpoch: NOW_S - 180, endEpoch: null, startedAt: "2026-11-02 09:57:00", endedAt: "", tokens: null,
  }],
  needsYou: [{ task: "T1", kind: "gate-fail", reason: "review", since: NOW_S - 60, blocks: [], cmd: RAW_CMD }],
  approvalWindow: null, eta: null, atEpoch: NOW_S, startEpoch: NOW_S - 180, endEpoch: null,
  readAt: "10:00:00", release: null, spec: "v2.19.0-run-board",
};
const okWire = (wire: unknown = SNAPSHOT): Wire => ({ exitCode: 0, stdout: JSON.stringify(wire), stderr: "" });

const flush = async (times = 6): Promise<void> => {
  for (let i = 0; i < times; i += 1) await new Promise<void>(done => setImmediate(done));
};

/** Every string an element tree carries, children and props alike. */
const stringsOf = (node: unknown): string[] =>
  typeof node === "string" || typeof node === "number" ? [String(node)]
  : Array.isArray(node) ? node.flatMap(stringsOf)
  : node !== null && typeof node === "object" ? Object.values(node).flatMap(stringsOf)
  : [];

type RigOptions = { kind?: string; placed?: boolean; options?: Record<string, unknown> };

/** The production register wired onto a recording host: every engine effect captured, nothing real touched. */
function rig(overrides: RigOptions = {}) {
  const fake = makeAtoms();
  const world = {
    cwd: "/work/repo",
    kind: overrides.kind ?? "dir",
    placed: overrides.placed ?? true,
    answer: (() => okWire()) as () => Wire | Promise<Wire>,
    commands: [] as Record<string, unknown>[],
    stats: [] as string[],
    runs: [] as { argv: string[]; opts: { cwd: string; timeoutMs: number } }[],
    opens: [] as Record<string, unknown>[],
    copies: [] as Record<string, unknown>[],
    statuses: [] as (string | undefined)[],
    timers: [] as { ms: number; tick: () => void; cancelled: boolean }[],
  };
  const element = (kind: string) => (props: Record<string, unknown>) => ({ kind, props });
  const elements = { Text: element("Text"), Box: element("Box"), Button: element("Button") };
  const Client = element("Client");
  const $ = {
    command: { register: async (spec: Record<string, unknown>) => { world.commands.push(spec); } },
    session: { cwd: async () => world.cwd },
    fs: { stat: async (path: string) => {
      world.stats.push(path);
      if (world.kind === "reject") throw new Error("stat refused");
      return { kind: world.kind };
    } },
    process: { run: async (argv: readonly string[], opts: { cwd: string; timeoutMs: number }) => {
      world.runs.push({ argv: [...argv], opts });
      return world.answer();
    } },
    ui: {
      open: async (spec: Record<string, unknown>) => { world.opens.push(spec); return { isPlaced: world.placed }; },
      status: (text: string | undefined) => { world.statuses.push(text); },
      copy: async (spec: Record<string, unknown>) => { world.copies.push(spec); },
      resolve: () => ({ ...elements, Client }),
    },
    clock: { every: (ms: number, tick: () => void) => {
      const timer = { ms, tick, cancelled: false };
      world.timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    } },
  };

  const loaded = new Map<string, Exports>();
  const require = (id: string): Exports => {
    if (id === "claude-code") return fake.claudeCode;
    if (id === "claude-code/jsx-runtime") return fake.jsxRuntime;
    if (id.startsWith(".")) {
      const base = resolve(HOOKS, id);
      const file = existsSync(`${base}.tsx`) ? `${base}.tsx` : `${base}.ts`;
      const cached = loaded.get(file);
      if (cached) return cached;
      const module = { exports: {} as Exports };
      new Function("require", "module", "exports", compile(file))(require, module, module.exports);
      loaded.set(file, module.exports);
      return module.exports;
    }
    throw new Error(`unexpected require "${id}"`);
  };
  const model = require("./model") as {
    visible: (text: unknown) => string;
    shown: (snapshot: unknown) => unknown;
    boardStatusLine: (snapshot: unknown) => string;
    READY_HINT: string;
    EMPTY_HEAD: string;
    EMPTY_TAIL: string;
  };

  const handlers = new Map<string, { match: unknown; run: (...args: unknown[]) => Promise<unknown> }>();
  const on = (event: string, ...rest: unknown[]) => {
    const isMatch = typeof rest[0] === "object" && rest[0] !== null && typeof rest[1] === "function";
    handlers.set(event, { match: isMatch ? rest[0] : undefined, run: (isMatch ? rest[1] : rest[0]) as (...args: unknown[]) => Promise<unknown> });
  };
  const register = require("./register").register as (on: unknown, options?: unknown) => void;
  register(on, overrides.options);
  const next = (e: unknown) => e;
  const fire = async (event: string, e: unknown = {}): Promise<unknown> => handlers.get(event)!.run($, e, next);
  const render = (surface: string): Promise<Rendered> => fire("ui.render", { surface, component: "Pane", requestId: "tickmarkr-board" }) as Promise<Rendered>;
  const message = (data: unknown, surface?: string): Promise<unknown> => fire("ui.message", { element: "board", data, surface });
  return {
    world, elements, Client, model, fire, render, message,
    atomValue: () => fake.values.get(fake.atoms[0]!),
  };
}

test("test: the plugin manifest keeps every existing field and gains userConfig with stateRoots and releaseRoots defaulting empty and marks defaulting to glyph with glyph and devicons as options, and holds no home path", () => {
  const pkg = readJson("package.json") as {
    version: string; description: string; homepage: string; license: string;
    repository: { url: string }; keywords: string[];
  };
  const manifest = readJson(".claude-plugin/plugin.json");
  expect(manifest).toEqual({
    name: "tickmarkr",
    version: pkg.version,
    description: pkg.description,
    types: "./hooks/board/state.d.ts",
    author: { name: "Khalid Alzahrani", url: pkg.homepage },
    homepage: pkg.homepage,
    repository: pkg.repository.url,
    license: pkg.license,
    keywords: pkg.keywords,
    userConfig: {
      stateRoots: {
        type: "string",
        title: "Run state roots",
        description: "Comma-separated .tickmarkr folders to read runs from; ~ and globs expand. Empty reads the session folder's own .tickmarkr.",
        default: "",
      },
      releaseRoots: {
        type: "string",
        title: "Release folders",
        description: "Comma-separated release folders to read the release card from; ~ and globs expand. Empty hides it.",
        default: "",
      },
      marks: {
        type: "string",
        title: "Harness marks",
        description: "glyph (default) draws a shape in place of each harness's name in any font. devicons draws the real logo from the Devicons icon font (devicons.io); add Devicons to your terminal's font list first, or the marks draw as empty boxes.",
        default: "glyph",
        options: ["glyph", "devicons"],
      },
    },
  });
  const text = JSON.stringify(manifest);
  expect(text).not.toContain("/Users/");
  expect(text).not.toContain("/home/");
});

test("test: the production register function, executed with a fake host and the real controller, wires start, command and end, reads the current cwd, checks the directory kind, runs the board json argv with a 20000 ms timeout and one 5000 ms timer, opens with no focus field, renders snapshot, empty and error states on terminal, desktop and fallback surfaces, and authorizes Copy only from the current raw state", async () => {
  const ARGV = ["tickmarkr", "board", "--json", "--root", "/state/a", "--root", "/state/b", "--release", "/rel"];

  // A non-interactive session registers the command and does nothing else.
  const quiet = rig({ options: {} });
  await quiet.fire("session.start", { isInteractive: false });
  await flush();
  expect(quiet.world.commands).toEqual([{ name: "tickmarkr-board", description: "Show the tickmarkr run board" }]);
  expect(quiet.world.stats).toEqual([]);
  expect(quiet.world.runs).toEqual([]);
  expect(quiet.world.opens).toEqual([]);
  expect(quiet.world.timers).toEqual([]);

  // A session folder whose .tickmarkr is not a directory — or whose check rejects — never reads, opens or polls.
  for (const kind of ["file", "reject"]) {
    const occupied = rig({ kind });
    await occupied.fire("session.start", { isInteractive: true });
    await flush();
    expect(occupied.world.stats).toEqual(["/work/repo/.tickmarkr"]);
    expect(occupied.world.runs).toEqual([]);
    expect(occupied.world.opens).toEqual([]);
    expect(occupied.world.timers).toEqual([]);
  }

  // An unplaced automatic open keeps the ready hint and the eligible poll (queue row 343). The miss is not a latch.
  const unplaced = rig({ placed: false });
  await unplaced.fire("session.start", { isInteractive: true });
  await flush();
  expect(unplaced.world.runs).toHaveLength(1);
  expect(unplaced.world.opens).toHaveLength(1);
  expect(unplaced.world.statuses).toEqual([unplaced.model.boardStatusLine(unplaced.model.shown(SNAPSHOT)), unplaced.model.READY_HINT]);
  expect(unplaced.world.timers.map(timer => timer.ms)).toEqual([5000]);
  expect(unplaced.world.timers[0]!.cancelled).toBe(false);

  // The autoload start: register, cwd + kind check, board json run, focus-less open, status line, one poll.
  const w = rig({ options: { stateRoots: "/state/a, /state/b", releaseRoots: "/rel", marks: "devicons" } });
  await w.fire("session.start", { isInteractive: true });
  await flush();
  expect(w.world.stats).toEqual(["/work/repo/.tickmarkr"]);
  expect(w.world.runs).toEqual([{ argv: ARGV, opts: { cwd: "/work/repo", timeoutMs: 20000 } }]);
  expect(w.world.opens).toEqual([{ id: "tickmarkr-board", title: "tickmarkr run" }]);
  expect("focus" in w.world.opens[0]!).toBe(false);
  expect(w.world.statuses).toEqual([w.model.boardStatusLine(w.model.shown(SNAPSHOT))]);
  expect(w.world.timers.map(timer => timer.ms)).toEqual([5000]);
  expect(w.atomValue()).toMatchObject({ snapshot: { runId: "run-x881" }, empty: null, error: null });

  // The first read never holds up the session (queue row 338): the host awaits session.start before the first prompt,
  // so start returns while the board read is still pending, and the pane opens once the read lands.
  const slow = rig({});
  const { promise: held, resolve: land } = Promise.withResolvers<Wire>();
  slow.world.answer = () => held;
  let returned = false;
  const started = slow.fire("session.start", { isInteractive: true }).then(() => { returned = true; });
  await flush();
  expect(slow.world.runs).toHaveLength(1);
  expect(returned).toBe(true);
  expect(slow.world.opens).toEqual([]);
  land(okWire());
  await started;
  await flush();
  expect(slow.world.opens).toHaveLength(1);

  // The command answers, reads unconditionally in the CURRENT cwd, reopens without focus and reuses the one timer.
  expect(await w.fire("command.run")).toEqual({ text: "Tickmarkr board opened." });
  w.world.cwd = "/second";
  await w.fire("command.run");
  expect(w.world.runs.map(run => run.opts)).toEqual([
    { cwd: "/work/repo", timeoutMs: 20000 }, { cwd: "/work/repo", timeoutMs: 20000 }, { cwd: "/second", timeoutMs: 20000 },
  ]);
  for (const run of w.world.runs) expect(run.argv).toEqual(ARGV);
  expect(w.world.opens).toHaveLength(3);
  for (const open of w.world.opens) expect("focus" in open).toBe(false);
  expect(w.world.timers).toHaveLength(1);

  // A poll whose session folder lost its .tickmarkr rechecks the CURRENT cwd and stops polling without reading.
  w.world.cwd = "/elsewhere";
  w.world.kind = "missing";
  w.world.timers[0]!.tick();
  await flush();
  expect(w.world.stats).toEqual(["/work/repo/.tickmarkr", "/elsewhere/.tickmarkr"]);
  expect(w.world.runs).toHaveLength(3);
  expect(w.world.timers[0]!.cancelled).toBe(true);

  // session.end while a read is in flight: the late answer publishes, statuses and opens nowhere.
  const { promise: pending, resolve: release } = Promise.withResolvers<Wire>();
  w.world.answer = () => pending;
  const before = w.atomValue();
  const late = w.fire("command.run");
  await flush();
  expect(w.world.runs).toHaveLength(4);
  await w.fire("session.end", { sessionId: "s1" });
  release(okWire());
  await late;
  await flush();
  expect(w.atomValue()).toBe(before);
  expect(w.world.opens).toHaveLength(3);
  expect(w.world.timers.every(timer => timer.cancelled)).toBe(true);

  // The snapshot pane: the reference's Client path on terminal and desktop (desktop's text runs 1.5 cells wide).
  w.world.answer = () => okWire();
  await w.fire("command.run");
  await flush();
  const terminal = await w.render("terminal");
  expect(terminal.type).toBe(w.Client);
  expect(terminal.props.module).toBe("./board.tsx");
  expect(terminal.props.width).toBe("100%");
  expect(terminal.props.props).toMatchObject({ error: null, marks: "devicons" });
  expect(terminal.props.props).not.toHaveProperty("fit");
  expect(terminal.props.props).toMatchObject({ snap: { runId: "run-x881" } });
  const desktop = await w.render("desktop");
  expect(desktop.type).toBe(w.Client);
  expect(desktop.props.props).toMatchObject({ fit: 1.5 });
  // The still fallback runs the board module itself against the fixed surface.
  const still = await w.render("web");
  const drawn = stringsOf(still).join(" ");
  expect(drawn).toContain("T1");
  expect(drawn).toContain("PARKED");
  expect(drawn).toContain("Park a review red");

  // Copy: only the current raw state's command, posted as the board shows it.
  const shownCmd = w.model.visible(RAW_CMD);
  await w.message({ copy: shownCmd }, "terminal");
  expect(w.world.copies).toEqual([{ text: RAW_CMD, surface: "terminal" }]);
  await w.message({ copy: "tickmarkr approve run-x T9" }, "terminal");
  await w.message({ copy: 42 }, "terminal");
  expect(w.world.copies).toHaveLength(1);
  const passedThrough = await w.fire("ui.message", { element: "other", data: { copy: shownCmd }, surface: "terminal" });
  expect(passedThrough).toMatchObject({ element: "other" });
  expect(w.world.copies).toHaveLength(1);

  // The empty answer replaces the pane with one block of text and clears the status line.
  w.world.answer = () => okWire({ version: 1, empty: "no tickmarkr run under /work/repo/.tickmarkr" });
  await w.fire("command.run");
  await flush();
  const emptyText = [w.model.EMPTY_HEAD, "Searched /work/repo/.tickmarkr", w.model.EMPTY_TAIL].join("\n");
  for (const surface of ["terminal", "desktop", "web"]) {
    const empty = await w.render(surface);
    expect(empty.type).toBe(w.elements.Text);
    expect(empty.props).toMatchObject({ color: "subtle", children: emptyText });
  }
  expect(w.world.statuses.at(-1)).toBeUndefined();
  // A state with no snapshot authorizes no Copy.
  await w.message({ copy: shownCmd }, "terminal");
  expect(w.world.copies).toHaveLength(1);

  // The failed read draws its stderr's last line the same way on every surface.
  w.world.answer = () => ({ exitCode: 1, stdout: "", stderr: "tickmarkr: not found\n" });
  await w.fire("command.run");
  await flush();
  for (const surface of ["terminal", "desktop", "web"]) {
    const failed = await w.render(surface);
    expect(failed.type).toBe(w.elements.Text);
    expect(failed.props.children).toBe("tickmarkr: not found");
  }
});

// review:material (repair): the real host refuses to load the module if `$` is assigned, aliased or stored — only
// passed as an argument and spelled `$.noun.event(...)` at the call site. The host's own validator is the oracle
// (`claude plugin validate`: "compiled line N `host = $;`: $ itself is assigned"); under Vitest the same rule is
// observable on the exact bytes the plugin ships. Fails on the pre-fix adapter (`host = $;` in every handler).
test("the shipped register never binds $ to an identifier, so the host loads the module", () => {
  const compiled = compile(resolve(HOOKS, "register.tsx"));
  // an identifier (or property) assigned `$` itself: `host = $;` / `engine: $,` — closure capture and passing
  // `deps($, args)` / `read($, atom)` are the allowed shapes.
  expect(compiled).not.toMatch(/[\w$)\]]+\s*=\s*\$\s*[;,)\]]/);
  // and `$` is never handed back out (returned, yielded or spread) for later aliasing.
  expect(compiled).not.toMatch(/return\s+\$\s*[;}\n]/);
  expect(compiled).not.toMatch(/\.\.\.\$\s*[},)\]]/);
});
