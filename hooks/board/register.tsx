import { atom, read, update } from "claude-code";
import type { ClientElements, ClientSurface, EngineInterface, Register } from "claude-code";
import Board from "./board";
import { boardArgs, boardController, copyTarget, view } from "./model";

const PANE = "tickmarkr-board";
const runBoard = atom({ plugin: "tickmarkr", key: "runBoard" } as const, { snapshot: null, empty: null, error: null });

/**
 * A thin adapter over boardController (queue rows 280, 331 and 332): every lifecycle decision — autoload eligibility,
 * one in-flight read, the single poll, the status line, what Copy may post — lives in the model. This file only maps
 * the engine onto the controller's plain-function deps and the published state onto the pane.
 *
 * The host's load rule: `$` may never be assigned, aliased or stored — only passed as an argument and spelled
 * `$.noun.event(...)` at the call site. So each handler builds the controller's deps from its OWN `$` (closure
 * capture is fine; a register-scope `host = $` is not), and only the controller — never `$` — stays in register
 * scope between events.
 */

type Engine = EngineInterface;

/** The lifecycle boardController returns: start (autoload eligibility), command (reopen now) and end (stop the poll). */
interface Controller {
  start: (isInteractive: boolean) => Promise<void>;
  command: () => Promise<void>;
  end: () => void;
}

/** The controller's plain-function deps, each mapped onto the `$` of the handler that built them. */
const deps = ($: Engine, args: readonly string[]) => ({
  cwd: () => $.session.cwd(),
  isDirectory: async (path: string) => {
    try {
      return (await $.fs.stat(path)).kind === "dir";
    } catch {
      return false;
    }
  },
  run: (argv: readonly string[], cwd: string) => $.process.run(argv, { cwd, timeoutMs: 20000 }),
  open: async () => ((await $.ui.open({ id: PANE, title: "tickmarkr run" })) as { isPlaced?: boolean } | undefined)?.isPlaced !== false,
  status: (text: string | undefined) => { $.ui.status(text); },
  every: (ms: number, tick: () => void) => $.clock.every(ms, tick).cancel,
  publish: async (state: unknown) => { await update($, runBoard, () => state); },
  args,
});

/** Copies the raw command a board press names, only when the current snapshot carries it exactly once. */
const copyCommand = async ($: Engine, data: unknown, surface: Parameters<Engine["ui"]["copy"]>[0]["surface"]): Promise<void> => {
  const raw = copyTarget((await read($, runBoard)).snapshot, (data as { copy?: unknown } | null)?.copy);
  if (raw !== undefined) await $.ui.copy({ text: raw, ...(surface ? { surface } : {}) });
};

export const register: Register = (on, options) => {
  const marks = String(options?.marks ?? "").trim() === "devicons" ? "devicons" : "glyph";
  const args = boardArgs(options);
  let controller: Controller | undefined;
  /**
   * Row 395 (D-2187 add.23): bumped by every session.start and every session.end. A start whose registration or seat
   * guard is still pending when its session ends or is replaced finds its number stale and never starts the board.
   */
  let generation = 0;

  on("session.start", async ($, e, next) => {
    const mine = ++generation;
    await $.command.register({ name: "tickmarkr-board", description: "Show the tickmarkr run board" });
    if (mine !== generation) return next(e);
    const started = controller = boardController(deps($, args));
    // Row 395 (D-2187 add.23): a tickmarkr seat (a nonblank TICKMARKR_SEAT) or a task worktree (a cwd under
    // `.tickmarkr/worktrees.noindex/`, src/run/git.ts WORKTREES_DIR) starts as not interactive — no autoload, so no
    // pane cuts a worker's result trailer. The /tickmarkr-board command below opens the board by hand as before.
    // The host awaits session.start before the first prompt, so neither the guard nor the first read holds it up (row 338).
    void (async () => {
      const seat = ((await $.env.get("TICKMARKR_SEAT")) ?? "").trim() !== "";
      const worktree = (await $.session.cwd()).includes("/.tickmarkr/worktrees.noindex/");
      // ended or replaced while the guard read: the controller's own session check cannot see an end that came first
      if (mine !== generation) return;
      await started.start(e.isInteractive && !seat && !worktree);
    })().catch(() => undefined);
    return next(e);
  });

  on("session.end", async ($, e, next) => {
    generation += 1;
    controller?.end();
    return next(e);
  });

  on("command.run", { command: "tickmarkr-board" }, async $ => {
    (controller ??= boardController(deps($, args)));
    await controller.command();
    return { text: "Tickmarkr board opened." };
  });

  on("ui.message", async ($, e, next) => {
    if (e.element !== "board") return next(e);
    await copyCommand($, e.data, e.surface);
    return {};
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const drawn = view(await read($, runBoard), marks, e.surface === "desktop" ? 1.5 : undefined);
    const elements = $.ui.resolve(e);
    if ("text" in drawn) return <elements.Text color="subtle">{drawn.text}</elements.Text>;
    if (e.surface === "terminal" || e.surface === "desktop") {
      const { Client } = $.ui.resolve(e);
      return <Client key="board" module="./board.tsx" props={drawn.props} width="100%" />;
    }
    // the still fallback: the board module drawn once against a fixed surface, its Copy posts routed back here
    const still: ClientSurface<never> = {
      elements: elements as unknown as ClientElements, state: undefined, setState: () => {},
      columns: 100, rows: 0, every: () => () => {}, onPointer: () => () => {}, onKey: () => () => {},
      post: data => { void copyCommand($, data, e.surface); },
    };
    return Board(drawn.props as never, still as never);
  });
};
