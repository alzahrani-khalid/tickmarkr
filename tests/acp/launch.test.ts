import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { graphDefinitionHash, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { makeTestTempDir, T } from "../helpers/tmprepo.js";
import { validateAgentMessage } from "../helpers/acp-schema.js";

const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const end = Date.now() + 8000;
  while (!check()) { if (Date.now() > end) throw new Error("ACP fixture timed out"); await pause(); }
}
// Read the kernel birth identity directly; sandboxed macOS workers cannot execute ps.
const birthProbe = `import ctypes,os,struct,sys
pid=int(sys.argv[1])
if sys.platform == 'darwin':
 b=ctypes.create_string_buffer(136)
 n=ctypes.CDLL('/usr/lib/libproc.dylib').proc_pidinfo(pid,3,0,b,136)
 assert n==136
 print(struct.unpack_from('QQ',b.raw,120))
else:
 print(open('/proc/%s/stat'%pid).read().rsplit(')',1)[1].split()[19])
`;
const recorder = String.raw`
const fs = require('node:fs'), cp = require('node:child_process');
const record = row => fs.appendFileSync(process.env.LAUNCH_AUDIT,JSON.stringify({pid:process.pid,...row})+'\n');
const kill = process.kill;
process.kill = function(pid,signal='SIGTERM') {
  record({kind:'process.kill',target:pid,signal});
  if (signal !== 0) throw Error('signal forbidden');
  return kill.call(this,pid,signal);
};
const childKill=cp.ChildProcess.prototype.kill;
cp.ChildProcess.prototype.kill=function(signal='SIGTERM') {
  record({kind:'child.kill',target:this.pid,signal});
  if (signal !== 0) throw Error('child signal forbidden');
  return childKill.call(this,signal);
};
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']) {
  const original=cp[name];
  cp[name]=function(...args) {
    const command=args.filter(v=>typeof v==='string'||Array.isArray(v)).flat().join(' ');
    if (/(?:^|[\s\/;&|])(?:kill|pkill|killall)(?:\s|$)/.test(command)) {
      record({kind:'kill command',command});throw Error('kill command forbidden');
    }
    return original.apply(this,args);
  };
}
require('node:module').syncBuiltinESMExports();record({kind:'installed'});
`;

