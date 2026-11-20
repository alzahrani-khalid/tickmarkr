// The Ink mount of the fleet screen. It owns nothing but the keyboard and the terminal: every frame
// and every transition comes from src/fleet/screen.ts.
import { render, Text, useApp } from "ink";
import { useRef, useState } from "react";
import { needSignature } from "../../fleet/load.js";
import type { Need } from "../../fleet/needs.js";
import { tiny } from "../../fleet/one-screen.js";
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

type Size = { cols: number; rows: number };
interface PresentedFrame extends Size { source: ScreenSource; state: ScreenState; leaving: boolean }
interface Presentation { rendering?: PresentedFrame; shown?: PresentedFrame; keys?: (chunk: string) => void }

/**
 * The key names in one raw chunk, read from the bytes before any parser splits or strips them
 * (row 499; D-2187 add.400). A key acts only bare: a chunk holding a control byte (Ctrl+letter, Tab,
 * DEL, NUL) does nothing at all, Ctrl+C, Tab and Backspace (DEL or BS) each ALONE in their chunk
 * excepted ("ctrl-c", "tab", "backspace": the models view's keys, row 498; D-2187 add.363). The arrows
 * are up, down, left and right, PgUp and PgDn are "pgup" and "pgdown"; any other Esc, alone or leading a sequence (Alt+key, an unknown CSI or
 * SS3, a paste bracket), is Esc alone and everything after it in the chunk is dropped. Typed characters
 * pass as themselves: the models view searches with them.
 */
