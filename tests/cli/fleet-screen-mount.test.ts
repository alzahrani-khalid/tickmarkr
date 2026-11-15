// `tickmarkr fleet` on a real mount: keys through the Ink screen to the file.
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadFleetSource, readDismissed } from "../../src/fleet/load.js";
import { adapters, setup, terminal } from "./fleet-screen-world.js";

describe("the real mount", () => {
  test("arrow keys, no, details, yes, the review and the save run through the Ink screen to the file", async () => {
    const { run, overlay, cwd } = setup();
    const t = terminal();
    const done = run([], { input: t.input as never, output: t.output as never });
    await t.frame("NEEDS YOU");
    // the second item, reached with a real arrow-key sequence, is the model that did not answer: not now
    let next = t.frame("not asked again");
    t.input.write("\x1b[Bn");
    await next;
    next = t.frame("Yes changes:");
    t.input.write("d");
    await next;
    next = t.frame("answered yes");
    t.input.write("y");
    await next;
    next = t.frame("WHAT CHANGES");
    t.input.write("\r");
    await next;
    next = t.frame("Saved to .tickmarkr/config.yaml.");
    t.input.write("y");
    await next;
    t.input.write("q");
    expect(await done).toBe("fleet: saved .tickmarkr/config.yaml");
    expect(overlay()).toContain("pool:");
    expect(t.text()).toContain("acceptance (judge)");
    expect(readDismissed(cwd).size).toBe(1);
  });
  test("a no is remembered at once and u forgets it at once: the item is asked again", async () => {
    const { run, cwd } = setup();
    const t = terminal();
    const done = run([], { input: t.input as never, output: t.output as never });
    await t.frame("NEEDS YOU (2)");
    let next = t.frame("NEEDS YOU (1)");
    t.input.write("n");
    await next;
    expect(readDismissed(cwd).size).toBe(1);
    next = t.frame("NEEDS YOU (2)");
    t.input.write("u");
    await next;
    expect(readDismissed(cwd).size).toBe(0);
    t.input.write("q");
    expect(await done).toBe("fleet: nothing changed");
  });
  test("a no that cannot be written down is said in one line and does not end the screen", async () => {
    const { run, cwd } = setup();
    const dir = join(cwd, ".tickmarkr");
    const t = terminal();
    const done = run([], { input: t.input as never, output: t.output as never });
    await t.frame("NEEDS YOU (2)");
    chmodSync(dir, 0o555);
    try {
      // the answer holds for this screen, and the screen says the file could not take it
      let next = t.frame("could not be written down");
      t.input.write("n");
      await next;
      expect(t.text()).toContain("NEEDS YOU (1)");
      // undoing it is just as safe
      next = t.frame("NEEDS YOU (2)");
      t.input.write("u");
      await next;
    } finally { chmodSync(dir, 0o755); }
    t.input.write("q");
    expect(await done).toBe("fleet: nothing changed");
    expect(readDismissed(cwd).size).toBe(0);
  });
  test("an error inside a key press leaves through the screen's own exit, not as a crash in the key handler", async () => {
    const { cwd, globalDir } = setup();
    const source = loadFleetSource(cwd, { globalDir, adapters });
    // a fault injected where the mount reads the remembered answers, armed after the first frame
    let armed = false;
    const ctx = source.ctx;
    const faulty = { ...source, ctx: new Proxy(ctx, { get: (target, prop, receiver) => { if (armed && prop === "dismissed") throw new Error("injected fault"); return Reflect.get(target, prop, receiver) as unknown; } }) };
    const t = terminal();
    const { runFleetScreen } = await import("../../src/tui/ink/fleet-screen.js");
    // the screen draws as soon as it is mounted, so the wait is set up first
    const first = t.frame("NEEDS YOU");
    const done = runFleetScreen({ source: faulty, input: t.input as never, output: t.output as never });
    await first;
    armed = true;
    t.input.write("n");
    // the promise the command awaits is rejected with the error, so its cleanup runs and the command reports it
    await expect(done).rejects.toThrow("injected fault");
  });
  test("several keys in one chunk are applied in order, and a chunk can never save", async () => {
    const { run, cwd } = setup();
    const t = terminal();
    const done = run([], { input: t.input as never, output: t.output as never });
    await t.frame("NEEDS YOU");
    // yes to the first item, open the review, and a y that would save: all in one chunk
    const next = t.frame("Press y to save.");
    t.burst("y\ry");
    await next;
    expect(t.text()).toContain("WHAT CHANGES");
    expect(existsSync(join(cwd, ".tickmarkr", "config.yaml"))).toBe(false);
    // the same y on its own saves
    const saved = t.frame("Saved to .tickmarkr/config.yaml.");
    t.input.write("y");
    await saved;
    t.input.write("q");
    expect(await done).toBe("fleet: saved .tickmarkr/config.yaml");
  });
  test("q with a yes not yet saved warns once and quits on the second q, writing nothing", async () => {
    const { run, cwd } = setup();
    const t = terminal();
    const done = run([], { input: t.input as never, output: t.output as never });
    await t.frame("NEEDS YOU");
    let next = t.frame("answered yes");
    t.input.write("y");
    await next;
    next = t.frame("q again quits without saving");
    t.input.write("q");
    await next;
    t.input.write("q");
    expect(await done).toBe("fleet: quit; 1 change was not saved");
    expect(existsSync(join(cwd, ".tickmarkr", "config.yaml"))).toBe(false);
  });
});