async function fixture(mode = "ready") {
  const cwd = realpathSync(makeTestTempDir("acp-launch-"));
  const file = (name: string) => join(cwd, name);
  const graph = validateGraph({ version: 1, spec: { source: "native", paths: ["spec.md"], hash: "launch" }, tasks: [T("T1")] });
  saveGraph(cwd, graph);
  writeFileSync(file("case.json"), JSON.stringify({ mode, hash: graphDefinitionHash(graph) }));
  const entry = file("entry.mjs"), preload = file("audit.cjs"), audit = file("audit.jsonl");
  writeFileSync(preload, recorder);
  const acp = new URL("../../src/cli/commands/acp.ts", import.meta.url).href;
  // Pin stand-in file access to this fixture; record its actual cwd independently.
  writeFileSync(entry, `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { cwd as currentDirectory } from 'node:process';
if (process.argv[2] === 'acp') {
  const {acp} = await import(${JSON.stringify(acp)}); await acp([]);
} else {
  const cwd=${JSON.stringify(cwd)}, file=n=>join(cwd,n), cfg=JSON.parse(readFileSync(file('case.json'),'utf8'));
  appendFileSync(file('children'),JSON.stringify({pid:process.pid,args:process.argv.slice(2),cwd:currentDirectory(),execArgv:process.execArgv})+'\\n');
  if (process.argv[2] === 'version') {
    writeFileSync(file('checking'),'yes');
    const end=Date.now()+10000;
    while (cfg.mode === 'slow-version' && !existsSync(file('version-go')) && Date.now()<end) await new Promise(r=>setTimeout(r,10));
    console.log('version check output');process.exitCode=cfg.mode==='version-fail'?4:0;
  } else {
    process.on('exit',()=>writeFileSync(file('done'),'yes'));
    const runId=process.argv[2]==='resume'?process.argv[3]:'run-launched', state=file('.tickmarkr'), dir=join(state,'runs',runId);
    mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'graph.json'),readFileSync(join(state,'graph.json')));
    const row=event=>JSON.stringify({ts:new Date().toISOString(),event,data:{pid:process.pid,graphDefinitionHash:cfg.hash,driver:'subprocess'}})+'\\n';
    const journal=join(dir,'journal.jsonl'), lock=join(state,'graph.lock');
    writeFileSync(lock,JSON.stringify({pid:process.pid,runId,startedAt:Date.now()}));
    appendFileSync(journal,row('baseline-start')); // capture remains pending
    console.log('daemon stdout');console.error('daemon stderr');
    const text=row(process.argv[2]==='resume'?'run-resume':'run-start');
    appendFileSync(journal,text.slice(0,-1));writeFileSync(file('partial'),'yes');
    const birth=execFileSync('/usr/bin/python3',['-c',${JSON.stringify(birthProbe)},String(process.pid)],{encoding:'utf8'}).trim();
    writeFileSync(file('identity'),JSON.stringify({pid:process.pid,birth}));
    const end=Date.now()+14000;
    while (!existsSync(file('row')) && !existsSync(file('finish')) && Date.now()<end) await new Promise(r=>setTimeout(r,10));
    if (existsSync(file('row'))) {appendFileSync(journal,'\\n');writeFileSync(file('published'),'yes');}
    while (!existsSync(file('finish')) && Date.now()<end) await new Promise(r=>setTimeout(r,10));
  }
}
`);
  const loader = pathToFileURL(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).pathname).href;
  const flags = ["--require", preload, "--import", loader, "--no-warnings"];
  const proc = spawn(process.execPath, [...flags, entry, "acp"], { cwd, env: { ...process.env, LAUNCH_AUDIT: audit }, stdio: "pipe" });
  const closed = once(proc, "close");
  const output: any[] = [], failures: unknown[] = [];
  const waiting = new Map<number, (row: any) => void>(), methods = new Map<number, string>();
  let nextId = 0, tail = "", stderr = "", ended = false;
  proc.stdout.setEncoding("utf8").on("data", chunk => {
    tail += chunk;
    let newline: number;
    while ((newline = tail.indexOf("\n")) !== -1) {
      const line = tail.slice(0, newline); tail = tail.slice(newline + 1);
      try {
        const row = JSON.parse(line);
        validateAgentMessage(row, methods.get(row.id));
        output.push(row); waiting.get(row.id)?.(row);
      } catch (fault) { failures.push(fault); }
    }
  });
  proc.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const request = (method: string, params: object) => {
    const id = ++nextId;
    methods.set(id, method);
    const answer = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(Error(`No ${method} answer: ${stderr}`)); }, 15000);
      waiting.set(id, row => { clearTimeout(timer); waiting.delete(id); resolve(row); });
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return { id, answer };
  };
  const end = async () => {
    if (!ended) { ended = true; proc.stdin.end(); }
    const [code, signal] = await closed;
    expect({ code, signal, stderr, tail }).toEqual({ code: 0, signal: null, stderr: "", tail: "" });
    expect(failures).toEqual([]);
    const attempts = readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line));
    for (const attempt of attempts.filter(row => row.kind !== "installed")) {
      expect(["process.kill", "child.kill"]).toContain(attempt.kind);
      expect(attempt.signal).toBe(0);
    }
  };
  await request("initialize", { protocolVersion: 1 }).answer;
  const sessionId = (await request("session/new", { cwd, mcpServers: [] }).answer).result.sessionId;
  const notify = (method: string) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: { sessionId } }) + "\n");
  return { cwd, file, proc, output, request, sessionId, flags, audit,
    prompt: (text: string) => request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
    cancel: () => notify("session/cancel"), end,
    children: () => existsSync(file("children")) ? readFileSync(file("children"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
    cleanup: async () => {
      writeFileSync(file("version-go"), "yes"); writeFileSync(file("finish"), "yes");
      await end();
      if (existsSync(file("children")) && readFileSync(file("children"), "utf8").includes('"--driver"')) await until(() => existsSync(file("done")));
    },
  };
}
const updates = (rows: any[], kind: string) => rows.filter(row => row.params?.update?.sessionUpdate === kind).map(row => row.params.update);
const messages = (rows: any[]) => updates(rows, "agent_message_chunk").map(update => update.content.text);

test("run and resume typed in a session bind the launched run, title the session and keep the turn watching, while a refusal or a cancel, before the spawn or landing with the child's row, ends the turn binding and announcing nothing, so a binding after a cancel fails", async () => {
  for (const verb of ["run", "resume"]) {
    const f = await fixture();
    const runId = verb === "run" ? "run-launched" : "run-existing";
    if (verb === "resume") {
      const dir = f.file(`.tickmarkr/runs/${runId}`); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "journal.jsonl"), JSON.stringify({ ts: new Date().toISOString(), event: "run-end", data: {} }) + "\n");
    }
    try {
      const watching = f.prompt(`/${verb}${verb === "resume" ? ` ${runId}` : ""}`);
      await until(() => existsSync(f.file("partial")));
      await pause(75);
      expect(updates(f.output, "session_info_update")).toEqual([]);
      expect(messages(f.output)).toEqual([]);
      writeFileSync(f.file("row"), "yes");
      await until(() => updates(f.output, "session_info_update").length > 0);
      await pause(60);
      expect(f.output.some(row => row.id === watching.id)).toBe(false);
      expect(updates(f.output, "session_info_update")).toEqual([{ sessionUpdate: "session_info_update", title: runId }]);
      const child = f.children()[1];
      expect(messages(f.output)).toEqual([`Run ${runId}: pid ${child.pid}; driver subprocess; log ${f.file(".tickmarkr/daemon.log")}\n\n`]);
      expect(f.children().map(row => row.args)).toEqual([["version", "--check"], [verb, ...(verb === "resume" ? [runId] : []), "--driver", "subprocess"]]);
      for (const record of f.children()) expect(record).toMatchObject({ cwd: f.cwd, execArgv: f.flags });
      f.cancel(); expect((await watching.answer).result.stopReason).toBe("cancelled");
      const before = f.output.length;
      await f.prompt("/status").answer;
      expect(messages(f.output.slice(before))[0]).toContain(`Run: ${runId}`);
      expect(updates(f.output, "session_info_update")).toHaveLength(1);
    } finally { await f.cleanup(); }
  }
  for (const mode of ["usage", "live", "version-fail", "slow-version", "cancel-row", "immediate-cancel"]) {
    const f = await fixture(mode);
    try {
      if (mode === "usage") {
        for (const text of ["/run extra", "/run --driver herdr", "/resume", "/resume --retry-failed", "/resume ../run-bait", "/resume run-ok extra", "/resume invalid"]) {
          const before = f.output.length;
          expect((await f.prompt(text).answer).result.stopReason).toBe("end_turn");
          expect(messages(f.output.slice(before))).toEqual([expect.stringMatching(/^Usage:/u)]);
        }
        expect(f.children()).toEqual([]);
        continue;
      }
      if (mode === "live") writeFileSync(f.file(".tickmarkr/graph.lock"), JSON.stringify({ pid: process.pid, runId: "run-other", startedAt: Date.now() }));
      const before = f.output.length;
      const turning = f.prompt("/run");
      if (mode === "immediate-cancel") f.cancel();
      if (mode === "slow-version") { await until(() => existsSync(f.file("checking"))); f.cancel(); writeFileSync(f.file("version-go"), "yes"); }
      if (mode === "cancel-row") {
        await until(() => existsSync(f.file("partial")));
        await pause(60); // readiness is sleeping with only an incomplete row
        f.cancel(); writeFileSync(f.file("row"), "yes");
      }
      const cancelled = ["slow-version", "cancel-row", "immediate-cancel"].includes(mode);
      expect((await turning.answer).result.stopReason).toBe(cancelled ? "cancelled" : "end_turn");
      expect(updates(f.output, "session_info_update")).toEqual([]);
      if (cancelled) expect(messages(f.output.slice(before))).toEqual([]);
      else expect(messages(f.output.slice(before))).toEqual([expect.stringContaining(mode === "live" ? `pid ${process.pid} (run run-other)` : "version --check exited 4\nversion check output")]);
      expect(f.children().filter(row => row.args[0] === "run")).toHaveLength(mode === "cancel-row" ? 1 : 0);
      const unbound = f.output.length;
      expect((await f.prompt("hello").answer).result.stopReason).toBe("end_turn");
      expect(messages(f.output.slice(unbound))).toEqual([expect.stringContaining(`Session directory: ${f.cwd}`)]);
    } finally { await f.cleanup(); }
  }
}, 30000);

