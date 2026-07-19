import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HerdrDriver } from "../../src/drivers/herdr.js";
import { pickDriver } from "../../src/drivers/index.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";

interface StubOpts { tab?: boolean; splitFails?: boolean; renameFails?: boolean; tabRenameFails?: boolean; incTabs?: boolean; takenNames?: string[]; paneCloseNoop?: boolean; startFailsOther?: boolean; tabFails?: boolean; tabGarbage?: boolean; tabNoId?: boolean; paneCols?: number; layoutFails?: boolean; survivingWatch?: { name: string; pane: string } }

function makeStub(waitExit = 0, opts: StubOpts = {}): { bin: string; log: string; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-herdr-"));
  const log = join(dir, "log.txt");
  const map = join(dir, "agents.txt"); // agent rename registry: "<name> <paneId>" per line
  const ctr = join(dir, "tabctr.txt"); // incTabs: distinct tab ids (t1,t2,…) so coexisting tabs are distinguishable
  const taken = join(dir, "taken.txt"); // DEFECT-01: names a prior (killed) process's kept pane still holds
  const bin = join(dir, "herdr");
  const cwd = mkdtempSync(join(tmpdir(), "tickmarkr-herdr-cwd-"));
  if (opts.takenNames?.length) writeFileSync(taken, opts.takenNames.join("\n") + "\n");
  // opt-in capabilities: tab → tab create answers tab_id + root_pane (SKILL:343) and pane split
  // answers result.pane.pane_id; existing makeStub() callers keep today's '{}' tab-create default.
  // incTabs emits incrementing tab ids so a group tab and a dedicated role tab are distinguishable.
  // VIS-10: default is now the VALID tab payload (post-fix every slot has a tab_id); tabFails
  // (non-zero exit), tabGarbage (unparseable stdout), tabNoId (parses but no tab_id — the pre-fix
  // degraded path) are the explicit degraded-path fixtures. opts.tab is a kept-as-no-op alias so
  // existing { tab: true } callers keep working unchanged.
  const tabCreate =
    opts.tabFails ? "exit 1" :
    opts.tabGarbage ? "printf 'not json'" :
    opts.incTabs
    ? `n=$(cat '${ctr}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${ctr}'; echo "{\\"result\\":{\\"tab\\":{\\"tab_id\\":\\"w1:t$n\\"},\\"root_pane\\":{\\"pane_id\\":\\"w1:p0\\"}}}"`
    : opts.tabNoId ? `echo '{}'`
    : `echo '{"result":{"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p0"}}}'`;
  const paneSplit = opts.splitFails ? "exit 1" : `echo '{"result":{"pane":{"pane_id":"w1:p7"}}}'`;
  const paneLayout = opts.layoutFails ? "exit 1" : `w=${opts.paneCols ?? 222}; pid=""; for a in "$@"; do case "$a" in --pane) shift; pid="$1";; esac; done; [ -z "$pid" ] && pid=w1:p42; echo "{\\"result\\":{\\"layout\\":{\\"area\\":{\\"width\\":$w},\\"panes\\":[{\\"pane_id\\":\\"$pid\\",\\"rect\\":{\\"width\\":$w}}]}}}"`;
  const rename = opts.renameFails ? "exit 1" : `echo "$4 $3" >> '${map}'; echo '{}'`;
  const tabRename = opts.tabRenameFails ? "exit 1" : "echo '{}'";
  // DEFECT-01: agent start refuses a taken name on STDOUT (Pitfall 6 — herdr prints error json to stdout), exit 1.
  const agentStart = opts.startFailsOther
    ? `echo '{"error":{"code":"workspace_missing","message":"no such workspace"}}'; exit 1`
    : `if [ -f '${taken}' ] && grep -qx "$3" '${taken}'; then echo "{\\"error\\":{\\"code\\":\\"agent_name_taken\\",\\"message\\":\\"agent name $3 already used; pane_id=w1:pSTALE\\"}}"; exit 1; fi; echo '{"result":{"agent":{"pane_id":"w1:p9"}}}'`;
  // agent get resolves a taken name to its stale holder pane; otherwise the existing rename-map lookup.
  const agentGet = `if [ -f '${taken}' ] && grep -qx "$3" '${taken}'; then echo '{"result":{"agent":{"pane_id":"w1:pSTALE"}}}'; else pane=$(grep "^$3 " '${map}' 2>/dev/null | tail -1 | cut -d' ' -f2); if [ -n "$pane" ]; then echo "{\\"result\\":{\\"agent\\":{\\"pane_id\\":\\"$pane\\"}}}"; elif [[ "$3" == tickmarkr:watch:* || "$3" == narrator-watch-* ]]; then exit 1; else echo '{"result":{"agent":{"pane_id":"w1:p42"}}}'; fi; fi`;
  // closing the stale holder frees the name (unless paneCloseNoop → the fail-closed retry-ceiling test).
  const paneClose = opts.paneCloseNoop ? `echo '{}'` : `if [ "$3" = "w1:pSTALE" ]; then : > '${taken}'; fi; echo '{}'`;
  const agentList = opts.survivingWatch
    ? `echo '{"result":{"agents":[{"name":"${opts.survivingWatch.name}","pane_id":"${opts.survivingWatch.pane}","workspace_id":"wTEST"}]}}'`
    : `echo '{"result":{"agents":[]}}'`;
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
echo "$@" >> '${log}'
case "$1 $2" in
  "agent start") ${agentStart} ;;
  "agent rename") ${rename} ;;
  "agent get") ${agentGet} ;;
  "agent list") ${agentList} ;;
  "tab create") ${tabCreate} ;;
  "tab rename") ${tabRename} ;;
  "pane split") ${paneSplit} ;;
  "pane layout") ${paneLayout} ;;
  "pane close") ${paneClose} ;;
  "notification show") echo '{}' ;;
  "wait output") exit ${waitExit} ;;
  "wait agent-status") exit 0 ;;
  "pane read")   printf 'line1\\nTICKMARKR_EXIT:0\\n' ;;
  *) echo '{}' ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log, cwd };
}

