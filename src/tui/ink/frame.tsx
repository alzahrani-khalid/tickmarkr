import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { compactTokens, GLYPHS } from "../../brand.js";

// ── ink stream bridges ───────────────────────────────────────────────────────
// Hoisted from fleet-app.tsx / init-app.tsx (both files carried byte-identical
// copies with a "hoist on the third act" note — this is that hoist).

const escape = String.fromCharCode(27);
const inkBookkeepingWrites: Record<string, true> = {
  "": true,
  [`${escape}[?25l`]: true,
  [`${escape}[?25h`]: true,
  [`${escape}[?2026h`]: true,
  [`${escape}[?2026l`]: true,
};

export function inkOutput(output: NodeJS.WriteStream): NodeJS.WriteStream {
  if (typeof output.on === "function" && typeof output.off === "function") return output;
  const facade = Object.create(output) as NodeJS.WriteStream;
  const write = output.write.bind(output);
  facade.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (inkBookkeepingWrites[text]) return true;
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as NodeJS.WriteStream["write"];
  facade.on = () => facade;
  facade.off = () => facade;
  return facade;
}

export function inkInput(input: NodeJS.ReadStream, initialInput: string[]) {
  const productionInput = typeof input.ref === "function" && typeof input.unref === "function";
  // Isolate Ink's listeners on a bridge so every editor exit can detach the
  // one listener it owns from the operator's terminal. Older injected FleetIO
  // streams can arrive as decoded keypress events, while real TTYs forward raw
  // data and leave decoding entirely to Ink.
  const stream = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => unknown;
    ref: () => NodeJS.ReadStream;
    unref: () => NodeJS.ReadStream;
  };
  stream.isTTY = input.isTTY;
  stream.setRawMode = input.setRawMode?.bind(input);
  stream.ref = () => {
    if (productionInput) input.ref();
    return stream as unknown as NodeJS.ReadStream;
  };
  stream.unref = () => {
    if (productionInput) input.unref();
    return stream as unknown as NodeJS.ReadStream;
  };

  const queued = [...initialInput];
  let active = true;
  let scheduled: NodeJS.Timeout | undefined;
  const pump = () => {
    scheduled = undefined;
    if (!active) return;
    const next = queued.shift();
    if (next === undefined) return;
    stream.write(next);
    scheduled = setTimeout(pump, 0);
  };
  const onData = (chunk: string | Buffer) => {
    queued.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    scheduled ??= setTimeout(pump, 0);
  };
  const onKeypress = (sequence: string | undefined, key: { sequence?: string } | undefined) => {
    const token = key?.sequence ?? sequence;
    if (token === undefined) return;
    queued.push(token);
    scheduled ??= setTimeout(pump, 0);
  };
  if (productionInput) {
    input.on("data", onData);
  } else {
    emitKeypressEvents(input);
    input.on("keypress", onKeypress);
  }
  input.resume();
  if (queued.length > 0) scheduled = setTimeout(pump, 0);

  return {
    stream: stream as unknown as NodeJS.ReadStream,
    stop() {
      active = false;
      clearTimeout(scheduled);
      if (productionInput) input.off("data", onData);
      else input.off("keypress", onKeypress);
      input.pause();
      stream.end();
    },
  };
}

/** Alt-screen guard: only the operator's real terminal, never injected test streams. */
export function enterAltScreen(output: NodeJS.WriteStream): () => void {
  if (output !== process.stdout || output.isTTY !== true) return () => {};
  output.write(`${escape}[?1049h${escape}[H`);
  return () => output.write(`${escape}[?1049l`);
}

// ── palette (ink color names over the brand contract in src/brand.ts) ────────
// brand green ramp anchor 41 = ok/authed/selection accent; amber = attention;
// red = fail. Chrome is dim. Data is plain. (docs/codebase/CLI-DESIGN.md)
export const INK = {
  brand: "ansi256(41)",
  brandBright: "ansi256(84)",
  warn: "yellow",
  fail: "red",
} as const;

// ── compact formatters for metadata columns ──────────────────────────────────

/** 1048576 → "1m" · 262144 → "262k" · 200000 → "200k" · undefined → "" */
export function fmtCtx(tokens?: number): string {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return "";
  return compactTokens(tokens);
}

const trimUsd = (n: number): string => {
  const fixed = n >= 10 ? String(Math.round(n)) : String(Math.round(n * 100) / 100);
  return fixed.replace(/\.0+$/, "");
};

