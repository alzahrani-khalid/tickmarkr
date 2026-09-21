import { GATE_NAMES, type RunGraph } from "../../graph/schema.js";
import type { OperatorSnapshot, OperatorTask } from "../../run/operator-state.js";
import type { AttemptHarvest, TaskRow } from "./derive.js";
import { cellWidth, sliceCells } from "./width.js";

/* ------------------------------------------------------------------------ */
/* BD-1 — the approved task board (RULING-231-19 §2, OBS-965 add.2).         */
/*                                                                           */
/* A pure, Ink-free port of .overseer/design-prototypes/tasks-redesign.mjs.  */
/* Palette, glyphs and column arithmetic are the prototype's constants; the  */
/* two contract corrections are the declaration-order subtitle and the       */
/* four-bucket green run-ended header. Facts come from the fold's snapshot   */
/* and the graph the Run view already receives — never from the journal.     */
/* ------------------------------------------------------------------------ */

// The prototype closes every span with a full reset (ESC[0m). Inside Ink that reset would also drop
// the shell's own foreground and background for the rest of the row, so spans close with the default
// foreground/background codes instead — chalk re-opens the enclosing colour after each of them.
const E = "\x1b[", R = `${E}0m`, CLOSE = `${E}39m`;
const c = (n: number) => (s: string) => `${E}38;5;${n}m${s}${CLOSE}`;
const bgc = (f: number, b: number) => (s: string) => `${E}38;5;${f};48;5;${b}m${s}${E}39;49m`;
const boldc = (s: string) => `${E}1m${s}${E}22m`;
const plain = (s: string) => s;

/** The prototype's palette (tasks-redesign.mjs:24-30): xterm-256 indices, stated once. */
export const BOARD_PALETTE = { chrome: 238, mute: 243, body: 252, faint: 240, accent: 75, pass: 71, fail: 174, warn: 179, park: 140 } as const;

/** The seven gates, declaration order; every cell is exactly CELL columns wide. */
export const BOARD_GATES = GATE_NAMES;
export const BOARD_CELL = 3;
export const BOARD_AREA_W = 16;
export const BOARD_DEPS_W = 14;
export const BOARD_NOTE_RESERVE = 28;
export const BOARD_FIXED = 4 + 5 + BOARD_AREA_W + BOARD_DEPS_W + BOARD_CELL * BOARD_GATES.length + 2 + 5;
export const BOARD_EFFORT_BAR_MAX = 46;
/** The board's own key hints — only the ones the Run view handles; nothing advertised is inert. */
export const BOARD_KEYS = ["↑↓ move", "↵ task detail", "q quit"] as const;

/** Width band the Run view draws in (RULING-231-19 §2: ≥150 full · 110–149 note wraps · <110 stack). */
export type BoardBand = "full" | "wrap" | "stacked";
export const boardBand = (columns: number): BoardBand => (columns >= 150 ? "full" : columns >= 110 ? "wrap" : "stacked");

export const stripBoardAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const vw = (s: string): number => cellWidth(stripBoardAnsi(s));
const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - vw(s)));
/** ANSI-aware clip at `n` visible cells (prototype `clip`), cut on a grapheme boundary so a
 * double-cell glyph never crosses the limit and an emoji is never emitted as a lone surrogate;
 * a clipped line closes its own colour. */
export function clipBoard(s: string, n: number): string {
  const { head, tail } = sliceCells(s, n);
  return tail && head.includes("\x1b") ? `${head}${R}` : head;
}