// VIS-10: every non-oracle test runs with the run's workspace id present — the env the daemon
// inherits and seeds. The env-unset oracle (and the rewritten unset test) delete it in their own
// try/finally; this helper just restores the default afterward. (File-scoped: runs for all tests.)
let _wsPrev: string | undefined;
let _panePrev: string | undefined;
beforeEach(() => {
  _wsPrev = process.env.HERDR_WORKSPACE_ID;
  _panePrev = process.env.HERDR_PANE_ID;
  process.env.HERDR_WORKSPACE_ID = "wTEST";
  process.env.HERDR_PANE_ID = "wTEST:pCALLER";
});
afterEach(() => {
  if (_wsPrev !== undefined) process.env.HERDR_WORKSPACE_ID = _wsPrev;
  else delete process.env.HERDR_WORKSPACE_ID;
  if (_panePrev !== undefined) process.env.HERDR_PANE_ID = _panePrev;
  else delete process.env.HERDR_PANE_ID;
});

describe("HerdrDriver (stubbed binary)", () => {
  test("slot → agent start with name/cwd/--no-focus -- bash; pane id parsed", async () => {
    const { bin, log } = makeStub();
    const d = new HerdrDriver(bin);
    const slot = await d.slot("/some/worktree", "run-1-T1-a0");
    expect(slot.id).toBe("w1:p9");
    expect(readFileSync(log, "utf8")).toContain("agent start run-1-T1-a0 --cwd /some/worktree --tab w1:t1 --no-focus -- bash");
  });

  test("run/read/close re-resolve pane id by agent name (ids never cached blindly)", async () => {
    const { bin, log, cwd } = makeStub();
    const d = new HerdrDriver(bin);
    const slot = await d.slot(cwd, "n1");
    await d.run(slot, "echo hi");
    expect(await d.read(slot, 50)).toContain("line1");
    await d.close(slot);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("agent get n1"); // re-resolution happened
    expect(calls).toContain("pane run w1:p42 echo hi"); // fresh id used, not the cached w1:p9
    expect(calls).toContain("pane read w1:p42 --source recent-unwrapped --lines 50");
    expect(calls).toContain("tab close w1:t1"); // slot now carries a tabId → close reaps the whole tab
  });

  test("waitOutput: exit 0 → true, exit 1 (timeout) → false", async () => {
    const { bin: binOk, cwd: cwdOk } = makeStub(0);
    const ok = new HerdrDriver(binOk);
    expect(await ok.waitOutput(await ok.slot(cwdOk, "a"), "TICKMARKR_EXIT:", 1000)).toBe(true);
    const { bin: binTo, cwd: cwdTo } = makeStub(1);
    const to = new HerdrDriver(binTo);
    expect(await to.waitOutput(await to.slot(cwdTo, "b"), "TICKMARKR_EXIT:", 1000)).toBe(false);
  });

  test("a herdr wait response containing the literal substring error in payload text is not misread as a dead pane", async () => {
    const { bin, cwd } = makeStub();
    writeFileSync(bin, `#!/usr/bin/env bash
case "$1 $2" in
  "agent get") echo '{"result":{"agent":{"pane_id":"w1:p1"}}}' ;;
  "wait output") echo '{"result":{"text":"error"}}' ;;
  *) echo '{"result":{"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p0"}}}' ;;
esac
`);
    chmodSync(bin, 0o755);
    const d = new HerdrDriver(bin);
    expect(await d.waitOutput({ id: "w1:p1", name: "a", cwd }, "done", 1000)).toBe(true);
  });

  // pin tabs to the RUN's workspace, not the operator's focused one
  // (Intl-Dossier run-20260709-104447 incident: worker tabs opened in the tickmarkr repo workspace)
  test("HERDR_WORKSPACE_ID set → tab create carries --workspace", async () => {
    const { bin, log, cwd } = makeStub();
    const prev = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = "wK";
    try {
      const d = new HerdrDriver(bin);
      await d.slot(cwd, "ws-pin");
      const calls = readFileSync(log, "utf8");
      expect(calls).toContain("tab create");
      expect(calls).toContain("--workspace wK");
    } finally {
      if (prev !== undefined) process.env.HERDR_WORKSPACE_ID = prev;
      else delete process.env.HERDR_WORKSPACE_ID;
    }
  });

  // VIS-10 (operator ruling 2026-07-11): "pane placed by focus heuristic" is a DEFECT CLASS.
  // The legacy test pinned TODAY'S DEFECT (graceful degrade to an untargeted pane); the defect proof
  // is committed in 43-01-DIAGNOSIS.md, so this now asserts the fix — slot() REJECTS without the env.
  test("HERDR_WORKSPACE_ID unset → slot() rejects (fail closed, no untargeted pane)", async () => {
    const { bin, cwd } = makeStub();
    const prev = process.env.HERDR_WORKSPACE_ID;
    delete process.env.HERDR_WORKSPACE_ID;
    try {
      const d = new HerdrDriver(bin);
      await expect(d.slot(cwd, "ws-nopin")).rejects.toThrow(/workspace/i);
    } finally {
      if (prev !== undefined) process.env.HERDR_WORKSPACE_ID = prev;
    }
  });

  test("notify maps to notification show with sound", async () => {
    const { bin, log } = makeStub();
    const d = new HerdrDriver(bin);
    await d.notify("run done", { sound: "done" });
    expect(readFileSync(log, "utf8")).toContain("notification show run done --sound done");
  });
});

