import { describe, expect, test } from "vitest";
import { dispatch, USAGE } from "../../src/cli/index.js";

const retiredBanner = `${["dro", "vr"].join("")} —`;

// Behavioral tests for the CLI dispatcher. Each pins an operator-visible contract:
// a typo'd command must not silently succeed, bare `tickmarkr` is help (not an error),
// argv reaches the handler, and a handler throw becomes a clean one-line error (no stack leak).
describe("cli dispatch", () => {
  test("usage advertises the agent install and consent flags", () => {
    expect(USAGE).toContain("init --agent");
    expect(USAGE).toContain("--force");
    expect(USAGE).toContain("--docs");
  });

  test("unknown command prints usage and exits non-zero", async () => {
    const r = await dispatch("nonexistent", []);
    expect(r.out).toContain("usage: tickmarkr");
    expect(r.out).not.toContain(retiredBanner);
    expect(r.code).toBe(1); // catches: CI scripts calling a typo'd tickmarkr command silently succeeding
  });

  test("bare tickmarkr (no command) prints usage and exits 0", async () => {
    const r = await dispatch(undefined, []);
    expect(r.out).toContain("usage: tickmarkr");
    expect(r.out).not.toContain(retiredBanner);
    expect(r.code).toBe(0); // help, not an error
  });

  test("routes argv to the resolved handler", async () => {
    const r = await dispatch("ping", ["a"], { ping: async (argv) => "pong:" + argv[0] });
    expect(r.out).toBe("pong:a"); // proves argv is forwarded verbatim to the handler
    expect(r.code).toBe(0);
  });

  test("a handler may return { out, code } directly", async () => {
    const r = await dispatch("ping", [], { ping: async () => ({ out: "custom", code: 2 }) });
    expect(r.out).toBe("custom");
    expect(r.code).toBe(2);
  });

  test("a throwing handler is shaped as `tickmarkr <cmd>: <message>`, code 1", async () => {
    const r = await dispatch("ping", [], { ping: async () => { throw new Error("boom"); } });
    expect(r.out).toBe("tickmarkr ping: boom"); // catches: raw stack traces leaking to the operator
    expect(r.code).toBe(1);
  });

  test("non-tty invocation refuses with a message naming the line-mode alternatives", async () => {
    const r = await dispatch("ui", []);
    expect(r.out).toContain("tickmarkr ui:");
    expect(r.out).toContain("fleet --print");
    expect(r.out).toContain("status --watch");
    expect(r.code).toBe(1);
  });
});
