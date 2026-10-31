import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { HOST_SESSION_VARS, SEAT_MARKER_ENV } from "../../src/drivers/host-env.js";
import { HERDR_CONTROL_VARS } from "../../src/drivers/subprocess.js";
import { loadGraph, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { childEnv, launchDaemon } from "../../src/run/launch.js";
import * as locks from "../../src/run/lock.js";
import { makeTestTempDir, T } from "../helpers/tmprepo.js";

const denied = [...HOST_SESSION_VARS, ...HERDR_CONTROL_VARS, SEAT_MARKER_ENV];
const controls = denied.flatMap(name => [`${name}_LOOKALIKE`, `PREFIX_${name}`, name.toLowerCase()]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("fixture timed out"); await pause(); }
}

function fixture(mode = "ready", prepared = true) {
  const cwd = realpathSync(makeTestTempDir("launch-"));
  const state = join(cwd, ".tickmarkr");
  if (prepared) {
    saveGraph(cwd, validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "launch" }, tasks: [T("T1")] }));
    const dir = join(state, "runs", "run-old");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "journal.jsonl"), "");
  }
  const entry = join(cwd, "entry.mjs");
  const file = (name: string) => join(cwd, name);
  // Pin stand-in file access to this fixture; record its actual cwd independently.
  writeFileSync(entry, `
import { appendFileSync, existsSync, fstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cwd as currentDirectory } from 'node:process';
const mode = ${JSON.stringify(mode)}, cwd = ${JSON.stringify(cwd)};
const file = n => join(cwd,n), state = file('.tickmarkr');
const names = new Set([...Object.keys(process.env), ...${JSON.stringify(denied)}]);
const env = Object.fromEntries([...names].map(name => [name, Object.hasOwn(process.env,name)
  ? {present:true,sha256:createHash('sha256').update(process.env[name]).digest('hex')} : {present:false}]));
const stdin = fstatSync(0);
appendFileSync(file('records'), JSON.stringify({pid:process.pid, cwd:currentDirectory(), execPath:process.execPath, execArgv:process.execArgv,
  args:process.argv.slice(2), env, stdin:{text:readFileSync(0,'utf8'),character:stdin.isCharacterDevice(),rdev:stdin.rdev},
  pgid:Number(execFileSync('/usr/bin/python3',['-c','import os,sys; print(os.getpgid(int(sys.argv[1])))',String(process.pid)],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()),
  sid:Number(execFileSync('/usr/bin/python3',['-c','import os,sys; print(os.getsid(int(sys.argv[1])))',String(process.pid)],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim())})+'\\n');
if (process.argv[2] === 'version') {
  if (mode === 'version-slow') await new Promise(r=>setTimeout(r,180));
  console.log('version output sentinel'); console.error('version stderr sentinel');
  process.exitCode = mode === 'version-fail' ? 3 : 0;
} else {
  const runId = mode === 'wrong-run' ? 'run-wrong' : process.argv[2] === 'resume' ? process.argv[3] : 'run-new';
  const dir = join(state,'runs',runId), lock = join(state,'graph.lock');
  mkdirSync(dir,{recursive:true});
  const journal = join(dir,'journal.jsonl');
  const row = event => JSON.stringify({ts:new Date().toISOString(),event,data:{pid:process.pid}})+'\\n';
  process.on('exit',()=>writeFileSync(file('done'),'done'));
  for (let i=0;i<25;i++) console.log('child log '+i);
  console.error('child stderr');
  if (mode !== 'silent' && mode !== 'exit') {
    // Row 305 (D-2178 add.69): publish the lock whole, as the daemon does, so a polling launcher never reads it torn.
    writeFileSync(lock+'.'+process.pid+'.tmp',JSON.stringify({pid:mode === 'competing' ? Number(process.env.HOLDER) : process.pid,runId,startedAt:Date.now()}));
    renameSync(lock+'.'+process.pid+'.tmp',lock);
    appendFileSync(journal,row('baseline-start'));
    writeFileSync(file('baseline-pending'),'yes');
    if (mode === 'competing') appendFileSync(journal,JSON.stringify({event:'run-resume',data:{pid:Number(process.env.HOLDER)}})+'\\n');
  }
  if (mode === 'exit') process.exitCode=7;
  else if (mode === 'transient') {
    await new Promise(r=>setTimeout(r,120)); unlinkSync(lock);
    console.error('repository claim refused');
    await new Promise(r=>setTimeout(r,80)); appendFileSync(journal,row('run-start'));
  } else if (mode !== 'silent' && mode !== 'competing') {
    // A historical resume end and a different child's lifecycle cannot authorize this child.
    if (process.argv[2] === 'resume') appendFileSync(journal,row('run-end'));
    appendFileSync(journal,JSON.stringify({event:'run-start',data:{pid:1}})+'\\n');
    const text = row(process.argv[2] === 'resume' ? 'run-resume' : 'run-start');
    appendFileSync(journal,text.slice(0,-1));
    writeFileSync(file('partial'),'yes');
    while (!existsSync(file('row')) && !existsSync(file('finish'))) await new Promise(r=>setTimeout(r,10));
    if (existsSync(file('row'))) appendFileSync(journal,'\\n');
  }
  if (mode !== 'exit') {
    const deadline=Date.now()+13000;
    while (!existsSync(file('finish')) && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
  }
}
`);
  return { cwd, state, entry, file,
    records: () => existsSync(file("records")) ? readFileSync(file("records"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
    finish: async () => { writeFileSync(file("finish"), "yes"); if (existsSync(file("partial")) || existsSync(file("baseline-pending"))) writeFileSync(file("row"), "yes");
      if (existsSync(file("records")) && readFileSync(file("records"), "utf8").includes('"--driver"')) await until(() => existsSync(file("done"))); },
  };
}

test("a run launch with no compiled graph in a bare folder or in a state folder holding none is refused naming the compile command before any spawn or state file, so a refusal after the spawn fails", async () => {
  for (const stateExists of [false, true]) {
    const f = fixture("ready", false);
    if (stateExists) mkdirSync(f.state);
    let waiting = false;
    try {
      expect(await launchDaemon({ cwd: f.cwd, self: f.entry, verb: "run", onWaiting: () => { waiting = true; } }))
        .toEqual({ status: "refused", message: `Launch refused: no graph at ${join(f.state, "graph.json")} — run \`tickmarkr compile <src>\` first` });
      expect(f.records().map(row => row.args)).toEqual([["version", "--check"]]);
      expect(waiting).toBe(false);
      expect(existsSync(f.state)).toBe(stateExists);
      if (stateExists) expect(readdirSync(f.state)).toEqual([]);
    } finally { await f.finish(); }
  }
});

test("a run launch over an invalid graph is refused with the graph loader's own message while a valid graph launches as before, so a second graph validator fails", async () => {
  const graph = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "launch" }, tasks: [T("T1")] });
  for (const content of ["{", "{}", JSON.stringify({ ...graph, tasks: [T("T1"), T("T1")] }), JSON.stringify({ ...graph, tasks: [T("T1", { deps: ["missing"] })] })]) {
    const f = fixture("ready", false);
    mkdirSync(f.state);
    const path = join(f.state, "graph.json");
    writeFileSync(path, content);
    let loaderMessage = "";
    try { loadGraph(f.cwd); } catch (error) { loaderMessage = (error as Error).message; }
    expect(loaderMessage).not.toBe("");
    try {
      expect(await launchDaemon({ cwd: f.cwd, self: f.entry, verb: "run" }))
        .toEqual({ status: "refused", message: `Launch refused: ${loaderMessage}` });
      expect(f.records().map(row => row.args)).toEqual([["version", "--check"]]);
      expect(readdirSync(f.state)).toEqual(["graph.json"]);
      expect(readFileSync(path, "utf8")).toBe(content);
    } finally { await f.finish(); }
  }
  const f = fixture();
  try {
    const launching = launchDaemon({ cwd: f.cwd, self: f.entry, verb: "run" });
    await until(() => existsSync(f.file("partial")));
    writeFileSync(f.file("row"), "yes");
    expect(await launching).toMatchObject({ status: "bound", runId: "run-new", driver: "subprocess" });
    expect(f.records().map(row => row.args)).toEqual([["version", "--check"], ["run", "--driver", "subprocess"]]);
  } finally { await f.finish(); }
});