describe("HerdrDriver grouped role-tabs (VIS-04)", () => {
  test("A: concurrent same-group slots share ONE tab; second stacks via downward split + rename + cd", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true });
    const d = new HerdrDriver(bin);
    const [s1, s2] = await Promise.all([d.slot(cwd, "n1", { group: "workers" }), d.slot(cwd, "n2", { group: "workers" })]);
    const calls = readFileSync(log, "utf8");
    expect(calls.match(/tab create/g)).toHaveLength(1); // exactly one tab, even under concurrent slot()
    expect(calls).toContain("tab create --label WORKERS"); // stage-named, not first-member-named (run-104447 incident)
    expect(calls).toContain("pane split w1:p42 --direction right --no-focus"); // first join licensed at 222 cols (43-MEASUREMENT.md)
    expect(calls).not.toMatch(/pane split w1:p7 --direction right/); // subsequent joins stack down
    expect(calls).toContain("agent rename w1:p7 n2"); // split pane gets a durable name
    expect(calls).toContain("agent get n2"); // rename verified live (research A1), not assumed
    expect(calls).toContain(`pane run w1:p7 cd '${cwd}'`); // split shell cd's into ITS OWN worktree
    expect(calls).toContain("pane close w1:p0"); // grouped first member reaps the orphan root pane
    expect(s1.tabId).toBe("w1:t1");
    expect(s2.tabId).toBe("w1:t1"); // shared tab
    expect(s2.id).toBe("w1:p7");
    expect(s2.group).toBe("workers");
  });

  test("B: no-group slot keeps per-slot tab behavior but reaps the orphan root pane", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true });
    const d = new HerdrDriver(bin);
    const s = await d.slot(cwd, "solo");
    const calls = readFileSync(log, "utf8");
    expect(s.id).toBe("w1:p9");
    expect(s.tabId).toBe("w1:t1");
    expect(s.group).toBeUndefined();
    expect(calls).toContain(`agent start solo --cwd ${cwd} --tab w1:t1 --no-focus -- bash`);
    expect(calls).toContain("pane close w1:p0"); // root pane (≠ agent pane w1:p9) reaped
    await d.close(s);
    expect(readFileSync(log, "utf8")).toContain("tab close w1:t1"); // per-slot tab close unchanged
  });

  test("C: ref-counted teardown — pane close per member, tab close only with the last one", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true });
    const d = new HerdrDriver(bin);
    const s1 = await d.slot(cwd, "n1", { group: "workers" });
    const s2 = await d.slot(cwd, "n2", { group: "workers" });
    await d.close(s1);
    let calls = readFileSync(log, "utf8");
    expect(calls).toContain("pane close w1:p42"); // n1's live pane closed
    expect(calls).not.toContain("tab close"); // one member still alive → tab survives
    await d.close(s2);
    calls = readFileSync(log, "utf8");
    expect(calls).toContain("pane close w1:p7"); // n2's split pane closed
    expect(calls.match(/tab close w1:t1/g)).toHaveLength(1); // refcount 0 → tab reaped once
  });

  test("C2: closing the newest member never poisons the split source for later joins", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true });
    const d = new HerdrDriver(bin);
    await d.slot(cwd, "n1", { group: "workers" });
    const s2 = await d.slot(cwd, "n2", { group: "workers" });
    await d.close(s2); // newest member's pane (w1:p7) is dead now
    const s3 = await d.slot(cwd, "n3", { group: "workers" });
    const calls = readFileSync(log, "utf8");
    expect(calls.match(/tab create/g)).toHaveLength(1); // still consolidated — no degrade
    expect(calls.match(/pane split w1:p42 --direction right/g)).toHaveLength(2); // n2 + n3 both first-join right off n1
    expect(calls).not.toContain("pane split w1:p7"); // never split the dead pane
    expect(s3.tabId).toBe("w1:t1");
    expect(s3.group).toBe("workers");
  });

  test("renames only the driver-owned group tab with one live worker task id on join and leave", async () => {
    const { bin, log, cwd } = makeStub(0, { incTabs: true });
    const d = new HerdrDriver(bin);
    const s1 = await d.slot(cwd, "T1-worker-fake-a0-run", { group: "workers" });
    await d.slot(cwd, "T9-consult-1", { label: "OPERATOR T9" });
    const s2 = await d.slot(cwd, "T2-worker-fake-a0-run", { group: "workers" });
    await d.close(s2);
    await d.close(s1);
    const renames = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("tab rename "));
    expect(renames).toEqual([
      "tab rename w1:t1 WORKERS · T1",
      "tab rename w1:t1 WORKERS · T2",
      "tab rename w1:t1 WORKERS · T1",
      "tab rename w1:t1 WORKERS",
    ]);
    expect(renames).not.toContain("tab rename w1:t2 OPERATOR T9");
  });

  test("group tab rename failures are cosmetic", async () => {
    const { bin, log, cwd } = makeStub(0, { tabRenameFails: true });
    const d = new HerdrDriver(bin);
    const s1 = await d.slot(cwd, "T1-worker-fake-a0-run", { group: "workers" });
    const s2 = await d.slot(cwd, "T2-worker-fake-a0-run", { group: "workers" });
    await d.close(s2);
    await d.close(s1);
    expect(readFileSync(log, "utf8").match(/^tab rename /gm) ?? []).toHaveLength(8);
  });

  test("D: split failure degrades to today's per-slot tab (agent start --tab bootstrap) and is memoized", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true, splitFails: true });
    const d = new HerdrDriver(bin);
    const s1 = await d.slot(cwd, "n1", { group: "workers" });
    const s2 = await d.slot(cwd, "n2", { group: "workers" });
    const s3 = await d.slot(cwd, "n3", { group: "workers" });
    const calls = readFileSync(log, "utf8");
    expect(calls.match(/pane split/g)).toHaveLength(1); // tried once, then memoized unsupported
    expect(calls.match(/tab create/g)).toHaveLength(3); // degraded members get their own tabs
    expect(calls).toContain(`agent start n2 --cwd ${cwd} --tab w1:t1 --no-focus -- bash`); // full fallback bootstrap
    expect(calls).toContain(`agent start n3 --cwd ${cwd} --tab w1:t1 --no-focus -- bash`);
    expect(s1.group).toBe("workers");
    expect(s2.id).toBe("w1:p9");
    expect(s2.group).toBeUndefined(); // degraded slot is NOT a shared-tab member
    expect(s3.group).toBeUndefined();
  });

  test("rename failure reaps the split pane and falls back to a per-slot tab (A1 fail-safe)", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true, renameFails: true });
    const d = new HerdrDriver(bin);
    await d.slot(cwd, "n1", { group: "workers" });
    const s2 = await d.slot(cwd, "n2", { group: "workers" });
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("pane close w1:p7"); // the unaddressable split pane is reaped
    expect(calls).toContain(`agent start n2 --cwd ${cwd} --tab w1:t1 --no-focus -- bash`); // fallback bootstrap
    expect(s2.id).toBe("w1:p9");
    expect(s2.group).toBeUndefined();
  });
});

