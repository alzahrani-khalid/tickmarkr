// The Ink mount of the fleet screen. It owns nothing but the keyboard and the terminal: every frame
// and every transition comes from src/fleet/screen.ts.
import { render, Text, useApp, useInput } from "ink";
import { useRef, useState } from "react";
import { needSignature } from "../../fleet/load.js";
import type { Need } from "../../fleet/needs.js";
import { derive, frame, initialScreen, press, type ScreenAction, type ScreenSource, type ScreenState, type Seg, type Style } from "../../fleet/screen.js";
import { enterAltScreen, INK, inkInput, inkOutput } from "./frame.js";

export type FleetScreenExit = Exclude<ScreenAction, { kind: "dismiss" | "restore" }>;
export interface FleetScreenProps {
  source: ScreenSource;
  /** one line shown on the first frame: what the last probe or save did */
  note?: string;
  /** the state to open on: what was answered and changed before a probe, still unsaved */
  resume?: ScreenState;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  onDismiss?: (need: Pick<Need, "id" | "title" | "ask">) => void;
  /** `u` after a no: forget that no (by the signature it was remembered by) */
  onRestore?: (signature: string) => void;
}

const STYLE: Record<Style, { bold?: boolean; dimColor?: boolean; color?: string; inverse?: boolean }> = {
  bold: { bold: true }, dim: { dimColor: true }, head: { bold: true, dimColor: true }, key: { inverse: true },
  ok: { color: INK.brand }, warn: { color: INK.warn }, fail: { color: INK.fail }, accent: { color: INK.brandBright },
};
const Cell = ({ seg }: { seg: Seg }) => <Text {...(seg.style ? STYLE[seg.style] : {})}>{seg.text}</Text>;

/** Runs a write that remembers an answer; false when it failed. */
const remembered = (write: () => void): boolean => { try { write(); return true; } catch { return false; } };

type InkKey = { upArrow: boolean; downArrow: boolean; return: boolean; escape: boolean };
/** The key names in one input event: one for a single key, several when a chunk carried more. */
export function keysOf(input: string, key: InkKey): string[] {
  if (key.upArrow) return ["up"];
  if (key.downArrow) return ["down"];
  if (key.return) return ["enter"];
  if (key.escape && input.length <= 1) return ["esc"];
  return (input.match(/\x1b?\[[AB]|\r|\n|\x1b|[\s\S]/g) ?? [])
    .map((t) => (/\[A$/.test(t) && t.length > 1 ? "up" : /\[B$/.test(t) && t.length > 1 ? "down" : t === "\r" || t === "\n" ? "enter" : t === "\x1b" ? "esc" : t));
}

function FleetScreen({ source: first, note, resume, onDismiss, onRestore, columns, rows }: Omit<FleetScreenProps, "input" | "output"> & { columns: number; rows: number }) {
  const { exit } = useApp();
  // Keys can arrive faster than React renders (a paste, key repeat, a driver). Each key must act on
  // what the key before it left behind, so the live values sit in a ref and the state only redraws.
  const live = useRef<{ source: ScreenSource; state: ScreenState; leaving: boolean }>({ source: first, state: { ...(resume ?? initialScreen()), msg: note ?? "" }, leaving: false });
  const [, redraw] = useState(0);
  useInput((input, key) => {
    if (key.ctrl && input === "c") return exit({ kind: "quit", unsaved: 0 } satisfies FleetScreenExit);
    // Several keys can arrive as one chunk (fast typing, a driver, a paste). They are applied one
    // by one, in order. A chunk can never save: the review's y must arrive on its own.
    const names = keysOf(input, key);
    try { apply(names); } catch (e) { exit(e instanceof Error ? e : new Error(String(e))); }
  });
  // An error in here is a defect, and it still must not strand the terminal: it leaves through Ink's
  // exit above, so the alternate screen and raw mode are undone before the command reports it.
  const apply = (names: string[]): void => {
    for (const name of names) {
      const { source, state, leaving } = live.current;
      const { state: next, action } = press(source, state, name, { cols: columns, rows });
      if (action?.kind === "quit" && action.unsaved && !leaving) {
        live.current = { source, leaving: true, state: { ...next, msg: `${action.unsaved} ${action.unsaved === 1 ? "change is" : "changes are"} not saved. q again quits without saving; Enter reviews.` } };
      } else if (action?.kind === "dismiss") {
        const need = derive(source, state).items.find((n) => n.id === action.id);
        // The answer holds for this screen whatever happens to the file that remembers it. A write
        // that fails is said in one line; it must never throw out of a key press.
        const kept = need ? remembered(() => onDismiss?.(need)) : true;
        live.current = { leaving: false, state: kept ? next : { ...next, msg: "Left as it is for now. The answer could not be written down, so it will be asked again next time." },
          source: need ? { ...source, ctx: { ...source.ctx, dismissed: new Set([...(source.ctx.dismissed ?? []), needSignature(need)]) } } : source };
      } else if (action?.kind === "restore") {
        const kept = remembered(() => onRestore?.(action.signature));
        live.current = { leaving: false, state: kept ? next : { ...next, msg: "Asked again for now. The change could not be written down." },
          source: { ...source, ctx: { ...source.ctx, dismissed: new Set([...(source.ctx.dismissed ?? [])].filter((s) => s !== action.signature)) } } };
      } else if (action?.kind === "save" && names.length > 1) {
        live.current = { source, leaving: false, state: { ...state, msg: "Press y to save." } };
        break;
      } else if (action) {
        return exit(action);
      } else {
        live.current = { source, state: next, leaving: false };
      }
    }
    if (names.length) redraw((n) => n + 1);
  };
  const { source, state } = live.current;
  return <>{frame(source, state, columns, rows).map((line, i) => <Text key={i} wrap="truncate">{line.map((seg, j) => <Cell key={j} seg={seg} />)}</Text>)}</>;
}

/** Runs the screen until the user quits, asks for a probe, or saves; the caller does that and may reopen. */
export async function runFleetScreen({ source, note, resume, input, output, onDismiss, onRestore }: FleetScreenProps): Promise<FleetScreenExit> {
  const bridged = inkInput(input, []);
  const legacy = typeof output.on !== "function" || typeof output.off !== "function";
  const leaveAltScreen = enterAltScreen(output);
  const element = () => <FleetScreen source={source} note={note} resume={resume} onDismiss={onDismiss} onRestore={onRestore} columns={Math.max(40, output.columns ?? 80)} rows={Math.max(12, output.rows ?? 24)} />;
  const app = render(element(), { stdin: bridged.stream, stdout: inkOutput(output), exitOnCtrlC: false, patchConsole: false, debug: legacy });
  const onResize = () => app.rerender(element());
  if (!legacy) output.on("resize", onResize);
  try {
    return (await app.waitUntilExit() as FleetScreenExit | undefined) ?? { kind: "quit", unsaved: 0 };
  } finally {
    if (!legacy) output.off("resize", onResize);
    app.unmount();
    bridged.stop();
    leaveAltScreen();
  }
}
