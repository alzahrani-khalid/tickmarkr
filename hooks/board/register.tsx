import { atom, read, update } from "claude-code";
import type { ClientElements, ClientSurface, EngineInterface, Register } from "claude-code";
import Board from "./board";
import { copyAllowed, headline, needsYou, readState } from "./model";
import type { BoardState } from "./state";

const PANE = "tickmarkr-board";
const board = atom({ plugin: "tickmarkr", key: "board" } as const, { error: "waiting for the first status read" });
let inFlight: Promise<void> | undefined;
let cancelPoll: (() => void) | undefined;

/** The engine's sole run read. Share an in-flight read between the timer and command. */
function refresh($: EngineInterface): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let state: BoardState;
    try {
      const cwd = await $.session.cwd();
      state = readState(await $.process.run(["tickmarkr", "status", "--json"], { cwd, timeoutMs: 20000 }));
    } catch (rejected) {
      state = readState({ rejected });
    }
    await update($, board, () => state);
    const label = headline(state).word;
    const parks = needsYou(state);
    const detail = "snapshot" in state
      ? ` · ${state.snapshot.tasks.filter(task => task.state === "merged").length}/${state.snapshot.tasks.length} merged` : "";
    $.ui.status(`tickmarkr · ${label}${detail}${parks.length ? ` · NEEDS YOU ${parks.map(park => park.task).join(", ")}` : ""}`);
  })().finally(() => { inFlight = undefined; });
  return inFlight;
}

async function copyCommand($: EngineInterface, data: unknown, surface: Parameters<EngineInterface["ui"]["copy"]>[0]["surface"]): Promise<void> {
  const command = (data as { copy?: unknown } | null)?.copy;
  if (typeof command === "string" && copyAllowed(await read($, board), command)) {
    await $.ui.copy({ text: command, ...(surface ? { surface } : {}) });
  }
}

export const register: Register = on => {
  // queue row 280: a session only registers the command; the status poll and status line start when the board opens.
  on("session.start", async ($, e, next) => {
    await $.command.register({ name: "tickmarkr-board", description: "Show the tickmarkr run board" });
    return next(e);
  });

  on("session.end", async ($, e, next) => {
    cancelPoll?.();
    cancelPoll = undefined;
    return next(e);
  });

  on("command.run", { command: "tickmarkr-board" }, async $ => {
    cancelPoll ??= $.clock.every(5000, () => { void refresh($); }).cancel;
    await refresh($);
    await $.ui.open({ id: PANE, title: "tickmarkr run" });
    return { text: "Tickmarkr board opened." };
  });

  on("ui.message", async ($, e, next) => {
    if (e.element !== "board") return next(e);
    await copyCommand($, e.data, e.surface);
    return {};
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e);
    const props = { state: await read($, board), now: await $.clock.now(), fit: e.surface === "desktop" ? 1.3 : 1 };
    if (e.surface === "terminal" || e.surface === "desktop") {
      const { Client } = $.ui.resolve(e);
      return <Client key="board" module="./board.tsx" props={props} width="100%" />;
    }
    const still: ClientSurface<never> = {
      elements: elements as unknown as ClientElements, state: undefined, setState: () => {},
      columns: 100, rows: 0, every: () => () => {}, onPointer: () => () => {}, onKey: () => () => {},
      post: data => { void copyCommand($, data, e.surface); },
    };
    return Board(props as never, still as never);
  });
};