describe("HerdrDriver dedicated role-tabs (SUP-01)", () => {
  test("label opt → dedicated labeled tab, no split, coexists with a worker group tab", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true, incTabs: true });
    const d = new HerdrDriver(bin);
    await d.slot(cwd, "n1", { group: "workers" });                         // WORKERS group tab (w1:t1)
    const c = await d.slot(cwd, "T2-consult-1", { label: "CONSULT T2" });  // dedicated role tab (w1:t2)
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("tab create --label CONSULT T2"); // role-labeled, its OWN tab
    expect(calls.match(/pane split/g) ?? []).toHaveLength(0); // role slot never splits into the group
    expect(c.group).toBeUndefined();                          // not a group member — no refcount involvement
    expect(c.tabId).toBe("w1:t2");                            // distinct tab from WORKERS (w1:t1)
    await d.close(c);
    expect(readFileSync(log, "utf8")).toContain("tab close w1:t2"); // existing tabId teardown reaps the whole tab
  });

  test("no opts → tab labeled with the slot name (today's behavior byte-identical)", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true });
    const d = new HerdrDriver(bin);
    await d.slot(cwd, "solo-x");
    expect(readFileSync(log, "utf8")).toContain("tab create --label solo-x"); // label defaults to name
  });
});

// DEFECT-01: `tickmarkr resume` with keepPanes:run re-dispatches at attempt=0 into a durable name a
// prior (SIGKILLed) process's pane still holds → herdr agent start fails agent_name_taken. tabSlot
// must reclaim (agent get → pane close the stale pane only → retry start once), not die.
describe("HerdrDriver agent_name_taken reclaim (DEFECT-01)", () => {
  test("reclaim resolves: agent get → pane close stale → retry start yields the fresh pane", async () => {
    const { bin, log, cwd } = makeStub(0, { takenNames: ["T1-worker-fake-a0-tag"] });
    const d = new HerdrDriver(bin);
    const slot = await d.slot(cwd, "T1-worker-fake-a0-tag"); // MUST resolve, not throw
    expect(slot.id).toBe("w1:p9"); // the retry's fresh pane, not the stale w1:pSTALE
    const lines = readFileSync(log, "utf8").trim().split("\n");
    const starts = lines.flatMap((l, i) => (l.startsWith("agent start ") ? [i] : []));
    const get = lines.findIndex((l) => l.startsWith("agent get T1-worker-fake-a0-tag"));
    const close = lines.findIndex((l) => l.startsWith("pane close w1:pSTALE"));
    expect(starts).toHaveLength(2); // failed start, then the single retry
    expect(starts[0]).toBeLessThan(get); // start (fail) → get → close → start (ok), in order
    expect(get).toBeLessThan(close);
    expect(close).toBeLessThan(starts[1]);
  });

  test("reclaim fail-closed: a pane close that does not free the name rejects after exactly one retry", async () => {
    const { bin, log, cwd } = makeStub(0, { takenNames: ["T2-worker-fake-a0-tag"], paneCloseNoop: true });
    const d = new HerdrDriver(bin);
    await expect(d.slot(cwd, "T2-worker-fake-a0-tag")).rejects.toThrow(/agent start failed/);
    expect(readFileSync(log, "utf8").match(/^agent start /gm)).toHaveLength(2); // retried once, never looped
  });

  test("unrelated agent start failure throws immediately — no agent get, no pane close (Pitfall 4)", async () => {
    const { bin, log, cwd } = makeStub(0, { startFailsOther: true });
    const d = new HerdrDriver(bin);
    await expect(d.slot(cwd, "T3-worker-fake-a0-tag")).rejects.toThrow(/agent start failed/);
    const calls = readFileSync(log, "utf8");
    expect(calls.match(/^agent start /gm)).toHaveLength(1); // no reclaim retry on a non-taken error
    expect(calls).not.toContain("agent get T3-worker-fake-a0-tag");
    expect(calls).not.toContain("pane close");
  });
});

