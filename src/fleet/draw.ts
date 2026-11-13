// How the fleet screen draws: styled segments, measured in terminal cells, cut and wrapped without
// ever breaking a cluster, and never carrying a control character from outside text to the terminal.
import { cellWidth, sliceCells } from "../tui/cockpit/width.js";

export type Style = "bold" | "dim" | "ok" | "warn" | "fail" | "accent" | "key" | "head";
export interface Seg { text: string; style?: Style; selected?: boolean }
export type Line = Seg[];
// Text from outside (a probe's own words, a config comment, a model id a CLI listed) never reaches
// the terminal with its control characters: an escape sequence in it could repaint the screen, and a
// tab would be drawn wider than it is counted.
export const clean = (t: string): string => t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]/g, "").replace(/\t/g, "  ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
export const S = (text: string, style?: Style): Seg => (style ? { text: clean(text), style } : { text: clean(text) });
// Cells, not characters: a wide character takes two and a combining mark none (the cockpit's own measure).
export const width = cellWidth;
/** The longest head of `t` that fits `w` cells; never a cluster cut in half, never more than `w`. */
export const head = (t: string, w: number): string => { const cut = sliceCells(t, w); return cut.cells > w ? "" : cut.head; };
export const fit = (t: string, w: number): string => { const shown = width(t) > w ? `${head(t, Math.max(0, w - 1))}…` : t; return shown + " ".repeat(Math.max(0, w - width(shown))); };
/** Exactly w cells: the tail is cut with … or padded. */
export function clip(line: Line, w: number): Line {
  const out: Line = [];
  let used = 0;
  for (const seg of line) {
    if (used >= w) break;
    const n = width(seg.text);
    if (used + n <= w) { out.push(seg); used += n; continue; }
    const text = `${head(seg.text, w - used - 1)}…`;
    out.push({ ...seg, text });
    used += width(text);
    break;
  }
  if (used < w) out.push(S(" ".repeat(w - used)));
  return out;
}
export function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!cur) cur = word;
    else if (width(cur) + 1 + width(word) <= w) cur += ` ${word}`;
    else { out.push(cur); cur = word; }
    while (width(cur) > w) { const cut = sliceCells(cur, w); out.push(cut.head); cur = cut.tail; }
  }
  return [...out, cur];
}
export const fmt = (n: number): string => n.toLocaleString("en-US");
/** A share for a team line. A share that is not zero never reads as 0%: rounding must not turn "some" into "none". */
export const pct = (share: number): string => (share > 0 && share < 1 ? "<1%" : `${Math.round(share)}%`);

/** The window of a list that keeps the cursor in view: where it starts, for `room` rows. */
export const windowFrom = (at: number, total: number, room: number): number => Math.max(0, Math.min(at - room + 1, total - room));

export const cap = (t: string): string => (t ? t[0].toUpperCase() + t.slice(1) : t);
