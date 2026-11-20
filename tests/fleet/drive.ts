// Driving the screen in tests: a frame as rows of text, and a state reached by pressing keys.
import { frame, homeTargets, initialScreen, press, type ScreenSource, type ScreenState } from "../../src/fleet/screen.js";

export const text = (src: ScreenSource, st = initialScreen(), cols = 80, rows = 24) => frame(src, st, cols, rows).map((l) => l.map((s) => s.text).join(""));
export const keys = (src: ScreenSource, ...ks: string[]) => ks.reduce((st, k) => press(src, st, k).state, initialScreen());
export const keysFrom = (src: ScreenSource, from: ReturnType<typeof initialScreen>, ...ks: string[]) => ks.reduce((st, k) => press(src, st, k).state, from);
/** The one cursor moved with up and down to the first place `is` names (row 499: one list, no second list of lines). */
export function moveTo(src: ScreenSource, is: (target: string) => boolean, from: ScreenState = initialScreen()): ScreenState {
  const ts = homeTargets(src, from), to = ts.findIndex(is);
  if (to < 0) throw new Error(`no place of the cursor: ${ts.join(" | ")}`);
  const at = Math.min(from.sel, ts.length - 1);
  return keysFrom(src, from, ...Array<string>(Math.abs(to - at)).fill(to > at ? "down" : "up"));
}
/** The cursor on the n-th item (from 0). */
export const toItem = (src: ScreenSource, n: number, from: ScreenState = initialScreen()): ScreenState => {
  const ids = homeTargets(src, from).filter((t) => t.startsWith("item:"));
  return moveTo(src, (t) => t === ids[n], from);
};
/** A line opened with Enter from the one screen: its row (a row of several shapes asks which first), its KEPT OUT row, or + for a list with no rule. */
export function open(src: ScreenSource, id: string, from: ScreenState = initialScreen()): ScreenState {
  const ts = homeTargets(src, from);
  const target = ts.find((t) => t.startsWith("shapes:") && t.slice(7).split(",").includes(id)) ?? ts.find((t) => t === `kept:routing.${id}`) ?? (ts.includes(id) ? id : "kept+");
  const st = press(src, moveTo(src, (t) => t === target, from), "enter").state;
  return st.choose ? keysFrom(src, st, ...Array<string>(st.choose.ids.indexOf(id)).fill("down"), "enter") : st;
}
/** The down arrows a real terminal sends to bring the cursor from the mode to the first place `is` names (the mounts' test terminal is 100 by 30). */
export function arrowsTo(src: ScreenSource, is: (target: string) => boolean, size = { cols: 100, rows: 30 }): string {
  const to = homeTargets(src, initialScreen(), size).findIndex(is);
  if (to < 0) throw new Error("no place of the cursor");
  return "\x1b[B".repeat(to);
}
