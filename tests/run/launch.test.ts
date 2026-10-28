import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { HOST_SESSION_VARS, SEAT_MARKER_ENV } from "../../src/drivers/host-env.js";
import { HERDR_CONTROL_VARS } from "../../src/drivers/subprocess.js";
import { childEnv, launchDaemon } from "../../src/run/launch.js";
import * as locks from "../../src/run/lock.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

const denied = [...HOST_SESSION_VARS, ...HERDR_CONTROL_VARS, SEAT_MARKER_ENV];
const controls = denied.flatMap(name => [`${name}_LOOKALIKE`, `PREFIX_${name}`, name.toLowerCase()]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("fixture timed out"); await pause(); }
}

function fixture(mode = "ready") {
  const cwd = realpathSync(makeTestTempDir("launch-"));
  const state = join(cwd, ".tickmarkr");
  mkdirSync(state);
  const entry = join(cwd, "entry.mjs");
  const file = (name: string) => join(cwd, name);
  // Pin stand-in file access to this fixture; record its actual cwd independently.
  writeFileSync(entry, `
import { appendFileSync, existsSync, fstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
    writeFileSync(lock,JSON.stringify({pid:mode === 'competing' ? Number(process.env.HOLDER) : process.pid,runId,startedAt:Date.now()}));
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
  const fail = fixture("version-fail");
  expect(await launchDaemon({ cwd: fail.cwd, self: fail.entry, verb: "run" })).toMatchObject({ status: "refused", message: expect.stringContaining("version --check exited 3\nversion output sentinel\nversion stderr sentinel") });
  expect(fail.records().map(row => row.args)).toEqual([["version", "--check"]]);
  expect(existsSync(join(fail.state, "daemon.log"))).toBe(false);
  const live = fixture();
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
    const original = locks.runLockOwner;
    const spy = vi.spyOn(locks, "runLockOwner").mockImplementation(cwd => {
      const owner = original(cwd);
      const journal = join(f.state, "runs/run-new/journal.jsonl");
      if (existsSync(f.file("row")) && existsSync(journal) && readFileSync(journal, "utf8").endsWith("\n") && ++checksAfterRow === 2) {
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
      expect(checksAfterRow).toBe(2);
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
