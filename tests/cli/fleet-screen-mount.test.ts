// `tickmarkr fleet` on a real mount: keys through the Ink screen to the file.
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { dismissNeed, loadFleetSource, readDismissed, restoreNeed } from "../../src/fleet/load.js";
import { arrowsTo, open, toItem } from "../fleet/drive.js";
import { derive, frame, homeTargets, initialScreen, press, type ScreenState } from "../../src/fleet/screen.js";
import { tiny, tooSmall } from "../../src/fleet/one-screen.js";
import { runFleetScreen } from "../../src/tui/ink/fleet-screen.js";
import { adapters, setup, strip, terminal } from "./fleet-screen-world.js";

/** Down arrows from the mode to the first item: the one cursor moves over one list (row 499; D-2187 add.363). */
const toFirstItem = (cwd: string, globalDir: string) => arrowsTo(loadFleetSource(cwd, { globalDir, adapters }), (t) => t.startsWith("item:"));
/** Both config files as bytes (null where there is none): they keep them until the save's Enter. */
const configBytes = (cwd: string, globalDir: string) => [join(cwd, ".tickmarkr", "config.yaml"), join(globalDir, "config.yaml")].map((p) => (existsSync(p) ? readFileSync(p, "utf8") : null));
const NORMAL = { cols: 100, rows: 30 };
const words = (s: string) => strip(s).replace(/\s+/g, " ").trim();
const frameWords = (src: Parameters<typeof frame>[0], st: ScreenState, size = NORMAL) => words(frame(src, st, size.cols, size.rows).map((l) => l.map((s) => s.text).join("")).join("\n"));

/** A real resize emitter and the last complete terminal frame, rather than the history of all frames. */
function resizingTerminal() {
  const t = terminal(), events = new EventEmitter();
  let last = "";
  const waiters = new Set<() => void>();
  // `shown` waits for a frame written after it is asked for: two sizes can draw the same words, and a
  // key sent before the repaint is not acted on (D-2187 add.400)
  const waitFor = (accept: (shown: string) => boolean, now = true) => new Promise<void>((resolve, reject) => {
    if (now && accept(words(last))) return resolve();
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`expected frame did not appear; last frame: ${words(last)}`)); }, 8000);
    const check = () => { if (accept(words(last))) { clearTimeout(timer); waiters.delete(check); resolve(); } };
    waiters.add(check);
  });
  const write = t.output.write;
  Object.assign(t.output, { on: events.on.bind(events), off: events.off.bind(events), removeListener: events.removeListener.bind(events),
    write: (chunk: string) => { if (strip(chunk).includes("\n") && strip(chunk).trim()) { last = strip(chunk); for (const check of waiters) check(); } return write(chunk); } });
  return { ...t, last: () => words(last), shown: (expected: string) => waitFor((f) => f === expected, false),
    changed: () => { const before = words(last); return waitFor((f) => f !== before); }, resize: (size: { cols: number; rows: number }) => {
    Object.assign(t.output, { columns: size.cols, rows: size.rows });
    events.emit("resize");
  } };
}

/** Both saved files have bytes to preserve; the yes is made through press(), never a fabricated pending count. */
function quitWorld() {
  const w = setup({ repo: "routing:\n  deny:\n    adapters: [agy]\n" });
  writeFileSync(join(w.globalDir, "config.yaml"), "# saved user settings\n");
  const src = loadFleetSource(w.cwd, { globalDir: w.globalDir, adapters });
  const yes = press(src, toItem(src, 0), "y").state;
  expect(derive(src, yes).said).toHaveLength(1);
  const choose = (base: ScreenState, kept: boolean) => {
    const targets = homeTargets(src, base, NORMAL);
    // KEPT OUT: a rule's own line opened (row 500); the + of 2.26.1 asked which list, and now opens the models view, where q searches
    const sel = targets.findIndex((id) => kept ? id === "kept:routing.deny.adapters" : id.startsWith("shapes:") && id.includes(","));
    expect(sel).toBeGreaterThan(0);
    return press(src, { ...base, sel }, "enter", NORMAL).state;
  };
  return { ...w, src, yes, choose };
}