// VIS-10 (operator-mandated oracle, red-capable by mutation): every pane/tab the driver creates
// carries an explicit workspace target; the driver FAILS CLOSED on every degraded placement path;
// the run's workspace id is seeded into every established pane shell. Reproduced RED on unfixed HEAD
// first — the four reject oracles and the seed oracle fail there; the positive --workspace oracle is
// green on HEAD (its red-capability is by mutation: dropping the flag reddens it).
describe("HerdrDriver VIS-10 fail-closed workspace placement", () => {
  test("env unset → slot() rejects", async () => {
    const { bin, cwd } = makeStub(0, { tab: true });
    const prev = process.env.HERDR_WORKSPACE_ID;
    delete process.env.HERDR_WORKSPACE_ID;
    try {
      const d = new HerdrDriver(bin);
      await expect(d.slot(cwd, "ws-unset")).rejects.toThrow(/workspace/i);
    } finally {
      if (prev !== undefined) process.env.HERDR_WORKSPACE_ID = prev;
    }
  });

  test("tab create non-zero exit → slot() rejects", async () => {
    const { bin, cwd } = makeStub(0, { tabFails: true });
    const prev = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = "wTEST";
    try {
      const d = new HerdrDriver(bin);
      await expect(d.slot(cwd, "ws-tabfail")).rejects.toThrow();
    } finally {
      if (prev !== undefined) process.env.HERDR_WORKSPACE_ID = prev;
      else delete process.env.HERDR_WORKSPACE_ID;
    }
  });

  test("tab create unparseable stdout → slot() rejects", async () => {
    const { bin, cwd } = makeStub(0, { tabGarbage: true });
    const prev = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = "wTEST";
    try {
      const d = new HerdrDriver(bin);
      await expect(d.slot(cwd, "ws-garbage")).rejects.toThrow();
    } finally {
      if (prev !== undefined) process.env.HERDR_WORKSPACE_ID = prev;
      else delete process.env.HERDR_WORKSPACE_ID;
    }
  });

  test("tab create parses but has no tab_id → slot() rejects", async () => {
    const { bin, cwd } = makeStub(0, { tabNoId: true });
    const prev = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = "wTEST";
    try {
      const d = new HerdrDriver(bin);
      await expect(d.slot(cwd, "ws-noid")).rejects.toThrow();
    } finally {
      if (prev !== undefined) process.env.HERDR_WORKSPACE_ID = prev;
      else delete process.env.HERDR_WORKSPACE_ID;
    }
  });

  test("every tab create carries --workspace (positive, red-capable by mutation)", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true });
    const prev = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = "wTEST";
    try {
      const d = new HerdrDriver(bin);
      await d.slot(cwd, "plain1");
      await d.slot(cwd, "g1", { group: "workers" });
      const tabCreates = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("tab create "));
      expect(tabCreates.length).toBeGreaterThanOrEqual(2);
      for (const l of tabCreates) expect(l).toContain("--workspace wTEST");
    } finally {
      if (prev !== undefined) process.env.HERDR_WORKSPACE_ID = prev;
      else delete process.env.HERDR_WORKSPACE_ID;
    }
  });

  test("workspace id seeded into every established pane (tabSlot member + joinGroup split)", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true });
    const prev = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = "wTEST";
    try {
      const d = new HerdrDriver(bin);
      await d.slot(cwd, "n1", { group: "workers" }); // tabSlot member
      await d.slot(cwd, "n2", { group: "workers" }); // joinGroup split member
      const calls = readFileSync(log, "utf8");
      const seeds = calls.split("\n").filter((l) => l.includes("export HERDR_WORKSPACE_ID"));
      expect(seeds.length).toBe(2);
    } finally {
      if (prev !== undefined) process.env.HERDR_WORKSPACE_ID = prev;
      else delete process.env.HERDR_WORKSPACE_ID;
    }
  });
});

