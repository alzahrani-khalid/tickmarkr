// Row 395 (D-2187 add.23): the shipped register's seat guard, executed through the same in-memory loader
// board-manifest.test.ts uses (register.tsx transpiled to CJS, its "claude-code" import answered by a fake), with
// env.get added to the engine double. The guard is exercised only through session.start and command.run — the
// predicate is never re-implemented here.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { transformSync } from "esbuild";

const HOOKS = resolve(import.meta.dirname, "../../hooks/board");
type Exports = Record<string, unknown>;

const compile = (file: string): string =>
  transformSync(readFileSync(file, "utf8"), { loader: "tsx", format: "cjs", jsx: "automatic", jsxImportSource: "claude-code" }).code;

const SNAPSHOT = {
  version: 1, runId: "run-x881", alive: true, pid: 4242, elapsedMin: 3, ended: null,
  tasks: [], needsYou: [], approvalWindow: null, eta: null, atEpoch: 0, startEpoch: 0, endEpoch: null,
  readAt: "10:00:00", release: null, spec: null,
};

const flush = async (times = 6): Promise<void> => {
  for (let i = 0; i < times; i += 1) await new Promise<void>(done => setImmediate(done));
};

/** Every read session.start awaits before it may start the controller: registration, then the guard's two reads. */
type Hold = "register" | "env" | "cwd";

/**
 * The production register on a recording engine: one session folder (holding a `.tickmarkr` directory) and one env.
 * `hold` parks the FIRST call of that read until `release()`, so a session can end or be replaced while it is pending.
 */
