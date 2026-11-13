// `tickmarkr fleet`, the command: what it prints without a terminal, the answer path, and the
// probe / save loop around the interactive screen. Stub adapters, a hand-written doctor.json.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { allAdapters, readDoctor, readModelsFirstSeen, writeDoctor } from "../../src/adapters/registry.js";
import type { AuthHealth } from "../../src/adapters/types.js";
import { fleetCommand, type FleetScreenIO } from "../../src/cli/commands/fleet-screen.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { lastRunDeaths, loadFleetSource, readDismissed } from "../../src/fleet/load.js";
import { makeRepo } from "../helpers/tmprepo.js";

const adapters = allAdapters({ operatorYaml: null, operatorPath: false });
function health(dead: string[] = [], extra: Record<string, string[]> = {}): Record<string, AuthHealth> {
  const out: Record<string, AuthHealth> = {};
  for (const [adapter, t] of Object.entries(DEFAULT_CONFIG.tiers)) {
    const models = [...Object.keys(t.models), ...(extra[adapter] ?? [])];
    out[adapter] = { installed: true, authed: true, models, modelAuth: Object.fromEntries(models.map((m) => [m, dead.includes(`${adapter}:${m}`)
      ? { authed: false, reason: "probe timed out (60000ms)", probedAt: new Date().toISOString() } : { authed: true, probedAt: new Date().toISOString() }])) };
  }
  return out;
}
function setup(opts: { repo?: string; dead?: string[]; probe?: boolean } = {}) {
  const cwd = makeRepo({ "keep.txt": "x" });
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-fleet-screen-"));
  mkdirSync(join(cwd, ".tickmarkr"), { recursive: true });
  if (opts.repo) writeFileSync(join(cwd, ".tickmarkr", "config.yaml"), opts.repo);
  if (opts.probe !== false) writeDoctor(cwd, health(opts.dead ?? ["claude-code:fable"]));
  const run = (argv: string[], io: FleetScreenIO = {}) => fleetCommand([...argv, "--global-dir", globalDir], cwd, adapters, { input: Object.assign(new PassThrough(), { isTTY: false }) as never, output: { isTTY: false, write: () => true }, ...io });
  return { cwd, globalDir, run, overlay: () => readFileSync(join(cwd, ".tickmarkr", "config.yaml"), "utf8") };
}
const tty = { input: Object.assign(new PassThrough(), { isTTY: true }) as never, output: { isTTY: true, write: () => true } };

describe("tickmarkr fleet in a linked worktree with no config of its own", () => {
  test("the review says the save writes a copy here and stops following the main checkout; the main file is never written", async () => {
    const mainYaml = "# the main checkout's\nreview:\n  required: true   # kept\n";
    const { cwd: main, globalDir } = setup({ repo: mainYaml });
    const linked = join(main, ".claude", "worktrees", "session");
    execFileSync("git", ["worktree", "add", "--detach", linked, "HEAD"], { cwd: main });
    writeDoctor(linked, health(["claude-code:fable"]));
    const run = (argv: string[]) => fleetCommand([...argv, "--global-dir", globalDir], linked, adapters, { input: Object.assign(new PassThrough(), { isTTY: false }) as never, output: { isTTY: false, write: () => true } as never });
    const mainFile = join(realpathSync(main), ".tickmarkr", "config.yaml");
    expect(loadFleetSource(linked, { globalDir, adapters }).inherited).toBe(mainFile);
    const id = (JSON.parse(await run(["--json"]) as string).needs as Array<{ id: string; answerable: boolean }>).find((n) => n.answerable)!.id;
    const review = (await run(["--yes", id])) as string;
    // a long path is cut where the row ends, so the sentence is compared without its spaces
    expect(review.replace(/\s+/g, "")).toContain(`This checkout has no config of its own: it reads ${mainFile}. Saving writes a full copy here`.replace(/\s+/g, ""));
    expect(existsSync(join(linked, ".tickmarkr", "config.yaml"))).toBe(false);
    expect(await run(["--yes", id, "--save"])).toContain("Saved to .tickmarkr/config.yaml.");
    // the copy holds the main checkout's lines, and the main checkout's file is as it was
    expect(readFileSync(join(linked, ".tickmarkr", "config.yaml"), "utf8")).toContain("# the main checkout's\nreview:\n  required: true   # kept\n");
    expect(readFileSync(join(main, ".tickmarkr", "config.yaml"), "utf8")).toBe(mainYaml);
    // with a config of its own the checkout reads that, and the review has nothing to warn about
    expect(loadFleetSource(linked, { globalDir, adapters }).inherited).toBeUndefined();
    // a main checkout never inherits
    expect(loadFleetSource(main, { globalDir, adapters }).inherited).toBeUndefined();
  });
});

