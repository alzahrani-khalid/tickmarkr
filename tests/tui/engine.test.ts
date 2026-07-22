import { describe, test, expect } from "vitest";
import { PassThrough } from "node:stream";
import { TerminalEngine } from "../../src/tui/engine.js";

function makeStreams() {
  const output: string[] = [];
  const input = new PassThrough();
  const out = new PassThrough();
  out.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  return { input, output, out };
}

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("terminal engine", () => {
  test("rendering the same line model twice writes no output the second time", () => {
    const { input, output, out } = makeStreams();
    const engine = new TerminalEngine({ input, output: out });
    engine.start(["line 1", "line 2"]);
    output.length = 0;
    engine.render(["line 1", "line 2"]);
    expect(output.join("")).toBe("");
    engine.stop();
  });

  test("a one-line change repaints only the changed line", () => {
    const { input, output, out } = makeStreams();
    const engine = new TerminalEngine({ input, output: out });
    engine.start(["line 1", "line 2"]);
    output.length = 0;
    engine.render(["line 1", "changed line 2"]);
    const rendered = output.join("");
    expect(rendered).toContain("changed line 2");
    expect(rendered).not.toContain("line 1");
    engine.stop();
  });

  test("arrow and escape key sequences dispatch to registered handlers as named keys", async () => {
    const { input, out } = makeStreams();
    const received: string[] = [];
    const engine = new TerminalEngine({ input, output: out });
    engine.key("up", () => received.push("up"));
    engine.key("down", () => received.push("down"));
    engine.key("left", () => received.push("left"));
    engine.key("right", () => received.push("right"));
    engine.key("escape", () => received.push("escape"));
    engine.start(["keys"]);
    input.write("\x1b[A");
    input.write("\x1b[B");
    input.write("\x1b[D");
    input.write("\x1b[C");
    input.write("\x1b");
    await wait();
    expect(received).toEqual(["up", "down", "left", "right", "escape"]);
    engine.stop();
  });

  test("a thrown error inside a handler still restores the terminal state", async () => {
    const { input, output, out } = makeStreams();
    const errors: unknown[] = [];
    const engine = new TerminalEngine({
      input,
      output: out,
      onError: (e) => errors.push(e),
    });
    engine.key("q", () => {
      throw new Error("boom");
    });
    engine.start(["error path"]);
    output.length = 0;
    input.write("q");
    await wait();
    const rendered = output.join("");
    expect(errors).toHaveLength(1);
    expect(rendered).toContain("\x1b[?25h"); // show cursor
    expect(rendered).toContain("\x1b[?1049l"); // leave alternate screen
    engine.stop();
  });

  test("a resize event re-renders the full frame at the new width", () => {
    const { input, output, out } = makeStreams();
    const engine = new TerminalEngine({ input, output: out });
    engine.start(["line 1", "line 2"]);
    output.length = 0;
    engine.resize(120, 40);
    expect(engine.size).toEqual({ cols: 120, rows: 40 });
    const rendered = output.join("");
    expect(rendered).toContain("line 1");
    expect(rendered).toContain("line 2");
    engine.stop();
  });

  test("the engine runs against injected streams with no TTY present", () => {
    const { input, output, out } = makeStreams();
    const engine = new TerminalEngine({ input, output: out });
    expect(() => engine.start(["no tty"])).not.toThrow();
    expect(() => engine.render(["still no tty"])).not.toThrow();
    expect(() => engine.stop()).not.toThrow();
    expect(output.join("")).toContain("still no tty");
  });
});