// ── AREA — derived from files[], never declared (prototype :48-94) ────────────────────────────────
const AREAS: readonly (readonly [string, readonly RegExp[]])[] = [
  ["SPEC", [/^src\/(compile|graph|plan)\//]],
  ["FLEET", [/^src\/(route|config|adapters)\//]],
  ["RUN", [/^src\/(run|drivers|eval)\//]],
  ["GATE", [/^src\/gates\//]],
  ["UI", [/^src\/(cli|tui|report)\//, /^src\/brand\.ts/]],
  ["DOCS", [/^(docs|skills)\//]],
  ["REPO", [/^(scripts|schema)\//, /^\.github\//, /^tests\/(lint|repo|helpers)\//, /^(vitest\.config|package\.json|tsconfig)/]],
];
export const BOARD_AREA_ORDER = AREAS.map(([n]) => n);
const expandBraces = (p: string): string[] => {
  const m = /^(.*?)\{([^}]*)\}(.*)$/.exec(p);
  return m ? m[2]!.split(",").flatMap((alt) => expandBraces(`${m[1]}${alt.trim()}${m[3]}`)) : [p];
};
const areaOf = (path: string): string | null => {
  for (const [name, res] of AREAS) if (res.some((re) => re.test(path))) return name;
  return null;
};
/** {codes, unmapped} — abstentions applied, set semantics, misses reported rather than dropped. */
export function areasFor(files: readonly string[]): { codes: string[]; unmapped: string[] } {
  const unmapped: string[] = [];
  const hit = new Set<string>(), softTest = new Set<string>(), softCli = new Set<string>();
  for (const f of files.flatMap(expandBraces)) {
    const a = areaOf(f) ?? areaOf(f.replace(/^tests\//, "src/"));
    if (!a) { unmapped.push(f); continue; }
    if (/^tests\//.test(f)) softTest.add(a);
    else if (/^src\/cli\//.test(f)) softCli.add(a);
    else hit.add(a);
  }
  let codes = [...hit];
  if (!codes.length) codes = [...softCli];
  if (!codes.length) codes = [...softTest];
  codes.sort((x, y) => BOARD_AREA_ORDER.indexOf(x) - BOARD_AREA_ORDER.indexOf(y));
  return { codes, unmapped };
}

const hm = (ms: number) => `${Math.floor(ms / 3.6e6)}h${String(Math.floor((ms % 3.6e6) / 6e4)).padStart(2, "0")}m`;
const ago = (ms: number) => (ms < 6e4 ? "just now" : ms < 3.6e6 ? `${Math.round(ms / 6e4)}m ago` : `${Math.round(ms / 3.6e6)}h ago`);

export interface BoardInput {
  readonly runId: string;
  readonly snapshot: OperatorSnapshot;
  readonly graph?: Pick<RunGraph, "tasks">;
  /** The clock the header's elapsed/ago fields read. */
  readonly now: number;
  /** A live daemon holds this run's lock. */
  readonly live?: boolean;
  /** The task the focus marker sits on; absent draws the prototype's plain indent. */
  readonly selection?: string;
  /** Footer key hints, joined the prototype's way; `false` leaves the footer to the caller (see boardFooter). */
  readonly keys?: readonly string[] | false;
  readonly colour?: boolean;
  /** The cockpit's derived rows: the shared projection (blocker, next action, harvest) rides on each board row, unrendered. */
  readonly rows?: readonly TaskRow[];
}

/** One task row, in the parts the Run view recomposes per width band. */
export interface BoardRow {
  readonly id: string;
  /** indent (or the focus marker) + id + area + deps + title */
  readonly head: string;
  /** the seven gate cells */
  readonly strip: string;
  /** channel + attempts */
  readonly tail: string;
  /** `◍ parked ×n · ↻ n review rounds · ✖ gate` / `waiting on …` / `in flight`, joined by ` · ` */
  readonly note: string;
  /** The note's segments, so a band can wrap it across continuation rows without cutting one. */
  readonly noteParts: readonly string[];
  /** From the shared projection (derive.ts TaskRow.summary), when the caller supplied rows. */
  readonly blocker?: string;
  readonly nextAction?: string;
  readonly permittedActions?: readonly string[];
  /** OBS-1048: the newest recorded attempt's harvest evidence, when the caller supplied rows. */
  readonly harvest?: AttemptHarvest;
}

export interface BoardFrame {
  /** Header through the gate header rule, in the prototype's order. */
  readonly top: readonly string[];
  readonly rows: readonly BoardRow[];
  /** Header row parts, aligned to the row parts. */
  readonly gateHeader: { readonly head: string; readonly strip: string; readonly tail: string };
  /** Legend, retired ids, rule, effort fold, footer. */
  readonly bottom: readonly string[];
  readonly width: number;
  readonly lbl: number;
  readonly chan: number;
}

const isDone = (t: OperatorTask | undefined): boolean => t !== undefined && (t.merged || t.state === "completed");

const projected = (row: TaskRow | undefined): Pick<BoardRow, "blocker" | "nextAction" | "permittedActions" | "harvest"> => {
  const blocker = row?.summary?.blocker;
  const harvest = row?.harvests?.at(-1);
  return {
    ...(blocker ? { blocker: blocker.kind, permittedActions: blocker.permittedActions } : {}),
    ...(blocker?.nextAction ? { nextAction: blocker.nextAction } : {}),
    ...(harvest ? { harvest } : {}),
  };
};

/** The prototype's frame, sectioned. `renderBoard` joins it row for row. */
export function boardFrame(input: BoardInput, width: number): BoardFrame {
  const W = Math.max(1, Math.floor(width));
  const col = input.colour === false ? () => plain : c;
  const bold = input.colour === false ? plain : boldc;
  const bg = input.colour === false ? () => plain : bgc;
  const chrome = col(BOARD_PALETTE.chrome), mute = col(BOARD_PALETTE.mute), body = col(BOARD_PALETTE.body), faint = col(BOARD_PALETTE.faint);
  const accent = col(BOARD_PALETTE.accent), pass = col(BOARD_PALETTE.pass), fail = col(BOARD_PALETTE.fail), warn = col(BOARD_PALETTE.warn), park = col(BOARD_PALETTE.park);
  const rule = (n = W) => chrome("─".repeat(n));

  const s = input.snapshot;
  const byId = new Map(s.tasks.map((t) => [t.id, t]));
  // The fold's comparability boundary: a graph whose identity the journal did not record (a
  // recompile) lends nothing — no titles, deps, declarations or denominator — so the rows are the
  // journal's tasks alone and every gate reads as declared.
  const graphTasks = input.graph?.tasks && s.comparable ? input.graph.tasks : s.tasks.map((t) => ({ id: t.id, title: t.title ?? "", deps: [] as string[], files: [] as string[], gates: undefined as readonly string[] | undefined }));
  const uncomparable = input.graph !== undefined && !s.comparable;
  const doneIds = new Set(s.tasks.filter(isDone).map((t) => t.id));
  const t0 = s.firstEventAt ? Date.parse(s.firstEventAt) : input.now;
  const t1 = s.lastEventAt ? Date.parse(s.lastEventAt) : input.now;
  const wide = W >= 118;

  const top: string[] = [];
  top.push(`${bg(16, 2)(" tickmarkr ")} ${bold(input.runId)}  ${chrome("│")}  ` +
    `${pass(`${doneIds.size}/${graphTasks.length} done`)}  ` +
    (wide
      ? `${chrome("│")}  ${warn(`${s.resumes} restarts`)}  ${chrome("│")}  ${fail(`${s.escalations} escalations`)}  `
      : `${chrome("│")}  ${fail(`${s.escalations} esc`)}  `) +
    `${chrome("│")}  ${mute(`${hm(t1 - t0)}${wide ? ` · ${ago(input.now - t1)}` : ""}`)}` +
    `${input.live ? `  ${chrome("│")}  ${pass("● LIVE")}` : ""}`);
  top.push("");
  // RUN ENDED — the four-bucket rule (RULING-231-19 §2): green needs failed, human, blocked and
  // pending every one empty AND the tip not failed; "tip verified" alone never borrows the colour.
  if (s.latestRunEnd) {
    const buckets = (["failed", "human", "blocked", "pending"] as const).map((k) => [k, s.buckets[k]] as const);
    const unknown = buckets.filter(([, v]) => v === undefined).map(([k]) => k);
    const parked = buckets.filter(([, v]) => v !== undefined && v.length > 0).map(([k, v]) => `${k} ${v!.join(",")}`);
    const tally = `${doneIds.size} merged · ${(s.buckets.human ?? []).length} parked · ${(s.buckets.blocked ?? []).length} dep-blocked`;
    const green = !unknown.length && !parked.length && (s.currentTip === "passed" || s.currentTip === "not required");
    const now = green
      ? `${pass("RUN ENDED — GREEN")}  ${mute(`tip ${s.currentTip} · ${tally}`)}`
      : s.currentTip === "failed"
      ? `${fail("RUN ENDED — TIP VERIFY FAILED")}  ${mute(tally)}`
      : parked.length || unknown.length
      ? `${fail("RUN ENDED — NOT GREEN")}  ${mute(`${[...parked, ...unknown.map((k) => `${k} bucket unknown`)].join(" · ")} · ${tally}`)}`
      : `${warn("RUN ENDED — TIP NOT VERIFIED")}  ${mute(`tip ${s.currentTip} · ${tally}`)}`;
    top.push(`  ${accent("▌")} ${bold("NOW")}        ${now}`);
    top.push("");
  }
  top.push(`  ${accent("▌")} ${bold("TASKS")}   ${mute(uncomparable ? `${doneIds.size} of ${graphTasks.length} journal tasks merged · graph not comparable` : `${doneIds.size} of ${graphTasks.length} merged in this graph`)}` +
    (wide ? mute(" · rows in dispatch order · gates left→right in declaration order") : ""));
  top.push("");

  // ── aligned gate header: each label truncated to the cell it owns (prototype :382-394) ──
  const elastic = Math.max(30, W - BOARD_FIXED - BOARD_NOTE_RESERVE);
  const LBL = Math.min(46, Math.max(18, Math.round(elastic * 0.62)));
  const CHAN = Math.min(26, Math.max(12, elastic - LBL));
  const gateHead = BOARD_GATES.map((g) => faint(pad(g.slice(0, BOARD_CELL - 1), BOARD_CELL))).join("");
  const gateHeader = {
    head: `    ${pad("", 5)}${pad(faint("area"), BOARD_AREA_W)}${pad(faint("deps"), BOARD_DEPS_W)}${pad(faint("task"), LBL)}`,
    strip: gateHead,
    tail: `  ${pad(faint("channel"), CHAN)}${pad(faint("att"), 5)}${faint("note")}`,
  };
  const headerRule = `    ${chrome("─".repeat(Math.min(W - 4, 5 + LBL + BOARD_CELL * BOARD_GATES.length + 2 + CHAN + 5 + 30)))}`;

  const areaTally = new Set<string>(), unmappedPaths = new Set<string>();
  const rows: BoardRow[] = [];
  for (const g of graphTasks) {
    const t = byId.get(g.id);
    const declared = new Set<string>(g.gates ?? BOARD_GATES);
    const cell = (k: string): true | false | undefined => {
      const st = t?.gates[k]?.state;
      return st === "passed" ? true : st === "failed" ? false : undefined;
    };
    const strip = BOARD_GATES.map((k) => {
      const v = cell(k);
      return pad(v === true ? pass("✔") : v === false ? fail("✖") : !declared.has(k) ? faint("─") : faint("·"), BOARD_CELL);
    }).join("");
    const unrun = BOARD_GATES.filter((k) => declared.has(k) && cell(k) === undefined).length;
    const failedGates = BOARD_GATES.filter((k) => cell(k) === false);
    const parks = t?.parks ?? 0, reviews = t?.reviewRounds ?? 0, attempts = t?.dispatches ?? 0;
    const hot = parks > 3 || failedGates.length > 0 || unrun > 2;
    const marker = input.selection === g.id ? `  ${accent("❯")} ` : "    ";
    const id = hot ? accent(bold(pad(g.id, 5))) : mute(pad(g.id, 5));
    const { codes: acodes, unmapped: aun } = areasFor(g.files ?? []);
    acodes.forEach((a) => areaTally.add(a));
    aun.forEach((u) => unmappedPaths.add(u));
    let alabel = acodes.length ? acodes.join("+") : (aun.length ? "UNMAPPED" : "—");
    if (alabel.length > BOARD_AREA_W - 2) {
      const keep: string[] = [];
      for (const a of acodes) { if ([...keep, a].join("+").length + 3 > BOARD_AREA_W - 2) break; keep.push(a); }
      alabel = `${keep.join("+")}+${acodes.length - keep.length}`;
    }
    const area = pad(hot ? body(alabel) : faint(alabel), BOARD_AREA_W);
    const depIds = g.deps ?? [];
    const depText = depIds.length ? depIds.join(",") : "—";
    const depLabel = depText.length <= BOARD_DEPS_W - 2
      ? depText
      : depIds.length > 1 ? `${depIds[0]}+${depIds.length - 1}` : `${depIds[0]!.slice(0, BOARD_DEPS_W - 3)}…`;
    const deps = pad(faint(depLabel), BOARD_DEPS_W);
    const titleText = sliceCells(g.title ?? "", LBL - 2).head;
    const title = hot ? body(pad(titleText, LBL)) : faint(pad(titleText, LBL));
    const note = [
      parks >= 3 ? park(`◍ parked ×${parks}`) : "",
      reviews > 2 ? warn(`↻ ${reviews} review rounds`) : "",
      failedGates.length ? fail(`✖ ${failedGates.join(",")}`) : "",
      !attempts
        ? (() => {
          const blockers = depIds.filter((d) => !doneIds.has(d));
          if (!blockers.length) return faint("queued");
          const room = Math.max(10, W - BOARD_FIXED - LBL - CHAN);
          let shown = blockers, dropped = 0;
          while (shown.length > 1 && `waiting on ${shown.join(", ")}`.length + (dropped ? 5 : 0) > room) {
            shown = shown.slice(0, -1); dropped = blockers.length - shown.length;
          }
          return faint(`waiting on ${shown.join(", ")}${dropped ? ` +${dropped}` : ""}`);
        })()
        : unrun === declared.size ? faint("in flight")
          : unrun > 2 ? faint(`${declared.size - unrun}/${declared.size} gates run`) : "",
    ].filter(Boolean);
    rows.push({
      id: g.id,
      head: `${marker}${id}${area}${deps}${title}`,
      strip,
      tail: `  ${pad(mute(sliceCells(t?.channel ?? "—", CHAN - 2).head), CHAN)}${pad(mute(String(attempts)), 5)}`,
      note: note.join(mute(" · ")),
      noteParts: note,
      ...projected(input.rows?.find((row) => row.taskId === g.id)),
    });
  }

  const bottom: string[] = [];
  bottom.push("");
  bottom.push(`    ${faint("area")}    ${BOARD_AREA_ORDER.map((a) => (areaTally.has(a) ? body(a) : faint(a))).join(mute(" · "))}${unmappedPaths.size ? mute("   ") + fail(`${unmappedPaths.size} unmapped`) : ""}`);
  if (unmappedPaths.size) bottom.push(`    ${pad("", 8)}${fail("UNMAPPED")} ${mute([...unmappedPaths].slice(0, 3).join("  "))}${unmappedPaths.size > 3 ? mute(`  +${unmappedPaths.size - 3}`) : ""}`);
  bottom.push(`    ${faint("gates")}   ${BOARD_GATES.map((k) => `${body(k.slice(0, BOARD_CELL - 1))} ${mute(k)}`).join("  ")}`);
  bottom.push(`    ${faint("     ")}   ${pass("✔")} ${mute("passed")}   ${fail("✖")} ${mute("failed")}   ${faint("·")} ${mute("pending")}   ${faint("─")} ${mute("not declared (acceptance and review are the optional two)")}`);
  bottom.push("");
  // the gap is stated, never silently skipped — derived, so it cannot go stale
  const retired = s.tasks.map((t) => t.id).filter((id) => !graphTasks.some((g) => g.id === id)).sort();
  // A retired task is still one of the fold's tasks, so the selection can land on it: its row carries
  // the same marker the graph rows do — paint and navigation cannot diverge.
  for (const id of retired) bottom.push(`${input.selection === id ? `  ${accent("❯")} ` : "    "}${faint(id)}  ${faint("— not in this graph (retired at compile)")}`);
  if (retired.length) bottom.push("");
  bottom.push(rule());
  bottom.push("");
  // ── where the run actually spent itself, per task (prototype :477-491) ──
  const worst = graphTasks.map((g) => { const t = byId.get(g.id); return { id: g.id, p: t?.parks ?? 0, r: t?.reviewRounds ?? 0, a: t?.dispatches ?? 0 }; })
    .sort((x, y) => (y.p + y.r + y.a) - (x.p + x.r + x.a)).slice(0, 4);
  bottom.push(`  ${accent("▌")} ${bold("WHERE THE EFFORT WENT")}   ${mute(`dispatches · review rounds · human parks — top ${worst.length} of ${graphTasks.length} tasks`)}`);
  bottom.push("");
  const maxTot = Math.max(...worst.map((w) => w.a + w.r + w.p), 1);
  const barw = Math.min(BOARD_EFFORT_BAR_MAX, Math.max(16, W - 60));
  for (const w of worst) {
    // The prototype rounds each segment on its own; the three share one budget, so the cells rounding
    // pushes past barw come off the longest segment (4·1·1 at 46 rounds to 31+8+8) — never past the maximum.
    const len = [w.a, w.r, w.p].map((n) => Math.round((n / maxTot) * barw));
    for (let over = len.reduce((x, y) => x + y, 0) - barw; over > 0; over--) len[len.indexOf(Math.max(...len))]--;
    const seg = (n: number, paint: (s: string) => string) => paint("█".repeat(n));
    bottom.push(`    ${accent(pad(w.id, 6))}${seg(len[0]!, accent)}${seg(len[1]!, warn)}${seg(len[2]!, park)}  ` +
      `${mute(`${w.a} dispatch`)}${mute(" · ")}${warn(`${w.r} review`)}${mute(" · ")}${park(`${w.p} park`)}`);
  }
  bottom.push("");
  bottom.push(`    ${mute("legend")}  ${accent("█")} ${faint("dispatch")}  ${warn("█")} ${faint("review round")}  ${park("█")} ${faint("human park")}`);
  bottom.push("");
  if (input.keys !== false) bottom.push(boardFooter(input.keys ?? BOARD_KEYS, input.colour !== false));

  return { top: [...top, `${gateHeader.head}${gateHeader.strip}${gateHeader.tail}`, headerRule], rows, gateHeader, bottom, width: W, lbl: LBL, chan: CHAN };
}

/** The footer row: the key hints in chrome, the prototype's leading space kept. */
export const boardFooter = (keys: readonly string[], colour = true): string => (colour ? c(BOARD_PALETTE.chrome) : plain)(` ${keys.join(" · ")}`);

/** The prototype's frame as lines, one row per task, unclipped — exactly what the design signed off. */
export function renderBoard(input: BoardInput, width: number): string[] {
  const f = boardFrame(input, width);
  return [...f.top, ...f.rows.map((r) => `${r.head}${r.strip}${r.tail}${r.note}`), ...f.bottom];
}

/**
 * The Run view's three width bands over the same frame: full draws the prototype's rows; wrap
 * puts a note that does not fit on its own second row; stacked draws the gate cells, channel and
 * attempts under the row so nothing is truncated away.
 */
export function renderBoardLines(input: BoardInput, width: number): string[] {
  const band = boardBand(width);
  const f = boardFrame(input, width);
  const IND = 9, ind = " ".repeat(IND);
  const sep = (input.colour === false ? plain : c(BOARD_PALETTE.mute))(" · ");
  const lines: string[] = [...f.top];
  if (band === "stacked") {
    // The gate header rides with the cells it labels; the title header stays with the title column.
    lines.splice(lines.length - 2, 1, f.gateHeader.head, `${ind}${f.gateHeader.strip}${f.gateHeader.tail}`);
  }
  // A note never truncates: what does not fit beside its row continues on indented rows below it.
  const noteRows = (r: BoardRow, lead: string) => {
    const [first, ...rest] = wrapNote(r.noteParts, sep, Math.max(1, width - vw(lead)), Math.max(1, width - IND));
    lines.push(`${lead}${first ?? ""}`, ...rest.map((l) => `${ind}${l}`));
  };
  for (const r of f.rows) {
    if (band === "stacked") {
      lines.push(r.head, `${ind}${r.strip}${r.tail}`);
      if (r.note) noteRows(r, ind);
      continue;
    }
    const row = `${r.head}${r.strip}${r.tail}`;
    if (!r.note || vw(row) + vw(r.note) <= width) lines.push(`${row}${r.note}`);
    else if (band === "full" && vw(row) < width - 12) noteRows(r, row);
    else { lines.push(row); noteRows(r, ind); }
  }
  lines.push(...f.bottom);
  return lines.map((l) => clipBoard(l, width));
}

/** Pack note segments greedily into rows of `avail` cells; a segment wider than a row splits at the cell. */
export function wrapNote(parts: readonly string[], sep: string, firstAvail: number, avail: number): string[] {
  const out: string[] = [];
  let cur = "";
  const room = () => (out.length ? avail : firstAvail);
  const flush = () => { if (cur) out.push(cur); cur = ""; };
  for (const part of parts) {
    const joined = cur ? `${cur}${sep}${part}` : part;
    if (vw(joined) <= room()) { cur = joined; continue; }
    flush();
    let rest = part;
    while (vw(rest) > room()) { const [head, tail] = splitBoard(rest, room()); if (!head) break; out.push(head); rest = tail; }
    cur = rest;
  }
  flush();
  return out;
}

/** ANSI-aware split at `n` visible cells on a grapheme boundary; the tail re-opens the colours the head left active. */
function splitBoard(s: string, n: number): [string, string] {
  const { head, tail } = sliceCells(s, n);
  let active = "";
  for (const [code] of head.matchAll(/\x1b\[[0-9;]*m/g)) active = code === CLOSE || code === R ? "" : active + code;
  return [head + (active ? CLOSE : ""), active + tail];
}
