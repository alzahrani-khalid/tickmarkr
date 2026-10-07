import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { BEAT_GENERATION_ENV, beatClaimPath, beatOwnerPath, readProcessIdentity } from "../../src/run/beat-lifecycle.js";

// The closed skills truth table (v2.6.8 T8). Every recipe below is EXTRACTED from the shipped skill text at test time
// and executed through /bin/sh with only its placeholders substituted — never a copy retyped here. The base-form
// controls (a visible split, a same-session launch, the old stop/start) are the wrong discriminators each row names.

const ROOT = join(import.meta.dirname, "../..");
const TSX = pathToFileURL(join(ROOT, "node_modules/tsx/dist/loader.mjs")).href;
const SKILLS = ["auto", "loop", "overseer"] as const;
// Cleanup/safety ceiling only (slowest-runner rule): every wait below synchronises on a file or process event.
const CEILING_MS = 30_000;

const cleanup: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = (prefix: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); cleanup.push(dir); return dir; };
const alive = (pid: number) => readProcessIdentity(pid) !== "DEAD";
const until = async (event: () => boolean, ms = CEILING_MS) => {
  const deadline = Date.now() + ms;
  while (!event()) {
    if (Date.now() > deadline) throw new Error("event never recorded");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Every canonical skill source, plus the installed aliases when present (.claude/skills is absent from the exported tree). */
function skillSources(): string[] {
  const sources = SKILLS.map((name) => join(ROOT, "skills", `tickmarkr-${name}`, "SKILL.md"));
  const installedRoot = join(ROOT, ".claude", "skills");
  if (existsSync(installedRoot)) sources.push(...SKILLS.map((name) => join(installedRoot, `tickmarkr-${name}`, "SKILL.md")));
  return sources;
}

/** The command lines of every fenced block in `text`. */
const fencedLines = (text: string) => [...text.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].map((m) => m[1].split("\n").filter((l) => l.startsWith("cd <repo> && ")));
/** The command lines of the first fenced block after `marker`. */
const blockAfter = (skill: string, marker: string) => {
  const at = skill.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  return fencedLines(skill.slice(at))[0];
};
const sq = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

// ---- row 1: run/resume daemon recipes ----

function hostBin(): string {
  const bin = tmp("tickmarkr-truth-bin-");
  // Recording daemon fixture: one record per process, then output that keeps advancing its log.
  writeFileSync(join(bin, "tickmarkr"), [
    "#!/bin/sh",
    `printf '{"pid":%s,"argv":"%s","orca":"%s","herdr":"%s"}\\n' "$$" "$*" "\${ORCA_TERMINAL_HANDLE:-}" "\${HERDR_PANE_ID:-}" >> "$PWD/daemon.records"`,
    "i=0; while [ $i -lt 2000 ]; do echo \"daemon tick $i\"; i=$((i+1)); sleep 0.05; done",
    "",
  ].join("\n"));
  // Recording host fixtures: any terminal/pane create or split lands here, and none runs its command.
  for (const host of ["orca", "herdr"]) writeFileSync(join(bin, host), `#!/bin/sh\necho "${host} $*" >> "$PWD/host.calls"\necho '{}'\n`);
  for (const name of ["tickmarkr", "orca", "herdr"]) chmodSync(join(bin, name), 0o755);
  return bin;
}

type Launch = { records: { pid: number; argv: string; orca: string; herdr: string }[]; hostCalls: string; survived: boolean; advanced: boolean; controlDied: boolean; ownGroup: boolean };

/**
 * Run `line` in a launcher session beside a same-session control, kill that whole session group, and report what
 * the daemon fixture did: its records, any host calls, and whether it survived with its log still advancing.
 */
async function launch(line: string, bin: string, env: NodeJS.ProcessEnv): Promise<Launch> {
  const repo = tmp("tickmarkr-truth-repo-");
  mkdirSync(join(repo, ".tickmarkr"));
  const out = tmp("tickmarkr-truth-out-");
  const launcher = spawn("/bin/sh", ["-c", [
    line.replaceAll("<repo>", sq(repo)).replaceAll("<state-dir>", ".tickmarkr"),
    `sleep 300 & echo $! > ${sq(join(out, "control"))}`,
    `touch ${sq(join(out, "ready"))}`,
    "wait",
  ].join("\n")], { detached: true, stdio: "ignore", env: { ...env, PATH: `${bin}:${dirname(process.execPath)}:${env.PATH}` } });
  pids.push(launcher.pid!);
  const records = () => existsSync(join(repo, "daemon.records"))
    ? readFileSync(join(repo, "daemon.records"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Launch["records"][number]) : [];
  const hostCalls = () => existsSync(join(repo, "host.calls")) ? readFileSync(join(repo, "host.calls"), "utf8") : "";
  await until(() => existsSync(join(out, "ready")) && (records().length > 0 || hostCalls() !== ""));
  const control = Number(readFileSync(join(out, "control"), "utf8"));
  pids.push(control, ...records().map((r) => r.pid));
  const log = join(repo, ".tickmarkr", "daemon.log");
  const daemon = records()[0]?.pid;
  const group = daemon ? spawnSync("ps", ["-o", "pgid=", "-p", String(daemon)], { encoding: "utf8" }).stdout.trim() : "";
  if (daemon) await until(() => existsSync(log) && readFileSync(log, "utf8").includes("daemon tick"));
  const before = existsSync(log) ? statSync(log).size : 0;
  process.kill(-launcher.pid!, "SIGKILL"); // the launcher's whole session group dies
  await until(() => !alive(control));
  // A surviving daemon's log grows past what it held at the kill; a same-session one dies with the group.
  await until(() => !daemon || !alive(daemon) || statSync(log).size > before);
  return {
    records: records(), hostCalls: hostCalls(), controlDied: !alive(control),
    survived: !!daemon && alive(daemon), advanced: existsSync(log) && statSync(log).size > before,
    ownGroup: !!daemon && Number(group) === daemon && Number(group) !== launcher.pid,
  };
}

test("test: documented run-resume recipes execute one detached logged daemon at the recorded ORCH address versus a visible split or same-session death", async () => {
  const bin = hostBin();
  const runId = "run-20261006-000000-0000000000000001";
  const base = { ...process.env };
  delete base.ORCA_TERMINAL_HANDLE;
  delete base.HERDR_PANE_ID;
  const cases: Promise<void>[] = [];
  for (const source of skillSources()) {
    const skill = readFileSync(source, "utf8");
    const lines = fencedLines(skill).flat().filter((l) => / tickmarkr (run|resume <runId>) /.test(l));
    const of = (anchor: string, verb: string) => {
      const found = lines.filter((l) => l.includes(anchor) && l.includes(` tickmarkr ${verb} `));
      expect(found, `${source}: ${anchor} ${verb}`).toHaveLength(1);
      return found[0];
    };
    for (const [host, anchor, envKey] of [["orca", "<ORCH handle>", "ORCA_TERMINAL_HANDLE"], ["herdr", "<ORCH pane id>", "HERDR_PANE_ID"]] as const) {
      for (const verb of ["run", "resume <runId>"]) {
        const line = of(anchor, verb).replaceAll("<runId>", runId);
        const argv = verb === "run" ? "run" : `resume ${runId}`;
        // ORCH launch: the ORCH's own address from its environment; overseer fallback: the recorded ORCH address
        // substituted while the launching shell's environment names the OVERSEER's own terminal or pane.
        for (const [who, sub, own] of [["orch", `$${envKey}`, `${host}-orch`], ["fallback", `${host}-orch`, `${host}-overseer`]] as const) {
          cases.push((async () => {
            const got = await launch(line.replaceAll(anchor, sub), bin, { ...base, [envKey]: own });
            const label = `${source} ${host} ${verb} ${who}`;
            expect(got.records, label).toHaveLength(1);
            expect(got.records[0], label).toMatchObject({ argv, [host]: `${host}-orch` });
            expect([label, got.hostCalls, got.ownGroup, got.survived, got.advanced, got.controlDied]).toEqual([label, "", true, true, true, true]);
          })());
        }
      }
    }
  }
  await Promise.all(cases);

  // Wrong discriminators, through the same oracle. A visible split (the base recipe) creates a pane and no daemon of
  // the recipe's own; the documented line stripped of its detach wrapper dies with the launcher's session.
  const documented = fencedLines(readFileSync(skillSources()[0], "utf8")).flat().find((l) => l.includes("<ORCH handle>") && l.includes(" tickmarkr run "))!;
  const split = await launch('cd <repo> && orca terminal split --terminal "orca-orch" --direction vertical --command "tickmarkr run"', bin, base);
  expect([split.hostCalls.includes("terminal split"), split.records.length]).toEqual([true, 0]);
  const sameSession = await launch(`${documented.replace(/ node -e "[^"]*"/, "").replace("<ORCH handle>", "orca-orch")} &`, bin, base);
  expect(sameSession.records).toHaveLength(1);
  expect([sameSession.survived, sameSession.advanced, sameSession.ownGroup]).toEqual([false, false, false]);
}, 120_000);

// ---- row 2: both watch-journal copies ----

const RUN = "run-20261006-000000-0000000000000002";
const row = (ts: string, event: string, data: Record<string, unknown>, taskId?: string) => JSON.stringify({ ts, event, ...(taskId ? { taskId } : {}), data });
const runEnd = (ts: string, buckets: Record<string, string[]>, owedChecks: unknown, tipVerify = "passed") =>
  row(ts, "run-end", { runId: RUN, branch: `tickmarkr/${RUN}`, done: ["T1", "T2"], failed: [], human: [], blocked: [], pending: [], ...buckets, tipVerify, owedChecks });

/** Arm a watcher on a journal holding `history`; the injected sleep appends `next` on its first call, then the watcher reports. */
function watch(script: string, history: string[], next: string) {
  const root = tmp("tickmarkr-truth-watch-");
  const bin = join(root, "bin");
  const journal = join(root, "runs", RUN, "journal.jsonl");
  mkdirSync(dirname(journal), { recursive: true });
  mkdirSync(bin);
  writeFileSync(journal, history.map((l) => `${l}\n`).join(""));
  writeFileSync(join(root, "next.row"), `${next}\n`);
  writeFileSync(join(bin, "sleep"), `#!/bin/sh\nif [ -f '${root}/next.row' ]; then cat '${root}/next.row' >> '${journal}'; rm -f '${root}/next.row'; fi\n`);
  chmodSync(join(bin, "sleep"), 0o755);
  const r = spawnSync("bash", [script, join(root, "runs"), "1", "5"], {
    encoding: "utf8", timeout: CEILING_MS, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { code: r.status, out: r.stdout };
}

test("test: shipped journal watchers print EXECUTION COMPLETE for debt one unknown and later zero versus historical run-end GREEN", () => {
  const scripts = [join(ROOT, "skills/tickmarkr-overseer/scripts/watch-journal.sh")];
  const installed = join(ROOT, ".claude", "skills", "tickmarkr-overseer", "scripts", "watch-journal.sh");
  if (existsSync(installed)) scripts.push(installed); // the installed alias, when present (absent from the exported tree)
  const owed = (outstanding: unknown[]) => ({ known: true, outstanding, acceptedRisk: [], discharged: [] });
  // A historical run-end already on disk at arm time: a parked earlier end that must never be re-reported.
  const history = [runEnd("2026-10-06T10:00:00.000Z", { human: ["T9"] }, owed([]))];
  for (const script of scripts) {
    for (const [debt, owedChecks] of [
      ["one", owed([{ taskId: "T2", gate: "review" }])],
      ["unknown", { known: false, debt: "unknown", outstanding: [] }],
      ["later zero", owed([])],
    ] as const) {
      const r = watch(script, history, runEnd("2026-10-06T11:00:00.000Z", {}, owedChecks));
      const label = `${script} debt ${debt}`;
      expect(r.code, label).toBe(0);
      expect(r.out, label).toContain(`RUN_END ${RUN} — EXECUTION COMPLETE (tipVerify=passed)`);
      expect(r.out, label).toContain(`read CURRENT \`tickmarkr status ${RUN}\`; only \`outstanding 0\` is green`);
      expect(r.out, label).not.toMatch(/— GREEN|this run is green|T9/);
    }
    // Partial and failed endings keep their bucket names visible and stay NOT GREEN.
    const parked = watch(script, [], runEnd("2026-10-06T11:00:00.000Z", { human: ["T2"] }, owed([])));
    expect(parked.out).toContain(`RUN_END ${RUN} — NOT GREEN`);
    expect(parked.out).toContain('human=["T2"]');
    const redTip = watch(script, [], runEnd("2026-10-06T11:00:00.000Z", {}, owed([]), "failed"));
    expect(redTip.out).toContain(`RUN_END ${RUN} — NOT GREEN (tipVerify=failed)`);
    // Positive wake: a new park reports its run id and its physical park token (line 2 of this journal).
    const park = watch(script, history, row("2026-10-06T11:05:00.000Z", "task-human", { reason: "review gate failed", kind: "gate-fail" }, "T2"));
    expect(park.code).toBe(0);
    expect(park.out).toContain(`TASK_HUMAN T2 — ${RUN}`);
    expect(park.out).toContain(`tickmarkr approve ${RUN} T2 --park 2@2026-10-06T11:05:00.000Z`);
  }
});

// ---- row 4: legacy beat migration and killed-taker recovery ----

function cliBin(): string {
  const bin = tmp("tickmarkr-truth-cli-");
  writeFileSync(join(bin, "tickmarkr"), `#!/bin/sh\nexec '${process.execPath}' --import '${TSX}' '${join(ROOT, "src/cli/index.ts")}' "$@"\n`);
  chmodSync(join(bin, "tickmarkr"), 0o755);
  return bin;
}

// A real compliant recovery taker held after its removal lock is taken, before it moves the dead claim aside.
const TAKER = `
import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const [root, repo] = process.argv.slice(1);
const l = await import(root + "/src/run/beat-lifecycle.ts");
const claim = l.beatClaimPath(repo, "overseer");
const { renameSync } = fs;
fs.renameSync = (from, to) => {
  if (from === claim && String(to).includes(".reclaim/claim.")) { fs.writeFileSync(repo + "/paused", ""); for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
  renameSync(from, to);
};
syncBuiltinESMExports();
l.acquireBeatClaim(repo, "overseer", "taker", l.defaultBeatDeps());`;

const exited = (child: ChildProcess) => new Promise<void>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve());
});

test("test: documented legacy migration and killed-taker recovery commands reach the landed beat refusal and read back ARMED versus the old start-stop dead end or a manual file removal", async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${cliBin()}:${process.env.PATH}` };
  delete env[BEAT_GENERATION_ENV];
  const shell = (line: string) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn("/bin/sh", ["-c", line], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
  });
  const mkRepo = () => { const repo = tmp("tickmarkr-truth-beat-"); mkdirSync(join(repo, ".git")); mkdirSync(join(repo, ".tickmarkr")); return repo; };
  // Seats here are shell-safe words, so each fills in exactly as tickmarkr prints it.
  const fill = (line: string, repo: string, seat: string, recorded = "") =>
    line.replaceAll("<repo>", sq(repo)).replaceAll("<tier>", "overseer").replaceAll("<recorded seat>", recorded).replaceAll("<seat>", seat);
  const armed = async (repo: string, status: string, seat: string) => {
    const read = await shell(status);
    expect(read).toMatchObject({ code: 0, out: expect.stringContaining(`overseer ARMED (${seat}) — detached pid`) });
    pids.push(JSON.parse(readFileSync(beatOwnerPath(repo, "overseer"), "utf8")).pid as number);
  };

  await Promise.all(skillSources().map(async (source) => {
    const skill = readFileSync(source, "utf8");
    const migration = blockAfter(skill, "**Legacy beat migration.**");
    const recovery = blockAfter(skill, "**Crash recovery.**");
    // Every documented step is a tickmarkr beat command: no step removes a claim, lock or stage file by hand.
    for (const line of [...migration, ...recovery]) expect(line, source).toMatch(/^cd <repo> && tickmarkr beat \S+ /);
    const [standDown, start, status] = migration;
    expect([standDown.endsWith(" --stand-down"), start.includes(" beat start "), status.includes(" beat status ")]).toEqual([true, true, true]);
    const [readOnly, stop, restart] = recovery;
    expect([readOnly.includes(" beat status "), stop.includes(" beat stop "), restart.includes(" beat start ")]).toEqual([true, true, true]);

    // Legacy arm, its writer exited: the old stop-then-start is a dead end by exit code; the documented steps are not.
    const legacy = mkRepo();
    expect((await shell(`cd ${sq(legacy)} && tickmarkr beat overseer --seat legacy:seat`)).code).toBe(0);
    const oldStop = await shell(fill(stop, legacy, "new:seat"));
    const oldStart = await shell(fill(start, legacy, "new:seat"));
    expect([oldStop.code, oldStart.code], source).toEqual([1, 1]);
    const printed = /`(tickmarkr beat [^`]+ --stand-down)`/.exec(oldStart.out)?.[1];
    expect(fill(standDown, legacy, "new:seat", "legacy:seat")).toBe(`cd ${sq(legacy)} && ${printed}`);
    expect(await shell(fill(standDown, legacy, "new:seat", "legacy:seat"))).toMatchObject({ code: 0, out: expect.stringContaining("DISARMED") });
    expect(await shell(fill(start, legacy, "new:seat"))).toMatchObject({ code: 0, out: expect.stringContaining("ARMED as new:seat") });
    await armed(legacy, fill(status, legacy, "new:seat"), "new:seat");

    // Control: an independently owned live legacy --loop writer. start names its pid and never signals it; the
    // documented step stops exactly that pid, then the same commands reach ARMED.
    const live = mkRepo();
    const writer = spawn("/bin/sh", ["-c", `cd ${sq(live)} && exec tickmarkr beat overseer --seat legacy:seat --loop`], { env, stdio: "ignore" });
    pids.push(writer.pid!);
    await until(() => existsSync(join(live, ".tickmarkr", "supervision", "overseer.beat")));
    const refusal = await shell(fill(start, live, "new:seat"));
    expect(refusal).toMatchObject({ code: 1, out: expect.stringContaining(`stop pid ${writer.pid} first`) });
    expect(alive(writer.pid!)).toBe(true);
    writer.kill("SIGKILL");
    await exited(writer);
    expect(await shell(fill(standDown, live, "new:seat", "legacy:seat"))).toMatchObject({ code: 0 });
    expect(await shell(fill(start, live, "new:seat"))).toMatchObject({ code: 0, out: expect.stringContaining("ARMED as new:seat") });
    await armed(live, fill(status, live, "new:seat"), "new:seat");

    // A killed compliant recovery taker over a dead claim.
    const crashed = mkRepo();
    const holder = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await exited(holder);
    const claim = beatClaimPath(crashed, "overseer");
    mkdirSync(dirname(claim), { recursive: true });
    writeFileSync(claim, JSON.stringify({ tier: "overseer", token: "dead", pid: holder.pid, claimedAt: new Date().toISOString() }) + "\n");
    const taker = spawn(process.execPath, ["--import", TSX, "--input-type=module", "-e", TAKER, ROOT, crashed], { stdio: "ignore", env });
    pids.push(taker.pid!);
    await until(() => existsSync(join(crashed, "paused")));
    taker.kill("SIGKILL");
    await exited(taker);
    const tree = () => readdirSync(dirname(claim), { recursive: true }).map(String).sort()
      .map((name) => [name, statSync(join(dirname(claim), name)).isDirectory() ? "dir" : readFileSync(join(dirname(claim), name), "utf8")]);
    const left = tree();
    expect(left.some(([name]) => String(name).endsWith(".reclaim"))).toBe(true);
    // The documented status read observes: nonzero, names the documented recovery command, changes no file.
    const observed = await shell(fill(readOnly, crashed, "s"));
    expect(observed.code).toBe(1);
    expect(`cd ${sq(crashed)} && ${/`(tickmarkr beat stop [^`]+)`/.exec(observed.out)?.[1]}`).toBe(fill(stop, crashed, "s"));
    expect(observed.out).toContain("status reports, never recovers");
    expect(tree()).toEqual(left);
    // The documented stop recovers it — tickmarkr's own notices name the killed taker and the dead holder.
    const recovered = await shell(fill(stop, crashed, "s"));
    expect(recovered.code).toBe(0);
    expect(recovered.out).toContain(`recovered the removal lock of killed taker pid ${taker.pid}`);
    expect(recovered.out).toContain(`reclaimed the claim of dead pid ${holder.pid}`);
    expect([existsSync(claim), tree().some(([name]) => String(name).endsWith(".reclaim"))]).toEqual([false, false]);
    expect(await shell(fill(restart, crashed, "s"))).toMatchObject({ code: 0, out: expect.stringContaining("ARMED as s") });
    await armed(crashed, fill(readOnly, crashed, "s"), "s");

    // Retire every detached beat this row started, through the documented stop.
    for (const [repo, seat] of [[legacy, "new:seat"], [live, "new:seat"], [crashed, "s"]]) {
      expect(await shell(fill(stop, repo, seat))).toMatchObject({ code: 0, out: expect.stringContaining("DISARMED") });
    }
  }));
}, 180_000);
