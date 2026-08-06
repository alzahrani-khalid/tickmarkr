import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HerdrDriver } from "../../src/drivers/herdr.js";

// Focused herdr stub for the tab-label regression: records every invocation to a log file and
// answers the JSON shapes the driver expects for the group join/leave rename path. Modeled on the
// canonical makeStub in tests/drivers/herdr.test.ts (herdr 0.7.5): the tab's root pane IS the worker,
// durable identity is the pane LABEL (`pane rename` → `pane list`), and agent_status is served off
// `pane list` (the glyph's live observation source — renameGroupTab queries it on every relabel).
// Only the failure-mode branches these tests do not exercise are omitted; the positive surface matches.
interface StubOpts { incTabs?: boolean; tabRenameFails?: boolean; tabRenameFailOnce?: boolean; blockedNames?: string[] }

function makeStub(opts: StubOpts = {}): { bin: string; log: string; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-herdr-tab-"));
  const log = join(dir, "log.txt");
  const panes = join(dir, "panes.txt"); // pane registry: "<pane_id> <label>" per line
  const ctr = join(dir, "tabctr.txt"); // incTabs: distinct tab ids (t1,t2,…) so coexisting tabs are distinguishable
  const bin = join(dir, "herdr");
  const cwd = mkdtempSync(join(tmpdir(), "tickmarkr-herdr-tab-cwd-"));
  const blocked = join(dir, "blocked.txt"); // VIS-13: names the driver observes as agent_status "blocked"
  if (opts.blockedNames?.length) writeFileSync(blocked, opts.blockedNames.join("\n") + "\n");
  // tab create answers tab_id + root_pane (the worker pane); incTabs emits incrementing tab AND root
  // pane ids so coexisting generations never collide on a shared pane id in the registry.
  const tabCreate = opts.incTabs
    ? `n=$(cat '${ctr}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${ctr}'; echo "{\\"result\\":{\\"tab\\":{\\"tab_id\\":\\"w1:t$n\\"},\\"root_pane\\":{\\"pane_id\\":\\"w1:pR$n\\"}}}"`
    : `echo '{"result":{"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p9"}}}'`;
  const paneSplit = `echo '{"result":{"pane":{"pane_id":"w1:p7"}}}'`;
  const paneLayout = `w=222; pid=""; for a in "$@"; do case "$a" in --pane) shift; pid="$1";; esac; done; [ -z "$pid" ] && pid=w1:p42; echo "{\\"result\\":{\\"layout\\":{\\"area\\":{\\"width\\":$w},\\"panes\\":[{\\"pane_id\\":\\"$pid\\",\\"rect\\":{\\"width\\":$w}}]}}}"`;
  const paneRename = `printf '%s %s\\n' "$3" "$4" >> '${panes}'; echo '{}'`;
  const tabRnCtr = join(dir, "tabrn.txt");
  const tabRename = opts.tabRenameFails
    ? "exit 1"
    : opts.tabRenameFailOnce
      ? `n=$(cat '${tabRnCtr}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${tabRnCtr}'; [ "$n" -eq 1 ] && exit 1; echo '{}'`
      : "echo '{}'";
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
BLOCKED='${blocked}'
PANES='${panes}'
herdr_pane_list() {
  out=""
  if [ -f "$PANES" ]; then
    while IFS=' ' read -r pid label; do
      [ -z "$pid" ] && continue
      st="idle"
      if [ -f "$BLOCKED" ] && grep -qx "$label" "$BLOCKED"; then st="blocked"; fi
      e="{\\"pane_id\\":\\"$pid\\",\\"label\\":\\"$label\\",\\"tab_id\\":\\"w1:t1\\",\\"workspace_id\\":\\"wTEST\\",\\"agent_status\\":\\"$st\\"}"
      if [ -z "$out" ]; then out="$e"; else out="$out,$e"; fi
    done < "$PANES"
  fi
  echo "{\\"result\\":{\\"panes\\":[$out]}}"
}
echo "$@" >> '${log}'
case "$1 $2" in
  "tab create") ${tabCreate} ;;
  "tab rename") ${tabRename} ;;
  "tab close") echo '{}' ;;
  "pane rename") ${paneRename} ;;
  "pane list") herdr_pane_list ;;
  "pane split") ${paneSplit} ;;
  "pane layout") ${paneLayout} ;;
  "pane close") grep -v "^$3 " '${panes}' > '${panes}.tmp' 2>/dev/null || :; mv '${panes}.tmp' '${panes}' 2>/dev/null || :; echo '{}' ;;
  "notification show") echo '{}' ;;
  *) echo '{}' ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log, cwd };
}

