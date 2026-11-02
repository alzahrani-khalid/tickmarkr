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

  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "tickmarkr-board", description: "Show the tickmarkr run board" });
    controller = boardController(deps($, args));
    // the host awaits session.start before the first prompt, so the first read never holds it up (queue row 338)
    void controller.start(e.isInteractive).catch(() => undefined);
    return next(e);
  });

  on("session.end", async ($, e, next) => {
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