/** ($3, $15) → "$3/15" — omp-style per-Mtok pair. Either side missing → "". */
export function fmtUsdPair(input?: number, output?: number): string {
  if (input === undefined && output === undefined) return "";
  if (input === undefined || output === undefined) return `$${trimUsd(input ?? output ?? 0)}`;
  return `$${trimUsd(input)}/${trimUsd(output)}`;
}

/** 4169 → "4.2s" */
export function fmtMs(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Hard cell clamp with ellipsis — model ids are ASCII, plain length is the width. */
export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

/** Path clamp that keeps the LAST segment — the distinguishing half of a deep model id.
 * `prime-agent/prime-inference/anthropic/claude-fable-5` at 34 → `prime-agent/prime-i…/claude-fable-5`;
 * end-clipping the same id hid exactly the part that told models apart (operator review, 80-col). */
export function clipPathTail(text: string, width: number): string {
  if (text.length <= width) return text;
  const cut = text.lastIndexOf("/");
  if (cut === -1) return clip(text, width);
  const tail = text.slice(cut);
  if (tail.length + 2 > width) return clip(text, width); // no room for any head — fall back
  return `${text.slice(0, width - tail.length - 1)}…${tail}`;
}

export const padCell = (text: string, width: number): string => clip(text, width).padEnd(width);
export const padCellStart = (text: string, width: number): string => clip(text, width).padStart(width);

// ── frame chrome ─────────────────────────────────────────────────────────────

export type KeyBind = { key: string; label: string };

/** One dim keybar line: `Enter assign · ↑/↓ move · Esc close` with bright keys. */
export function KeyBar({ binds }: { binds: KeyBind[] }) {
  return (
    <Text>
      {binds.map((bind, index) => (
        <Text key={bind.key + bind.label}>
          {index > 0 && <Text dimColor>{"  ·  "}</Text>}
          <Text>{bind.key}</Text>
          <Text dimColor>{` ${bind.label}`}</Text>
        </Text>
      ))}
    </Text>
  );
}

/** Search prompt row — brand cursor while the search mode is live; dim hint when idle and empty. */
export function SearchRow({ filter, active, hint }: { filter: string; active: boolean; hint?: string }) {
  return (
    <Text>
      <Text dimColor>{"  "}</Text>
      <Text color={active ? INK.brand : undefined} dimColor={!active}>{"> "}</Text>
      {filter === "" && !active && hint ? <Text dimColor>{hint}</Text> : <Text>{filter}</Text>}
      {active ? <Text color={INK.brand}>{"█"}</Text> : <Text> </Text>}
    </Text>
  );
}

/** Elision marker rows for windowed lists. */
export function ElisionMark({ count, side, hint = "type to search" }: { count: number; side: "above" | "below"; hint?: string }) {
  if (count <= 0) return null;
  return <Text dimColor>{`  … ${count} ${side}${side === "below" ? ` — ${hint}` : ""}`}</Text>;
}

/** Pointer cell: two columns everywhere so rows never shift when the cursor moves. */
export function Pointer({ on }: { on: boolean }) {
  return on ? <Text color={INK.brand}>{`${GLYPHS.pointer} `}</Text> : <Text>{"  "}</Text>;
}

/** Verdict/toggle glyph vocabulary, colored per the design contract. */
export function Glyph({ kind }: { kind: "on" | "off" | "fail" | "warn" | "unknown" | "neutral" }) {
  switch (kind) {
    case "on":
      return <Text color={INK.brand}>{GLYPHS.toggleActive}</Text>;
    case "off":
      return <Text dimColor>{GLYPHS.toggleInactive}</Text>;
    case "fail":
      return <Text color={INK.fail}>{GLYPHS.fail}</Text>;
    case "warn":
      return <Text color={INK.warn}>{GLYPHS.attention}</Text>;
    case "unknown":
      return <Text color={INK.warn}>{"?"}</Text>;
    default:
      return <Text dimColor>{GLYPHS.neutral}</Text>;
  }
}

/** Bordered overlay panel (rendered in the body region — the rail stays put). */
export function OverlayPanel({ title, children, width }: { title: string; children: ReactNode; width?: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={width} alignSelf="flex-start">
      <Text bold color={INK.brand}>{title}</Text>
      {children}
    </Box>
  );
}