// VIS-10: the daemon inherits and seeds HERDR_WORKSPACE_ID; every slot requires it (fail closed).
let _wsPrev: string | undefined;
beforeEach(() => { _wsPrev = process.env.HERDR_WORKSPACE_ID; process.env.HERDR_WORKSPACE_ID = "wTEST"; });
afterEach(() => { if (_wsPrev !== undefined) process.env.HERDR_WORKSPACE_ID = _wsPrev; else delete process.env.HERDR_WORKSPACE_ID; });

// Regression lock on VIS-04/22cfc57, carried forward to ONE TAB PER TASK: a task's tab is labelled
// with its task id and refreshes on membership change (the newest live worker, plus its state glyph),
// reverting to the bare task label when empty. ONLY driver-created task tabs are ever relabeled —
// dedicated role tabs and per-slot tabs keep their create-time label.
// The `{ group: "workers" }` these tests still pass is deliberate: the daemon passes it too, and a
// task-bearing name must group by its TASK regardless (derived-wins precedence).
describe("HerdrDriver live tab labels (regression)", () => {
  test("join then leave renames only tickmarkr-created task tabs, each carrying its own task id", async () => {
    const { bin, log, cwd } = makeStub({ incTabs: true });
    const d = new HerdrDriver(bin);
    // T1's tab (w1:t1) and T2's tab (w1:t4) are the only tickmarkr-created tabs the driver may relabel;
    // a dedicated role tab (w1:t2) and a per-slot tab (w1:t3) are labeled once at create, never renamed.
    const s1 = await d.slot(cwd, "T1-worker-fake-a0-run", { group: "workers" });
    await d.slot(cwd, "T9-consult-1", { label: "OPERATOR T9" }); // dedicated role tab — foreign to rename
    await d.slot(cwd, "solo-agent");                              // per-slot tab — foreign to rename
    const s2 = await d.slot(cwd, "T2-worker-fake-a0-run", { group: "workers" }); // a SECOND task
    expect(s2.tabId).not.toBe(s1.tabId); // a second task never lands in the first task's tab
    await d.close(s2); // T2's last member leaves → bare task label, then its tab is reaped
    await d.close(s1);
    const renames = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("tab rename "));
    // exact join/leave sequence: short task-id labels (the extracted task id, never the full agent name),
    // one tab per task rather than one shared stage tab whose label chases whichever worker joined last.
    expect(renames).toEqual([
      "tab rename w1:t1 T1", // s1 bootstrap — the tab is named for its task
      "tab rename w1:t4 T2", // s2 bootstrap — its OWN tab, NOT a refresh of T1's label
      "tab rename w1:t4 T2", // s2 leave — empty generation reverts to the bare task label
      "tab rename w1:t1 T1", // s1 leave
    ]);
    // tickmarkr-created tabs ONLY: every rename targets a task tab; no foreign tab id is ever relabeled.
    const renamedTabs = new Set(renames.map((l) => l.split(" ")[2]));
    expect(renamedTabs).toEqual(new Set(["w1:t1", "w1:t4"]));
    // the foreign tabs coexisted (created with their own labels) but the driver never renamed them.
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("tab create --label OPERATOR T9");
    expect(calls).toContain("tab create --label solo-agent");
  });

  test("a rename command failure does not throw and the slot lifecycle completes", async () => {
    const { bin, log, cwd } = makeStub({ incTabs: true, tabRenameFails: true });
    const d = new HerdrDriver(bin);
    // join: slot() must resolve despite every `tab rename` exiting non-zero (renameGroupTab retries
    // once then notes — cosmetic-only, never blocks membership or pane establishment). Two attempts of
    // ONE task, so both members share that task's tab and the join/leave refcount is exercised.
    const s1 = await d.slot(cwd, "T1-worker-fake-a0-run", { group: "workers" });
    const s2 = await d.slot(cwd, "T1-worker-fake-a1-run", { group: "workers" });
    expect(s1.tabId).toBe("w1:t1");
    expect(s2.tabId).toBe("w1:t1");
    // leave: close() must resolve and the lifecycle must COMPLETE — the last leave still reaps the
    // generation's tab, proving a rename failure did not abort the refcounted teardown.
    await d.close(s2);
    await expect(d.close(s1)).resolves.toBeUndefined();
    const calls = readFileSync(log, "utf8");
    // bounded retry: two tab-rename attempts per relabel across four relabels.
    expect(calls.match(/^tab rename /gm) ?? []).toHaveLength(8);
    // lifecycle completed end-to-end: the generation's tab was reaped on the last leave.
    expect(calls.match(/^tab close w1:t1$/gm) ?? []).toHaveLength(1);
  });

  test("a relabel that fails once and succeeds on retry produces the short label and no note", async () => {
    const { bin, log, cwd } = makeStub({ incTabs: true, tabRenameFailOnce: true });
    const d = new HerdrDriver(bin);
    await d.slot(cwd, "T1-worker-fake-a0-run", { group: "workers" });
    const calls = readFileSync(log, "utf8");
    const renames = calls.split("\n").filter((l) => l.startsWith("tab rename "));
    expect(renames).toEqual(["tab rename w1:t1 T1", "tab rename w1:t1 T1"]);
    expect(calls.match(/^notification show /m)).toBeNull();
  });

  test("a persistent relabel failure emits exactly one note naming tab and label; lifecycle still completes", async () => {
    const { bin, log, cwd } = makeStub({ incTabs: true, tabRenameFails: true });
    const d = new HerdrDriver(bin);
    const s1 = await d.slot(cwd, "T1-worker-fake-a0-run", { group: "workers" });
    const afterJoin = readFileSync(log, "utf8");
    const notes = afterJoin.split("\n").filter((l) => l.startsWith("notification show "));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("w1:t1");
    expect(notes[0]).toMatch(/→ T1(?: |$)/); // the WHOLE label, so a regressed prefix ("WORKERS · T1") reddens
    await expect(d.close(s1)).resolves.toBeUndefined();
    expect(readFileSync(log, "utf8")).toMatch(/^tab close w1:t1$/m);
  });
});