test("a resume of a run without a journal is refused naming that run before any spawn or state file while a run with a journal resumes as before, so a resume that creates state first fails", async () => {
  for (const shape of ["bare", "state", "run-folder", "journal-directory", "run-file"]) {
    const f = fixture("ready", false);
    const dir = join(f.state, "runs", "run-old");
    if (shape === "state") mkdirSync(f.state);
    if (shape === "run-folder" || shape === "journal-directory") mkdirSync(dir, { recursive: true });
    if (shape === "journal-directory") mkdirSync(join(dir, "journal.jsonl"));
    if (shape === "run-file") { mkdirSync(join(f.state, "runs"), { recursive: true }); writeFileSync(dir, "not a directory"); }
    const before = existsSync(f.state) ? readdirSync(f.state, { recursive: true }).sort() : undefined;
    let waiting = false;
    try {
      expect(await launchDaemon({ cwd: f.cwd, self: f.entry, verb: "resume", runId: "run-old", onWaiting: () => { waiting = true; } }))
        .toEqual({ status: "refused", message: "Launch refused: no journal for run run-old" });
      expect(f.records().map(row => row.args)).toEqual([["version", "--check"]]);
      expect(waiting).toBe(false);
      expect(existsSync(f.state) ? readdirSync(f.state, { recursive: true }).sort() : undefined).toEqual(before);
    } finally { await f.finish(); }
  }
  const f = fixture();
  rmSync(join(f.state, "graph.json")); // Resume preflights its journal, independently of the current graph.
  try {
    const launching = launchDaemon({ cwd: f.cwd, self: f.entry, verb: "resume", runId: "run-old" });
    await until(() => existsSync(f.file("partial")));
    writeFileSync(f.file("row"), "yes");
    expect(await launching).toMatchObject({ status: "bound", runId: "run-old", driver: "subprocess" });
    expect(f.records().map(row => row.args)).toEqual([["version", "--check"], ["resume", "run-old", "--driver", "subprocess"]]);
  } finally { await f.finish(); }
});