describe("a probe file left in any state", () => {
  test("a malformed doctor.json never crashes the screen and never reads as working", async () => {
    const good = health([]);
    const each = (f: (h: Record<string, unknown>) => void) => { const d = structuredClone(good) as unknown as Record<string, Record<string, unknown>>; for (const h of Object.values(d)) f(h); return d; };
    const variants: Record<string, unknown> = {
      "no models field": each((h) => { delete h.models; }),
      "models is null": each((h) => { h.models = null; }),
      "modelAuth values are strings": each((h) => { h.modelAuth = Object.fromEntries(Object.keys(h.modelAuth as object).map((m) => [m, "ok"])); }),
      "only installed: false": Object.fromEntries(Object.keys(good).map((k) => [k, { installed: false }])),
      "an adapter is null, another a string": { ...structuredClone(good), codex: null, "claude-code": "broken" },
      "identity is a number, reason is a number": each((h) => { for (const v of Object.values(h.modelAuth as Record<string, Record<string, unknown>>)) { v.identity = 7; v.reason = 404; v.authed = false; } }),
      "probedAt is not a date": each((h) => { for (const v of Object.values(h.modelAuth as Record<string, Record<string, unknown>>)) v.probedAt = "not a date"; }),
      "the first-seen record is malformed": { ...structuredClone(good), modelsFirstSeen: { omp: { "google/gemini-4-carbon": 12345, x: null }, codex: "soon", qwen: ["a"] } },
      "an array": [1, 2, 3],
      "a string": "nothing here",
    };
    for (const [name, doctor] of Object.entries(variants)) {
      const { run, cwd } = setup({ probe: false });
      writeFileSync(join(cwd, ".tickmarkr", "doctor.json"), JSON.stringify(doctor));
      const out = await run(["--json"]);
      const data = JSON.parse(typeof out === "string" ? out : out.out) as { ok: boolean; working: number; team: Array<{ status: string }> };
      expect(data.ok, name).toBe(true);
      // where the verdicts themselves cannot be read, nothing counts as working
      if (["modelAuth values are strings", "only installed: false", "identity is a number, reason is a number", "an array", "a string"].includes(name)) expect(data.working, name).toBe(0);
      expect(typeof (await run(["--plain"])), name).toBe("string");
    }
    // the other files the screen reads, in the same state: a journal of lines that are not events, a graph
    // that is not one, answers that are not a list
    {
      const { run, cwd } = setup();
      const dir = join(cwd, ".tickmarkr", "runs", "run-20261109-000000-1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "journal.jsonl"), 'null\n5\n"text"\n[1,2]\nnot json\n{"event":"quota-failover","data":null}\n{"event":"quota-failover","data":{"from":7}}\n{"event":"task-dispatch","taskId":7,"data":{"assignment":"x"}}\n');
      writeFileSync(join(dir, "graph.json"), '{"tasks":[null,5,{"id":"T1"}]}');
      writeFileSync(join(cwd, ".tickmarkr", "fleet-answers.json"), '{"no":{"a":1}}');
      expect(lastRunDeaths(cwd)).toEqual([]);
      expect(JSON.parse(await run(["--json"]) as string)).toMatchObject({ ok: true });
    }
    // the well-formed file, for contrast, has working models
    const { run, cwd } = setup({ probe: false });
    writeFileSync(join(cwd, ".tickmarkr", "doctor.json"), JSON.stringify(good));
    expect((JSON.parse(await run(["--json"]) as string) as { working: number }).working).toBeGreaterThan(0);
  });
});

describe("tickmarkr fleet without a terminal", () => {
  test("prints the screen instead of refusing, and --plain prints the same", async () => {
    const { run } = setup();
    const out = await run([]);
    expect(out).toContain(" WORKERS");
    expect(out).toContain("acceptance (judge)");
    expect(out).toContain("First setup: nobody for plan, spec, the judge and the consult.");
    expect(await run(["--plain"])).toBe(out);
  });
  test("--json lists the team and the items a yes can answer", async () => {
    const { run } = setup();
    const data = JSON.parse(await run(["--json"]) as string);
    expect(data).toMatchObject({ ok: true, mode: "risk-based", probed: true });
    expect(data.team.find((r: { line: string }) => r.line === "consult")).toMatchObject({ status: "NO MODEL" });
    expect(data.needs[0]).toMatchObject({ id: "setup", answerable: true });
    expect(data.needs[0].changes.length).toBeGreaterThan(0);
  });
  test("--yes prints the review and saves nothing; --save writes the repo layer through the guarded writer", async () => {
    const { run, cwd, overlay } = setup();
    const preview = await run(["--yes", "setup"]) as string;
    expect(preview).toMatch(/shapes with no model\s+2 → 0\s+better/);
    expect(preview).toContain("Nothing was saved. Add --save to save it.");
    expect(existsSync(join(cwd, ".tickmarkr", "config.yaml"))).toBe(false);
    expect(await run(["--yes", "setup", "--save"])).toContain("Saved to .tickmarkr/config.yaml.");
    expect(overlay()).toContain("pool:");
    // the saved config has nothing left to ask about its team
    expect(JSON.parse(await run(["--json"]) as string).team.every((r: { status: string }) => r.status === "ok")).toBe(true);
  });
  test("--yes refuses an id the fleet does not ask about, and --save needs --yes", async () => {
    const { run } = setup();
    expect(await run(["--yes", "nope"])).toMatchObject({ code: 1 });
    expect(await run(["--save"])).toMatchObject({ code: 1 });
  });
  test("a config that does not load is reported, never drawn over", async () => {
    const { run, cwd } = setup({ repo: "routing:\n  mode: partner-lead\n" });
    // the same words as on a terminal, and a non-zero exit: a script must not read a broken config as fine
    const plain = await run([]) as { out: string; code: number };
    expect(plain.out).toContain("THE CONFIG DOES NOT LOAD");
    expect(plain.code).toBe(1);
    expect(await run(["--plain"])).toEqual(plain);
    const json = await run(["--json"]) as { out: string; code: number };
    expect(JSON.parse(json.out)).toMatchObject({ ok: false });
    expect(json.code).toBe(1);
    // each way of asking names the file the error is in
    expect(plain.out).toMatch(/It is in:\n {2}\.tickmarkr\/config\.yaml\n {2}Correct it there, then open fleet again\./);
    expect(JSON.parse(json.out).in).toEqual([join(cwd, ".tickmarkr", "config.yaml")]);
    expect(await run(["--yes", "setup", "--save"])).toMatchObject({ code: 1, out: expect.stringContaining("It is in .tickmarkr/config.yaml. Correct it there, then open fleet again.") });
    expect(await run(["--yes", "setup"])).toMatchObject({ code: 1 });
  });
  test("a config path with a run of spaces is printed whole by --plain, as --json gives it", async () => {
    const { cwd, globalDir } = setup();
    const dir = join(globalDir, `user${" ".repeat(120)}settings`);
    mkdirSync(dir);
    const r = (argv: string[]) => fleetCommand([...argv, "--global-dir", dir], cwd, adapters, { input: Object.assign(new PassThrough(), { isTTY: false }) as never, output: { isTTY: false, write: () => true } }) as Promise<{ out: string; code: number }>;
    writeFileSync(join(dir, "config.yaml"), "routing:\n  mode: partner-lead\n");
    const file = JSON.parse((await r(["--json"])).out).in[0] as string;
    expect(file).toContain(" ".repeat(120));
    const rows = (await r([])).out.split("\n"), a = rows.findIndex((l) => l.trim() === "It is in:"), b = rows.findIndex((l) => l.trim().startsWith("Correct it there"));
    expect(rows.slice(a + 1, b).map((l) => l.slice(2)).join("")).toBe(file);
  });
  test("--print and --pick keep their 2.24.0 command", async () => {
    const { run } = setup();
    expect(await run(["--print"])).toContain("# tickmarkr fleet — effective state");
    expect(await run(["--pick", "consult"])).toMatchObject({ code: 1 });
  });
});

describe("tickmarkr fleet on a terminal", () => {
  test("a save writes and reopens; a probe runs doctor and reopens; a no is remembered; quit reports what was not saved", async () => {
    const { run, cwd, overlay } = setup();
    const seen: string[] = [];
    let probes = 0;
    const out = await run([], { ...tty,
      doctor: (async () => { probes++; return "probed"; }) as never,
      runScreen: async ({ source, note, onDismiss }) => {
        const { derive, initialScreen } = await import("../../src/fleet/screen.js");
        seen.push(note ?? "");
        if (seen.length === 1) {
          const d = derive(source, { ...initialScreen(), yes: ["setup"] });
          // the second item is the model that did not answer: the user says "not now" to it, then saves the setup
          onDismiss?.(d.items[1]);
          return { kind: "save", texts: d.texts!, touched: d.texts!.touched };
        }
        if (seen.length === 2) return { kind: "probe" };
        // with the recommended team saved, nothing is left to ask
        expect(derive(source, initialScreen()).items).toEqual([]);
        return { kind: "quit", unsaved: 2 };
      } });
    expect(seen).toEqual(["", "Saved to .tickmarkr/config.yaml.", "Probed."]);
    expect(probes).toBe(1);
    expect(overlay()).toContain("pool:");
    expect(readDismissed(cwd).size).toBe(1);
    // (this session saved once before it quit: the last line says that too, and names the file)
    expect(out).toBe("fleet: quit; 2 changes were not saved (saved before that: .tickmarkr/config.yaml)");
  });
  test("a probe reopens the screen with what was answered and changed before it, still unsaved", async () => {
    const { run } = setup();
    const seen: Array<{ note: string; yes: string[]; hand: string[] }> = [];
    let probes = 0;
    const out = await run([], { ...tty,
      doctor: (async () => { probes++; return "probed"; }) as never,
      runScreen: async ({ note, resume }) => {
        seen.push({ note: note ?? "", yes: resume?.yes ?? [], hand: (resume?.hand ?? []).map((c) => c.line) });
        // the user answers yes to the setup, changes the judge by hand, and presses r
        if (seen.length === 1) return { kind: "probe", keep: { yes: ["setup"], hand: [{ line: "judge", chosen: ["codex:gpt-6-astra"] }] } };
        return { kind: "quit", unsaved: 2 };
      } });
    expect(probes).toBe(1);
    expect(seen).toEqual([{ note: "", yes: [], hand: [] },
      { note: "Probed. 1 answered yes, 1 changed by hand: kept through the probe, not saved yet.", yes: ["setup"], hand: ["judge"] }]);
    expect(out).toBe("fleet: quit; 2 changes were not saved");
  });
  test("the printed review is as long as the change: what --save writes is never more than what --yes prints", async () => {
    // 600 deny rules that keep nothing out: the clean-up removes every one of them
    const idle = Array.from({ length: 600 }, (_, i) => `      - nosuch:model-${i}`).join("\n");
    const { run, overlay } = setup({ repo: `routing:\n  deny:\n    models:\n${idle}\n      - claude-code:haiku\nconsult:\n  prefer: [codex:gpt-6-astra]\n` });
    const printed = await run(["--yes", "tidy"]) as string;
    expect(printed).toContain("TO BE SAVED IN .tickmarkr/config.yaml  +0 −600");
    const removed = printed.split("\n").filter((l) => /^ +\d+ *- +- nosuch:model-\d+$/.test(l));
    expect(removed).toHaveLength(600);
    expect(await run(["--yes", "tidy", "--save"])).toContain("Saved to .tickmarkr/config.yaml.");
    expect(overlay()).not.toContain("nosuch:");
    expect(overlay()).toContain("- claude-code:haiku");
  });
  test("a config that cannot be written says so in plain words, and says nothing was saved", async () => {
    const { run, cwd } = setup();
    const dir = join(cwd, ".tickmarkr");
    chmodSync(dir, 0o555);
    try {
      await expect(run(["--yes", "setup", "--save"])).rejects.toThrow(".tickmarkr/config.yaml could not be written (permission denied). Nothing was saved.");
    } finally { chmodSync(dir, 0o755); }
    expect(existsSync(join(dir, "config.yaml"))).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  test("a config that is a symbolic link is written through the link, in each layer; a link that points to nothing refuses and creates nothing", async () => {
    // the repository's config and the user's are both links into a dotfiles folder
    const { run, cwd, globalDir } = setup();
    const dot = mkdtempSync(join(tmpdir(), "tickmarkr-dotfiles-"));
    const repoReal = join(dot, "repo-config.yaml"), userReal = join(dot, "user-config.yaml");
    writeFileSync(repoReal, "# kept in dotfiles\nreview:\n  required: true\n");
    writeFileSync(userReal, "# every repository reads this\njudge:\n  adapter: claude-code\n  model: opus\n");
    const repoLink = join(cwd, ".tickmarkr", "config.yaml"), userLink = join(globalDir, "config.yaml");
    symlinkSync(repoReal, repoLink);
    symlinkSync(userReal, userLink);
    // one save that changes both: the judge lives in the user config, implement's pool in the repository's
    const out = await run(["--set", "judge=codex:gpt-6-astra", "--set", "implement=codex:gpt-6-astra", "--save"]) as string;
    expect(out).toContain("Saved to");
    for (const [link, real] of [[repoLink, repoReal], [userLink, userReal]] as const) {
      expect(lstatSync(link).isSymbolicLink(), link).toBe(true);
      expect(readlinkSync(link)).toBe(real);
    }
    expect(readFileSync(userReal, "utf8")).toBe("# every repository reads this\njudge:\n  adapter: codex\n  model: gpt-6-astra\n");
    expect(readFileSync(repoReal, "utf8")).toContain("# kept in dotfiles\nreview:\n  required: true\n");
    expect(readFileSync(repoReal, "utf8")).toContain("          - codex:gpt-6-astra\n");
    // no temporary file is left beside a link or beside the file it points to
    for (const dir of [dot, join(cwd, ".tickmarkr"), globalDir]) expect(readdirSync(dir).filter((f) => f.endsWith(".tmp")), dir).toEqual([]);
    // a link that points to nothing: refused by name, and nothing is created where it points
    const lost = setup();
    const nowhere = join(mkdtempSync(join(tmpdir(), "tickmarkr-dotfiles-")), "gone", "config.yaml");
    symlinkSync(nowhere, join(lost.cwd, ".tickmarkr", "config.yaml"));
    await expect(lost.run(["--set", "implement=codex:gpt-6-astra", "--save"])).rejects.toThrow(".tickmarkr/config.yaml could not be written (it is a symbolic link that points to nothing). Nothing was saved.");
    expect(existsSync(nowhere)).toBe(false);
    expect(existsSync(join(nowhere, ".."))).toBe(false);
    expect(lstatSync(join(lost.cwd, ".tickmarkr", "config.yaml")).isSymbolicLink()).toBe(true);
  });
  test("the last line names the file or files this session wrote, and no other: the user config alone, the repository's alone, both, and a save made before unsaved changes", async () => {
    // (OBSERVER's F-3: a save that wrote only the user config ended on "fleet: saved .tickmarkr/config.yaml")
    const { derive, initialScreen } = await import("../../src/fleet/screen.js");
    const repoYaml = "# the repository's\nreview:\n  required: true\n", userYaml = "# every repository reads this\njudge:\n  adapter: claude-code\n  model: opus\n";
    const session = async (saves: string[][], unsaved = 0, lockUser = false) => {
      const s = setup({ repo: repoYaml });
      const userFile = join(s.globalDir, "config.yaml");
      writeFileSync(userFile, userYaml);
      let turn = 0;
      const notes: string[] = [];
      const out = await s.run([], { ...tty,
        runScreen: async ({ source, note }) => {
          notes.push(note ?? "");
          chmodSync(s.globalDir, 0o755);
          const lines = saves[turn++];
          if (!lines) return { kind: "quit", unsaved };
          if (lockUser) chmodSync(s.globalDir, 0o555);
          const d = derive(source, { ...initialScreen(), hand: lines.map((line) => ({ line, chosen: ["codex:gpt-6-astra"] })) });
          return { kind: "save", texts: d.texts!, touched: d.texts!.touched };
        } });
      return { out, notes, userFile, user: readFileSync(userFile, "utf8"), repo: s.overlay() };
    };
    // the judge lives in the user config: only that file is written, and only it is named
    const user = await session([["judge"]]);
    expect(user.out).toBe(`fleet: saved ${user.userFile}`);
    expect(user.repo).toBe(repoYaml);
    expect(user.user).not.toBe(userYaml);
    // implement's pool goes to the repository's config: only that file is written, and only it is named
    const repo = await session([["implement"]]);
    expect(repo.out).toBe("fleet: saved .tickmarkr/config.yaml");
    expect(repo.user).toBe(userYaml);
    expect(repo.repo).not.toBe(repoYaml);
    // one save that writes both names both; two saves, one file each, name both as well
    const both = await session([["judge", "implement"]]);
    expect(both.out).toBe(`fleet: saved .tickmarkr/config.yaml and ${both.userFile}`);
    const twice = await session([["judge"], ["implement"]]);
    expect(twice.out).toBe(`fleet: saved ${twice.userFile} and .tickmarkr/config.yaml`);
    // a save, then a change left unsaved: the line says both things
    const left = await session([["judge"]], 1);
    expect(left.out).toBe(`fleet: quit; 1 change was not saved (saved before that: ${left.userFile})`);
    // a save of both where the second file cannot be written: the first one was, and it alone is named
    const half = await session([["judge", "implement"]], 0, true);
    expect(half.notes[1]).toBe(`Not saved: ${half.userFile} could not be written (permission denied). .tickmarkr/config.yaml was saved.`);
    expect(half.out).toBe("fleet: saved .tickmarkr/config.yaml");
    expect(half.user).toBe(userYaml);
    expect(half.repo).not.toBe(repoYaml);
  });
  test("a config file that changed while the screen was open is never overwritten: the save is refused and the new file is shown", async () => {
    const { run, cwd, overlay } = setup({ repo: "# mine\nreview:\n  required: true\n" });
    const seen: string[] = [];
    const out = await run([], { ...tty,
      runScreen: async ({ source, note }) => {
        const { derive, initialScreen } = await import("../../src/fleet/screen.js");
        seen.push(note ?? "");
        if (seen.length === 1) {
          const first = derive(source, initialScreen()).items.find((n) => n.edits)!;
          const d = derive(source, { ...initialScreen(), yes: [first.id] });
          // someone else saves the file after the screen read it and before its own save
          writeFileSync(join(cwd, ".tickmarkr", "config.yaml"), "# mine\n# theirs\nreview:\n  required: false\n");
          return { kind: "save", texts: d.texts!, touched: d.texts!.touched };
        }
        // the reopened screen is on the new file
        expect(source.inputs.repoText).toContain("# theirs");
        return { kind: "quit", unsaved: 0 };
      } });
    expect(seen[1]).toBe("Not saved: .tickmarkr/config.yaml changed while this screen was open. This is the new file: answer again.");
    expect(overlay()).toBe("# mine\n# theirs\nreview:\n  required: false\n");
    expect(out).toBe("fleet: nothing changed");
  });
});

// The production path: real key bytes into the Ink mount, one key sequence per event (Ink treats a
// multi-character write as a paste). Frames are collected for assertions; nothing waits on a clock.
const strip = (t: string) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => input, unref: () => input });
  const direct = input.write.bind(input);
  const pending: string[] = [];
  let pumping = false;
  const pump = () => { const c = pending.shift(); if (c === undefined) { pumping = false; return; } direct(c); setImmediate(pump); };
  input.write = ((chunk: string) => { pending.push(...(chunk.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? [])); if (!pumping) { pumping = true; setImmediate(pump); } return true; }) as typeof input.write;
  const writes: string[] = [];
  const waiters: Array<{ marker: string; resolve: () => void }> = [];
  const output = { isTTY: true, columns: 100, rows: 30, on: () => {}, off: () => {}, removeListener: () => {},
    write: (chunk: string) => {
      writes.push(chunk);
      for (let i = waiters.length - 1; i >= 0; i--) if (strip(chunk).includes(waiters[i].marker)) waiters.splice(i, 1)[0].resolve();
      return true;
    } };
  // a frame that never comes fails by name, with the last frame drawn, instead of at the test's timeout
  /** One chunk, unsplit: what a driver or fast typing delivers. */
  const burst = (chunk: string) => direct(chunk);
  const frame = (marker: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no frame containing "${marker}"; the last frame was:\n${strip(writes.filter((w) => w.length > 80).at(-1) ?? "")}`)), 8000);
    waiters.push({ marker, resolve: () => { clearTimeout(timer); resolve(); } });
  });
  return { input, output, frame, burst, text: () => writes.map(strip).join("\n") };
}

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

describe("what the screen reads from disk", () => {
  test("a probe records, inside doctor.json and nowhere else, when each model was first listed", () => {
    const { cwd } = setup();
    const seen = () => readModelsFirstSeen(cwd)!.omp;
    // the record never reaches the health an adapter or the router reads
    expect(Object.keys(readDoctor(cwd)!)).not.toContain("modelsFirstSeen");
    expect(new Set(Object.values(seen()))).toEqual(new Set([""]));
    writeDoctor(cwd, health(["claude-code:fable"], { omp: ["google/gemini-4-carbon"] }));
    expect(seen()["google/gemini-4-carbon"]).toMatch(/^20\d\d-/);
    expect(readdirSync(join(cwd, ".tickmarkr")).sort()).toEqual([".gitignore", "doctor.json"]);
  });
  test("a seat readmission (2.25.0) writes its verdict through the doctor writer and leaves the first-seen record as it was", async () => {
    const { recordReadmitVerdict } = await import("../../src/run/seat-readmit.js");
    const { cwd } = setup();
    // a model first listed by a later probe: it has a date; every model of the baseline has none
    writeDoctor(cwd, health(["claude-code:fable"], { omp: ["google/gemini-4-carbon"] }));
    const before = readModelsFirstSeen(cwd)!;
    expect(before.omp["google/gemini-4-carbon"]).toMatch(/^20\d\d-/);
    // the daemon readmits claude-code:fable: one model's verdict, merged as a scoped doctor probe merges it
    const merged = recordReadmitVerdict(cwd, health(["claude-code:fable"], { omp: ["google/gemini-4-carbon"] }), "claude-code:fable", { authed: true, probedAt: new Date().toISOString() });
    expect(merged.modelAuth!.fable.authed).toBe(true);
    // nothing is dated new, nothing is lost, and the record still never reaches a reader of the health
    expect(readModelsFirstSeen(cwd)).toEqual(before);
    expect(Object.keys(readDoctor(cwd)!)).not.toContain("modelsFirstSeen");
    expect(readDoctor(cwd)!["claude-code"].modelAuth!.fable.authed).toBe(true);
  });
  test("a model a later probe lists for the first time is offered at the tier its benchmark gives; a weak one and an old one are not", async () => {
    const { cwd, run } = setup();
    writeFileSync(join(cwd, ".tickmarkr", "catalog-cache.json"), JSON.stringify({ schemaVersion: 1, fetchedAt: new Date().toISOString(), modelsDev: { openai: { models: { "gpt-6-astra": {} } } },
      artificialAnalysis: { data: [
        { slug: "gpt-6-astra", name: "GPT-6 Astra (Max)", evaluations: { artificial_analysis_intelligence_index: 56.9 } },
        { slug: "gemini-4-carbon", name: "Gemini 4 Carbon (High)", evaluations: { artificial_analysis_intelligence_index: 60 } },
        { slug: "weak-model", name: "Weak", evaluations: { artificial_analysis_intelligence_index: 20 } },
      ] } }));
    // before any later probe nothing is new: the first record is a baseline
    expect(loadFleetSource(cwd, { adapters }).ctx.newModels).toEqual([]);
    writeDoctor(cwd, health(["claude-code:fable"], { omp: ["google/gemini-4-carbon", "google/weak-model"] }));
    const fresh = loadFleetSource(cwd, { adapters }).ctx.newModels!;
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ id: "gemini-4-carbon", name: "Gemini 4 Carbon", provider: "google", tier: "frontier", score: 60, best: { score: 56.9, model: "gpt-6-astra" } });
    expect(fresh[0].paths).toEqual([{ adapter: "omp", model: "google/gemini-4-carbon", score: 60 }]);
    const item = JSON.parse(await run(["--json"]) as string).needs.find((n: { id: string }) => n.id === "new:gemini-4-carbon");
    expect(item).toMatchObject({ title: "New model: Gemini 4 Carbon (google), on omp.", ask: "Add it as frontier? That rests on one benchmark of two: Artificial Analysis 60 (your best: 56.9); it has no Terminal-Bench score.", answerable: true });
    // thirty-one days on, it is no longer news
    expect(loadFleetSource(cwd, { adapters, now: Date.now() + 31 * 86_400_000 }).ctx.newModels).toEqual([]);
    // and once the config gives it a tier it is a model like any other, not a new one
    writeFileSync(join(cwd, ".tickmarkr", "config.yaml"), "tiers:\n  omp:\n    models:\n      google/gemini-4-carbon: frontier\n");
    expect(loadFleetSource(cwd, { adapters }).ctx.newModels).toEqual([]);
  });
  test("each path of a new model is offered on its own effort's score: a weak or unscored variant gets no tier edit", async () => {
    const { cwd, run } = setup();
    writeFileSync(join(cwd, ".tickmarkr", "catalog-cache.json"), JSON.stringify({ schemaVersion: 1, fetchedAt: new Date().toISOString(), modelsDev: { openai: { models: { "gpt-6-astra": {} } } },
      artificialAnalysis: { data: [
        { slug: "gpt-6-astra", name: "GPT-6 Astra", evaluations: { artificial_analysis_intelligence_index: 100 } },
        { slug: "gemini-next", name: "Gemini Next", evaluations: { artificial_analysis_intelligence_index: 95 } },
        { slug: "gemini-next-low", name: "Gemini Next (Low)", evaluations: { artificial_analysis_intelligence_index: 20 } },
        { slug: "gemini-next-medium", name: "Gemini Next (Medium)", evaluations: { artificial_analysis_intelligence_index: 80 } },
      ] } }));
    for (const low of ["google/gemini-next-low", "google/gemini-next-medium", "google/gemini-next-xhigh"]) {
      writeDoctor(cwd, health(["claude-code:fable"]));
      writeDoctor(cwd, health(["claude-code:fable"], { omp: ["google/gemini-next-high"], opencode: [low] }));
      const fresh = loadFleetSource(cwd, { adapters }).ctx.newModels!;
      expect(fresh.map((g) => g.tier), low).toEqual(["frontier"]);
      expect(fresh[0].paths.map((p) => p.model), low).toEqual(["google/gemini-next-high"]);
      const item = JSON.parse(await run(["--json"]) as string).needs.find((n: { id: string }) => n.id === "new:gemini-next");
      const edited = item.changes.map((c: { path: string }) => c.path).join("\n");
      expect(edited, low).toContain("google/gemini-next-high");
      expect(edited, low).not.toContain(low);
    }
  });
  test("a model meets its benchmark row one way, for the fleet's best and for every new path: its exact row, else a high or bare identity's base row, else none", () => {
    const offered = (rows: Record<string, number>, added: string[], repo?: string) => {
      const { cwd } = setup(repo ? { repo } : {});
      writeFileSync(join(cwd, ".tickmarkr", "catalog-cache.json"), JSON.stringify({ schemaVersion: 1, fetchedAt: new Date().toISOString(), modelsDev: { openai: { models: { "gpt-6-astra": {} } } },
        artificialAnalysis: { data: Object.entries(rows).map(([slug, v]) => ({ slug, name: slug, evaluations: { artificial_analysis_intelligence_index: v } })) } }));
      writeDoctor(cwd, health(["claude-code:fable"], repo ? { codex: ["existing-top-high"] } : {}));
      writeDoctor(cwd, health(["claude-code:fable"], { omp: added, ...(repo ? { codex: ["existing-top-high"] } : {}) }));
      return loadFleetSource(cwd, { adapters }).ctx.newModels!.flatMap((g) => g.paths.map((p) => ({ model: p.model, score: p.score, tier: g.tier, best: g.best.score })));
    };
    // an exact high row that is weak beside a strong base row: the exact row decides, and it is not offered
    expect(offered({ "gpt-6-astra": 100, "gemini-next": 95, "gemini-next-high": 20 }, ["google/gemini-next-high"])).toEqual([]);
    // an exact high row with no base row: offered at its own tier
    expect(offered({ "gpt-6-astra": 100, "gemini-next-high": 95 }, ["google/gemini-next-high"])).toEqual([{ model: "google/gemini-next-high", score: 95, tier: "frontier", best: 100 }]);
    // a configured high variant whose only row is the base sets the best, so a weak newcomer is not offered
    expect(offered({ "existing-top": 100, "gpt-6-astra": 50, "gemini-next": 60 }, ["google/gemini-next"], "tiers:\n  codex:\n    models:\n      existing-top-high: frontier\n")).toEqual([]);
    // a low variant with no row is not offered on its base's score
    expect(offered({ "gpt-6-astra": 100, "gemini-next": 95 }, ["google/gemini-next-low"])).toEqual([]);
    // a low variant with its own row: that row decides, not the base's
    expect(offered({ "gpt-6-astra": 100, "gemini-next": 20, "gemini-next-low": 96 }, ["google/gemini-next-low"])).toEqual([{ model: "google/gemini-next-low", score: 96, tier: "frontier", best: 100 }]);
    // an identity without a suffix meets its own row
    expect(offered({ "gpt-6-astra": 100, "gemini-next": 95 }, ["google/gemini-next"])).toEqual([{ model: "google/gemini-next", score: 95, tier: "frontier", best: 100 }]);
  });
  test("a malformed benchmark table in the catalog cache leaves the screen drawing", async () => {
    const tables: Record<string, unknown> = {
      "data holds null": [null], "data is an object": {}, "a name that is a number": [{ slug: "x", name: 7, evaluations: { artificial_analysis_intelligence_index: 50 } }],
      "a slug that is a number": [{ slug: 7, evaluations: { artificial_analysis_intelligence_index: 50 } }], "evaluations is a string": [{ slug: "x", evaluations: "high" }],
      "data is a string": "rows", "rows of strings": ["a", 5, true],
    };
    for (const [name, data] of Object.entries(tables)) {
      const { cwd, run } = setup();
      writeDoctor(cwd, health(["claude-code:fable"], { omp: ["google/x"] }));
      writeFileSync(join(cwd, ".tickmarkr", "catalog-cache.json"), JSON.stringify({ schemaVersion: 1, fetchedAt: new Date().toISOString(), modelsDev: { openai: { models: { "gpt-6-astra": {} } } }, artificialAnalysis: { data } }));
      expect(loadFleetSource(cwd, { adapters }).ctx.newModels, name).toEqual([]);
      expect(await run(["--plain"]), name).toContain(" WORKERS");
    }
  });
  test("the last run's journal: a model that ran out of quota with nothing to take over, and the shapes it was doing", () => {
    const { cwd } = setup();
    const dir = join(cwd, ".tickmarkr", "runs", "run-20261108-000000-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "graph.json"), JSON.stringify({ tasks: [{ id: "T1", shape: "implement" }] }));
    writeFileSync(join(dir, "journal.jsonl"), [
      { event: "task-dispatch", taskId: "T1", data: { assignment: { adapter: "codex", model: "gpt-6-astra" } } },
      { event: "quota-failover", taskId: "T9", data: { from: "codex:gpt-6-astra", to: null } },
      { event: "quota-failover", taskId: "T1", data: { from: "grok:grok-4.5", to: "codex:gpt-6-sol" } },
    ].map((e) => JSON.stringify(e)).join("\n"));
    expect(lastRunDeaths(cwd)).toEqual([{ runId: "run-20261108-000000-1", seat: "codex:gpt-6-astra", shapes: ["implement"], tasks: ["T9"] }]);
    expect(loadFleetSource(cwd, { adapters }).labels).toMatchObject({ repo: ".tickmarkr/config.yaml" });
    // it is the LAST run that counts: a later run in which nothing died has nothing to report
    const later = join(cwd, ".tickmarkr", "runs", "run-20261109-000000-1");
    mkdirSync(later, { recursive: true });
    writeFileSync(join(later, "journal.jsonl"), `${JSON.stringify({ event: "run-start", data: {} })}\n`);
    expect(lastRunDeaths(cwd)).toEqual([]);
  });
  test("the save itself loads the bytes it is about to write, and refuses the ones that do not load", async () => {
    const { cwd, globalDir, overlay } = setup({ repo: "review:\n  required: true\n" });
    const { saveFleet } = await import("../../src/cli/commands/fleet-screen.js");
    const src = loadFleetSource(cwd, { globalDir, adapters });
    expect(() => saveFleet(src, { repoText: "routing:\n  mode: partner-lead\n", userText: "" }, ["repo"], src)).toThrow(/partner-lead|Invalid option/);
    expect(overlay()).toBe("review:\n  required: true\n");
  });
  test("an id that is not one of the screen's questions is refused by name, and --save needs an answer", async () => {
    const { run, cwd } = setup();
    expect(await run(["--yes", "nope"])).toEqual({ out: "tickmarkr fleet --yes: nope is not something this fleet asks a yes about — tickmarkr fleet --json lists the ids", code: 1 });
    expect(await run(["--yes", "setup", "--yes", "nope", "--save"])).toMatchObject({ code: 1 });
    expect(await run(["--save"])).toEqual({ out: "tickmarkr fleet: --save needs --yes <id> or --set <line>=<models>", code: 1 });
    expect(existsSync(join(cwd, ".tickmarkr", "config.yaml"))).toBe(false);
  });
  test("--set changes a line by hand without a terminal: the same review, the same save, and the same refusals as the key", async () => {
    const { run, cwd, overlay } = setup({ repo: "review:\n  required: true\n" });
    // --json lists the lines, what is on each and what may take it
    const lines = (JSON.parse(await run(["--json"]) as string) as { lines: Array<{ line: string; one: boolean; models: string[]; candidates: string[] }> }).lines;
    expect(lines.map((l) => l.line)).toEqual(["plan", "spec", "implement", "tests", "docs", "migration", "ui", "refactor", "chore", "judge", "review", "consult", "mode",
      "deny.adapters", "deny.models", "deny.workers.adapters", "deny.workers.models"]);
    expect(lines.find((l) => l.line === "judge")).toMatchObject({ one: true, models: ["claude-code:fable"] });
    expect(lines.find((l) => l.line === "implement")!.candidates).toContain("codex:gpt-6-astra");
    // a shape says its pool's mode, and a deny list says it is one
    expect(lines.find((l) => l.line === "implement")).toMatchObject({ mode: "any", floor: "mid", floorSetFor: "the mode" });
    expect(lines.find((l) => l.line === "judge")).not.toHaveProperty("mode");
    // and which config a change of the line is written to
    expect(lines.find((l) => l.line === "implement")).toMatchObject({ layer: "repo" });
    expect(lines.find((l) => l.line === "deny.models")).toMatchObject({ deny: true, models: [] });
    // the review first, and nothing saved
    const shown = await run(["--set", "implement=codex:gpt-6-astra,claude-code:opus"]) as string;
    expect(shown).toContain("YOU CHANGED BY HAND");
    expect(shown).toContain("implement: add gpt-6-astra, opus");
    expect(shown).toContain("Nothing was saved. Add --save to save it.");
    expect(overlay()).toBe("review:\n  required: true\n");
    // two lines and an answer in one save
    expect(await run(["--set", "implement=codex:gpt-6-astra,claude-code:opus", "--set", "judge=codex:gpt-6-astra", "--save"])).toContain("Saved to .tickmarkr/config.yaml.");
    expect(overlay()).toContain("    implement:\n      pool:\n        mode: any\n        channels:\n          - codex:gpt-6-astra\n          - claude-code:opus\n");
    expect(overlay()).toContain("judge:\n  adapter: codex\n  model: gpt-6-astra\n");
    expect(overlay()).toContain("review:\n  required: true\n");
    // a mode named before the models turns the pool, as the o key does; the same models in the same mode are no change
    const ordered = await run(["--set", "implement=ordered:codex:gpt-6-astra,claude-code:opus", "--save"]) as string;
    expect(ordered).toContain("implement: mode ordered");
    expect(overlay()).toContain("    implement:\n      pool:\n        mode: ordered\n        channels:\n          - codex:gpt-6-astra\n          - claude-code:opus\n");
    expect(await run(["--set", "implement=ordered:codex:gpt-6-astra,claude-code:opus"])).toMatchObject({ code: 1 });
    expect(await run(["--set", "implement=any:codex:gpt-6-astra,claude-code:opus", "--save"])).toContain("implement: mode any");
    // a shape's floor, as the f key moves it; with the shape's models in the same command it is one change of that line
    const floored = await run(["--set", "docs.floor=mid", "--set", "docs=codex:gpt-6-astra", "--save"]) as string;
    expect(floored).toContain("docs: floor mid, where mode risk-based said cheap");
    expect(floored).toContain("docs: add gpt-6-astra; it gets a pool: only these take it");
    expect(overlay()).toMatch(/^ {2}floors:\n {4}docs: mid$/m);
    expect(await run(["--set", "docs.floor=mode", "--save"])).toContain("docs: floor as mode risk-based says, was mid for this shape");
    expect(overlay()).not.toContain("docs: mid");
    for (const [arg, words] of [["docs.floor=high", "docs.floor is cheap, mid, frontier or mode"], ["docs.floor=mode", "docs.floor is already what the routing mode says"], ["judge.floor=mid", "names no line"]] as const) {
      const out = await run(["--set", arg, "--save"]);
      expect(out, arg).toMatchObject({ code: 1 });
      expect((out as { out: string }).out, arg).toContain(words);
    }
    // the routing mode is set the same way, and only to one of its three values
    expect(await run(["--set", "mode=partner-led", "--save"])).toContain("mode: partner-led");
    expect(overlay()).toMatch(/^ {2}mode: partner-led$/m);
    const wrong = await run(["--set", "mode=fastest", "--save"]);
    expect(wrong).toMatchObject({ code: 1 });
    expect((wrong as { out: string }).out).toContain("fastest is not something mode can name");
    // what the key refuses, the flag refuses, by name, and writes nothing
    const before = overlay();
    for (const [args, words] of [
      [["--set", "nowhere=codex:gpt-6-astra"], "names no line —"],
      [["--set", "implement"], "names no line —"],
      [["--set", "implement="], "implement needs at least one model"],
      [["--set", "implement=codex:no-such-model"], "codex:no-such-model is not a working model that may take implement"],
      [["--set", "implement=claude-code:fable"], "claude-code:fable is not a working model that may take implement"],
      [["--set", "judge=codex:gpt-6-astra,claude-code:opus"], "judge is one model, and 2 were given"],
      [["--set", "implement=codex:gpt-6-astra,codex:gpt-6-astra"], "implement names a model twice"],
      [["--set", "implement=codex:gpt-6-astra", "--set", "implement=claude-code:opus"], "implement is set twice"],
      [["--set", "implement=codex:gpt-6-astra,claude-code:opus"], "implement already has exactly those models, in that order"],
    ] as const) {
      const out = await run([...args, "--save"]);
      expect(out, args.join(" ")).toMatchObject({ code: 1 });
      expect((out as { out: string }).out, args.join(" ")).toContain(words);
    }
    expect(overlay()).toBe(before);
    expect(existsSync(join(cwd, ".tickmarkr", "config.yaml.tmp"))).toBe(false);
  });
  test("--set reaches the deny lists, lifts the rule of a model it names on a line, and refuses a rule wider than the model", async () => {
    const { run, overlay } = setup({ repo: "routing:\n  deny:\n    workers:\n      models:\n        # benched\n        - claude-code:opus\n        - codex:gpt-5.6-terra\nreview:\n  required: true\n" });
    // --json names what a rule keeps from a line, and whether naming it lifts the rule
    const lines = (JSON.parse(await run(["--json"]) as string) as { lines: Array<{ line: string; models: string[]; candidates: string[]; keptOut?: Record<string, { why: string; liftable: boolean }> }> }).lines;
    expect(lines.find((l) => l.line === "plan")!.keptOut).toMatchObject({ "claude-code:opus": { why: "the deny rule claude-code:opus for all work (every shape, plan and spec too)", liftable: true } });
    expect(lines.find((l) => l.line === "deny.workers.models")).toMatchObject({ models: ["claude-code:opus", "codex:gpt-5.6-terra"] });
    // naming it on plan lifts its rule in the same review, and only its rule
    const shown = await run(["--set", "plan=codex:gpt-6-astra,claude-code:opus"]) as string;
    expect(shown).toContain("plan: add gpt-6-astra, opus");
    expect(shown).toContain("claude-code:opus: no longer denied for all work (every shape, plan and spec too)");
    expect(await run(["--set", "plan=codex:gpt-6-astra,claude-code:opus", "--save"])).toContain("Saved to .tickmarkr/config.yaml.");
    expect(overlay()).toContain("        # benched\n        - codex:gpt-5.6-terra\n");
    expect(overlay()).not.toContain("        - claude-code:opus\n        - codex");
    expect(overlay()).toContain("    plan:\n      pool:\n        mode: any\n        channels:\n          - codex:gpt-6-astra\n          - claude-code:opus\n");
    // a deny list is set to what is named, and to nothing
    expect(await run(["--set", "deny.workers.models=codex:gpt-5.6-terra,claude-code:fable", "--save"])).toContain("claude-code:fable: denied for all work (every shape, plan and spec too)");
    expect(overlay()).toContain("        - codex:gpt-5.6-terra\n        - claude-code:fable\n");
    const emptied = await run(["--set", "deny.workers.models=", "--save"]) as string;
    // a label longer than the review is wide is whole, on two rows
    expect(emptied.replace(/\n +/g, " ")).toContain("codex:gpt-5.6-terra, claude-code:fable: no longer denied for all work (every shape, plan and spec too)");
    expect(emptied).toContain("Saved to .tickmarkr/config.yaml.");
    expect(overlay()).not.toContain("claude-code:fable");
    const now = (JSON.parse(await run(["--json"]) as string) as { lines: Array<{ line: string; models: string[] }> }).lines;
    expect(now.find((l) => l.line === "deny.workers.models")!.models).toEqual([]);
    // refusals, by name
    const before = overlay();
    for (const [args, words] of [
      [["--set", "deny.models=no-such-thing"], "no-such-thing is not something deny.models can name"],
      [["--set", "deny.workers.models="], "deny.workers.models already has exactly those models"],
    ] as const) {
      const out = await run([...args, "--save"]);
      expect(out, args.join(" ")).toMatchObject({ code: 1 });
      expect((out as { out: string }).out, args.join(" ")).toContain(words);
    }
    expect(overlay()).toBe(before);
    const wide = setup({ repo: "routing:\n  deny:\n    adapters: [claude-code]\nreview:\n  required: true\n" });
    const out = await wide.run(["--set", "plan=codex:gpt-6-astra,claude-code:opus", "--save"]);
    expect(out).toMatchObject({ code: 1 });
    expect((out as { out: string }).out).toContain("claude-code:opus is kept from plan by the deny rule claude-code, which covers the whole claude-code CLI — change that deny list first");
    expect(wide.overlay()).toBe("routing:\n  deny:\n    adapters: [claude-code]\nreview:\n  required: true\n");
  });
  test("r with a yes not yet saved probes and comes back with the yes still there, through the Ink screen", async () => {
    const { run, cwd } = setup();
    const t = terminal();
    let probes = 0;
    const done = run([], { input: t.input as never, output: t.output as never, doctor: (async () => { probes++; return "probed"; }) as never });
    await t.frame("NEEDS YOU");
    let next = t.frame("answered yes");
    t.input.write("y");
    await next;
    // the probe leaves the screen and opens it again: the answer is carried, said, and still counted
    next = t.frame("kept through the probe, not saved yet");
    t.input.write("r");
    await next;
    expect(probes).toBe(1);
    expect(t.text()).toContain("Probed. 1 answered yes: kept through the probe, not saved yet.");
    next = t.frame("not saved. q again quits");
    t.input.write("q");
    await next;
    t.input.write("q");
    expect(await done).toBe("fleet: quit; 1 change was not saved");
    expect(existsSync(join(cwd, ".tickmarkr", "config.yaml"))).toBe(false);
  });
  test("a line changed by hand runs through the Ink screen to the file: a tick, its place in the order, the pool's mode", async () => {
    const { run, overlay } = setup({ repo: "review:\n  required: true\n", dead: [] });
    const t = terminal();
    const done = run([], { input: t.input as never, output: t.output as never });
    await t.frame("NEEDS YOU");
    let next = t.frame("CHANGE A LINE");
    t.input.write("e");
    await next;
    // plan is the first line, pinned to one model by the defaults: it opens with that model ticked
    next = t.frame("tick the models for it");
    t.input.write("\r");
    await next;
    // down to the second model, Space ticks it, [ moves it first, o makes the pool ordered: each is one real key
    next = t.frame("[2]");
    t.input.write("\x1b[B ");
    await next;
    next = t.frame("ordered: the first that works takes every task");
    t.input.write("[o");
    await next;
    next = t.frame("plan changed");
    t.input.write("\r");
    await next;
    next = t.frame("YOU CHANGED BY HAND");
    t.input.write("\r");
    await next;
    next = t.frame("Saved to .tickmarkr/config.yaml.");
    t.input.write("y");
    await next;
    t.input.write("q");
    expect(await done).toBe("fleet: saved .tickmarkr/config.yaml");
    expect(overlay()).toMatch(/ {4}plan:\n {6}pool:\n {8}mode: ordered\n {8}channels:\n {10}- claude-code:opus\n {10}- claude-code:fable\n/);
    expect(t.text()).toContain("the pin becomes a pool");
  });
  test("keys: Esc alone is Esc, and an Esc that came with other keys does not swallow them", async () => {
    const { keysOf } = await import("../../src/tui/ink/fleet-screen.js");
    const none = { upArrow: false, downArrow: false, return: false, escape: false };
    expect(keysOf("", { ...none, escape: true })).toEqual(["esc"]);
    expect(keysOf("yn", { ...none, escape: true })).toEqual(["y", "n"]);
    expect(keysOf("y\x1b[B\ry", none)).toEqual(["y", "down", "enter", "y"]);
    expect(keysOf("", { ...none, upArrow: true })).toEqual(["up"]);
    expect(keysOf("", none)).toEqual([]);
    // the keys of an opened line are plain characters, alone or together
    expect(keysOf("[", none)).toEqual(["["]);
    expect(keysOf("] o", none)).toEqual(["]", " ", "o"]);
  });
});