export function keysOf(chunk: string): string[] {
  if (chunk === "\x03") return ["ctrl-c"];
  if (chunk === "\t") return ["tab"];
  if (chunk === "\x7f" || chunk === "\b") return ["backspace"];
  if (/[\x00-\x09\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/.test(chunk)) return [];
  const names: string[] = [];
  for (const t of chunk.match(/\x1b\[[56]~|\x1b[[O][ABCD]|[\s\S]/gu) ?? []) {
    // PgUp and PgDn scroll the models view's notes and legend (row 498; D-2187 add.408)
    if (t.length === 4) names.push(t[2] === "5" ? "pgup" : "pgdown");
    else if (t.length === 3) names.push(({ A: "up", B: "down", C: "right", D: "left" } as Record<string, string>)[t[2]]);
    else if (t === "\x1b") return [...names, "esc"];
    else names.push(t === "\r" || t === "\n" ? "enter" : t);
  }
  return names;
}

function FleetScreen({ source: first, note, resume, onDismiss, onRestore, columns, rows, size, presentation }: Omit<FleetScreenProps, "input" | "output"> & { columns: number; rows: number; size: () => Size; presentation: Presentation }) {
  const { exit } = useApp();
  // Keys can arrive faster than React renders (a paste, key repeat, a driver). Each key must act on
  // what the key before it left behind, so the live values sit in a ref and the state only redraws.
  const live = useRef<{ source: ScreenSource; state: ScreenState; leaving: boolean }>({ source: first, state: { ...(resume ?? initialScreen()), msg: note ?? "" }, leaving: false });
  // A question cannot remain pending behind the small-window sentence (row 499; D-2187 add.397).
  if (tiny(columns, rows) && live.current.leaving) live.current = { ...live.current, leaving: false, state: { ...live.current.state, msg: "" } };
  const [, redraw] = useState(0);
  // Every raw chunk of the keyboard comes here, bypassing Ink's input parser (D-2187 add.400).
  presentation.keys = (chunk: string) => {
    const names = keysOf(chunk);
    // Ctrl+C quits as q does (its visible confirmation and unsaved count, as today), passed as its own key so the
    // models view, where q searches, still quits on it (row 498; D-2187 add.408); nothing on the small window's frame
    if (names[0] === "ctrl-c") {
      const shown = presentation.shown;
      if (!shown || tiny(shown.cols, shown.rows)) return;
    }
    // Several keys can arrive as one chunk (fast typing, a driver, a paste). They are applied one
    // by one, in order. A chunk can never save: the save's Enter must arrive on its own (5.7; row 499 (h); D-2187 add.363).
    try { apply(names); } catch (e) { exit(e instanceof Error ? e : new Error(String(e))); }
  };
  // An error in here is a defect, and it still must not strand the terminal: it leaves through Ink's
  // exit above, so the alternate screen and raw mode are undone before the command reports it.
  const apply = (names: string[]): void => {
    for (const name of names) {
      const { source, state, leaving } = live.current;
      const currentSize = size(), shown = presentation.shown;
      // The frame on screen decides, never a size or a state not yet drawn (D-2187 add.400).
      if (!shown) continue;
      // The small window's frame says only "q quit": q quits at once, reporting what is unsaved; nothing else acts.
      if (tiny(shown.cols, shown.rows)) {
        if (name === "q") return exit(press(source, state, "q", shown).action!);
        continue;
      }
      // Between a resize and its repaint no key acts: the frame shown is not the window's any more.
      if (shown.cols !== currentSize.cols || shown.rows !== currentSize.rows) continue;
      const visible = shown.state === state && shown.source === source;
      const { state: next, action } = press(source, state, name, currentSize);
      if (action?.kind === "quit" && action.unsaved) {
        if (leaving && visible && shown.leaving) return exit(action);
        // Close every view/chooser first, so the question and its s action are both available.
        // A repeated q before this frame is drawn cannot confirm an unseen question (add.397).
        if (!leaving) live.current = { source, leaving: true, state: { ...next, view: "home", choose: null, pick: null, item: null, scroll: 0,
          msg: `${action.unsaved} ${action.unsaved === 1 ? "change is" : "changes are"} not saved. q again quits without saving; s reviews.` } };
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
      } else if (action?.kind === "save" && (names.length > 1 || !visible)) {
        live.current = { source, leaving: false, state: { ...state, msg: "Press Enter to save." } };
        break;
      } else if (action) {
        return exit(action);
      } else {
        live.current = { source, state: next, leaving: false };
      }
    }
    if (names.length) redraw((n) => n + 1);
  };
  const { source, state, leaving } = live.current;
  // Ink's onRender acknowledges this frame, not the newer live state that fast keys may have made.
  presentation.rendering = { source, state, leaving, cols: columns, rows };
  return <>{frame(source, state, columns, rows).map((line, i) => <Text key={i} wrap="truncate">{line.map((seg, j) => <Cell key={j} seg={seg} />)}</Text>)}</>;
}

/** Runs the screen until the user quits, asks for a probe, or saves; the caller does that and may reopen. */
export async function runFleetScreen({ source, note, resume, input, output, onDismiss, onRestore }: FleetScreenProps): Promise<FleetScreenExit> {
  const bridged = inkInput(input, []);
  const legacy = typeof output.on !== "function" || typeof output.off !== "function";
  const leaveAltScreen = enterAltScreen(output);
  const presentation: Presentation = {};
  const size = (): Size => ({ cols: output.columns ?? 80, rows: output.rows ?? 24 });
  // the terminal's real size, never rounded up: below 80 by 20 the one screen asks for a larger window (row 499; D-2187 add.363)
  const element = () => <FleetScreen source={source} note={note} resume={resume} onDismiss={onDismiss} onRestore={onRestore} columns={size().cols} rows={size().rows} size={size} presentation={presentation} />;
  const app = render(element(), { stdin: bridged.stream, stdout: inkOutput(output), exitOnCtrlC: false, patchConsole: false, debug: legacy,
    onRender: () => { presentation.shown = presentation.rendering; } });
  const onResize = () => app.rerender(element());
  if (!legacy) output.on("resize", onResize);
  // The screen reads the raw chunks itself; Ink never parses them (D-2187 add.400).
  const onData = (chunk: string | Buffer) => presentation.keys?.(String(chunk));
  bridged.stream.setRawMode?.(true);
  bridged.stream.on("data", onData);
  try {
    return (await app.waitUntilExit() as FleetScreenExit | undefined) ?? { kind: "quit", unsaved: 0 };
  } finally {
    if (!legacy) output.off("resize", onResize);
    bridged.stream.off("data", onData);
    bridged.stream.setRawMode?.(false);
    app.unmount();
    bridged.stop();
    leaveAltScreen();
  }
}