test("the launch helper starts run or resume with the subprocess driver detached in its own process group, stdin closed and output appended to the state log, with every denylist name removed and look-alikes byte-equal whatever environment it is handed, so an attached or unscrubbed daemon fails", async () => {
  for (const verb of ["run", "resume"] as const) for (const inherited of [false, true]) {
    const f = fixture();
    const planted = Object.fromEntries([...denied, ...controls].map(name => [name, `fixture:${name}:雪\nbyte-exact`]));
    const env = { ...(inherited ? process.env : {}), ...planted, EMPTY: "", __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0" };
    const logPath = join(f.state, "daemon.log");
    writeFileSync(logPath, "old log\n");
    try {
      const launching = launchDaemon({ cwd: f.cwd, self: f.entry, verb, runId: verb === "resume" ? "run-old" : undefined, env });
      await until(() => existsSync(f.file("partial")));
      writeFileSync(f.file("row"), "yes");
      const result = await launching;
      expect(result).toMatchObject({ status: "bound", runId: verb === "run" ? "run-new" : "run-old", driver: "subprocess", logPath });
      const records = f.records();
      expect(records.map(row => row.args)).toEqual([["version", "--check"], [verb, ...(verb === "resume" ? ["run-old"] : []), "--driver", "subprocess"]]);
      for (const row of records) {
        expect(row).toMatchObject({ cwd: f.cwd, execPath: process.execPath, execArgv: process.execArgv, stdin: { text: "", character: true } });
        for (const name of denied) expect(row.env[name], name).toEqual({ present: false });
        for (const name of controls) expect(row.env[name], name).toEqual({ present: true, sha256: digest(planted[name]) });
        expect(Object.keys(row.env).filter(name => row.env[name].present).sort()).toEqual(Object.keys(childEnv(env)).sort());
        for (const [name, value] of Object.entries(childEnv(env))) expect(row.env[name]).toEqual({ present: true, sha256: digest(value!) });
      }
      const daemon = records[1];
      expect(daemon.pgid).toBe(daemon.pid);
      expect(daemon.sid).toBe(daemon.pid);
      expect(daemon.pgid).not.toBe(Number(execFileSync("/usr/bin/python3", ["-c", "import os,sys; print(os.getpgid(int(sys.argv[1])))", String(process.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()));
      expect(readFileSync(logPath, "utf8")).toMatch(/^old log\nchild log 0/u);
      expect(readFileSync(logPath, "utf8")).toContain("child stderr");
      expect(existsSync(f.file("baseline-pending"))).toBe(true);
      expect(env.CLAUDECODE).toBe(planted.CLAUDECODE);
    } finally { await f.finish(); }
  }
});

test("a failed version check or a live lock launches nothing, and a launch binds only after a complete new run-start or run-resume row names its child, the lock then still its own for the run asked, so a lock-only, historical-row or competing-holder binding fails", async () => {
  const fail = fixture("version-fail", false);
  expect(await launchDaemon({ cwd: fail.cwd, self: fail.entry, verb: "run" })).toMatchObject({ status: "refused", message: expect.stringContaining("version --check exited 3\nversion output sentinel\nversion stderr sentinel") });
  expect(fail.records().map(row => row.args)).toEqual([["version", "--check"]]);
  expect(existsSync(join(fail.state, "daemon.log"))).toBe(false);
  expect(existsSync(fail.state)).toBe(false);
  const live = fixture("ready", false);
  mkdirSync(live.state);
  const payload = JSON.stringify({ pid: process.pid, runId: "run-bait-other", startedAt: Date.now() });
  writeFileSync(join(live.state, "graph.lock"), payload);
  expect(await launchDaemon({ cwd: live.cwd, self: live.entry, verb: "resume", runId: "run-old" })).toMatchObject({ status: "refused", message: expect.stringContaining(`pid ${process.pid} (run run-bait-other)`) });
  expect(live.records()).toHaveLength(1);
  expect(readFileSync(join(live.state, "graph.lock"), "utf8")).toBe(payload);
  for (const verb of ["run", "resume"] as const) {
    const f = fixture();
    const runId = verb === "run" ? "run-new" : "run-old";
    const dir = join(f.state, "runs", runId);
    mkdirSync(dir, { recursive: true });
    const journal = join(dir, "journal.jsonl");
    const history = (pid: number) => `{"event":"${verb === "run" ? "run-start" : "run-resume"}","data":{"pid":${String(pid).padStart(12)}}}\n`;
    writeFileSync(journal, history(1));
    let settled = false;
    const launching = launchDaemon({ cwd: f.cwd, self: f.entry, verb, runId: verb === "resume" ? runId : undefined,
      onWaiting: ({ pid }) => writeFileSync(journal, history(pid)) }).then(value => { settled = true; return value; });
    try {
      await until(() => existsSync(f.file("partial")));
      await pause(80);
      expect(settled).toBe(false);
      expect(readFileSync(journal, "utf8").endsWith("\n")).toBe(false);
      writeFileSync(f.file("row"), "yes");
      expect(await launching).toMatchObject({ status: "bound", runId });
    } finally { await f.finish(); }
  }
  for (const mode of ["wrong-run", "competing"]) {
    const f = fixture(mode);
    try {
      expect(await launchDaemon({ cwd: f.cwd, self: f.entry, verb: "resume", runId: "run-old", env: { ...process.env, HOLDER: String(process.pid) } })).toMatchObject({ status: "refused" });
    } finally { await f.finish(); }
  }
  // Change the lock during the post-row read; then cancel during the last recheck.
  for (const action of ["replace", "cancel"]) {
    const f = fixture();
    let cancelled = false;
    let checksAfterRow = 0;
    // D-2178 add.142: the binding recheck is the SECOND lock read in one synchronous turn (launch.ts reads the
    // lock, the journal row, then the lock again with no await between). Keying on "journal complete" raced
    // the child's row write under CI load: a row completed between the two reads left the recheck as the
    // first counted read, so nothing was injected and the launch correctly bound.
    let inTurn = false;
    const original = locks.runLockOwner;
    const spy = vi.spyOn(locks, "runLockOwner").mockImplementation(cwd => {
      const owner = original(cwd);
      const recheck = inTurn;
      if (!inTurn) { inTurn = true; queueMicrotask(() => { inTurn = false; }); }
      if (recheck && existsSync(f.file("row")) && ++checksAfterRow === 1) {
        if (action === "cancel") cancelled = true;
        else return { live: true, pid: process.pid, runId: "run-competitor" };
      }
      return owner;
    });
    try {
      const launching = launchDaemon({ cwd: f.cwd, self: f.entry, verb: "run", cancelled: () => cancelled });
      await until(() => existsSync(f.file("partial")));
      writeFileSync(f.file("row"), "yes");
      expect((await launching).status).toBe(action === "cancel" ? "cancelled" : "refused");
      expect(checksAfterRow).toBe(1);
    } finally { spy.mockRestore(); await f.finish(); }
  }
  const error = fixture();
  let checks = 0;
  try {
    const result = await launchDaemon({ cwd: error.cwd, self: error.entry, verb: "run", cancelled: () => {
      if (++checks === 3) renameSync(error.cwd, `${error.cwd}-moved`);
      return false;
    } });
    expect(result).toMatchObject({ status: "refused", message: expect.stringContaining("spawn failed") });
  } finally { renameSync(`${error.cwd}-moved`, error.cwd); }
  expect(error.records().map(row => row.args)).toEqual([["version", "--check"]]);
});

test("a launched child that releases its lock before its lifecycle row, exits first, or takes no lock within ten seconds is reported with its log lines, binds nothing and is left running unsignalled, so a transient lock taken as readiness fails", async () => {
  const kill = vi.spyOn(process, "kill");
  try {
    for (const mode of ["transient", "exit", "silent"]) {
      const f = fixture(mode);
      writeFileSync(join(f.state, "daemon.log"), "old lines must not leak\n");
      const start = Date.now();
      try {
        const result = await launchDaemon({ cwd: f.cwd, self: f.entry, verb: "run" });
        expect(result).toMatchObject({ status: "refused" });
        if (result.status !== "refused") throw new Error("unexpected binding");
        expect(result.message).toContain("child log 24\nchild stderr");
        expect(result.message).not.toContain("old lines must not leak");
        expect(result.message).not.toContain("child log 0\n");
        expect(result.message.split("\n").slice(1)).toHaveLength(20);
        expect(result.message).toContain("not signalled");
        if (mode === "transient") expect(result.message).toContain("lock released or changed");
        if (mode === "exit") expect(result.message).toContain("exited before readiness");
        if (mode === "silent") {
          expect(Date.now() - start).toBeGreaterThanOrEqual(10000);
          expect(result.message).toMatch(/No child lock within 10 seconds; child pid \d+ left running/u);
          expect(existsSync(f.file("done"))).toBe(false);
        }
      } finally { await f.finish(); }
    }
    expect(kill.mock.calls.length).toBeGreaterThan(0);
    for (const [, signal] of kill.mock.calls) expect(signal).toBe(0);
  } finally { kill.mockRestore(); }
}, 30000);

test("a fresh run or another run's resume launches beside an unreadable journal while an unreadable resume target is refused before the spawn, so a launch refused by history fails", async () => {
  for (const verb of ["run", "resume"] as const) {
    const f = fixture();
    const unreadable = join(f.state, "runs", "run-unreadable", "journal.jsonl");
    mkdirSync(join(f.state, "runs", "run-unreadable"), { recursive: true });
    writeFileSync(unreadable, "history\n");
    const runId = verb === "run" ? "run-new" : "run-old";
    const dir = join(f.state, "runs", runId);
    mkdirSync(dir, { recursive: true });
    const journal = join(dir, "journal.jsonl");
    const history = (pid: number) => `{"event":"${verb === "run" ? "run-start" : "run-resume"}","data":{"pid":${String(pid).padStart(12)}}}\n`;
    writeFileSync(journal, history(1));
    const open = fs.openSync;
    const denied = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      if (String(args[0]) === unreadable) throw Object.assign(new Error("unreadable history sentinel"), { code: "EACCES" });
      return open(...args);
    });
    syncBuiltinESMExports();
    let settled = false;
    try {
      const launching = launchDaemon({ cwd: f.cwd, self: f.entry, verb, runId: verb === "resume" ? runId : undefined,
        onWaiting: ({ pid }) => writeFileSync(journal, history(pid)) }).then(result => { settled = true; return result; });
      await until(() => settled || existsSync(f.file("partial")));
      expect(settled).toBe(false);
      await pause(80);
      // Rewriting a readable historical row in place must not make it post-spawn evidence.
      expect(settled).toBe(false);
      writeFileSync(f.file("row"), "yes");
      expect(await launching).toMatchObject({ status: "bound", runId });
      expect(f.records().map(row => row.args)).toEqual([["version", "--check"], [verb, ...(verb === "resume" ? [runId] : []), "--driver", "subprocess"]]);
    } finally {
      denied.mockRestore();
      syncBuiltinESMExports();
      await f.finish();
    }
  }

  const f = fixture();
  const journal = join(f.state, "runs", "run-old", "journal.jsonl");
  mkdirSync(join(f.state, "runs", "run-old"), { recursive: true });
  writeFileSync(journal, "history\n");
  const open = fs.openSync;
  const denied = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    if (String(args[0]) === journal) throw Object.assign(new Error("unreadable target sentinel"), { code: "EACCES" });
    return open(...args);
  });
  syncBuiltinESMExports();
  try {
    expect(await launchDaemon({ cwd: f.cwd, self: f.entry, verb: "resume", runId: "run-old" }))
      .toMatchObject({ status: "refused", message: expect.stringContaining("unreadable target sentinel") });
    expect(f.records().map(row => row.args)).toEqual([["version", "--check"]]);
    expect(existsSync(join(f.state, "daemon.log"))).toBe(false);
  } finally {
    denied.mockRestore();
    syncBuiltinESMExports();
    await f.finish();
  }
});