test("ending acp's input after a launch leaves the daemon running with the same birth time, with no signal but signal-zero queries attempted by acp or its children, and its lock and journal as the daemon wrote them, so a detach that signals fails", async () => {
  const f = await fixture();
  try {
    const watching = f.prompt("/run");
    await until(() => existsSync(f.file("partial")));
    writeFileSync(f.file("row"), "yes");
    await until(() => updates(f.output, "session_info_update").length > 0 && existsSync(f.file("published")));
    const identity = JSON.parse(readFileSync(f.file("identity"), "utf8"));
    const lock = readFileSync(f.file(".tickmarkr/graph.lock"));
    const journal = readFileSync(f.file(".tickmarkr/runs/run-launched/journal.jsonl"));
    expect(JSON.parse(lock.toString())).toMatchObject({ pid: identity.pid, runId: "run-launched" });
    expect(journal.toString()).toContain('"event":"run-start"');
    await f.end();
    expect((await watching.answer).result.stopReason).toBe("cancelled");
    expect(execFileSync("/usr/bin/python3", ["-c", birthProbe, String(identity.pid)], { encoding: "utf8" }).trim()).toBe(identity.birth);
    expect(existsSync(f.file("done"))).toBe(false);
    expect(readFileSync(f.file(".tickmarkr/graph.lock"))).toEqual(lock);
    expect(readFileSync(f.file(".tickmarkr/runs/run-launched/journal.jsonl"))).toEqual(journal);
    const attempts = readFileSync(f.audit, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(attempts.filter(row => row.kind === "installed").map(row => row.pid)).toEqual(expect.arrayContaining([f.proc.pid, ...f.children().map(row => row.pid)]));
    const calls = attempts.filter(row => row.kind !== "installed");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls).toContainEqual({ kind: "process.kill", pid: f.proc.pid, target: identity.pid, signal: 0 });
    for (const attempt of calls) { expect(["process.kill", "child.kill"]).toContain(attempt.kind); expect(attempt.signal).toBe(0); }
  } finally { await f.cleanup(); }
});