describe("the real mount", () => {
  // Replay all three executed findings first (row 499; D-2187 add.397), through FleetScreen.apply().
  test.each([["grouped-shape", false, "open which?"], ["KEPT OUT rule", true, "x remove this rule"]] as const)("q with pending changes in the %s view displays its confirmation and s opens the save", async (_name, kept, shown) => {
    const w = quitWorld(), t = resizingTerminal(), before = configBytes(w.cwd, w.globalDir);
    const first = t.frame(shown);
    const done = runFleetScreen({ source: w.src, resume: w.choose(w.yes, kept), input: t.input as never, output: t.output as never });
    try {
      await first;
      const warning = t.frame("q again quits without saving");
      t.input.write("q");
      await warning;
      expect(t.last()).toContain("1 change is not saved. q again quits without saving; s reviews.");
      expect(t.last()).not.toContain(shown);
      expect(configBytes(w.cwd, w.globalDir)).toEqual(before);
      const save = t.frame("YOU ARE SAVING");
      t.input.write("s");
      await save;
      expect(configBytes(w.cwd, w.globalDir)).toEqual(before);
      const again = t.frame("q again quits without saving");
      t.input.write("q");
      await again;
      t.input.write("q");
      expect(await done).toEqual({ kind: "quit", unsaved: 1 });
    } finally { t.input.write("qq"); await done; }
    expect(configBytes(w.cwd, w.globalDir)).toEqual(before);
  });

  test("q after a real resize from 100 by 30 to 30 by 8 exits at once and reports the unsaved change", async () => {
    const w = setup(), t = resizingTerminal(), before = configBytes(w.cwd, w.globalDir);
    const done = w.run([], { input: t.input as never, output: t.output as never });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await t.frame("NEEDS YOU");
      const pending = t.frame("NOT SAVED");
      t.input.write(`${toFirstItem(w.cwd, w.globalDir)}y`);
      await pending;
      const small = t.shown(`${tooSmall(30, 8)} q quit`);
      t.resize({ cols: 30, rows: 8 });
      await small;
      expect(t.last()).toBe(`${tooSmall(30, 8)} q quit`);
      t.input.write("q");
      expect(await Promise.race([done, new Promise((resolve) => { deadline = setTimeout(() => resolve("still waiting for an invisible confirmation"), 1000); })])).toBe("fleet: quit; 1 change was not saved");
    } finally { clearTimeout(deadline); t.input.write("qq"); await done; }
    expect(configBytes(w.cwd, w.globalDir)).toEqual(before);
  });

  test("every view keeps quit and save tied to the visible frame, with or without pending changes, across window sizes and resizes", async () => {
    // Bounded cross product for the whole input class (D-2187 add.397): all seven views, both pending
    // states, all three sizes, both sides of the minimum, and a round trip while a question is pending.
    const w = quitWorld(), before = configBytes(w.cwd, w.globalDir);
    const min = { cols: 80, rows: 20 }, small = { cols: 30, rows: 8 };
    const routes = [[NORMAL], [min], [small], [NORMAL, min], [min, small], [small, NORMAL], [NORMAL, small, NORMAL]];
    let checked = 0;
    for (const pending of [false, true]) {
      const base = pending ? w.yes : initialScreen();
      const views: Array<[string, ScreenState]> = [["one screen", base], ["shapes", w.choose(base, false)], ["KEPT OUT", w.choose(base, true)],
        ["opened line", open(w.src, "judge", base)], ["opened item", press(w.src, toItem(w.src, 1, base), "enter").state],
        ["help", press(w.src, base, "?").state], ["save", { ...base, view: "save" }]];
      for (const [view, resume] of views) for (const route of routes) {
        const where = `${view}; ${pending ? 1 : 0} pending; ${route.map((s) => `${s.cols}x${s.rows}`).join(" → ")}`;
        const t = resizingTerminal();
        Object.assign(t.output, { columns: route[0].cols, rows: route[0].rows });
        const first = t.shown(frameWords(w.src, resume, route[0]));
        const done = runFleetScreen({ source: w.src, resume, input: t.input as never, output: t.output as never });
        let ended = false;
        void done.then(() => { ended = true; }, () => { ended = true; });
        try {
          await first;
          for (const size of route.slice(1)) {
            const resized = t.shown(frameWords(w.src, resume, size));
            // Real dimensions may change before the resize event and the repaint. Keys during
            // that interval must use neither the old cursor nor the unseen new one (add.397).
            Object.assign(t.output, { columns: size.cols, rows: size.rows });
            t.burst("ynurs\r");
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(ended, where).toBe(false);
            t.resize(size);
            await resized;
          }
          const size = route.at(-1)!;
          if (size === small) {
            expect(t.last(), where).toBe(`${tooSmall(30, 8)} q quit`);
            // No key behind the sentence changes a view, answers, saves, undoes, or probes.
            t.burst("\x1b[B\x1b[Aysunr?\r \x03 \x1b");
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(ended, where).toBe(false);
            expect(t.last(), where).toBe(`${tooSmall(30, 8)} q quit`);
          }
          if (!pending || size === small) {
            t.input.write("q");
            expect(await done, where).toEqual({ kind: "quit", unsaved: pending ? 1 : 0 });
          } else {
            // Even qq in one input event cannot discard before its question has appeared.
            const warning = t.frame("q again quits without saving");
            t.burst("qq");
            await warning;
            expect(ended, where).toBe(false);
            expect(t.last(), where).toContain("1 change is not saved. q again quits without saving; s reviews.");
            expect(t.last(), where).not.toContain("open which?");
            expect(t.last(), where).not.toContain("nothing is written yet");
            if (route.length === 3) {
              // A pending question is cancelled when it cannot be drawn; after growing, a new q
              // must show it again, rather than accepting a confirmation the small frame hid.
              let resized = t.shown(`${tooSmall(30, 8)} q quit`);
              t.resize(small);
              await resized;
              expect(t.last(), where).toBe(`${tooSmall(30, 8)} q quit`);
              resized = t.shown(frameWords(w.src, { ...resume, view: "home", choose: null, pick: null, item: null, scroll: 0, msg: "" }));
              t.resize(NORMAL);
              await resized;
              expect(t.last(), where).not.toContain("q again quits without saving");
              const again = t.frame("q again quits without saving");
              t.input.write("q");
              await again;
              expect(ended, where).toBe(false);
            }
            // Enter acts on home, never the save that q closed to show its question.
            const opened = t.changed();
            t.input.write("\r");
            await opened;
            expect(ended, where).toBe(false);
            expect(t.last(), where).not.toContain("nothing is written yet");
            // Escape back home; s opens review, and Enter in that event still cannot save it.
            const home = t.shown(frameWords(w.src, { ...resume, view: "home", choose: null, pick: null, item: null, scroll: 0, msg: "" }, size));
            t.input.write("\x1b");
            await home;
            const review = t.frame("Press Enter to save.");
            t.burst("s\r");
            await review;
            expect(ended, where).toBe(false);
            expect(t.last(), where).toContain("YOU ARE SAVING");
            expect(t.last(), where).toContain("Enter save");
            expect(configBytes(w.cwd, w.globalDir), where).toEqual(before);
            if (view === "save") {
              // A standalone Enter is allowed only after that review frame was presented.
              t.input.write("\r");
              expect(await done, where).toMatchObject({ kind: "save", touched: ["repo"] });
            } else {
              const again = t.frame("q again quits without saving");
              t.input.write("q");
              await again;
              t.input.write("q");
              expect(await done, where).toEqual({ kind: "quit", unsaved: 1 });
            }
          }
          expect(configBytes(w.cwd, w.globalDir), where).toEqual(before);
          checked++;
        } finally {
          // Leave no mounted app or input bridge behind if any assertion fails.
          // q acts only once the small window's frame is the one on screen (D-2187 add.400)
          if (!ended) { const shown = t.shown(`${tooSmall(30, 8)} q quit`); t.resize(small); await shown; t.input.write("q"); await done; }
        }
      }
    }
    expect(checked).toBe(98);
  }, 60_000);

  // D-2187 add.400: a key acts only bare, and the frame on screen decides. The reviewer's reproducers first.
  const SMALL = { cols: 30, rows: 8 }, MIN = { cols: 80, rows: 20 }, UNDER = { cols: 79, rows: 20 };
  const sentence = (size: { cols: number; rows: number }) => `${tooSmall(size.cols, size.rows)} q quit`;
  const dismissedBytes = (cwd: string) => { const p = join(cwd, ".tickmarkr", "fleet-answers.json"); return existsSync(p) ? readFileSync(p, "utf8") : null; };
  /** A mount of the screen on `resume` with the product's own dismissal writers, and a way to end it whatever it shows. */
  async function mount(w: ReturnType<typeof quitWorld>, resume: ScreenState, size = NORMAL) {
    const t = resizingTerminal();
    Object.assign(t.output, { columns: size.cols, rows: size.rows });
    const first = t.shown(frameWords(w.src, resume, size));
    const done = runFleetScreen({ source: w.src, resume, input: t.input as never, output: t.output as never,
      onDismiss: (need) => dismissNeed(w.cwd, need), onRestore: (signature) => restoreNeed(w.cwd, signature) });
    let ended = false;
    void done.then(() => { ended = true; }, () => { ended = true; });
    await first;
    const close = async () => {
      if (ended) return;
      const small = t.shown(sentence(SMALL));
      t.resize(SMALL);
      await small;
      t.input.write("q");
      await done;
    };
    return { t, done, ended: () => ended, close };
  }
  const settle = () => new Promise((r) => setTimeout(r, 40));
  const viewsOf = (w: ReturnType<typeof quitWorld>): Array<[string, ScreenState]> => [["one screen", w.yes], ["shapes", w.choose(w.yes, false)], ["KEPT OUT", w.choose(w.yes, true)],
    ["opened line", open(w.src, "judge", w.yes)], ["opened item", press(w.src, toItem(w.src, 1, w.yes), "enter").state], ["help", press(w.src, w.yes, "?").state], ["save", { ...w.yes, view: "save" }]];

  // the review of T11 (row 498; D-2187 add.408): in the models view q searches, and Ctrl+C keeps its own quit and its confirmation
  test("in the models view q searches; Ctrl+C quits, and asks first when changes are pending", async () => {
    const w = quitWorld(), before = configBytes(w.cwd, w.globalDir);
    const modelsOf = (st: ScreenState): ScreenState => ({ ...open(w.src, "implement", st), view: "models", models: { cli: 0, at: 0, query: "" } });
    const clean = await mount(w, modelsOf(initialScreen()));
    try {
      const typed = clean.t.frame("search: q");
      clean.t.input.write("q");
      await typed;
      expect(clean.ended()).toBe(false);
      clean.t.input.write("\x03");
      expect(await clean.done).toEqual({ kind: "quit", unsaved: 0 });
    } finally { await clean.close(); }
    const pending = await mount(w, modelsOf(w.yes));
    try {
      const asked = pending.t.frame("q again quits without saving");
      pending.t.input.write("\x03");
      await asked;
      expect(pending.ended()).toBe(false);
      pending.t.input.write("\x03");
      expect(await pending.done).toEqual({ kind: "quit", unsaved: 1 });
    } finally { await pending.close(); }
    expect(configBytes(w.cwd, w.globalDir)).toEqual(before);
  });

  test("Esc and Enter in one chunk on the save's view go back and never save", async () => {
    const w = quitWorld(), before = configBytes(w.cwd, w.globalDir);
    const m = await mount(w, { ...w.yes, view: "save" });
    try {
      const home = m.t.shown(frameWords(w.src, w.yes));
      m.t.burst("\x1b\r");
      await home;
      expect(m.ended()).toBe(false);
      expect(configBytes(w.cwd, w.globalDir)).toEqual(before);
    } finally { await m.close(); }
  });

  test("Esc+q, Alt+q and Ctrl+Q never confirm a quit question that is shown", async () => {
    const w = quitWorld(), before = configBytes(w.cwd, w.globalDir);
    const m = await mount(w, w.yes);
    try {
      for (const raw of ["\x1bq", "\x11", "\x1b\x11"]) {
        const asked = m.t.frame("q again quits without saving");
        m.t.input.write("q");
        await asked;
        m.t.burst(raw);
        await settle();
        expect(m.ended(), JSON.stringify(raw)).toBe(false);
        // Esc+q (Alt+q) is Esc alone: the question is withdrawn; Ctrl+Q does nothing
        if (raw === "\x1bq") expect(m.t.last()).not.toContain("q again quits without saving");
        else {
          expect(m.t.last()).toContain("q again quits without saving");
          const home = m.t.shown(frameWords(w.src, w.yes));
          m.t.input.write("\x1b");
          await home;
        }
      }
      expect(configBytes(w.cwd, w.globalDir)).toEqual(before);
    } finally { await m.close(); }
  });

  test("Ctrl+N and Esc+n on an item dismiss nothing and write no dismissal", async () => {
    const w = quitWorld(), item = toItem(w.src, 1, w.yes);
    const m = await mount(w, item);
    try {
      for (const raw of ["\x0e", "\x1bn", "\x19", "\x1by"]) { m.t.burst(raw); await settle(); }
      expect(m.ended()).toBe(false);
      expect(dismissedBytes(w.cwd)).toBeNull();
      expect(readDismissed(w.cwd).size).toBe(0);
    } finally { await m.close(); }
  });

  test.each([["shrinks from 100 by 30 to 30 by 8", NORMAL, SMALL], ["grows from 30 by 8 to 100 by 30", SMALL, NORMAL],
    ["shrinks from 80 by 20 to 79 by 20", MIN, UNDER], ["grows from 79 by 20 to 80 by 20", UNDER, MIN]] as const)(
    "q pressed before the repaint when the window %s acts as the shown frame says, in every view", async (_name, from, to) => {
      const w = quitWorld(), before = configBytes(w.cwd, w.globalDir);
      for (const [view, resume] of viewsOf(w)) {
        const m = await mount(w, resume, from);
        try {
          Object.assign(m.t.output, { columns: to.cols, rows: to.rows });
          m.t.input.write("q");
          if (tiny(from.cols, from.rows)) {
            // the frame shown says "q quit": q quits at once and reports the unsaved change
            expect(await m.done, view).toEqual({ kind: "quit", unsaved: 1 });
          } else {
            // the frame shown asked nothing: q before the repaint neither quits nor discards
            await settle();
            expect(m.ended(), view).toBe(false);
            const small = m.t.shown(sentence(to));
            m.t.resize(to);
            await small;
            m.t.input.write("q");
            expect(await m.done, view).toEqual({ kind: "quit", unsaved: 1 });
          }
          expect(configBytes(w.cwd, w.globalDir), view).toEqual(before);
        } finally { await m.close(); }
      }
    }, 60_000);

  test("Ctrl and Alt keys and Esc in a chunk never save, discard, dismiss or quit, in every view and at every size", async () => {
    // Bounded: every view with a pending change, every raw form the reviewer listed, at 100 by 30, 80 by 20 and 30 by 8,
    // and once more on the shown quit question.
    const RAW = ["\x1b\r", "\x1bq", "\x11", "\x19", "\x0e", "\x13", "\x15", "\x12", "\x1by", "\x1bn", "\x1bs", "\x1bu", "\x1br",
      "\x1b\x11", "\x1b\x19", "\x1b\x0e", "\x1b\x13", "\x1b\x15", "\x1b\x12", "\x03"];
    const w = quitWorld(), before = configBytes(w.cwd, w.globalDir);
    let checked = 0;
    for (const size of [NORMAL, MIN, SMALL]) for (const [view, resume] of viewsOf(w)) for (const asked of [false, true]) {
      if (asked && (view !== "one screen" || size === SMALL)) continue;
      const m = await mount(w, resume, size);
      try {
        if (asked) { const q = m.t.frame("q again quits without saving"); m.t.input.write("q"); await q; }
        for (const raw of RAW) {
          // Ctrl+C is the ruled exception (q's confirmation, as today) except on the small window's frame, where it does nothing
          if (raw === "\x03" && size !== SMALL) continue;
          m.t.burst(raw);
          await settle();
          const where = `${view} ${size.cols}x${size.rows} ${asked ? "asked " : ""}${JSON.stringify(raw)}`;
          expect(m.ended(), where).toBe(false);
          expect(configBytes(w.cwd, w.globalDir), where).toEqual(before);
          expect(dismissedBytes(w.cwd), where).toBeNull();
          if (size === SMALL) expect(m.t.last(), where).toBe(sentence(SMALL));
          checked++;
        }
      } finally { await m.close(); }
    }
    expect(checked).toBeGreaterThan(400);
  }, 120_000);

  test("the dismissal file the product writes is the one these tests read", () => {
    // the reviewer's reproducer: dismissNeed writes fleet-answers.json, so an assertion on any other path is vacuous
    const w = quitWorld();
    expect(dismissedBytes(w.cwd)).toBeNull();
    dismissNeed(w.cwd, derive(w.src, initialScreen()).items[0]);
    expect(readDismissed(w.cwd).size).toBe(1);
    expect(dismissedBytes(w.cwd)).not.toBeNull();
  });

  test("raw chunks with an Esc, a control byte or an unknown sequence never save, confirm a quit, dismiss or quit the small window", async () => {
    // The reviewer's reproducers (D-2187 add.400), bounded: every raw form in the views and sizes it named.
    const w = quitWorld(), before = configBytes(w.cwd, w.globalDir);
    const SAVE = ["\x1b\n", "\x1b\r", "\x1b\x11\r", "\x1b\x11\n", "\x1b\x03\r", "\x1b[1;5A\r", "\x1bOa\r", "\x1b[C\r", "\x11\r", "\x11\n", "\x03\r", "\t\r", "\x7f\r", "\b\r", "\x00\r", "\r\x11"];
    const QUIT = ["\x1b\x11q", "\x1b\x00q", "\x1b\x11\x03", "\x1b[1;5Aq", "\x1bOaq", "\x1b[Eq", "\x11q", "\x03q", "\tq", "\x7fq", "\x1baq", "\x1bqq", "\x1b\x1bq", "\x1bOq", "\x1b[q", "\x1b[200~q\x1b[201~", "\x1b[1;5q"];
    const DISMISS = ["\x1ban", "\x1bqn", "\x1b\x1bn", "\x1b\x11n", "\x1bOn", "\x1b[n", "\x1b[0n", "\x1b[1;5n", "\x1b[1;5y", "\x1bar", "\x1bOr", "\x1b[r", "\x1bau", "\x1bOu", "\x1b[u"];
    let checked = 0;
    const still = (m: Awaited<ReturnType<typeof mount>>, where: string) => {
      expect(m.ended(), where).toBe(false);
      expect(configBytes(w.cwd, w.globalDir), where).toEqual(before);
      expect(dismissedBytes(w.cwd), where).toBeNull();
      checked++;
    };
    for (const size of [NORMAL, MIN]) {
      let m = await mount(w, { ...w.yes, view: "save" }, size);
      try { for (const raw of SAVE) { m.t.burst(raw); await settle(); still(m, `save ${size.cols}x${size.rows} ${JSON.stringify(raw)}`); } } finally { await m.close(); }
      m = await mount(w, w.yes, size);
      try {
        for (const raw of QUIT) {
          const asked = m.t.frame("q again quits without saving");
          m.t.input.write("q");
          await asked;
          m.t.burst(raw);
          await settle();
          still(m, `asked ${size.cols}x${size.rows} ${JSON.stringify(raw)}`);
          m.t.input.write("\x1b");
          await settle();
        }
      } finally { await m.close(); }
      for (const [view, st] of [["one screen", toItem(w.src, 1, w.yes)], ["opened item", press(w.src, toItem(w.src, 1, w.yes), "enter").state]] as const) {
        m = await mount(w, st, size);
        try { for (const raw of DISMISS) { m.t.burst(raw); await settle(); still(m, `${view} ${size.cols}x${size.rows} ${JSON.stringify(raw)}`); } } finally { await m.close(); }
      }
    }
    for (const size of [SMALL, UNDER, { cols: 80, rows: 19 }]) for (const [view, st] of viewsOf(w)) {
      const m = await mount(w, st, size);
      try { for (const raw of QUIT) { m.t.burst(raw); await settle(); still(m, `${view} ${size.cols}x${size.rows} ${JSON.stringify(raw)}`); } } finally { await m.close(); }
    }
    expect(checked).toBeGreaterThan(400);
  }, 180_000);

  test("arrow keys, Enter, yes, no, the review and the save run through the Ink screen to the file", async () => {
    const { run, overlay, cwd, globalDir } = setup();
    const t = terminal();
    const done = run([], { input: t.input as never, output: t.output as never });
    await t.frame("NEEDS YOU");
    // the first item, reached with real arrow-key sequences, opened with Enter
    let next = t.frame("A YES NEVER TOUCHES");
    t.input.write(`${toFirstItem(cwd, globalDir)}\r`);
    await next;
    next = t.frame("NOT SAVED");
    t.input.write("y");
    await next;
    // the next item is the model that did not answer: not now
    next = t.frame("not asked again");
    t.input.write("\x1b[Bn");
    await next;
    next = t.frame("YOU ARE SAVING");
    t.input.write("s");
    await next;
    // every key before the save's Enter, y among them, leaves both config files their bytes
    const before = configBytes(cwd, globalDir);
    expect(before).toEqual([null, null]);
    t.input.write("y");
    await new Promise((r) => setTimeout(r, 100));
    expect(configBytes(cwd, globalDir)).toEqual(before);
    next = t.frame("Saved to .tickmarkr/config.yaml.");
    t.input.write("\r");
    await next;
    t.input.write("q");
    expect(await done).toBe("fleet: saved .tickmarkr/config.yaml");
    expect(overlay()).toContain("pool:");
    expect(t.text()).toContain("acceptance (judge)");
    expect(readDismissed(cwd).size).toBe(1);
  });
  test("a no is remembered at once and u forgets it at once: the item is asked again", async () => {
    const { run, cwd, globalDir } = setup();
    const t = terminal();
    const done = run([], { input: t.input as never, output: t.output as never });
    await t.frame("NEEDS YOU (2)");
    let next = t.frame("NEEDS YOU (1)");
    t.input.write(`${toFirstItem(cwd, globalDir)}n`);
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
    const { run, cwd, globalDir } = setup();
    const dir = join(cwd, ".tickmarkr");
    const t = terminal();
    const done = run([], { input: t.input as never, output: t.output as never });
    await t.frame("NEEDS YOU (2)");
    chmodSync(dir, 0o555);
    try {
      // the answer holds for this screen, and the screen says the file could not take it
      let next = t.frame("could not be written down");
      t.input.write(`${toFirstItem(cwd, globalDir)}n`);
      await next;
      expect(t.text()).toContain("NEEDS YOU (1)");
      // the two-row message moves no cursor place: Enter opens the item the drawn ▸ is on
      const shown = t.text().split("\n");
      const title = shown.filter((l) => l.includes("could not be written down")).length && shown.findLast((l) => /▸ +\d+ +\S/.test(l))!.replace(/^.*▸ +\d+ +/, "").trim();
      expect(title).toBeTruthy();
      next = t.frame("Esc later");
      t.input.write("\r");
      await next;
      expect(t.text().split("Esc later").at(-2)).toContain(title as string);
      next = t.frame("NEEDS YOU (1)");
      t.input.write("\x1b");
      await next;
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
    const arrows = toFirstItem(cwd, globalDir);
    armed = true;
    t.input.write(`${arrows}n`);
    // the promise the command awaits is rejected with the error, so its cleanup runs and the command reports it
    await expect(done).rejects.toThrow("injected fault");
  });
  test("a save that arrives inside a chunk of several keys is held; the screen says Press Enter to save", async () => {
    const { run, cwd, globalDir } = setup();
    const t = terminal();
    const done = run([], { input: t.input as never, output: t.output as never });
    await t.frame("NEEDS YOU");
    // to the first item, yes to it, open the save with s, and an Enter that would save: all in one chunk; the keys before it apply in order
    const next = t.frame("Press Enter to save.");
    t.burst(`${toFirstItem(cwd, globalDir)}ys\r`);
    await next;
    expect(t.text()).toContain("YOU ARE SAVING");
    expect(existsSync(join(cwd, ".tickmarkr", "config.yaml"))).toBe(false);
    // the same Enter on its own saves
    const saved = t.frame("Saved to .tickmarkr/config.yaml.");
    t.input.write("\r");
    await saved;
    t.input.write("q");
    expect(await done).toBe("fleet: saved .tickmarkr/config.yaml");
  });
  test("q with a yes not yet saved warns once and quits on the second q, writing nothing", async () => {
    const { run, cwd, globalDir } = setup();
    const t = terminal();
    const done = run([], { input: t.input as never, output: t.output as never });
    await t.frame("NEEDS YOU");
    let next = t.frame("NOT SAVED");
    t.input.write(`${toFirstItem(cwd, globalDir)}y`);
    await next;
    next = t.frame("q again quits without saving");
    t.input.write("q");
    await next;
    t.input.write("q");
    expect(await done).toBe("fleet: quit; 1 change was not saved");
    expect(existsSync(join(cwd, ".tickmarkr", "config.yaml"))).toBe(false);
  });
  test("a real mount at 30 columns by 8 rows shows only the sentence asking for a larger window", async () => {
    const { run, cwd } = setup();
    const t = terminal();
    // the terminal's real size reaches the screen: it is not rounded up to 40 by 12
    Object.assign(t.output, { columns: 30, rows: 8 });
    const frames: string[] = [];
    const write = t.output.write;
    t.output.write = (chunk: string) => { frames.push(chunk); return write(chunk); };
    const done = run([], { input: t.input as never, output: t.output as never });
    await t.frame("q quit");
    const words = (f: string) => strip(f).replace(/\s+/g, " ").trim();
    expect(words(frames.filter((f) => strip(f).includes("q quit")).at(-1)!)).toBe(`${tooSmall(30, 8)} q quit`);
    // no key but q does anything: nothing moves, opens, answers or saves
    const before = frames.length;
    t.input.write("\x1b[Bysu\r");
    await new Promise((r) => setTimeout(r, 200));
    for (const f of frames.slice(before)) if (strip(f).trim()) expect(words(f)).toBe(`${tooSmall(30, 8)} q quit`);
    t.input.write("q");
    expect(await done).toBe("fleet: nothing changed");
    expect(existsSync(join(cwd, ".tickmarkr", "config.yaml"))).toBe(false);
  });
});
