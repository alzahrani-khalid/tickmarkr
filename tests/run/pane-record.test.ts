import { chmodSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HerdrDriver, type DriverJournal } from "../../src/drivers/herdr.js";
import { formatOwnedName } from "../../src/drivers/types.js";
import { Journal, type JournalEvent } from "../../src/run/journal.js";
import { beatSupervision, SUPERVISION_STALE_MS, supervisionBeatPath } from "../../src/run/supervision.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

interface StubPane {
  paneId: string;
  label: string;
  tabId?: string;
  workspaceId?: string;
}

interface ReconcileStub {
  bin: string;
  log: string;
  panes: string;
}

function makeReconcileStub(opts: { unparseableList?: boolean; closeFails?: string[] } = {}): ReconcileStub {
  const dir = makeTestTempDir("tickmarkr-reconcile-herdr-");
  const bin = join(dir, "herdr");
  const log = join(dir, "log.txt");
  const panes = join(dir, "panes.txt");
  const badList = join(dir, "bad-list");
  const closeFails = join(dir, "close-fails.txt");
  if (opts.unparseableList) writeFileSync(badList, "1\n");
  if (opts.closeFails?.length) writeFileSync(closeFails, opts.closeFails.join("\n") + "\n");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
PANES='${panes}'
BAD_LIST='${badList}'
CLOSE_FAILS='${closeFails}'
echo "$@" >> '${log}'
case "$1 $2" in
  "pane list")
    if [ -f "$BAD_LIST" ]; then printf 'not json'; exit 0; fi
    out=""
    if [ -f "$PANES" ]; then
      while IFS='|' read -r pid label tab ws; do
        [ -z "$pid" ] && continue
        [ -z "$tab" ] && tab='wTEST:t1'
        [ -z "$ws" ] && ws='wTEST'
        e="{\\"pane_id\\":\\"$pid\\",\\"label\\":\\"$label\\",\\"tab_id\\":\\"$tab\\",\\"workspace_id\\":\\"$ws\\"}"
        if [ -z "$out" ]; then out="$e"; else out="$out,$e"; fi
      done < "$PANES"
    fi
    echo "{\\"result\\":{\\"panes\\":[$out]}}"
    ;;
  "pane close")
    if [ -f "$CLOSE_FAILS" ] && grep -qx "$3" "$CLOSE_FAILS"; then printf 'close denied\\n'; exit 17; fi
    if [ -f "$PANES" ]; then
      awk -F'|' -v pid="$3" '$1 != pid' "$PANES" > "$PANES.tmp"
      mv "$PANES.tmp" "$PANES"
    fi
    echo '{}'
    ;;
  "tab close") echo '{}' ;;
  *) echo '{}' ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log, panes };
}

function writePanes(path: string, panes: StubPane[]): void {
  writeFileSync(
    path,
    panes.map((p) => `${p.paneId}|${p.label}|${p.tabId ?? "wTEST:t1"}|${p.workspaceId ?? "wTEST"}`).join("\n") + "\n",
  );
}

