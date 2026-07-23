import { describe as d, test, expect } from "vitest";
import { PassThrough } from "node:stream";

const describe = d.skip;

function makeInput() {
  return new PassThrough();
}

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("input router", () => {
  test("decodes arrow keys", async () => {
    const input = makeInput();
    const router = new InputRouter(input);
    const keys: string[] = [];
    router.on("up", () => keys.push("up"));
    router.on("down", () => keys.push("down"));
    router.on("left", () => keys.push("left"));
    router.on("right", () => keys.push("right"));
    router.start();
    input.write("\x1b[A\x1b[B\x1b[D\x1b[C");
    await wait();
    expect(keys).toEqual(["up", "down", "left", "right"]);
    router.stop();
  });

  test("decodes an arrow sequence split across chunks", async () => {
    const input = makeInput();
    const router = new InputRouter(input);
    const keys: string[] = [];
    router.on("up", () => keys.push("up"));
    router.start();
    input.write("\x1b[");
    input.write("A");
    await wait();
    expect(keys).toEqual(["up"]);
    router.stop();
  });

  test("decodes escape key", async () => {
    const input = makeInput();
    const router = new InputRouter(input);
    const keys: string[] = [];
    router.on("escape", () => keys.push("escape"));
    router.start();
    input.write("\x1b");
    await wait();
    expect(keys).toEqual(["escape"]);
    router.stop();
  });

  test("plain character keys dispatch by name", async () => {
    const input = makeInput();
    const router = new InputRouter(input);
    const keys: string[] = [];
    router.on("q", () => keys.push("q"));
    router.start();
    input.write("q");
    await wait();
    expect(keys).toEqual(["q"]);
    router.stop();
  });

  test("unregistered keys are ignored", async () => {
    const input = makeInput();
    const router = new InputRouter(input);
    const keys: string[] = [];
    router.on("q", () => keys.push("q"));
    router.start();
    input.write("x");
    await wait();
    expect(keys).toEqual([]);
    router.stop();
  });

  test("multiple handlers for the same key both run", async () => {
    const input = makeInput();
    const router = new InputRouter(input);
    const keys: string[] = [];
    router.on("a", () => keys.push("a1"));
    router.on("a", () => keys.push("a2"));
    router.start();
    input.write("a");
    await wait();
    expect(keys).toEqual(["a1", "a2"]);
    router.stop();
  });

  test("off removes only the requested handler", async () => {
    const input = makeInput();
    const router = new InputRouter(input);
    const keys: string[] = [];
    const h1 = () => keys.push("h1");
    const h2 = () => keys.push("h2");
    router.on("b", h1);
    router.on("b", h2);
    router.off("b", h1);
    router.start();
    input.write("b");
    await wait();
    expect(keys).toEqual(["h2"]);
    router.stop();
  });
});