// VIS-13 (operator-locked hygiene), under ONE TAB PER TASK: the primary generation tab is the TASK's
// tab and carries its task id plus one hot token; overflow generations are "cleanup · <token>"; the
// token carries ONE state glyph — ↻ for a retry attempt (attempt > 0 parsed from the member name), ✋
// when the driver observes the member blocked (queried live at every relabel), bare otherwise; ✋ wins
// over ↻ (at most one glyph); no tab is ever given a numeric suffix. Because the tab label already IS
// the task id, the token is not appended a second time — the glyph rides the existing label.
// Rename failures stay swallowed and foreign tabs stay untouched.
describe("HerdrDriver VIS-13 tab hygiene + state glyphs", () => {
  test("a task tab carries its task id once; a retry attempt (attempt > 0) appends ↻, attempt 0 is bare", async () => {
    const { bin, log, cwd } = makeStub({ incTabs: true });
    const d = new HerdrDriver(bin);
    const s0 = await d.slot(cwd, "T0-worker-fake-a0-run", { group: "workers" }); // attempt 0 → bare
    const s1 = await d.slot(cwd, "T0-worker-fake-a1-run", { group: "workers" }); // SAME task, attempt 1 → ↻ (newest)
    await d.close(s1); // leave → reverts to the remaining attempt-0 member (bare)
    await d.close(s0); // empty → bare task label
    const renames = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("tab rename "));
    expect(renames).toEqual([
      "tab rename w1:t1 T0",  // bootstrap: attempt 0, observed running → bare token, printed ONCE
      "tab rename w1:t1 T0↻", // join: attempt 1 (retry) → ↻ appended, still not "T0 · T0↻"
      "tab rename w1:t1 T0",  // leave: remaining attempt-0 member → bare again
      "tab rename w1:t1 T0",  // empty → bare task label
    ]);
  });

  test("a member the driver observes blocked renders ✋ (status re-queried live at every relabel)", async () => {
    const { bin, log, cwd } = makeStub({ incTabs: true, blockedNames: ["T1-worker-fake-a0-run"] });
    const d = new HerdrDriver(bin);
    const s1 = await d.slot(cwd, "T1-worker-fake-a0-run", { group: "workers" }); // blocked
    const s2 = await d.slot(cwd, "T1-worker-fake-a1-run", { group: "workers" }); // retry, not blocked → newest
    await d.close(s2); // leave → relabel to s1: status re-queried → blocked → ✋
    await d.close(s1);
    const renames = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("tab rename "));
    expect(renames).toEqual([
      "tab rename w1:t1 T1✋", // bootstrap: s1 observed blocked → ✋
      "tab rename w1:t1 T1↻", // join: s2 (not blocked, attempt 1) → the retry glyph
      "tab rename w1:t1 T1✋", // leave: status re-queried on s1 → ✋ (live, not cached)
      "tab rename w1:t1 T1",   // empty → bare task label
    ]);
  });

  test("✋ wins over ↻: a blocked retry renders exactly one glyph (✋), never ↻ or ↻✋", async () => {
    const { bin, log, cwd } = makeStub({ incTabs: true, blockedNames: ["T3-worker-fake-a1-run"] });
    const d = new HerdrDriver(bin);
    const s = await d.slot(cwd, "T3-worker-fake-a1-run", { group: "workers" }); // retry AND blocked
    await d.close(s);
    const renames = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("tab rename "));
    expect(renames).toEqual([
      "tab rename w1:t1 T3✋", // bootstrap: blocked retry → one glyph (✋ wins)
      "tab rename w1:t1 T3",   // leave → bare task label
    ]);
    expect(renames[0]).not.toMatch(/↻/); // ✋ won — the retry glyph never co-appears
  });

  test("overflow generation tabs are cleanup · <token><glyph>, relabel on leave like the primary; never <task>-N", async () => {
    const { bin, log, cwd } = makeStub({ incTabs: true });
    const d = new HerdrDriver(bin, 1); // workersPerTab=1 → a 2nd WORKER of the same task overflows
    const s1 = await d.slot(cwd, "T1-worker-fake-a0-run", { group: "workers" }); // gen 1 (the task tab)
    const s2 = await d.slot(cwd, "T1-worker-fake-a1-run", { group: "workers" }); // gen 2 (cleanup, retry → ↻)
    await d.close(s2); // overflow gen's last leaves → bare stage, then tab reaped
    await d.close(s1); // primary gen's last leaves → bare task label, then tab reaped
    const calls = readFileSync(log, "utf8");
    // primary is the task's own tab; overflow is cleanup — never a numeric suffix (VIS-13)
    expect(calls).toContain("--label T1");
    expect(calls).toContain("--label cleanup");
    expect(calls).not.toMatch(/--label T1-\d/);
    const renames = calls.split("\n").filter((l) => l.startsWith("tab rename "));
    expect(renames).toEqual([
      "tab rename w1:t1 T1",             // gen 1 primary bootstrap (attempt 0 → bare token, printed once)
      "tab rename w1:t2 cleanup · T1↻",  // gen 2 overflow bootstrap — label ≠ token, so the token IS appended
      "tab rename w1:t2 cleanup",        // gen 2 leave → bare stage (reverts like the primary)
      "tab rename w1:t1 T1",             // gen 1 leave → bare task label
    ]);
    // foreign tabs stay untouched: only the two driver-created group tabs were ever renamed
    const renamedTabs = new Set(renames.map((l) => l.split(" ")[2]));
    expect(renamedTabs).toEqual(new Set(["w1:t1", "w1:t2"]));
  });
});
