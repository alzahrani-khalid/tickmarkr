import type { StreamTurn } from "./types.js";

/** Claude print-mode JSONL. The final result event alone owns the answer, even if it is an error.
 * Every row before init, startup hooks included, is user-owned output and dropped; init establishes the seat boundary
 * but is not seat work; a hook row after init is a seat row, persisted and counted (D-2174).
 * Keep malformed and partial rows after that boundary as evidence, never as verdict text: one voids any earlier
 * result, and only a later complete success restores a verdict (D-2174). */
export function decodeClaudeStream(stream: string): StreamTurn {
  let started = false;
  let raw = "";
  let seatAuthoredBytes = 0;
  let output = "";
  for (const line of stream.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    let event: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) event = parsed as Record<string, unknown>;
    } catch { /* a torn or malformed row can still be seat evidence */ }
    if (!started) {
      if (event?.type !== "system" || event.subtype !== "init") continue;
      started = true;
      raw += line;
      continue;
    }
    raw += line;
    seatAuthoredBytes += Buffer.byteLength(line, "utf8");
    if (!event) output = "";
    else if (event.type === "result") {
      output = event.subtype === "success" && event.is_error === false && typeof event.result === "string"
        ? event.result : "";
    }
  }
  return { output, raw, started, seatAuthoredBytes };
}