describe("HerdrDriver VIS-09 cap + cleanup overflow (VIS-13)", () => {
  test("VIS-09: cap+1'th member opens a cleanup tab (a second tab create, NOT a third split)", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true, incTabs: true });
    const d = new HerdrDriver(bin, 2); // workersPerTab=2
    const s1 = await d.slot(cwd, "n1", { group: "workers" });
    const s2 = await d.slot(cwd, "n2", { group: "workers" });
    const s3 = await d.slot(cwd, "n3", { group: "workers" });
    const calls = readFileSync(log, "utf8");
    expect(calls.match(/tab create/g)).toHaveLength(2); // exactly TWO tabs (WORKERS + cleanup), not one
    const tabCreates = calls.split("\n").filter((l) => l.startsWith("tab create "));
    expect(tabCreates.some((l) => l.includes("--label WORKERS"))).toBe(true);    // gen 1 (primary)
    expect(tabCreates.some((l) => l.includes("--label cleanup"))).toBe(true);    // gen 2 (overflow) — cleanup, never WORKERS-N
    expect(calls).not.toMatch(/--label WORKERS-\d/);                              // VIS-13: no WORKERS-N numeric suffix, ever
    expect(calls.match(/pane split/g) ?? []).toHaveLength(1); // only ONE split (n2 into gen 1); n3 is a NEW tab
    expect(s1.tabId).toBe("w1:t1");
    expect(s2.tabId).toBe("w1:t1"); // gen 1
    expect(s3.tabId).toBe("w1:t2"); // gen 2 — the overflow member lives in the SECOND tab
    expect(s3.group).toBe("workers");
    expect(calls).toContain("pane split w1:p42 --direction right --no-focus"); // D-10 width law: first join right when licensed
  });

  test("VIS-09: overflow teardown is per-tab refcounted (each tab closes when its own last leaves)", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true, incTabs: true });
    const d = new HerdrDriver(bin, 2);
    const s1 = await d.slot(cwd, "n1", { group: "workers" });
    const s2 = await d.slot(cwd, "n2", { group: "workers" });
    const s3 = await d.slot(cwd, "n3", { group: "workers" }); // cleanup tab (gen 2)
    // close both gen-1 members → tab 1 closes; the cleanup tab survives until n3 (its own last) leaves
    await d.close(s1);
    await d.close(s2);
    let calls = readFileSync(log, "utf8");
    expect(calls.match(/tab close w1:t1/g)).toHaveLength(1); // gen 1 reaped
    expect(calls).not.toContain("tab close w1:t2"); // cleanup tab still alive
    await d.close(s3);
    calls = readFileSync(log, "utf8");
    expect(calls.match(/tab close w1:t2/g)).toHaveLength(1); // now the cleanup tab reaps
    // each tab closed EXACTLY once (no double-close, no cross-close)
    expect(calls.match(/^tab close /gm)).toHaveLength(2);
  });

  test("VIS-09: the cap counts LIVE members (after a close, next member joins tab 1 via a split)", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true, incTabs: true });
    const d = new HerdrDriver(bin, 2);
    const a = await d.slot(cwd, "n1", { group: "workers" });
    const bslot = await d.slot(cwd, "n2", { group: "workers" });
    await d.close(a); // tab 1 now has 1 LIVE member (n2) — C2 split-source liveness pruned n1
    const c = await d.slot(cwd, "n3", { group: "workers" });
    const calls = readFileSync(log, "utf8");
    expect(calls.match(/tab create/g)).toHaveLength(1); // still ONE tab — n3 joined tab 1, no cleanup overflow
    expect(calls.match(/pane split/g)).toHaveLength(2); // both n2 and n3 are splits off n1's live pane
    expect(c.tabId).toBe("w1:t1");
    expect(c.group).toBe("workers");
    expect(bslot.tabId).toBe("w1:t1");
    void bslot;
  });

  test("VIS-09: concurrent cap+1'th members create the cleanup overflow tab exactly once (groupSerial holds)", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true, incTabs: true });
    const d = new HerdrDriver(bin, 2);
    const slots = await Promise.all([
      d.slot(cwd, "n1", { group: "workers" }),
      d.slot(cwd, "n2", { group: "workers" }),
      d.slot(cwd, "n3", { group: "workers" }),
    ]);
    const calls = readFileSync(log, "utf8");
    expect(calls.match(/tab create/g)).toHaveLength(2); // not 3 — two cap+1 races did not both open the cleanup tab
    expect(calls).toContain("--label cleanup");
    expect(calls).not.toMatch(/--label WORKERS-\d/); // VIS-13: no WORKERS-N numeric suffix, ever
    const tabs = new Set(slots.map((s) => s.tabId));
    expect(tabs.size).toBe(2); // members partition across exactly two tabs
    expect(calls).toContain("--direction right");
  });

  test("VIS-09: narrow pane width forces down-only splits (incident geometry)", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true, incTabs: true, paneCols: 100 });
    const d = new HerdrDriver(bin, 2);
    for (let i = 0; i < 5; i++) await d.slot(cwd, `n${i}`, { group: "workers" });
    expect(readFileSync(log, "utf8")).not.toContain("--direction right");
  });

  test("VIS-09: layout introspection failure forces down-only splits", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true, layoutFails: true });
    const d = new HerdrDriver(bin, 2);
    await d.slot(cwd, "n1", { group: "workers" });
    await d.slot(cwd, "n2", { group: "workers" });
    expect(readFileSync(log, "utf8")).not.toContain("--direction right");
  });
});

