import { expect, test } from "vitest";
import { decodeClaudeStream } from "../../src/adapters/claude-stream.js";
import { hooks, init, lines, own, recorded, result, rewrite, working } from "../fixtures/claude-stream/fixture.js";

test("test: the claude stream decoder takes the verdict from the final result event alone, over assistant text contradicting it, a success followed by an error, two results, a missing result, malformed or partial lines and an empty stream, and counts seat bytes after init only, so a decoder reading assistant text or an earlier result fails", () => {
  expect(decodeClaudeStream(recorded)).toEqual({ output: "OK", raw: recorded.slice(hooks.length), started: true,
    seatAuthoredBytes: Buffer.byteLength(recorded.slice(hooks.length + init.length)) });
  // The assistant says OK, while only the final result is the verdict.
  expect(decodeClaudeStream(working + result("REJECT")).output).toBe("REJECT");
  expect(decodeClaudeStream(recorded + result("second result")).output).toBe("second result");
  for (const patch of [
    { subtype: "error_during_execution", is_error: true }, { is_error: true }, { subtype: "error_max_turns" },
    { is_error: undefined }, { result: null }, { result: 42 }, { result: { approve: true } },
  ]) {
    const tail = result("must not be read", patch);
    expect(decodeClaudeStream(recorded + tail).output, JSON.stringify(patch)).toBe("");
    expect(decodeClaudeStream(working + tail).output).toBe("");
  }
  expect(decodeClaudeStream(working).output).toBe("");
  expect(decodeClaudeStream(working)).toMatchObject({ seatAuthoredBytes: Buffer.byteLength(own), started: true });
  // Summary events seen in 2.1.310 are derived from the recorded system event.
  const summaries = ["task_summary", "post_turn_summary", "init"].map((subtype) => rewrite(init, { subtype })).join("");
  const malformed = lines[6]!.replace('"type":"assistant"', '"type":broken');
  const partial = lines.at(-1)!.slice(0, -20);
  const unicode = lines[6]!.replace('"text":"OK"', '"text":"é 🧪"');
  for (const tail of [summaries, malformed, partial, malformed + partial, lines[6]!.slice(-1), unicode]) {
    const decoded = decodeClaudeStream(hooks + init + own + tail);
    expect(decoded).toEqual({ output: "", raw: init + own + tail, started: true,
      seatAuthoredBytes: Buffer.byteLength(own + tail) });
    // The same bytes before init cannot start a seat, become a verdict, or contaminate its capture.
    expect(decodeClaudeStream(hooks + malformed + partial + "\n" + init + own + tail)).toEqual(decoded);
  }
  expect(decodeClaudeStream(init)).toEqual({ output: "", raw: init, started: true, seatAuthoredBytes: 0 });
  for (const raw of ["", hooks, own + result("not started"), malformed, partial, init.slice(0, -15)]) {
    expect(decodeClaudeStream(raw)).toEqual({ output: "", raw: "", started: false, seatAuthoredBytes: 0 });
  }
  // A complete final JSON object needs no trailing newline; a torn one never supplies a verdict.
  expect(decodeClaudeStream(recorded.trimEnd()).output).toBe("OK");
  expect(decodeClaudeStream(init + partial).output).toBe("");
  // A result stays final only while no torn or malformed row follows it; only a later complete success restores one (D-2174).
  const approved = result("APPROVED");
  for (const tail of [partial, partial + "\n", malformed, malformed + partial, result("x", { subtype: "error_during_execution", is_error: true })]) {
    expect(decodeClaudeStream(init + approved + tail).output, tail).toBe("");
  }
  expect(decodeClaudeStream(init + approved + malformed + result("second")).output).toBe("second");
  expect(decodeClaudeStream(init + approved).output).toBe("APPROVED");
  // Hook rows are dropped only before init; after it they are seat rows, persisted and counted (D-2174).
  expect(decodeClaudeStream(hooks + init + hooks)).toEqual({ output: "", raw: init + hooks, started: true,
    seatAuthoredBytes: Buffer.byteLength(hooks) });
  expect(decodeClaudeStream(hooks + init + own + hooks + approved)).toEqual({ output: "APPROVED",
    raw: init + own + hooks + approved, started: true, seatAuthoredBytes: Buffer.byteLength(own + hooks + approved) });
});
