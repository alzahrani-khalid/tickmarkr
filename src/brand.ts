import { shq } from "./adapters/types.js";
import type { OwnedName } from "./drivers/types.js";

// TTY-only pixel-tick logo (assets/mark.svg is generated as the image twin of this bitmap).
// Never printed to pipes — the non-TTY stdout surface is byte-pinned by tests and consumed by machines.
const B = "\x1b[1m", R = "\x1b[0m";
export const MARK_BITMAP = [
  "..................",
  "..............###.",
  "............####..",
  "..........####....",
  "........####......",
  ".###..####........",
  "...#####..........",
  "....###...........",
  "..................",
  "..................",
] as const;

const QUADRANTS = [
  " ", "▘", "▝", "▀", "▖", "▌", "▞", "▛",
  "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█",
] as const;

function packMark(bitmap: readonly string[]): string {
  const rows: string[] = [];
  for (let y = 0; y < bitmap.length; y += 2) {
    let row = "";
    for (let x = 0; x < bitmap[y]!.length; x += 2) {
      const mask = (bitmap[y]![x] === "#" ? 1 : 0)
        | (bitmap[y]![x + 1] === "#" ? 2 : 0)
        | (bitmap[y + 1]![x] === "#" ? 4 : 0)
        | (bitmap[y + 1]![x + 1] === "#" ? 8 : 0);
      row += QUADRANTS[mask]!;
    }
    rows.push(row);
  }
  return rows.join("\n");
}

// The ruled silhouette, packed from the 18x10 bitmap into a 9x5 quadrant-cell grid.
export const PLAIN_MARK = packMark(MARK_BITMAP);
// Near-black ANSI 233 knockout ink on the solid ANSI 41 brand tile.
export const MARK = PLAIN_MARK.split("\n")
  .map((row) => `\x1b[38;5;233;48;5;41m${row}${R}`)
  .join("\n");

// Retain the reviewed 28-column compact row so narrow-header copy wraps unchanged.
const BANNER_COPY_GAP = " ".repeat(10);
export const BANNER = [
  // The fifth packed row is tile-only padding; the composed header stays four rows
  // so setup retains every detected state at the contracted 24-row height.
  ...MARK.split("\n").slice(0, -1).map((row, index) =>
    index === 2 ? `${row}${BANNER_COPY_GAP}${B}tickmarkr${R}`
      : index === 3 ? `${row}${BANNER_COPY_GAP}spec in, verified work out.`
        : row
  ),
  "",
].join("\n");