function rig(cwd: string, env: Record<string, string>, hold?: Hold) {
  let parked = false;
  let release = (): void => undefined;
  const held = <T>(kind: Hold, value: T): Promise<T> => {
    if (kind !== hold || parked) return Promise.resolve(value);
    parked = true;
    return new Promise<T>(done => { release = () => done(value); });
  };
  const world = {
    envReads: [] as string[],
    stats: [] as string[],
    runs: [] as { argv: string[]; cwd: string }[],
    opens: [] as Record<string, unknown>[],
    statuses: [] as (string | undefined)[],
    timers: [] as number[],
  };
  const values = new Map<object, unknown>();
  const claudeCode: Exports = {
    atom: (_id: unknown, initial: unknown) => { const a = {}; values.set(a, initial); return a; },
    read: (_$: unknown, a: object) => Promise.resolve(values.get(a)),
    update: (_$: unknown, a: object, write: (current: unknown) => unknown) => { values.set(a, write(values.get(a))); return Promise.resolve(); },
  };
  const element = (type: unknown, props: unknown) => ({ type, props });
  const $ = {
    command: { register: () => held("register", undefined) },
    session: { cwd: () => held("cwd", cwd) },
    env: { get: (name: string) => { world.envReads.push(name); return held("env", env[name]); } },
    fs: { stat: async (path: string) => { world.stats.push(path); return { kind: "dir" }; } },
    process: { run: async (argv: readonly string[], opts: { cwd: string }) => {
      world.runs.push({ argv: [...argv], cwd: opts.cwd });
      return { exitCode: 0, stdout: JSON.stringify(SNAPSHOT), stderr: "" };
    } },
    ui: {
      open: async (spec: Record<string, unknown>) => { world.opens.push(spec); return { isPlaced: true }; },
      status: (text: string | undefined) => { world.statuses.push(text); },
      copy: async () => undefined,
    },
    clock: { every: (ms: number) => { world.timers.push(ms); return { cancel: () => undefined }; } },
  };

  const loaded = new Map<string, Exports>();
  const require = (id: string): Exports => {
    if (id === "claude-code") return claudeCode;
    if (id === "claude-code/jsx-runtime") return { jsx: element, jsxs: element, Fragment: "Fragment" };
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
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const on = (event: string, ...rest: unknown[]) => {
    handlers.set(event, rest[rest.length - 1] as (...args: unknown[]) => Promise<unknown>);
  };
  (require("./register").register as (on: unknown, options?: unknown) => void)(on, {});
  const fire = (event: string, e: unknown = {}): Promise<unknown> => handlers.get(event)!($, e, (x: unknown) => x);
  const start = async (): Promise<void> => { await fire("session.start", { isInteractive: true }); await flush(); };
  return { world, fire, start, release: () => release() };
}

const OPERATOR = "/work/repo";
const WORKTREE = "/work/repo/.tickmarkr/worktrees.noindex/tickmarkr-run-20261108-000000-0000000000000001--T3";
const SEATS = ["worker", "judge", "review", "consult"];

const expectNoBoard = (world: ReturnType<typeof rig>["world"]): void => {
  expect(world.envReads).toEqual(["TICKMARKR_SEAT"]);
  expect(world.stats).toEqual([]);
  expect(world.runs).toEqual([]);
  expect(world.opens).toEqual([]);
  expect(world.statuses).toEqual([]);
  expect(world.timers).toEqual([]);
};

describe("row 395: the board never auto-opens inside a tickmarkr seat or task worktree", () => {
  test("an interactive session with the seat marker set never auto-opens the board", async () => {
    for (const seat of SEATS) {
      const r = rig(OPERATOR, { TICKMARKR_SEAT: seat });
      await r.start();
      expectNoBoard(r.world);
    }
  });

  test("an interactive session in a task worktree without a seat marker never auto-opens the board", async () => {
    const r = rig(WORKTREE, {});
    await r.start();
    expectNoBoard(r.world);
  });

  test("an operator session in a checkout holding the tickmarkr folder still auto-opens the board", async () => {
    const r = rig(OPERATOR, {});
    await r.start();
    expect(r.world.envReads).toEqual(["TICKMARKR_SEAT"]);
    expect(r.world.stats).toEqual([`${OPERATOR}/.tickmarkr`]);
    expect(r.world.runs).toEqual([{ argv: ["tickmarkr", "board", "--json"], cwd: OPERATOR }]);
    expect(r.world.opens).toEqual([{ id: "tickmarkr-board", title: "tickmarkr run" }]);
    expect(r.world.statuses).toHaveLength(1);
    expect(r.world.timers).toEqual([5000]);
  });

  test("the board command opens the board by hand in a seat and in a task worktree", async () => {
    const cases: [string, Record<string, string>][] = [
      ...SEATS.map((seat): [string, Record<string, string>] => [OPERATOR, { TICKMARKR_SEAT: seat }]),
      [WORKTREE, {}],
    ];
    for (const [cwd, env] of cases) {
      const r = rig(cwd, env);
      await r.start();
      expect(r.world.opens).toEqual([]);
      expect(await r.fire("command.run", {})).toEqual({ text: "Tickmarkr board opened." });
      await flush();
      expect(r.world.runs).toEqual([{ argv: ["tickmarkr", "board", "--json"], cwd }]);
      expect(r.world.opens).toEqual([{ id: "tickmarkr-board", title: "tickmarkr run" }]);
      expect(r.world.timers).toEqual([5000]);
    }
  });

  // review r1 (row 395): an end or a replacement start that lands while the guard is still reading must win — the
  // controller's own session check is taken inside start, so it cannot see an end that came before start was called.
  const expectNothing = (world: ReturnType<typeof rig>["world"]): void => {
    expect(world.stats).toEqual([]);
    expect(world.runs).toEqual([]);
    expect(world.opens).toEqual([]);
    expect(world.statuses).toEqual([]);
    expect(world.timers).toEqual([]);
  };
  const expectOneBoard = (world: ReturnType<typeof rig>["world"]): void => {
    expect(world.stats).toEqual([`${OPERATOR}/.tickmarkr`]);
    expect(world.runs).toEqual([{ argv: ["tickmarkr", "board", "--json"], cwd: OPERATOR }]);
    expect(world.opens).toEqual([{ id: "tickmarkr-board", title: "tickmarkr run" }]);
    expect(world.statuses).toHaveLength(1);
    expect(world.timers).toEqual([5000]);
  };
  /** An eligible operator start parked at `hold`, then `invalidate`d, then released. */
  const raced = async (hold: Hold, invalidate: "end" | "restart"): Promise<ReturnType<typeof rig>["world"]> => {
    const r = rig(OPERATOR, {}, hold);
    const starting = r.fire("session.start", { isInteractive: true });
    await flush();
    if (invalidate === "end") await r.fire("session.end");
    else await r.start();
    r.release();
    await starting;
    await flush();
    return r.world;
  };

  test("a session that ends while the seat marker read is pending never starts the board", async () => {
    const world = await raced("env", "end");
    expect(world.envReads).toEqual(["TICKMARKR_SEAT"]);
    expectNothing(world);
  });

  test("a session that ends while the guard's folder read is pending never starts the board", async () => {
    const world = await raced("cwd", "end");
    expect(world.envReads).toEqual(["TICKMARKR_SEAT"]);
    expectNothing(world);
  });

  test("every read session.start awaits loses to an end or a replacement start that lands while it is pending", async () => {
    for (const hold of ["register", "env", "cwd"] as const) {
      expectNothing(await raced(hold, "end"));
      // the replacement session boards once; the stale first start adds no second probe, read, open, status or timer
      expectOneBoard(await raced(hold, "restart"));
    }
  });
});
