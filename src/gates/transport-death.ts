import { stripVTControlCharacters } from "node:util";
import { shq } from "../adapters/types.js";

// Queue row 417; D-2187 add.77: a reviewer or judge whose provider endpoint is down prints nothing but reconnect lines
// until its ceiling (run …2493: seventeen `ERROR: Reconnecting... waiting for network`, killed at 900 000 ms, cause
// truncated). Over the seat-authored output a line is TRANSPORT, NOISE or MODEL — a closed format table (D-2187 add.99).
const TRANSPORT_LINE = /^ERROR: Reconnecting\.\.\. (?:waiting for network|[0-9]+\/[0-9]+)$/;
const NOISE_LINE = /^hook: [A-Za-z]+( Completed)?$/;
// A live `codex exec` stream's header block and `user` row (codex-cli 0.167.0; D-2187 add.123), exactly these rows.
const CODEX_HEADER_LINE =
  /^(?:Reading additional input from stdin\.\.\.|OpenAI Codex v\S+.*|-{4,}|(?:workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id): .*|user)$/;
/** A reconnect-only dispatch holding this many TRANSPORT lines is killed as cause transport. */
export const TRANSPORT_DEATH_LINES = 3;

/** Control sequences removed, CRLF and a bare CR turned into LF — the same for the log and the brief. */
const normalize = (text: string): string => stripVTControlCharacters(text).replace(/\r\n?/g, "\n");

export type StreamLineKind = "transport" | "noise" | "model";

export function classifyStreamLine(line: string): StreamLineKind {
  const t = line.trim();
  if (TRANSPORT_LINE.test(t)) return "transport";
  if (t === "" || NOISE_LINE.test(t) || t.startsWith("warning: ") || CODEX_HEADER_LINE.test(t)) return "noise";
  return "model";
}

/**
 * One dispatch's accumulated reading (row 417). Both dispatch paths tee the seat's pipes to an append-only log
 * (teeSeatCommand), and every check reads that whole log — never a pane's 400-row snapshot, which forgets rows and
 * cannot tell a new row from a repeated read. The reading is a pure function of the whole log (D-2187 add.120): a
 * MODEL row once written is found again at every later read, every TRANSPORT row is counted once, and a reconnect
 * that succeeds within one check is never failed fast. A live check classifies only complete (LF-terminated) rows; a
 * non-empty unfinished row may still become a MODEL line, so it holds the kill until a later check reads it complete
 * (or the stream ends and it is read as it stands). A row equal to one of the adapter's declared harness banner rows
 * is NOISE wherever it appears. The echoed brief is removed only as the whole brief contiguous, once complete; a
 * partial echo, or a seat line that merely equals some brief line, reads as the seat's own.
 */
export class TransportWatch {
  private readonly brief: string[];
  private readonly banner: Set<string>;
  private modelSeen = false;
  private transportLines = 0;
  private pending = false;

  constructor(brief: string, bannerRows: readonly string[] = []) {
    // The brief gets the log's own normalization before its echo is matched (D-2187 add.123).
    this.brief = normalize(brief).split("\n").map((line) => line.trim()).filter(Boolean);
    this.banner = new Set(bannerRows.map((row) => row.trim()));
  }

  /**
   * `log` is the dispatch's whole raw seat log so far; `ended` also reads its unterminated last row. The log never
   * holds the pane preamble, so it is never cut by reviewSeatOutput (whose preamble walk would delete a first MODEL
   * row shaped like the identity row, e.g. `tickmarkr`); only control sequences, the echo and banner rows go.
   */
  observe(log: string, ended = false): void {
    const text = normalize(log);
    const cut = ended ? text.length : text.lastIndexOf("\n") + 1;
    this.pending = text.slice(cut).trim() !== "";
    const rows = text.slice(0, cut).split("\n");
    const echo = this.echo(rows);
    let model = false;
    let transport = 0;
    rows.forEach((row, i) => {
      if (echo.has(i) || this.banner.has(row.trim())) return;
      const kind = classifyStreamLine(row);
      if (kind === "model") model = true;
      else if (kind === "transport") transport++;
    });
    this.modelSeen = model;
    this.transportLines = transport;
  }

  private echo(rows: string[]): Set<number> {
    if (!this.brief.length) return new Set();
    const nonblank = rows.flatMap((row, i) => (row.trim() ? [i] : []));
    for (let p = 0; p < nonblank.length; p++) {
      if (rows[nonblank[p]!]!.trim() !== this.brief[0]) continue;
      const run: number[] = [];
      for (let q = p; q < nonblank.length && run.length < this.brief.length
        && rows[nonblank[q]!]!.trim() === this.brief[run.length]; q++) run.push(nonblank[q]!);
      if (run.length === this.brief.length) return new Set(run);
    }
    return new Set();
  }

  /** No MODEL row in the log, at least one TRANSPORT row: an exit or timeout now is cause transport. */
  get reconnectOnly(): boolean { return !this.modelSeen && this.transportLines > 0; }

  /** The fail-fast condition: kill now, cause transport. Silence is never transport. */
  get dead(): boolean { return this.reconnectOnly && !this.pending && this.transportLines >= TRANSPORT_DEATH_LINES; }
}

/** The headless path's append-only copy of both pipes, so a live check reads every row the seat ever wrote. */
export function teeSeatCommand(command: string, log: string): string {
  return `{ ${command}\n} > >(tee -a ${shq(log)}) 2> >(tee -a ${shq(log)} >&2)`;
}

/** The pane path's copy: a pipeline, so bash waits for tee before the exit trailer and the final read is complete. */
export function teePaneSeatCommand(command: string, log: string): string {
  return `set -o pipefail\n{ ${command}\n} 2>&1 | tee -a ${shq(log)}`;
}

/** Fail-fast check every `intervalMs` over the whole log; returns its stop. `onDead` runs at most once. */
export function pollTransport(watch: TransportWatch, read: () => string, onDead: () => void, intervalMs: number): () => void {
  const timer = setInterval(() => {
    try { watch.observe(read()); } catch { return; } // an unreadable log proves nothing
    if (watch.dead) { clearInterval(timer); onDead(); }
  }, intervalMs);
  return () => clearInterval(timer);
}