describe("pickDriver", () => {
  test("explicit override wins; auto follows HERDR_ENV", () => {
    expect(pickDriver(DEFAULT_CONFIG, "subprocess").id).toBe("subprocess");
    expect(pickDriver(DEFAULT_CONFIG, "herdr").id).toBe("herdr");
    const prev = process.env.HERDR_ENV;
    process.env.HERDR_ENV = "1";
    expect(pickDriver(DEFAULT_CONFIG).id).toBe("herdr");
    delete process.env.HERDR_ENV;
    expect(pickDriver(DEFAULT_CONFIG).id).toBe("subprocess");
    if (prev !== undefined) process.env.HERDR_ENV = prev;
  });
});

// T2 watch pane: one live status surface per run — a rightward split of the invoking orchestrator
// pane, never a separate tab. A second request for the same canonical watch name must reuse it.
describe("HerdrDriver narrator pane (T2)", () => {
  test("narrator splits right of its invoking pane and reuses the owned watch pane", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true, incTabs: true });
    const d = new HerdrDriver(bin);
    const first = await d.narrator(cwd, "tickmarkr status --watch", "run-watch");
    const second = await new HerdrDriver(bin).narrator(cwd, "tickmarkr status --watch", "run-watch");
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("pane split wTEST:pCALLER --direction right --no-focus");
    expect(calls).toContain("agent rename w1:p7 tickmarkr:watch:run:0:run-watch");
    expect(calls).not.toContain("tab create");
    expect(calls.match(/pane split /g)).toHaveLength(1);
    expect(calls.match(/pane run w1:p7 tickmarkr status --watch/g)).toHaveLength(1);
    expect(second).toEqual(first);
    expect(first.tabId).toBeUndefined();
    await d.close(first);
    expect(readFileSync(log, "utf8")).toContain("pane close w1:p7");
  });

  test("a new run reclaims a surviving prior-run watch instead of splitting another pane", async () => {
    const oldName = "tickmarkr:watch:run:0:run-old";
    const { bin, log, cwd } = makeStub(0, { survivingWatch: { name: oldName, pane: "w1:pOLD" } });
    const next = await new HerdrDriver(bin).narrator(cwd, "tickmarkr status --watch", "run-new");
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("agent list");
    expect(calls).toContain("agent rename w1:pOLD tickmarkr:watch:run:0:run-new");
    expect(calls).not.toContain("pane split");
    expect(next).toEqual({ id: "w1:pOLD", name: "tickmarkr:watch:run:0:run-new", cwd });
  });

  test("narrator reuses fail-closed placement: no HERDR_WORKSPACE_ID → throws (never untargeted)", async () => {
    const { bin, cwd } = makeStub(0, { tab: true });
    const prev = process.env.HERDR_WORKSPACE_ID;
    delete process.env.HERDR_WORKSPACE_ID;
    try {
      const d = new HerdrDriver(bin);
      await expect(d.narrator(cwd, "tickmarkr status --watch")).rejects.toThrow(/workspace/i); // propagates; daemon swallows
    } finally {
      if (prev !== undefined) process.env.HERDR_WORKSPACE_ID = prev;
    }
  });
});
