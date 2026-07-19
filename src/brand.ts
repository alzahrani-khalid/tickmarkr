import { shq } from "./adapters/types.js";
import type { OwnedName } from "./drivers/types.js";

// TTY-only pixel-tick logo (assets/mark.svg is the image twin — same block geometry).
// Never printed to pipes — the non-TTY stdout surface is byte-pinned by tests and consumed by machines.
const B = "\x1b[1m", R = "\x1b[0m";
const g = (n: number, s: string) => `\x1b[38;5;${n}m${s}${R}`; // 256-color green ramp, bright → deep
export const BANNER = [
  `              ${g(84, "▄▄████")}`,
  `          ${g(78, "▄▄████▀▀")}`,
  `${g(41, "████▄▄▄▄████▀▀")}     ${B}tickmarkr${R}`,
  `  ${g(35, "▀▀████▀▀")}         spec in, verified work out.`,
  "",
].join("\n");

/** ANSI-stripped, trailing-space-trimmed twin of BANNER — README hero and other plain surfaces. */
export const PLAIN_BANNER = BANNER.replace(/\x1b\[[0-9;]*m/g, "").replace(/[ \t]+$/gm, "");

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

/** OBS-50: one short herdr pane-run line; bootstrap lives in the script file beside the prompt. */
export function paneDispatchCommand(scriptPath: string): string {
  return `bash ${shq(scriptPath)}`;
}

// ── design system (v1.50) ── contract: docs/codebase/CLI-DESIGN.md ──────────
// Every cockpit surface styles through these tokens/glyphs/helpers. Styled only
// on a real TTY with NO_COLOR unset; otherwise output is the plain text itself
// (non-TTY surfaces stay byte-pinned and machine-consumable).

/** The settled brand green ramp (256-color), bright → deep — the BANNER hues. */
export const BRAND_RAMP = [84, 78, 41, 35] as const;

const visual = () => process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const sgr = (code: string) => (s: string) => visual() ? `\x1b[${code}m${s}${R}` : s;

/** Brand green (ramp anchor 41) — the tickmark hue; also the ok/pass/authed verdict color. */
export const brand = sgr(`38;5;${BRAND_RAMP[2]}`);
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
export const TOKENS = { brand, ok, fail, warn, dim, bold } as const;

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
