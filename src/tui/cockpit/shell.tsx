import { Box, Text, type DOMElement } from "ink";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ShellPresentation, ShellTheme } from "./components.js";
import { planShell, type ShellPlan } from "./layout.js";
import { SHELL_BINDINGS, shellBindings } from "./keys.js";
import { SHELL_PALETTE, SHELL_REDUCED_PALETTE } from "./theme.js";
import { fitCells } from "./width.js";
import type { LiveStoreSnapshot } from "./live-store.js";

export type ShellView = "home" | "run" | "evidence";
export type ShellFocus = ShellPlan["focus"][number];
export interface ShellState {
  view: ShellView; focus: ShellFocus; scroll: number; help: boolean;
  evidenceSection?: number; canOpen?: boolean;
  shortcutColumns?: number; canResize?: boolean;
  editorKind?: "filter" | "export";
  editor?: string; query: string; overlay?: readonly string[]; overlayOffset: number;
  quit: boolean; staged: readonly string[]; reviewing: boolean;
}
export const initialShellState = (): ShellState => ({ view: "home", focus: "content", scroll: 0, help: false, query: "", overlayOffset: 0, quit: false, staged: [], reviewing: false });
export const shellHelp = (bindings: readonly (typeof SHELL_BINDINGS)[number][] = SHELL_BINDINGS) => [
  ...bindings.map(b => `${b.key} ${b.label}`),
  "Shift-Tab reverses focus; folded regions are skipped.",
  "Esc closes deepest overlay; it never quits.",
  "Text: q1? is literal; Enter applies; Esc cancels.",
  "Confirm: y alone confirms; n/Esc cancels.",
  "Tab now moves focus; view numbers are 1/4/5.",
  "Fleet: tickmarkr fleet", "Plan: tickmarkr plan", "Health: tickmarkr doctor",
];

export interface ShellPaintRow { evidenceId?: string; text: string; column: number; row: number; columns: number; rows: number }
export type ShellCommit = ShellPlan & { paintedRows: readonly ShellPaintRow[]; contentRows: number; scroll: number };

/** Read the Yoga geometry that actually painted, including clipped/scrolled leaves.
 * Targets are resolved from these rows, never from guessed header offsets. */
function paintedRows(root: DOMElement): ShellPaintRow[] {
  const result: ShellPaintRow[] = [];
  const textOf = (node: DOMElement["childNodes"][number]): string => node.nodeName === "#text"
    ? node.nodeValue : node.childNodes.map(textOf).join("");
  const visit = (node: DOMElement, x: number, y: number, inheritedEvidence?: string) => {
    if (node.style.display === "none") return;
    const evidenceId = typeof node.attributes.shellEvidence === "string" ? node.attributes.shellEvidence : inheritedEvidence;
    const column = x + (node.yogaNode?.getComputedLeft() ?? 0);
    const row = y + (node.yogaNode?.getComputedTop() ?? 0);
    if (node.nodeName === "ink-text") result.push({ evidenceId, text: textOf(node), column, row,
      columns: node.yogaNode?.getComputedWidth() ?? 0, rows: node.yogaNode?.getComputedHeight() ?? 0 });
    else for (const child of node.childNodes) if (child.nodeName !== "#text") visit(child, column, row, evidenceId);
  };
  visit(root, 0, 0);
  return result;
}