function paneRows(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function startJournal(repoRoot: string, runId: string): Journal {
  const journal = Journal.create(repoRoot, runId);
  journal.append("run-start", undefined, {});
  return journal;
}

async function bindRepo(driver: HerdrDriver, repoRoot: string, runId: string): Promise<void> {
  await driver.worktree(repoRoot, `tickmarkr/${runId}--bind`, "HEAD");
}

function sweepEvents(repoRoot: string, runId: string, event: string): JournalEvent[] {
  return Journal.open(repoRoot, runId).read().filter((e) => e.event === event);
}

let wsPrev: string | undefined;
beforeEach(() => {
  wsPrev = process.env.HERDR_WORKSPACE_ID;
  process.env.HERDR_WORKSPACE_ID = "wTEST";
});
afterEach(() => {
  if (wsPrev !== undefined) process.env.HERDR_WORKSPACE_ID = wsPrev;
  else delete process.env.HERDR_WORKSPACE_ID;
});

describe("HerdrDriver reconcile pane records", () => {
  test("a reconcile closing two panes journals one event per pane; each event carries that pane's own id, the owned name parsed from its label, plus the runId reconcile received; one aggregate event naming a count fails", async () => {
    const runId = "run-pane-record-two";
    const repo = makeRepo({ "base.txt": "base\n" });
    startJournal(repo, runId);
    const first = formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId });
    const second = formatOwnedName({ role: "review", taskId: "T2", attempt: 0, runId });
    const stub = makeReconcileStub();
    writePanes(stub.panes, [
      { paneId: "wTEST:p1", label: first, tabId: "wTEST:t1" },
      { paneId: "wTEST:p2", label: second, tabId: "wTEST:t2" },
    ]);
    const driver = new HerdrDriver(stub.bin);
    await bindRepo(driver, repo, runId);

    await driver.reconcile(new Set(), runId);

    const rows = sweepEvents(repo, runId, "pane-reconcile-close");
    expect(rows).toHaveLength(2);
    expect(rows.map((e) => e.data.paneId)).toEqual(["wTEST:p1", "wTEST:p2"]);
    expect(rows.map((e) => e.data.ownedName)).toEqual([
      { role: "worker", taskId: "T1", attempt: 0, runId },
      { role: "review", taskId: "T2", attempt: 0, runId },
    ]);
    for (const row of rows) {
      expect(row.data.sweeperRunId).toBe(runId);
      expect(row.data.count).toBeUndefined();
    }
  });

  test("a close command that fails journals that failure against the pane it was attempting, so the path records the action or its failure and never neither; the present catch swallows both and fails", async () => {
    const runId = "run-pane-record-close-fails";
    const repo = makeRepo({ "base.txt": "base\n" });
    startJournal(repo, runId);
    const label = formatOwnedName({ role: "worker", taskId: "T3", attempt: 0, runId });
    const stub = makeReconcileStub({ closeFails: ["wTEST:p3"] });
    writePanes(stub.panes, [{ paneId: "wTEST:p3", label }]);
    const driver = new HerdrDriver(stub.bin);
    await bindRepo(driver, repo, runId);

    await driver.reconcile(new Set(), runId);

    const failures = sweepEvents(repo, runId, "pane-reconcile-close-failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.taskId).toBe("T3");
    expect(failures[0]!.data).toMatchObject({
      paneId: "wTEST:p3",
      label,
      ownedName: { role: "worker", taskId: "T3", attempt: 0, runId },
      sweeperRunId: runId,
      exitCode: 17,
    });
    expect(sweepEvents(repo, runId, "pane-reconcile-close")).toHaveLength(0);
  });

  test("a reconcile whose pane listing is unparseable journals that failure and still returns without throwing; a method that records the failure by propagating it breaks the never-throws contract this sweep runs under and fails", async () => {
    const runId = "run-pane-record-bad-list";
    const repo = makeRepo({ "base.txt": "base\n" });
    startJournal(repo, runId);
    const stub = makeReconcileStub({ unparseableList: true });
    const driver = new HerdrDriver(stub.bin);
    await bindRepo(driver, repo, runId);

    await expect(driver.reconcile(new Set(), runId)).resolves.toBeUndefined();

    const failures = sweepEvents(repo, runId, "pane-reconcile-list-failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.data).toMatchObject({
      sweeperRunId: runId,
      stage: "pre-close",
      stdout: "not json",
    });
  });

  test("a pane whose label an ARMED supervision beat names survives a reconcile that would otherwise close it, drilled by labelling a throwaway pane an owned-looking token; the same pane whose beat is older than the module's stale threshold is closed; a guard keyed on a beat file merely existing fails", async () => {
    const runId = "run-pane-record-live-seat";
    const repo = makeRepo({ "base.txt": "base\n" });
    startJournal(repo, runId);
    const label = formatOwnedName({ role: "worker", taskId: "Seat", attempt: 0, runId });
    beatSupervision(repo, "overseer", label);
    const stub = makeReconcileStub();
    writePanes(stub.panes, [{ paneId: "wTEST:p-seat", label }]);
    const driver = new HerdrDriver(stub.bin);
    await bindRepo(driver, repo, runId);

    await driver.reconcile(new Set(), runId);

    expect(paneRows(stub.panes)).toContain(`wTEST:p-seat|${label}|wTEST:t1|wTEST`);
    expect(sweepEvents(repo, runId, "pane-reconcile-close")).toHaveLength(0);

    const stale = new Date(Date.now() - SUPERVISION_STALE_MS - 1_000);
    utimesSync(supervisionBeatPath(repo, "overseer"), stale, stale);
    await driver.reconcile(new Set(), runId);

    expect(paneRows(stub.panes)).toEqual([]);
    expect(sweepEvents(repo, runId, "pane-reconcile-close")).toHaveLength(1);
  });

  test("a reconcile closing a pane belonging to a different run journals both the runId that swept it plus the owned runId of the pane closed; an event carrying only one of the two cannot say who killed whom; that is the question OBS-769 could not answer", async () => {
    const sweeperRunId = "run-pane-record-sweeper";
    const ownedRunId = "run-pane-record-ended";
    const repo = makeRepo({ "base.txt": "base\n" });
    startJournal(repo, sweeperRunId);
    const label = formatOwnedName({ role: "worker", taskId: "T9", attempt: 0, runId: ownedRunId });
    const stub = makeReconcileStub();
    writePanes(stub.panes, [{ paneId: "wTEST:p-ended", label }]);
    const driver = new HerdrDriver(stub.bin);
    await bindRepo(driver, repo, sweeperRunId);

    await driver.reconcile(new Set(), sweeperRunId, { endedRunIds: new Set([ownedRunId]) });

    const rows = sweepEvents(repo, sweeperRunId, "pane-reconcile-close");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({
      paneId: "wTEST:p-ended",
      sweeperRunId,
      ownedRunId,
      ownedName: { role: "worker", taskId: "T9", attempt: 0, runId: ownedRunId },
    });
  });

  test("the events are readable from this run's own journal through Journal.open against the repository root and that runId; events delivered only to an injected sink exist nowhere on disk when the run is over and fail", async () => {
    const runId = "run-pane-record-disk";
    const repo = makeRepo({ "base.txt": "base\n" });
    startJournal(repo, runId);
    const label = formatOwnedName({ role: "worker", taskId: "T4", attempt: 0, runId });
    const stub = makeReconcileStub();
    writePanes(stub.panes, [{ paneId: "wTEST:p4", label }]);
    const sinkRows: Array<{ event: string; slotName: string; data: Record<string, unknown> }> = [];
    const sink: DriverJournal = (event, slotName, data) => {
      sinkRows.push({ event, slotName, data });
    };
    const driver = new HerdrDriver(stub.bin, 3, undefined, sink);
    await bindRepo(driver, repo, runId);

    await driver.reconcile(new Set(), runId);

    const diskRows = Journal.open(repo, runId).read().filter((e) => e.event === "pane-reconcile-close");
    expect(diskRows).toHaveLength(1);
    expect(diskRows[0]!.data).toMatchObject({ paneId: "wTEST:p4", sweeperRunId: runId });
    expect(sinkRows.filter((row) => row.event === "pane-reconcile-close")).toHaveLength(0);
  });
});