/** ANSI-stripped, trailing-space-trimmed twin of BANNER — README hero and other plain surfaces. */
export const PLAIN_BANNER = BANNER.replace(/\x1b\[[0-9;]*m/g, "").replace(/[ \t]+$/gm, "");

/** Two-line run-cockpit lockup, sliced from BANNER so its mark and product name cannot drift. */
export const COMPACT_LOCKUP = BANNER.split("\n").slice(1, 3).join("\n");
/** ANSI-stripped, trailing-space-trimmed twin of COMPACT_LOCKUP for colourless surfaces. */
export const PLAIN_COMPACT_LOCKUP =
  COMPACT_LOCKUP.replace(/\x1b\[[0-9;]*m/g, "").replace(/[ \t]+$/gm, "");

// T5: the pane identity every visible pane announces under the logo. HerdrDriver seeds this env var
// into each pane shell at slot() time (paneIdentityLine of the pane's T1 owned name); the banner's
// identity line reads it at pane runtime, so every role — worker/judge/review/consult — wears the
// same header without the dispatch call sites threading identity through the script.
export const PANE_IDENTITY_ENV = "TICKMARKR_PANE_IDENTITY";

/** One-line pane identity through the T1 ownership contract: role · task · attempt · run. */
export function paneIdentityLine(o: OwnedName): string {
  return `${o.role} · ${o.taskId} · attempt ${o.attempt}${o.runId ? ` · ${o.runId}` : ""}`;
}

// Shell one-liner that prints the banner inside a pane before a gate command runs, followed by ONE
// dim identity line (the seeded $TICKMARKR_PANE_IDENTITY, else a bare "tickmarkr"). ESC bytes are
// carried as printf %b escapes (never raw control bytes in a command string crossing the herdr socket).
export function bannerShell(): string {
  const printable = BANNER.replaceAll("\x1b", "\\033").replaceAll("\n", "\\n");
  return `printf '%b\\n' '${printable}' "\\033[2m\${${PANE_IDENTITY_ENV}:-tickmarkr}\\033[0m"`;
}

// OBS-50: quote-split exit marker — herdr echoes the typed command into the transcript that
// waitOutput matches, so the literal must not appear unsplit in the dispatch line.
export const TICKMARKR_EXIT_TRAILER = `printf '\\nTICKMARKR_''EXIT:%s\\n' $?`;

/** OBS-50: visible-pane bootstrap script — banner + agent command + byte-identical exit trailer. */
export function paneDispatchScript(body: string[]): string {
  return ["export BASH_SILENCE_DEPRECATION_WARNING=1", ...body, TICKMARKR_EXIT_TRAILER].join("\n");
}

// OBS-342: ExecutorDriver.run predates command intent and accepts only a string. Keep that stable API,
// but pass the builder's launch fact through a linear, same-dispatch handoff rather than encoding a
// sentinel into the shell bytes. Herdr consumes the token synchronously at run() entry; a non-herdr
// call or a command merely built for display lets its token expire at the next microtask. Tokens are
// objects, not command strings, so identical bytes do not acquire identity by having appeared before.
interface PaneLaunchIntent { readonly kind: "launch" }
const pendingPaneLaunchIntents: PaneLaunchIntent[] = [];

/** Record that the command being passed directly to ExecutorDriver.run is a daemon-built launch. */
export function paneLaunchCommand(command: string): string {
  const intent: PaneLaunchIntent = { kind: "launch" };
  pendingPaneLaunchIntents.push(intent);
  queueMicrotask(() => {
    const index = pendingPaneLaunchIntents.indexOf(intent);
    if (index >= 0) pendingPaneLaunchIntents.splice(index, 1);
  });
  return command;
}

/** Driver-side half of paneLaunchCommand's one-shot handoff. */
export function consumePaneLaunchIntent(): boolean {
  return pendingPaneLaunchIntents.shift()?.kind === "launch";
}

/** OBS-50/342: one short, intent-bearing pane-run line; bootstrap lives beside the prompt. */
export function paneDispatchCommand(scriptPath: string): string {
  return paneLaunchCommand(`bash ${shq(scriptPath)}`);
}

// ── design system (v1.50) ── contract: docs/codebase/CLI-DESIGN.md ──────────
// Every cockpit surface styles through these tokens/glyphs/helpers. Styled only
// on a real TTY with NO_COLOR unset; otherwise output is the plain text itself
// (non-TTY surfaces stay byte-pinned and machine-consumable).

/** The settled brand green ramp (256-color), bright → deep. */
export const BRAND_RAMP = [84, 78, 41, 35] as const;

const visual = () => process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const sgr = (code: string) => (s: string) => visual() ? `\x1b[${code}m${s}${R}` : s;

/** Brand green (ramp anchor 41) — the tickmark hue; also the ok/pass/authed verdict color. */
export const brand = sgr(`38;5;${BRAND_RAMP[2]}`);
/** Compact product chip — black ink on the terminal theme's ANSI green. */
export const brandChip = sgr("30;42");
/** Ok verdicts (pass/authed/green) render in the brand green ramp — same hue as the tickmark. */
export const ok = brand;
/** Fail verdicts (unauthed/red) — red, always paired with the ✗ shape. */
export const fail = sgr("31");
/** Attention (warn/lint) — amber, always paired with the ! shape. */
export const warn = sgr("33");
/** Chrome (legends, rules, parentheticals, inactive state) — dim. */
export const dim = sgr("2");
/** Emphasis (titles, selection, the product name) — bold. */
export const bold = sgr("1");
/** Every semantic color token, for sweeps: each is TTY-gated and NO_COLOR-aware. */
export const TOKENS = { brand, brandChip, ok, fail, warn, dim, bold } as const;

// ── operator live-surface palette (v1.99) ───────────────────────────────────
// The tokens above remain the global design system for one-shot surfaces. LIVE is the closed
// five-colour system for long-running operator surfaces. Semantic aliases below deliberately share
// renderers: glyphs and words retain the distinction between pass/brand, running/information,
// chrome/secondary text, and attention/failure when colour is unavailable.

/** Exact operator-approved live colours. Values stay hex so the authority is inspectable. */
export const LIVE_PALETTE = {
  /** muted teal — brand identity and pass */
  brand: "#90C4A4",
  /** cornflower blue — running state and information */
  running: "#5A76AE",
  /** ice — primary text */
  text: "#E6FDFF",
  /** cloud — chrome and secondary text */
  chrome: "#D9D7DD",
  /** amethyst — attention and failure */
  attention: "#B07BAC",
} as const;

export type LiveRole = keyof typeof LIVE_PALETTE;
type LiveHex = (typeof LIVE_PALETTE)[LiveRole];

const liveSgr = (hex: LiveHex): ((s: string) => string) => {
  const channels = hex.slice(1).match(/.{2}/gu)!.map((channel) => Number.parseInt(channel, 16));
  return sgr(`38;2;${channels.join(";")}`);
};

const liveBrand = liveSgr(LIVE_PALETTE.brand);
const liveRunning = liveSgr(LIVE_PALETTE.running);
const liveText = liveSgr(LIVE_PALETTE.text);
const liveChrome = liveSgr(LIVE_PALETTE.chrome);
const liveAttention = liveSgr(LIVE_PALETTE.attention);

/** Semantic live tokens. Aliases are intentional; no token introduces a sixth colour. */
export const LIVE = {
  brand: liveBrand,
  pass: liveBrand,
  running: liveRunning,
  information: liveRunning,
  text: liveText,
  primaryText: liveText,
  chrome: liveChrome,
  secondaryText: liveChrome,
  attention: liveAttention,
  failure: liveAttention,
  chip: liveBrand,
} as const;

/**
 * The glyph vocabulary — plain characters only; color layers on via tokens so
 * shape survives NO_COLOR. Bracket toggles ([x]/[ ]) are forbidden on every surface.
 */
export const GLYPHS = {
  /** Cursor row pointer in list pickers. */
  pointer: "❯",
  /** Active toggle: THE brand tickmark — always rendered via brand(), never brackets. */
  toggleActive: "✓",
  /** Inactive toggle: dim circle — always rendered via dim(). */
  toggleInactive: "○",
  /** Pass verdict. */
  pass: "✓",
  /** Fail verdict. */
  fail: "✗",
  /** Attention/warn verdict. */
  attention: "!",
  /** Neutral/skip — the dash. */
  neutral: "-",
} as const;

/** The active toggle as rendered: brand green tickmark on a TTY, plain ✓ otherwise. */
export const toggleActive = (): string => brand(GLYPHS.toggleActive);
/** The inactive toggle as rendered: dim circle on a TTY, plain ○ otherwise. */
export const toggleInactive = (): string => dim(GLYPHS.toggleInactive);

/** Dominant title line — one glance answers "what am I looking at". Bold on a TTY. */
export const title = (text: string): string => bold(text);
/** Single dim legend line under a title (key hints) — never scattered, never a paragraph. */
export const legend = (text: string): string => dim(text);
/** Horizontal rule sized to the terminal (capped at 100 cols) — dim chrome. */
export const rule = (width = Math.min(process.stdout.columns ?? 80, 100)): string =>
  dim("─".repeat(width));
/** Aligned key-value row: dim key, plain value. Padding applied BEFORE styling so columns hold. */
export const kvRow = (key: string, value: string, keyWidth = 14): string =>
  `  ${dim(key.padEnd(keyWidth))} ${value}`;

export type Verdict = "pass" | "fail" | "warn" | "neutral";
const VERDICT: Record<Verdict, () => string> = {
  pass: () => ok(GLYPHS.pass),
  fail: () => fail(GLYPHS.fail),
  warn: () => warn(GLYPHS.attention),
  neutral: () => dim(GLYPHS.neutral),
};
/** Status row: verdict glyph FIRST, then the label — glyph-first, distinct shape per verdict. */
export const statusRow = (verdict: Verdict, label: string): string =>
  `${VERDICT[verdict]()} ${label}`;

/** Compact token counts for tables: 1048576 → "1m", 262144 → "262k" (UI-free — safe for doctor). */
export function compactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    const rounded = m >= 10 ? Math.round(m) : Math.round(m * 10) / 10;
    return `${String(rounded).replace(/\.0$/, "")}m`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}