/** Chrome remains outside the clipped, paged leaf at every measured size. */
export function CockpitShell({ snapshot, state, columns, rows, version, children, onCommit, colour = "truecolor" }: {
  snapshot: LiveStoreSnapshot; state: ShellState; columns: number; rows: number; version: string;
  children: ReactNode; onCommit?: (plan: ShellCommit) => void; colour?: "truecolor" | "reduced" | "none";
}) {
  const plan = planShell(columns, rows, state.shortcutColumns);
  const root = useRef<DOMElement>(null);
  const leaf = useRef<DOMElement>(null);
  const [contentRows, setContentRows] = useState(0);
  const scroll = Math.min(state.scroll, Math.max(0, contentRows - plan.bodyRows));
  useLayoutEffect(() => {
    const measured = Math.ceil(leaf.current?.yogaNode?.getComputedHeight() ?? 0);
    if (!state.overlay && !state.help && state.editor === undefined) setContentRows(measured);
    if (plan.refused) onCommit?.({ ...plan, paintedRows: [], contentRows: 0, scroll: 0 });
    else if (root.current) onCommit?.({ ...plan, paintedRows: paintedRows(root.current), contentRows: overlay?.length ?? measured, scroll: displayOffset });
  });
  const palette = colour === "reduced" ? SHELL_REDUCED_PALETTE : SHELL_PALETTE;
  const ink = (color: string) => colour === "none" ? undefined : color;
  const line = (text: string, width = columns, color: string = palette.text) => <Text color={ink(color)} wrap="truncate-end">{fitCells(text.replace(/[\x00-\x1f\x7f]/g, " "), width)}</Text>;
  if (plan.refused) return <Box flexDirection="column" width={columns} backgroundColor={ink(palette.surface)}>{line("Need at least 40x14; resize or q Quit")}{line("q Quit | Ctrl-C Quit")}</Box>;
  const op = snapshot.operator;
  const bindings = shellBindings(state);
  const overlay = state.editor !== undefined ? [`${state.editorKind === "export" ? "Export destination" : "Filter"}: ${state.editor}`, "Enter Apply | Esc Cancel"] : state.overlay ?? (state.help ? shellHelp(bindings) : undefined);
  const totalRows = overlay?.length ?? contentRows;
  const displayOffset = overlay ? Math.min(state.overlayOffset, Math.max(0, totalRows - plan.bodyRows)) : scroll;
  const position = `${totalRows ? displayOffset + 1 : 0}–${Math.min(totalRows, displayOffset + plan.bodyRows)}/${totalRows} | ${Math.max(0, totalRows - plan.bodyRows)} hidden`;
  const keybar = bindings.filter(b => ["focus", "open", "actions", "help", "quit"].includes(b.action) && (columns >= 60 || b.action !== "focus")).map(b => `${b.key} ${columns < 60 && b.action === "actions" ? "Act" : b.label}`).join(" | ");
  const status = columns < 60 ? `${op.label} | tip ${op.currentTip.toUpperCase()}` : `${op.label} | MERGED ${op.merged}/${op.planned ?? "?"} | CURRENT TIP ${op.currentTip.toUpperCase()} | ${snapshot.freshness}`;
  return <ShellPresentation.Provider value={true}>
    <ShellTheme.Provider value={{ mode: colour, palette }}>
    <Box ref={root} flexDirection="column" width={columns} height={rows} flexShrink={0} backgroundColor={ink(palette.surface)}>
      {line(`tickmarkr ${version} | ${state.view.toUpperCase()} | ${snapshot.journal.source.split("/").at(-2) ?? "run identity unknown"}`)}
      {line(columns < 60
        ? `1H 4R 5E | ${position}`
        : `1 Home  4 Run  5 Evidence | ${state.focus} | ${position}`)}
      {line("─".repeat(columns), columns, palette.chrome)}
      <Box height={plan.bodyRows} flexShrink={0} flexDirection="row" overflow="hidden">
        {<Box width={1} flexDirection="column">{Array.from({ length: plan.bodyRows }, (_, i) => <Text key={i} color={ink(palette.chrome)}>│</Text>)}</Box>}
        {plan.rail > 0 && <><Box width={plan.rail} flexDirection="column">{["1 Home", "4 Run", "5 Evidence", "", "CLI:", "fleet", "plan", "doctor"].map((t, i) => <Text key={i} color={ink(palette.chrome)}>{fitCells(t, plan.rail)}</Text>)}</Box>{<Box width={1} flexDirection="column">{Array.from({ length: plan.bodyRows }, (_, i) => <Text key={i} color={ink(palette.chrome)}>│</Text>)}</Box>}</>}
        <Box width={plan.bodyColumns} height={plan.bodyRows} flexDirection="column" overflow="hidden" flexShrink={0}>
          {overlay?.slice(displayOffset, displayOffset + plan.bodyRows).map((t, i) => <Text key={i} wrap="truncate-end" color={ink(palette.text)}>{fitCells(t, plan.bodyColumns)}</Text>)}
          <Box ref={leaf} display={overlay ? "none" : "flex"} flexDirection="column" flexShrink={0} marginTop={-scroll}>{children}</Box>
        </Box>
        {plan.shortcuts > 0 && <>{<Box width={1} flexDirection="column">{Array.from({ length: plan.bodyRows }, (_, i) => <Text key={i} color={ink(palette.chrome)}>│</Text>)}</Box>}<Box width={plan.shortcuts} flexDirection="column">{bindings.map(b => <Text key={b.key} color={ink(palette.chrome)} wrap="truncate-end">{fitCells(`${b.key} ${b.label}`, plan.shortcuts)}</Text>)}</Box></>}
        {<Box width={1} flexDirection="column">{Array.from({ length: plan.bodyRows }, (_, i) => <Text key={i} color={ink(palette.chrome)}>│</Text>)}</Box>}
      </Box>
      {line("─".repeat(columns), columns, palette.chrome)}
      {line(status)}
      {line(keybar)}
      {line("─".repeat(columns), columns, palette.chrome)}
    </Box>
    </ShellTheme.Provider>
  </ShellPresentation.Provider>;
}
