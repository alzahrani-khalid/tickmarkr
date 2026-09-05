import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { declareInputBox } from "../../src/adapters/types.js";
import { DELIVERY_ATTEMPTS, DISPATCH_START_PREFIX, DeliveryReadinessError, HerdrDriver, taskGroupOf } from "../../src/drivers/herdr.js";
import { pickDriver } from "../../src/drivers/index.js";
import { formatOwnedName } from "../../src/drivers/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { classifyTaskFailure, Journal, type JournalEvent } from "../../src/run/journal.js";
import { runDaemon } from "../../src/run/daemon.js";
import { bindNarration, narrationSink } from "../../src/cli/commands/run.js";
import { setupRepo, T } from "../helpers/tmprepo.js";

interface StubOpts { tab?: boolean; splitFails?: boolean; renameFails?: boolean; tabRenameFails?: boolean; incTabs?: boolean; incPanes?: boolean; takenNames?: string[]; paneCloseNoop?: boolean; startFailsOther?: boolean; tabFails?: boolean; tabGarbage?: boolean; tabNoId?: boolean; paneCols?: number; layoutFails?: boolean; swapFails?: boolean; swapNoChange?: boolean; survivingWatch?: { name: string; pane: string }; corrupt?: "always" | "once" | "p9-only"; contendDelivery?: boolean; wrappedCmd?: string; boxWrappedCmd?: string; paneIds?: Record<string, string>; dropBindingFor?: string; rebindAfterDelivery?: { name: string; pane: string }; paneReadFrames?: string[]; paneReadFails?: boolean; paneReadHangs?: boolean; paneReadHangsAfter?: number; changingPaneRead?: boolean; clearFailsThroughRead?: number; submission?: "first" | "second" | "never" | "slow" | "absent" | "scaled" | "banner-only" | "empty-box" | "bare-command" | "execution-echo" | "looks-successful"; submitAfterReads?: number; dispatchAck?: "never" | "fresh-only"; dispatchEcho?: boolean; ackWatchBlind?: boolean; ackWriteFails?: boolean; paneCloseFails?: boolean }

function steppedTimeSource() {
  let nowMs = 0;
  const sleeps: number[] = [];
  return {
    time: {
      now: () => nowMs,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    },
    sleeps,
    now: () => nowMs,
  };
}

// OBS-85 fixture text: what the incident panes actually showed instead of the typed dispatch line.
const CORRUPT_READ = `printf "git: 'rev-parseprintf' is not a git command\\n"`;

function makeStub(waitExit = 0, opts: StubOpts = {}): { bin: string; log: string; cwd: string; panes: string } {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-herdr-"));
  const log = join(dir, "log.txt");
  // herdr 0.7.5 durable identity is the PANE LABEL: `pane rename` registers "<paneId> <label>" and
  // `pane list` reports it back (namedPaneId/statusByName/reconcile/ownedWatchPanes all resolve here).
  const panes = join(dir, "panes.txt");
  const ctr = join(dir, "tabctr.txt"); // incTabs: distinct tab ids (t1,t2,…) so coexisting tabs are distinguishable
  const verctr = join(dir, "verctr.txt"); // corrupt:"once" — first delivery verify fails, later ones match
  const readctr = join(dir, "readctr.txt"); // staged pane paints + clear guard timing
  const inflight = join(dir, "inflight.txt"); // contendDelivery: pane ids with an active delivery
  const enterctr = join(dir, "enterctr.txt"); // submission verification: bounded Enter presses
  const submitreadctr = join(dir, "submitreadctr.txt"); // slow-submit fixture: reads before registration
  const typed = join(dir, "typed.txt"); // the currently typed delivery prompt
  const paneOut = join(dir, "paneout"); // per-pane stdout of the lines this pane's shell actually ran
  const bin = join(dir, "herdr");
  const cwd = mkdtempSync(join(tmpdir(), "tickmarkr-herdr-cwd-"));
  // DEFECT-01: a prior (killed) attempt's kept pane still carries the durable label — a stale pane-list
  // entry the reclaim sweep must find and close before the fresh pane can be the sole holder of the name.
  if (opts.takenNames?.length) for (const n of opts.takenNames) writeFileSync(panes, `w1:pSTALE ${n}\n`, { flag: "a" });
  // pre-registered pane labels (delivery-contention test resolves names to fixed panes).
  if (opts.paneIds) for (const [name, id] of Object.entries(opts.paneIds)) writeFileSync(panes, `${id} ${name}\n`, { flag: "a" });
  // a surviving prior-run watch pane (narrator reclaim path).
  if (opts.survivingWatch) writeFileSync(panes, `${opts.survivingWatch.pane} ${opts.survivingWatch.name}\n`, { flag: "a" });
  // tab create answers tab_id + root_pane.pane_id; in 0.7.5 that root shell pane IS the worker pane
  // (no separate `agent start … -- bash`). incTabs emits incrementing tab ids so a group tab and a
  // dedicated role tab are distinguishable. tabFails/tabGarbage/tabNoId are the degraded-path fixtures.
  const tabCreate =
    opts.tabFails ? "exit 1" :
    opts.tabGarbage ? "printf 'not json'" :
    // incPanes: distinct tab ids AND distinct root pane ids — what real herdr does, and what a
    // one-tab-per-TASK scenario needs, since two concurrent tasks no longer share one tab's root pane.
    opts.incPanes
    ? `n=$(cat '${ctr}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${ctr}'; echo "{\\"result\\":{\\"tab\\":{\\"tab_id\\":\\"w1:t$n\\"},\\"root_pane\\":{\\"pane_id\\":\\"w1:pR$n\\"}}}"`
    : opts.incTabs
    ? `n=$(cat '${ctr}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${ctr}'; echo "{\\"result\\":{\\"tab\\":{\\"tab_id\\":\\"w1:t$n\\"},\\"root_pane\\":{\\"pane_id\\":\\"w1:p9\\"}}}"`
    : opts.tabNoId ? `echo '{}'`
    : `echo '{"result":{"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p9"}}}'`;
  // A split pane is a LIVE pane from the moment herdr returns it, so the fixture registers it in the
  // pane registry (unlabelled until a rename) — otherwise `pane list` could never witness a split the
  // driver failed to close, and every close-verification would be vacuously satisfied.
  const paneSplit = opts.splitFails ? "exit 1" : `printf '%s -\n' 'w1:p7' >> '${panes}'; echo '{"result":{"pane":{"pane_id":"w1:p7"}}}'`;
  // ⚠ THE BOARD NO LONGER SWAPS (2026-08-25): it is split to the RIGHT of the caller in one
  // operation, so no test drives swapFails/swapNoChange any more. The fixture is kept, unused, for
  // the response shape it records — deleting it would mean editing the StubOpts mega-line, which is
  // the likeliest merge conflict on this file while a task owns it. Delete both with the next edit
  // that touches that line for its own reasons.
  // `pane swap` is what USED TO PUT the board ABOVE the caller after the down split. The flag lives at
  // `result.swap.changed` — this fixture previously hand-wrote `result.changed`, the same wrong
  // shape the driver read, so the suite validated the defect instead of catching it (OBS-561: the
  // board died at birth on every real run while these tests were green). Shape captured verbatim
  // from herdr 0.8.0; tests/drivers/herdr-swap-shape.test.ts pins it. swapFails is a swap it errors
  // on, swapNoChange is the one that matters more — a ZERO exit reporting `changed:false`, i.e.
  // nothing moved and the board is still under the narration while the exit code says it went fine.
  const paneSwap = opts.swapFails
    ? "exit 1"
    : opts.swapNoChange
      ? `echo '{"result":{"swap":{"changed":false,"reason":"panes are not siblings"}},"type":"pane_swap"}'`
      : `echo '{"result":{"swap":{"changed":true,"source_pane_id":"w1:p7","target_pane_id":"wTEST:pCALLER"}},"type":"pane_swap"}'`;
  const paneLayout = opts.layoutFails ? "exit 1" : `w=${opts.paneCols ?? 222}; pid=""; for a in "$@"; do case "$a" in --pane) shift; pid="$1";; esac; done; [ -z "$pid" ] && pid=w1:p42; echo "{\\"result\\":{\\"layout\\":{\\"area\\":{\\"width\\":$w},\\"panes\\":[{\\"pane_id\\":\\"$pid\\",\\"rect\\":{\\"width\\":$w}}]}}}"`;
  // pane rename <pane> <name>: register the durable label ($3=pane, $4=label). renameFails rejects the
  // SPLIT pane's rename only (w1:p7) — the old agent-rename fixture hit joins, not the tabSlot root — so
  // the first group member still names its root pane and the join is what degrades (A1 fail-safe).
  const paneRename = opts.dropBindingFor
    ? `if [ "$4" != '${opts.dropBindingFor}' ]; then printf '%s %s\\n' "$3" "$4" >> '${panes}'; fi; echo '{}'`
    : opts.renameFails
    ? `if [ "$3" = "w1:p7" ]; then exit 1; fi; printf '%s %s\\n' "$3" "$4" >> '${panes}'; echo '{}'`
    : `printf '%s %s\\n' "$3" "$4" >> '${panes}'; echo '{}'`;
  const tabRename = opts.tabRenameFails ? "exit 1" : "echo '{}'";
  // pane close <pane>: drop its registry line (frees the label) unless paneCloseNoop (the reclaim
  // fail-closed fixture — a close that never frees the name must make the driver reject).
  const paneClose = opts.paneCloseFails ? `exit 1` : opts.paneCloseNoop ? `echo '{}'` : `grep -v "^$3 " '${panes}' > '${panes}.tmp' 2>/dev/null || :; mv '${panes}.tmp' '${panes}' 2>/dev/null || :; echo '{}'`;
  // OBS-85: the delivery read-back rides `pane wait-output --match <cmd>` (exit 0 = pane echoed the typed
  // command). corrupt:"always" never matches; corrupt:"once" fails the first verify then matches —
  // the cleared-and-retyped path. pane read then serves the corrupted-transcript capture.
  const waitOutput =
    opts.wrappedCmd || opts.boxWrappedCmd
      ? "exit 1"
      : opts.corrupt === "always"
      ? "exit 1"
      // a wedged pane: the typed read-back never lands there, while a fresh sibling takes it normally
      : opts.corrupt === "p9-only"
      ? `[ "$3" = 'w1:p9' ] && exit 1; exit 0`
      : opts.corrupt === "once"
        ? `n=$(cat '${verctr}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${verctr}'; [ $n -le 1 ] && exit 1; exit 0`
        : `exit ${waitExit}`;
  const stagedReads = opts.paneReadFrames?.map(
    (frame, i) => `${i + 1}) printf '%s\\n' '${frame.replaceAll("'", "'\\''")}' ;;`,
  ).join(" ");
  const lastStagedRead = opts.paneReadFrames?.at(-1)?.replaceAll("'", "'\\''");
  // v1.85 T5: the pane ECHOES the entire dispatched line beneath a shell prompt, with worker output
  // and a fresh prompt below it — the exact shape the deleted shell-execution-echo reader (OBS-144)
  // read as "the shell ran this". The nonce is mangled on the way in (below), so it was never
  // PRINTED: a perfect lookalike carrying no causal evidence.
  const dispatchEchoRead = `printf '➜  worker git:(task) ✗ %s\\nworker-output\\n➜  worker git:(task) ✗ \\n' "$(cat '${typed}' 2>/dev/null)"`;
  const preSubmitPaneRead = opts.dispatchEcho
    ? dispatchEchoRead
    : opts.changingPaneRead
    ? `n=$(cat '${readctr}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${readctr}'; printf 'painting-frame-%s\\n' "$n"`
    : opts.paneReadFrames?.length
      ? `n=$(cat '${readctr}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${readctr}'; case "$n" in ${stagedReads} *) printf '%s\\n' '${lastStagedRead}' ;; esac`
      : opts.corrupt ? CORRUPT_READ : opts.boxWrappedCmd
        // OBS-154: a TUI editor re-wraps a long delivery across ITS OWN bordered rows, so the pane
        // carries `│` between fragments we typed as one line — the shape captured verbatim from
        // kimi 0.29.1 at probe 6b (indented one column, per OBS-152).
        ? `[ -s '${typed}' ] && printf ' ╭─────────╮\\n │ > ${opts.boxWrappedCmd.slice(0, 20)}   │\\n │   ${opts.boxWrappedCmd.slice(20)}   │\\n ╰─────────╯\\n' || printf ' ╭─────────╮\\n │ >       │\\n ╰─────────╯\\n'`
      : opts.wrappedCmd
        ? `[ -s '${typed}' ] && printf '> ${opts.wrappedCmd.slice(0, 20)}\\n${opts.wrappedCmd.slice(20)}\\n' || printf '> \\n'`
        : opts.submission
          ? `printf '╭────────────╮\\n│ >          │\\n╰────────────╯\\n'`
        : `printf 'line1\\nTICKMARKR_EXIT:0\\n'`;
  const stuckSubmission = `cmd=$(cat '${typed}' 2>/dev/null); printf '╭────────────╮\\n│ > %s │\\n╰────────────╯\\n' "$cmd"`;
  const completedSubmission = `cmd=$(cat '${typed}' 2>/dev/null); printf '%s\\nworker-output\\nSend /help for help information.\\n╭────────────╮\\n│ >          │\\n╰────────────╯\\n' "$cmd"`;
  // v1.85 T5: the same frame WITHOUT the fresh empty box — a transcript that merely looks successful.
  const looksSuccessfulSubmission = `cmd=$(cat '${typed}' 2>/dev/null); printf '%s\\nworker-output\\nSend /help for help information.\\n> \\n' "$cmd"`;
  const absentSubmission = `printf 'worker-output\\n> \\n'`;
  const bannerOnlySubmission = `printf 'Welcome to Kimi Code!\\nSend /help for help information.\\n'`;
  const emptyBoxSubmission = `printf '╭────────────╮\\n│ >          │\\n╰────────────╯\\n'`;
  const bareCommandSubmission = `cat '${typed}' 2>/dev/null; printf '\\n'`;
  const executionEchoSubmission = `cmd=$(cat '${typed}' 2>/dev/null); printf '➜  worker git:(task) ✗ %s\\n' "$cmd"`;
  const postSubmitPaneRead = opts.submission === "never"
    ? stuckSubmission
    : opts.submission === "absent"
      ? absentSubmission
    : opts.submission === "banner-only"
      ? bannerOnlySubmission
    : opts.submission === "empty-box"
      ? emptyBoxSubmission
    : opts.submission === "bare-command"
      ? bareCommandSubmission
    : opts.submission === "execution-echo"
      ? executionEchoSubmission
    : opts.submission === "looks-successful"
      ? looksSuccessfulSubmission
    : opts.submission === "second"
      ? `n=$(cat '${enterctr}' 2>/dev/null || echo 0); if [ "$n" -ge 2 ]; then ${completedSubmission}; else ${stuckSubmission}; fi`
      : opts.submission === "slow" || opts.submission === "scaled"
        ? `n=$(cat '${submitreadctr}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${submitreadctr}'; if [ "$n" -ge ${opts.submitAfterReads ?? (opts.submission === "scaled" ? 8 : 3)} ]; then ${completedSubmission}; else ${stuckSubmission}; fi`
        : completedSubmission;
  const paneRead = opts.paneReadFails
    ? `printf 'pane read protocol failure\\n'; exit 1`
    : opts.paneReadHangs
      ? `sleep 2; printf 'late pane read\\n'`
      : opts.paneReadHangsAfter !== undefined
        ? `n=$(cat '${readctr}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${readctr}'; if [ "$n" -gt ${opts.paneReadHangsAfter} ]; then sleep 2; fi; printf 'restless-frame-%s\\n' "$n"`
        : `n=$(cat '${enterctr}-'"$3" 2>/dev/null || echo 0); if [ "$n" -gt 0 ]; then ${postSubmitPaneRead}; else ${preSubmitPaneRead}; fi`;
  const deliveryContend = opts.contendDelivery
    ? `
delivery_pane() { for a in "$@"; do case "$a" in w1:p*) echo "$a"; return;; esac; done; }
delivery_begin() { p=$(delivery_pane "$@"); [ -z "$p" ] && return; grep -qx "$p" '${inflight}' 2>/dev/null && exit 1; echo "$p" >> '${inflight}'; }
delivery_end() { p=$(delivery_pane "$@"); [ -z "$p" ] && return; grep -vx "$p" '${inflight}' > '${inflight}.tmp' 2>/dev/null || : > '${inflight}.tmp'; mv '${inflight}.tmp' '${inflight}'; }
delivery_clear() { p=$(delivery_pane "$@"); [ -z "$p" ] && return; n=$(wc -l < '${inflight}' 2>/dev/null | tr -d ' '); [ -z "$n" ] && n=0; [ "$n" -gt 1 ] && exit 1; delivery_end "$@"; echo '{}'; }
pane_send_keys() { if [[ "$*" == *C-u* ]]; then delivery_clear "$@"; elif [[ "$*" == *Enter* ]]; then delivery_end "$@"; echo '{}'; else echo '{}'; fi; }
`
    : "";
  const sendText = opts.contendDelivery
    ? `printf '%s' "$4" > '${typed}'; delivery_begin "$@"; echo '{}'`
    : `printf '%s' "$4" > '${typed}'; echo '{}'`;
  const clearResult = opts.clearFailsThroughRead === undefined
    ? `echo '{}'`
    : `n=$(cat '${readctr}' 2>/dev/null || echo 0); [ "$n" -le ${opts.clearFailsThroughRead} ] && exit 1; echo '{}'`;
  const rebind = opts.rebindAfterDelivery
    ? `grep -v " ${opts.rebindAfterDelivery.name}$" '${panes}' > '${panes}.tmp' 2>/dev/null || :; mv '${panes}.tmp' '${panes}' 2>/dev/null || :; printf '%s %s\\n' '${opts.rebindAfterDelivery.pane}' '${opts.rebindAfterDelivery.name}' >> '${panes}';`
    : "";
  const enterResult = opts.rebindAfterDelivery ? `if [[ "$*" == *Enter* ]]; then ${rebind} fi; echo '{}'` : `echo '{}'`;
  // dispatchEcho: keep the delivered line so `pane read` can echo it back, but break the marker so
  // the pane never carries a joined nonce — the shell here echoes without ever running.
  const recordDispatch = opts.dispatchEcho ? `printf '%s' "$4" | sed 's/TICKMARKR_START_/TICKMARKR_ECHOED_/g' > '${typed}'; ` : "";
  // v1.85 T5: `pane run` hands the delivered line to a REAL shell, the way a live pane does. Nothing
  // in this fixture writes an acknowledgment — the marker exists only if the shell executed the line
  // the driver composed, which is the whole claim under test. PATH is emptied and the shell invoked
  // by absolute path, so the line's builtins (printf, redirection) run while the agent command it
  // launches cannot: a unit test executes the dispatch protocol, never an agent CLI.
  const execDispatch = `PATH='' /bin/bash -c "$4" >> '${paneOut}-'"$3" 2>/dev/null || :`;
  // dispatchAck fixtures are wedged panes: the herdr request is accepted and the line never runs.
  const ackDispatch =
    opts.dispatchAck === "never" ? ":"
    : opts.dispatchAck === "fresh-only" ? `if [ "$3" != 'w1:p9' ]; then ${execDispatch}; fi`
    : execDispatch;
  // ackWriteFails: the pane's shell cannot write the acknowledgment the driver opened for it — the
  // path is replaced by a DIRECTORY, so the line's `>` redirection fails for a reason no privilege
  // level bypasses. Nothing else about the pane is disturbed: the shell below still really runs.
  const breakAck = opts.ackWriteFails
    ? `p=$(printf '%s' "$4" | grep -o "/[^']*tickmarkr-dispatch-[^']*\\.ack" | head -1); if [ -n "$p" ]; then rm -f "$p"; mkdir -p "$p"; fi; `
    : "";
  // the atomic dispatch verb: with no Enter following it, a label rebind now races THIS call
  const paneRun = `${recordDispatch}${breakAck}${opts.rebindAfterDelivery ? `if [[ "$*" == *TICKMARKR_START_* ]]; then ${rebind} fi; ` : ""}${ackDispatch}; echo '{}'`;
  const countEnter = `if [[ "$*" == *Enter* ]]; then n=$(cat '${enterctr}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${enterctr}'; m=$(cat '${enterctr}-'"$3" 2>/dev/null || echo 0); m=$((m+1)); echo $m > '${enterctr}-'"$3"; fi`;
  const sendKeys = opts.contendDelivery
    ? `${countEnter}; pane_send_keys "$@"`
    : `${countEnter}; if [[ "$*" == *C-u* ]]; then ${clearResult}; else ${enterResult}; fi`;
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
PANES='${panes}'
herdr_pane_list() {
  out=""
  if [ -f "$PANES" ]; then
    while IFS=' ' read -r pid label; do
      [ -z "$pid" ] && continue
      e="{\\"pane_id\\":\\"$pid\\",\\"label\\":\\"$label\\",\\"tab_id\\":\\"w1:t1\\",\\"workspace_id\\":\\"wTEST\\",\\"agent_status\\":\\"idle\\"}"
      if [ -z "$out" ]; then out="$e"; else out="$out,$e"; fi
    done < "$PANES"
  fi
  echo "{\\"result\\":{\\"panes\\":[$out]}}"
}
${deliveryContend}
echo "$@" >> '${log}'
case "$1 $2" in
  "tab create") ${tabCreate} ;;
  "tab rename") ${tabRename} ;;
  "tab close") echo '{}' ;;
  "pane rename") ${paneRename} ;;
  "pane list") herdr_pane_list ;;
  "pane split") ${paneSplit} ;;
  "pane swap") ${paneSwap} ;;
  "pane layout") ${paneLayout} ;;
  "pane close") ${paneClose} ;;
  # a START-nonce wait is answered from what this pane's shell actually PRINTED, never from the
  # pattern it was asked about: a fixture that answered the question by reading the question would
  # prove nothing about the driver (v1.85 T5)
  "pane wait-output") case "$5" in
    TICKMARKR_START_*) ${opts.ackWatchBlind ? "exit 1" : `grep -q -- "$5" '${paneOut}-'"$3" 2>/dev/null && exit 0 || exit 1`} ;;
    *) ${waitOutput} ;;
  esac ;;
  "agent wait") exit 0 ;;
  "notification show") echo '{}' ;;
  "pane send-text") ${sendText} ;;
  "pane send-keys") ${sendKeys} ;;
  "pane run")    ${paneRun} ;;
  "pane read")   ${paneRead} ;;
  *) echo '{}' ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log, cwd, panes };
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
  test("slot → tab create --cwd root pane, named via pane rename; pane id parsed", async () => {
    const { bin, log } = makeStub();
    const d = new HerdrDriver(bin);
    const slot = await d.slot("/some/worktree", "run-1-T1-a0");
    expect(slot.id).toBe("w1:p9"); // the tab's root shell pane IS the worker pane (0.7.5)
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("tab create --label run-1-T1-a0 --no-focus --workspace wTEST --cwd /some/worktree");
    expect(calls).toContain("pane rename w1:p9 run-1-T1-a0"); // durable identity is the pane label
    expect(calls).not.toContain("agent start"); // the removed one-shot verb never runs (regression fence)
  });

  test("run verifies the pane label before delivery and later reads stay on the delivered pane", async () => {
    const { bin, log, cwd } = makeStub();
    const d = new HerdrDriver(bin);
    const slot = await d.slot(cwd, "n1");
    await d.run(slot, "echo hi");
    expect(await d.read(slot, 50)).toContain("TICKMARKR_EXIT:0");
    await d.close(slot);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("pane list"); // re-resolution reads the label back (never a cached id)
    expect(calls).toContain("pane run w1:p9 printf"); // atomic delivery, resolved fresh from the label
    expect(calls).toContain("pane read w1:p9 --source recent-unwrapped --lines 50");
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

  // 0.7.5 `pane wait-output` treats --match (literal) and --regex (pattern) as MUTUALLY EXCLUSIVE; the
  // old `--match <p> --regex` combo is rejected, so the exit-marker wait errored instantly instead of
  // waiting and LLM-gate/consult verdicts were read before they rendered → unparseable. Pin exactly one.
  test("waitOutput uses --regex xor --match, never the rejected combo (verdict-read regression)", async () => {
    const { bin, log, cwd } = makeStub(0);
    const d = new HerdrDriver(bin);
    const slot = await d.slot(cwd, "j1");
    await d.waitOutput(slot, "RGXMARK", 1000, { regex: true });
    await d.waitOutput(slot, "LITMARK", 1000);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("pane wait-output w1:p9 --regex RGXMARK --timeout 1000"); // regex → --regex <pattern>
    expect(calls).toContain("pane wait-output w1:p9 --match LITMARK --timeout 1000"); // literal → --match <pattern>
    expect(calls).not.toMatch(/--match \S+ --regex/); // never the mutually-exclusive combo again
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

// v1.85 T5 (OBS-140/253). OBS-85 hardened the TYPED path — type, read back, then Enter — because
// `pane run` had pressed Enter on a line nobody had verified. Ten dispatch corruptions across seven
// runs later, the diagnosis inverted: the seam between "text landed" and "Enter registered" is the
// defect, and no amount of read-back inference closes it. A shell or bootstrap dispatch now goes out
// through the atomic verb and is acknowledged by a START nonce the delivered line PRINTS, which no
// pane can produce by echoing what it was handed. Typed delivery survives only where a real TUI turn
// needs it, licensed by the adapter's own declared input states.
// The declared box for the positional-inference oracle: painted (readiness) before submission, and
// absent from the lookalike frame the pane shows afterwards.
const looksSuccessfulAdapterId = "looks-successful-test";
declareInputBox(looksSuccessfulAdapterId, {
  fingerprint: "│ >",
  match: (paneText: string) => paneText.includes("│ >"),
  emptyMatch: (paneText: string) => paneText.includes("│ >          │"),
  launchCommand: () => false,
  readinessTimeoutMs: 500,
});

describe("HerdrDriver atomic shell dispatch (OBS-140/253)", () => {
  test("test: a shell dispatch is delivered by pane-run and its START nonce appears before the agent launches, with no typed-text verification path taken", async () => {
    // The stub's `pane run` hands this line to a real shell, so the dispatch below is acknowledged
    // only because the marker statements actually EXECUTED — nothing in the fixture answers "ok".
    const { bin, log, cwd } = makeStub();
    const d = new HerdrDriver(bin);

    await d.run(await d.slot(cwd, "n1"), "bash dispatch.sh");

    const lines = readFileSync(log, "utf8").trim().split("\n");
    const delivered = lines.find((l) => l.startsWith("pane run w1:p9 printf"))!;
    expect(delivered).toBeDefined();
    // the nonce is PRINTED by the line, from two separate printf arguments, so the joined marker
    // cannot exist anywhere unless the shell ran it — and both statements run before the agent is
    // launched: first to the private file the driver waits on, which GATES the launch, then to the
    // pane for the operator (v1.85 T5 review — a pane marker printed ahead of a failed ack write
    // would satisfy the event watch for a command that never started)
    expect(delivered).toContain(`printf '%s%s\\n' '${DISPATCH_START_PREFIX}'`);
    expect(delivered).toMatch(
      /printf '%s%s\\n' 'TICKMARKR_START_' '\S+' > '\S+\.ack' \|\| exit 1; printf '%s%s\\n' 'TICKMARKR_START_' '\S+'; bash dispatch\.sh$/,
    );
    expect(delivered.indexOf(DISPATCH_START_PREFIX)).toBeLessThan(delivered.indexOf("bash dispatch.sh"));
    expect(delivered).not.toContain(`${DISPATCH_START_PREFIX}'; bash`); // never pre-joined in the text

    // no typed-text verification path is taken anywhere on this dispatch
    expect(lines.filter((l) => l.startsWith("pane send-text "))).toHaveLength(0);
    expect(lines.filter((l) => /^pane send-keys \S+ Enter$/.test(l))).toHaveLength(0);
    expect(lines.filter((l) => l.includes("--match bash dispatch.sh"))).toHaveLength(0);
    // the acknowledgment is causal in both halves: herdr's event watch on the nonce the shell
    // PRINTED, backed by the file that same line wrote. No pane snapshot is consulted, so a
    // successful launch cannot be read as corrupt just because it painted over its own first line.
    const ack = lines.find((l) => l.includes(`--match ${DISPATCH_START_PREFIX}`))!;
    expect(ack).toContain("pane wait-output w1:p9");
    expect(lines.indexOf(ack)).toBeGreaterThan(lines.indexOf(delivered));
    expect(lines.filter((l) => l.startsWith("pane read "))).toHaveLength(0);
  });

  // The duplication half of OBS-253: the pane watch subscribes AFTER the request, so a fast or
  // full-screen launch can repaint over the very line it is watching for. Here the shell really ran
  // the line — the ack the line wrote for itself proves it — and the watch saw nothing. A driver
  // that trusted the watch alone would call this successful launch corrupt and launch it AGAIN.
  test("a launch whose printed nonce the pane watch never sees is still acknowledged by the line's own durable ack, and is never dispatched twice", async () => {
    const { bin, log, cwd } = makeStub(0, { ackWatchBlind: true });
    const d = new HerdrDriver(bin, 3, steppedTimeSource().time, () => {});

    await expect(d.run(await d.slot(cwd, "n1"), "bash dispatch.sh")).resolves.toBeUndefined();

    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.filter((l) => l.includes(`--match ${DISPATCH_START_PREFIX}`))).toHaveLength(1); // the watch was asked, and missed
    expect(lines.filter((l) => l.startsWith("pane run w1:p9 printf"))).toHaveLength(1); // delivered exactly once
    expect(lines.filter((l) => l.startsWith("pane split "))).toHaveLength(0); // no fresh pane, no second agent
  });

  // The other half of that duplication, and the one the `;` separator left open: the pane RAN the
  // line but could not write the acknowledgment. From the driver's side that is indistinguishable
  // from a line that never ran — so the command ran, the miss bought a fresh pane, and one task got
  // TWO live agents. The ack now gates the launch (v1.85 T5 review, src/drivers/herdr.ts ~579).
  test("a dispatch whose acknowledgment the pane cannot write never launches its command — not on the wedged pane, and not on the fresh pane it is retried onto", async () => {
    const repo = setupRepo([T("T1")], { tasks: { T1: [{ shell: "true" }] } });
    Journal.create(repo.repo, "run-ack-gate").append("task-dispatch", "T1", { attempt: 0 });
    const { bin, log, cwd } = makeStub(0, { ackWriteFails: true, ackWatchBlind: true });
    const sentinel = join(cwd, "launched.txt");
    const d = new HerdrDriver(bin, 3, steppedTimeSource().time);
    const wt = await d.worktree(repo.repo, "tickmarkr/run-ack-gate--T1", "HEAD");
    const slot = await d.slot(wt, "n1", {
      owned: { role: "worker", taskId: "T1", attempt: 0, runId: "run-ack-gate" },
    });

    await expect(d.run(slot, `printf 'LAUNCHED\\n' > ${sentinel}`)).rejects.toThrow(/never ran/);

    // the dispatched command is a shell builtin writing an absolute path, so it leaves this file
    // behind the instant it runs on EITHER pane. It is absent because the failed ack aborted the
    // line before the command — twice — and neither pane ever started an agent.
    expect(existsSync(sentinel)).toBe(false);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.filter((l) => l.startsWith("pane run w1:p9 printf"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("pane run w1:p7 printf"))).toHaveLength(1); // retried, and launched nothing there either
    for (const p of lines.flatMap((l) => l.match(/\/[^' ]+\.ack/) ?? [])) rmSync(p, { recursive: true, force: true });
  });

  // Same channel, one step earlier: an ack path THIS process cannot open is a broken host, not a
  // wedged pane. The fresh-pane retry would fail there for the identical reason, so the failure is
  // not a DeliveryCorruptedError and the retry is never spent on it.
  test("an unopenable acknowledgment channel fails the dispatch before any pane is spent, and is never retried onto a fresh one", async () => {
    const { bin, log, cwd } = makeStub();
    const d = new HerdrDriver(bin, 3, steppedTimeSource().time);
    const slot = await d.slot(cwd, "n1");
    const prevTmp = process.env.TMPDIR;
    process.env.TMPDIR = join(mkdtempSync(join(tmpdir(), "tickmarkr-noack-")), "does-not-exist");
    try {
      await expect(d.run(slot, "bash dispatch.sh")).rejects.toThrow(/acknowledgment channel unavailable/);
    } finally {
      if (prevTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmp;
    }

    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("bash dispatch.sh"); // never delivered, so never launched
    expect(calls).not.toContain("pane split"); // and no fresh pane bought for a host-level fault
  });

  // OBS-253's fresh pane inherits the slot's durable label from the pane it replaces. A close that
  // fails — or that returns success and frees nothing — leaves two panes answering to one name, and
  // `pane list` then resolves the slot by whichever it reports first. The replacement is not
  // renamed, seeded or dispatched until that name is provably free (v1.85 T5 review, ~636).
  test("a fresh pane is never renamed, seeded or dispatched while the pane it replaces still holds the slot's durable label", async () => {
    const fixtures = [
      { label: "a close that reports failure", opts: { paneCloseFails: true } },
      { label: "a close that reports success and frees nothing", opts: { paneCloseNoop: true } },
    ];
    for (const [i, fixture] of fixtures.entries()) {
      const runId = `run-stale-label-${i}`;
      const repo = setupRepo([T("T1")], { tasks: { T1: [{ shell: "true" }] } });
      Journal.create(repo.repo, runId).append("task-dispatch", "T1", { attempt: 0 });
      const { bin, log } = makeStub(0, { dispatchAck: "fresh-only", ...fixture.opts });
      const d = new HerdrDriver(bin, 3, steppedTimeSource().time);
      const wt = await d.worktree(repo.repo, `tickmarkr/${runId}--T1`, "HEAD");
      const slot = await d.slot(wt, "n1", { owned: { role: "worker", taskId: "T1", attempt: 0, runId } });

      await expect(d.run(slot, "bash dispatch.sh")).rejects.toThrow(/never ran/); // fixture: ${fixture.label}

      const calls = readFileSync(log, "utf8");
      expect(calls, fixture.label).toContain("pane close w1:p9"); // the reap was attempted
      expect(calls, fixture.label).not.toContain(`pane rename w1:p7 ${slot.name}`); // and never claimed the contested name
      expect(calls, fixture.label).not.toContain("pane run w1:p7 export"); // never seeded
      expect(calls, fixture.label).not.toContain("pane run w1:p7 printf"); // never dispatched
      expect(calls, fixture.label).toContain("pane close w1:p7"); // the unusable replacement is reaped
    }
  });

  test("test: an adapter without declared input states cannot receive typed delivery — the dispatch fails closed naming the missing declaration", async () => {
    // Case 1: the adapter declared a box but not the states a submission is judged by.
    const undeclaredId = "undeclared-states-test";
    declareInputBox(undeclaredId, {
      fingerprint: "│ >",
      launchCommand: () => false, // every delivery to this adapter is a real TUI turn
    });
    const { bin, log, cwd } = makeStub();
    const d = new HerdrDriver(bin);
    const slot = await d.slot(cwd, `T1-worker-${undeclaredId}-a0-undeclared`, {
      owned: { role: "worker", taskId: "T1", attempt: 0, runId: "run-undeclared" },
    });

    await expect(d.run(slot, "seed the prompt")).rejects.toThrow(
      /has not declared its input states \(missing: emptyMatch, occupiedMatch\)/,
    );

    // fail CLOSED: nothing was typed, nothing was submitted, and it was not silently shell-executed
    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("pane send-text");
    expect(calls).not.toMatch(/pane send-keys \S+ Enter/);
    expect(calls).not.toContain("pane run w1:p9 printf");

    // Case 2: the adapter declared NOTHING. Its launch is an ordinary shell dispatch, but the seed
    // turn that follows is a turn into whatever that launch started — an interface this driver has
    // no declaration for. The dangerous answer here is "shell": it would hand a prompt written for
    // a TUI to bash. The pane's own history is the evidence, and it fails closed naming inputBox.
    const bare = makeStub();
    const d2 = new HerdrDriver(bare.bin);
    const bareSlot = await d2.slot(bare.cwd, "T2-worker-no-declaration-test-a0-bare", {
      owned: { role: "worker", taskId: "T2", attempt: 0, runId: "run-bare" },
    });
    await d2.run(bareSlot, "some-tui --interactive"); // the bootstrap: a shell line, delivered atomically
    await expect(d2.run(bareSlot, "Read /prompts/T2.md and do exactly what it says.")).rejects.toThrow(
      /has not declared its input states \(missing: inputBox\)/,
    );

    const bareCalls = readFileSync(bare.log, "utf8");
    expect(bareCalls).toContain("some-tui --interactive"); // the launch went out
    expect(bareCalls).not.toContain("Read /prompts/T2.md"); // the seed reached neither a shell nor the TUI
    expect(bareCalls).not.toContain("pane send-text");
  });

  test("test: a first dispatch corruption retries once on a fresh pane and journals dispatch-retry; a second consecutive corruption parks", async () => {
    // No journal spy: these drivers keep their DEFAULT handle, which opens the daemon's own run
    // ledger from the slot's owned name and the repo bound by worktree(). Everything asserted below
    // is the persisted JSONL that runDaemon and `resume --retry-failed` read back.
    const ledger = (repo: string, runId: string) => {
      const journal = Journal.create(repo, runId);
      journal.append("task-dispatch", "T1", { attempt: 0 }); // the dispatch the corruption interrupts
      return join(journal.dir, "journal.jsonl");
    };
    const events = (path: string) =>
      readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as JournalEvent);
    const ownedSlot = (d: HerdrDriver, cwd: string, runId: string) =>
      d.slot(cwd, "n1", { owned: { role: "worker", taskId: "T1", attempt: 0, runId } });

    // First corruption: the original pane never runs the line, the retry pane does. worktree() is
    // the production seam by which the daemon binds this driver to its repo; the suite still launches
    // outside that repo, proving the event is not accidentally written to the launch directory.
    const recovered = setupRepo([T("T1")], { tasks: { T1: [{ shell: "true" }] } });
    const recoveredLedger = ledger(recovered.repo, "run-dispatch-recovered");
    const once = makeStub(0, { dispatchAck: "fresh-only" });
    const d1 = new HerdrDriver(once.bin, 3, steppedTimeSource().time);
    const recoveredWt = await d1.worktree(recovered.repo, "tickmarkr/run-dispatch-recovered--T1", "HEAD");
    await d1.run(await ownedSlot(d1, recoveredWt, "run-dispatch-recovered"), "bash dispatch.sh");

    const retries = events(recoveredLedger).filter((e) => e.event === "dispatch-retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]!.taskId).toBe("T1");
    expect(retries[0]!.data.wedgedPane).toBe("w1:p9");
    const lines = readFileSync(once.log, "utf8").trim().split("\n");
    expect(lines).toContain("pane split w1:p9 --direction down --no-focus --cwd " + recoveredWt);
    expect(lines).toContain("pane close w1:p9"); // the wedged pane is reaped, never re-pressed
    expect(lines.filter((l) => l.startsWith("pane run w1:p9 printf"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("pane run w1:p7 printf"))).toHaveLength(1);

    // Second consecutive corruption: exercise the complete daemon terminal path, not merely the
    // driver's rejection or a classifier call. The daemon owns this Journal and persists both the
    // one retry and the terminal dispatch park in the same ledger.
    const parkedRepo = setupRepo(
      [T("T1")],
      { tasks: { T1: [{ shell: "true", result: { ok: true, summary: "never launches" } }] } },
    );
    const never = makeStub(0, { dispatchAck: "never" });
    const d2 = new HerdrDriver(never.bin, 3, steppedTimeSource().time);
    const summary = await runDaemon(parkedRepo.repo, {
      adapters: [parkedRepo.fake],
      runId: "run-dispatch-parked",
      driver: d2,
    });

    expect(summary.failed).toEqual(["T1"]);
    const parked = Journal.open(parkedRepo.repo, "run-dispatch-parked").read();
    expect(parked.filter((e) => e.event === "dispatch-retry")).toHaveLength(1); // one recovery, then it stops
    expect(parked.find((e) => e.event === "task-failed")?.data).toMatchObject({
      kind: "dispatch",
      attempts: 0,
    });
    expect(classifyTaskFailure(parked.filter((e) => e.taskId === "T1"))).toBe("dispatch");
    const failed = readFileSync(never.log, "utf8").trim().split("\n");
    expect(failed.filter((l) => l.startsWith("pane run w1:p9 printf") && l.includes("T1-a0.sh"))).toHaveLength(1);
    expect(failed.filter((l) => l.startsWith("pane run w1:p7 printf") && l.includes("T1-a0.sh"))).toHaveLength(1);
  });

  // v1.99 T2: `dispatch-retry` is the ONE event a driver writes that the daemon never sees — the
  // driver opens its own Journal from inside the recovery. Feeding a synthetic event to the renderer
  // proves nothing about that: the producer has to reach the console through the run's real sink, or
  // the rail is silent about a redispatch that already happened.
  test("test: a driver-journaled dispatch retry reaches the live rail through the run's own narration sink, while the same recovery on an unbound driver prints nothing", async () => {
    const isTTY = process.stdout.isTTY;
    const columns = process.stdout.columns;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: 200, configurable: true });
    const console0 = console.log;
    const printed: string[] = [];
    console.log = (...a: unknown[]) => void printed.push(a.join(" "));
    try {
      // the same corruption recovery the tests above drive, run end to end: the pane wedges, the
      // driver re-splits, and the driver journals dispatch-retry through the Journal IT opens.
      const recover = async (bind: boolean) => {
        printed.length = 0;
        const runId = bind ? "run-rail-bound" : "run-rail-unbound";
        const repo = setupRepo([T("T1")], { tasks: { T1: [{ shell: "true" }] } });
        Journal.create(repo.repo, runId).append("task-dispatch", "T1", { attempt: 0 });
        const stub = makeStub(0, { dispatchAck: "fresh-only" });
        // `bindNarration` is the PRODUCTION seam itself — run.ts and resume.ts wrap their driver in
        // exactly this call — so the bound case here is the shipped wiring and the control is the
        // same driver with that one wrapper taken off.
        const built = new HerdrDriver(stub.bin, 3, steppedTimeSource().time);
        const d = bind ? bindNarration(built, narrationSink(runId)) : built;
        const wt = await d.worktree(repo.repo, `tickmarkr/${runId}--T1`, "HEAD");
        await d.run(await d.slot(wt, "n1", { owned: { role: "worker", taskId: "T1", attempt: 0, runId } }), "bash dispatch.sh");
        // the producer really did fire: the recovery is on disk either way, so the console
        // difference below is the SINK and never a recovery that failed to happen.
        expect(Journal.open(repo.repo, runId).read().filter((e) => e.event === "dispatch-retry")).toHaveLength(1);
        return [...printed];
      };

      const rows = (await recover(true)).filter((l) => l.includes("redispatch"));
      expect(rows).toHaveLength(1); // exactly one rail row for the recovery
      expect(rows[0]).toContain("T1"); // …naming the task…
      expect(rows[0]).not.toContain("dispatch-retry"); // …in the rail's vocabulary, not the journal's

      // the control: the identical recovery on a driver nobody bound prints nothing at all, which
      // is precisely the seam this test exists to hold shut.
      expect((await recover(false)).filter((l) => l.includes("redispatch"))).toHaveLength(0);
    } finally {
      console.log = console0;
      Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
      Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
    }
  });

  test("a recovery that cannot be journaled is not taken — no pane is swapped off the record", async () => {
    // The slot carries no run identity, so the driver's default journal handle has nowhere to write
    // the required dispatch-retry event. The recovery is abandoned rather than performed unrecorded:
    // the corruption propagates exactly as it did before this recovery existed.
    const { bin, log, cwd } = makeStub(0, { dispatchAck: "fresh-only" });
    const d = new HerdrDriver(bin, 3, steppedTimeSource().time);

    await expect(d.run(await d.slot(cwd, "legacy-unowned-name"), "bash dispatch.sh")).rejects.toThrow(
      /cannot journal dispatch-retry: slot legacy-unowned-name carries no run identity/,
    );

    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("pane split w1:p9"); // no fresh pane, and the wedged one is left as evidence
    expect(calls).not.toContain("pane close w1:p9");
  });

  test("test: the positional-transcript success inference is gone — a transcript that merely looks successful no longer acknowledges delivery", async () => {
    // The deleted rule: prompt found in the transcript, bytes present after it ⇒ "delivered". This
    // pane shows exactly that shape — the command echoed, worker output and a plain prompt below it
    // — while the adapter's declared box is nowhere on screen. Under the old inference this passed.
    const { bin, log, cwd } = makeStub(0, { submission: "looks-successful" });
    const { time } = steppedTimeSource();
    const d = new HerdrDriver(bin, 3, time);
    const slot = await d.slot(cwd, `T1-worker-${looksSuccessfulAdapterId}-a0-inference`, {
      owned: { role: "worker", taskId: "T1", attempt: 0, runId: "run-inference" },
    });

    await expect(d.run(slot, "echo hi")).rejects.toThrow(/submission never registered/);

    // and it refused without ever accepting the lookalike as evidence
    expect(readFileSync(log, "utf8")).not.toContain("worker-output-accepted");
  });

  // The whole class in one place. Both delivery kinds now own a CAUSAL acknowledgment — the shell
  // dispatch's printed START nonce, the TUI turn's adapter-declared empty box — and neither will
  // take a lookalike instead. Asserted in both directions, because a driver that simply refused
  // everything would satisfy half of this and deliver nothing.
  test("no delivery is acknowledged by inference where a causal acknowledgment exists", async () => {
    const owned = (runId: string) => ({ owned: { role: "worker" as const, taskId: "T1", attempt: 0, runId } });

    // Kind 1, lookalike: the pane echoes the entire dispatched line under a shell prompt with output
    // below it — what the deleted execution-echo reader called proof — but never printed the nonce.
    const shellFake = makeStub(0, { dispatchAck: "never", dispatchEcho: true });
    const d1 = new HerdrDriver(shellFake.bin, 3, steppedTimeSource().time, () => {});
    const refused = await d1
      .run(await d1.slot(shellFake.cwd, "n1"), "bash dispatch.sh")
      .then(() => null, (e: Error) => e);
    expect(refused?.message).toMatch(/START nonce TICKMARKR_START_\S+ never appeared/);
    // it SAW the lookalike and still refused — the transcript it captured is the echo itself
    expect(refused?.message).toContain("➜  worker git:(task) ✗ ");
    expect(refused?.message).toContain("bash dispatch.sh");

    // Kind 1, causal: the same dispatch against a pane whose shell actually RUNS the line is
    // delivered — on the real clock, because a line that ran acknowledges itself immediately.
    const shellReal = makeStub();
    const d2 = new HerdrDriver(shellReal.bin, 3, undefined, () => {});
    await expect(d2.run(await d2.slot(shellReal.cwd, "n1"), "bash dispatch.sh")).resolves.toBeUndefined();

    // Kind 2, lookalike: prompt echoed, worker output, a plain prompt below — and no declared box.
    const tuiFake = makeStub(0, { submission: "looks-successful" });
    const d3 = new HerdrDriver(tuiFake.bin, 3, steppedTimeSource().time);
    await expect(
      d3.run(await d3.slot(tuiFake.cwd, `T1-worker-${looksSuccessfulAdapterId}-a0-fake`, owned("run-fake")), "echo hi"),
    ).rejects.toThrow(/submission never registered/);

    // Kind 2, causal: the same turn against a pane whose declared box comes back EMPTY is delivered.
    const tuiReal = makeStub(0, { submission: "first" });
    const d4 = new HerdrDriver(tuiReal.bin, 3, steppedTimeSource().time);
    await expect(
      d4.run(await d4.slot(tuiReal.cwd, `T1-worker-${looksSuccessfulAdapterId}-a0-real`, owned("run-real")), "echo hi"),
    ).resolves.toBeUndefined();
  });
});

// Typed delivery — the ONLY surviving typed path — still owes OBS-85's read-back pincer and OBS-154's
// box-chrome tolerance, because a real TUI re-wraps a long turn across its own bordered rows.
describe("HerdrDriver typed TUI-turn delivery (OBS-85/154)", () => {
  const typedAdapterId = "typed-turn-test";
  declareInputBox(typedAdapterId, {
    fingerprint: "│ > ",
    match: (paneText: string) => paneText.includes("│ >"),
    emptyMatch: (paneText: string) => /│ >\s+│/.test(paneText),
    launchCommand: () => false,
    readinessTimeoutMs: 500,
  });
  const typedSlot = (d: HerdrDriver, cwd: string, taskId: string) =>
    d.slot(cwd, `${taskId}-worker-${typedAdapterId}-a0-typed`, {
      owned: { role: "worker", taskId, attempt: 0, runId: "run-typed" },
    });

  test("a delivery re-wrapped inside a TUI's own bordered editor rows is still recognized as matching the typed command", async () => {
    const cmd = "Read /Users/probe/.tickmarkr/runs/run-1/prompts/T1-a0.md and do exactly what it says.";
    const { bin, log, cwd } = makeStub(0, { boxWrappedCmd: cmd });
    const { time } = steppedTimeSource();
    const d = new HerdrDriver(bin, 3, time);

    await d.run(await typedSlot(d, cwd, "T1"), cmd);

    const lines = readFileSync(log, "utf8").trim().split("\n");
    const send = lines.findIndex((l) => l === `pane send-text w1:p9 ${cmd}`);
    const read = lines.findIndex((l, i) => i > send && l.startsWith("pane read w1:p9"));
    const enter = lines.findIndex((l) => l === "pane send-keys w1:p9 Enter");
    expect(send).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(send);
    expect(enter).toBeGreaterThan(read);
    // one typing, and never a clear — the line was never corrupt, only re-wrapped by box chrome
    expect(lines.filter((l) => l.startsWith("pane send-text "))).toHaveLength(1);
    expect(lines.filter((l) => l === "pane send-keys w1:p9 C-u")).toHaveLength(0);
  });

  test("a typed turn whose read-back never contains the command fails closed as a dispatch corruption", async () => {
    const { bin, log, cwd } = makeStub(0, { corrupt: "always", paneReadFrames: ["│ >       │"] });
    const { time } = steppedTimeSource();
    // an accepting journal, so what stops the retry below is the missing bootstrap and nothing else
    const d = new HerdrDriver(bin, 3, time, () => {});

    await expect(d.run(await typedSlot(d, cwd, "T2"), "echo hi")).rejects.toThrow(/enter never pressed/);

    const calls = readFileSync(log, "utf8");
    // bounded, and Enter is never pressed on an unverified line
    expect(calls.match(/^pane send-text /gm)).toHaveLength(DELIVERY_ATTEMPTS);
    expect(calls).not.toMatch(/pane send-keys \S+ Enter/);
    // no fresh pane either: this slot delivered no bootstrap, so a bare sibling shell has nothing to
    // type into. Retyping there would buy a guaranteed second failure, not a recovery.
    expect(calls).not.toContain("pane split w1:p9");
  });

  // OBS-253's recovery is only real if it works for the delivery kind that actually wedges a TUI.
  // A fresh pane is a bare shell, so the turn cannot simply be retyped there — the interface has to
  // be relaunched first, from the bootstrap this slot already delivered and had acknowledged.
  test("a corrupted TUI turn is recovered by relaunching the adapter's bootstrap on the fresh pane before retyping", async () => {
    const relaunchAdapterId = "relaunch-turn-test";
    declareInputBox(relaunchAdapterId, {
      fingerprint: "│ >",
      match: (paneText: string) => paneText.includes("│ >"),
      emptyMatch: (paneText: string) => paneText.includes("│ >          │"),
      launchCommand: (command: string) => command.startsWith("some-tui --interactive"),
      readinessTimeoutMs: 500,
    });
    const box = "╭────────────╮\n│ >          │\n╰────────────╯";
    const { bin, log, cwd } = makeStub(0, {
      corrupt: "p9-only", // the wedged pane never echoes the turn; its fresh sibling takes it normally
      paneReadFrames: [box, box],
      submission: "first",
    });
    const retried: { event: string; data: Record<string, unknown> }[] = [];
    const d = new HerdrDriver(bin, 3, steppedTimeSource().time, (event, _slot, data) => retried.push({ event, data }));
    const slot = await d.slot(cwd, `T3-worker-${relaunchAdapterId}-a0-relaunch`, {
      owned: { role: "worker", taskId: "T3", attempt: 0, runId: "run-relaunch" },
    });

    await d.run(slot, "some-tui --interactive"); // bootstrap: a shell line, delivered atomically
    await d.run(slot, "Read /prompts/T3.md and do exactly what it says."); // the turn that wedges, then recovers

    expect(retried.map((r) => r.event)).toEqual(["dispatch-retry"]);
    expect(retried[0]!.data.wedgedPane).toBe("w1:p9");
    const lines = readFileSync(log, "utf8").trim().split("\n");
    const relaunched = lines.findIndex((l) => l.startsWith("pane run w1:p7 printf") && l.includes("some-tui --interactive"));
    const retyped = lines.findIndex((l) => l === "pane send-text w1:p7 Read /prompts/T3.md and do exactly what it says.");
    expect(relaunched).toBeGreaterThanOrEqual(0); // the interface is put back before anything is typed
    expect(retyped).toBeGreaterThan(relaunched);
    expect(lines).toContain("pane close w1:p9"); // the wedged pane is reaped, never re-pressed
    expect(lines.filter((l) => l === "pane send-keys w1:p7 Enter")).toHaveLength(1);
  });
});

describe("HerdrDriver interactive-readiness delivery gate (OBS-142)", () => {
  const inputBox = [
    "╭────────────╮",
    "│ >          │",
    "╰────────────╯",
  ].join("\n");
  const banner = "Welcome to Kimi Code!\nSend /help for help information.";
  const matchesEditorBox = (paneText: string) => paneText.includes("│ >");
  const matchesEmptyEditorBox = (paneText: string) => paneText.includes("│ >          │");
  const readinessAdapterId = "readiness-test";
  declareInputBox(readinessAdapterId, {
    fingerprint: "Send /help for help information.",
    match: matchesEditorBox,
    emptyMatch: matchesEmptyEditorBox,
    readinessTimeoutMs: 1_200,
  });

  async function readinessSlot(d: HerdrDriver, cwd: string, taskId: string) {
    return d.slot(cwd, `${taskId}-worker-${readinessAdapterId}-a0-readiness`, {
      group: "workers",
      owned: { role: "worker", taskId, attempt: 0, runId: "run-readiness" },
    });
  }

  test("test: a slow-interface timing scenario completes deterministically by stepping the injected time source rather than sleeping", async () => {
    const stepped = steppedTimeSource();
    const { bin, log, cwd } = makeStub(0, {
      paneReadFrames: [`${banner}\n1`, `${banner}\n2`, inputBox, inputBox],
      submission: "scaled",
      submitAfterReads: 3,
    });
    const d = new HerdrDriver(bin, 3, stepped.time);

    await d.run(await readinessSlot(d, cwd, "T0"), "echo hi");

    expect(stepped.sleeps.length).toBeGreaterThan(0);
    expect(stepped.sleeps.every((ms) => ms === 100)).toBe(true);
    expect(stepped.now()).toBe(stepped.sleeps.reduce((total, ms) => total + ms, 0));
    expect(readFileSync(log, "utf8").match(/^pane send-keys w1:p9 Enter$/gm)).toHaveLength(1);
  });

  test("test: delivery into a pane whose adapter declares an input box types nothing until the box is painted and stable", async () => {
    const paintingBox1 = inputBox.replace("│ >          │", "│ > paint-1  │");
    const paintingBox2 = inputBox.replace("│ >          │", "│ > paint-2  │");
    const { bin, log, cwd } = makeStub(0, {
      paneReadFrames: [paintingBox1, paintingBox2, inputBox, inputBox],
      submission: "first",
    });
    const { time } = steppedTimeSource();
    const d = new HerdrDriver(bin, 3, time);

    await d.run(await readinessSlot(d, cwd, "T1"), "echo hi");

    const lines = readFileSync(log, "utf8").trim().split("\n");
    const send = lines.findIndex((line) => line === "pane send-text w1:p9 echo hi");
    const readsBeforeSend = lines.slice(0, send).filter((line) => line.startsWith("pane read w1:p9"));
    expect(readsBeforeSend).toHaveLength(4);
    expect(send).toBeGreaterThan(lines.findLastIndex((line, index) => index < send && line.startsWith("pane read w1:p9")));
  });

  test("test: a pane that never becomes interactive within the bounded readiness window fails closed with an error naming readiness rather than submission", async () => {
    const { bin, log, cwd } = makeStub(0, {
      paneReadFrames: [banner],
      submission: "first",
    });
    const { time } = steppedTimeSource();
    const d = new HerdrDriver(bin, 3, time);

    // OBS-142 acceptance: the error names READINESS rather than submission. On a loaded runner a
    // single stub read can exceed its own bound INSIDE the readiness window, which surfaces the
    // bounded-read readiness error instead of the window-expired one — both carry the readiness
    // identity, and pinning one message races real time (the OBS-143/147 class; CI red ×2 on v1.78.0).
    await expect(d.run(await readinessSlot(d, cwd, "T2"), "echo hi")).rejects.toThrow(/readiness/i);

    const calls = readFileSync(log, "utf8");
    expect(calls).not.toContain("pane send-text w1:p9 echo hi");
    expect(calls).not.toContain("submission never registered");
  });

  test("test: a pane already interactive at first read types immediately with no added delay", async () => {
    const { bin, log, cwd } = makeStub(0, {
      paneReadFrames: [inputBox],
      submission: "first",
    });
    const { time, sleeps } = steppedTimeSource();
    const d = new HerdrDriver(bin, 3, time);
    await d.run(await readinessSlot(d, cwd, "T3"), "echo hi");

    const lines = readFileSync(log, "utf8").trim().split("\n");
    const send = lines.findIndex((line) => line === "pane send-text w1:p9 echo hi");
    expect(lines.slice(0, send).filter((line) => line.startsWith("pane read w1:p9"))).toHaveLength(2);
    expect(sleeps).toHaveLength(0);
  });

  test("test: a submission whose prompt is absent from the transcript is refused rather than treated as registered", async () => {
    const { bin, log, cwd } = makeStub(0, { submission: "absent" });
    const { time } = steppedTimeSource();
    const d = new HerdrDriver(bin, 3, time);

    await expect(d.run(await readinessSlot(d, cwd, "T9"), "echo hi")).rejects.toThrow(
      /submission never registered/,
    );

    const calls = readFileSync(log, "utf8");
    expect(calls.match(/^pane send-keys w1:p9 Enter$/gm)).toHaveLength(2);
  });

  test("test: an interface that became interactive slowly is granted a commensurately scaled submission window and a slow but successful submit is never pressed twice", async () => {
    const { bin, log, cwd } = makeStub(0, {
      paneReadFrames: [`${banner}\n1`, `${banner}\n2`, `${banner}\n3`, `${banner}\n4`, inputBox, inputBox],
      submission: "scaled",
      submitAfterReads: 8,
    });
    const stepped = steppedTimeSource();
    const d = new HerdrDriver(bin, 3, stepped.time);

    await d.run(await readinessSlot(d, cwd, "T5"), "echo hi");

    const calls = readFileSync(log, "utf8");
    expect(calls.match(/^pane send-keys w1:p9 Enter$/gm)).toHaveLength(1);
    expect(calls.match(/^pane read w1:p9/gm)?.length ?? 0).toBeGreaterThan(10);
    expect(stepped.now()).toBeLessThan(1_200);
  });

  test("a pane-read protocol failure remains a structural driver error without the READINESS identity", async () => {
    const { bin, cwd } = makeStub(0, { paneReadFails: true });
    const d = new HerdrDriver(bin);

    const error = await d.run(await readinessSlot(d, cwd, "T6"), "echo hi").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DeliveryReadinessError);
    expect(String(error)).toMatch(/pane read.*failed/i);
  });

  test("the adapter readiness bound also bounds an individual pane read", async () => {
    const hungAdapterId = "hung-readiness-test";
    declareInputBox(hungAdapterId, {
      fingerprint: "editor-box",
      match: (paneText: string) => paneText.includes("editor-box"),
      emptyMatch: (paneText: string) => paneText.includes("editor-box"),
      readinessTimeoutMs: 250,
    });
    const { bin, cwd } = makeStub(0, { paneReadHangs: true });
    const d = new HerdrDriver(bin);
    const slot = await d.slot(cwd, `T7-worker-${hungAdapterId}-a0-readiness`, {
      group: "workers",
      owned: { role: "worker", taskId: "T7", attempt: 0, runId: "run-readiness" },
    });
    const error = await d.run(slot, "echo hi").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DeliveryReadinessError);
  });

  // A non-first read is given exactly the remaining readiness budget as its real subprocess
  // timeout, so it timing out IS the bounded window expiring — the classification must not also
  // require the injected clock to have reached the bound, because the injected clock does not
  // advance during a real read. On a slow runner the last read's real budget shrinks below spawn
  // latency and this path fires deterministically (the two release-run reds of 2026-07-26).
  test("a timed-out read after an observed frame carries the READINESS identity even when the injected clock has not reached the bound", async () => {
    const lateHangAdapterId = "late-hang-readiness-test";
    declareInputBox(lateHangAdapterId, {
      fingerprint: "editor-box",
      match: (paneText: string) => paneText.includes("editor-box"),
      emptyMatch: (paneText: string) => paneText.includes("editor-box"),
      readinessTimeoutMs: 500,
    });
    const { bin, cwd } = makeStub(0, { paneReadHangsAfter: 2 });
    const { time } = steppedTimeSource();
    const d = new HerdrDriver(bin, 3, time);
    const slot = await d.slot(cwd, `T8-worker-${lateHangAdapterId}-a0-late-hang`, {
      group: "workers",
      owned: { role: "worker", taskId: "T8", attempt: 0, runId: "run-late-hang" },
    });
    const error = await d.run(slot, "echo hi").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeliveryReadinessError);
    expect(String(error)).toMatch(/READINESS/);
  });
});

describe("HerdrDriver submission-verified delivery (OBS-140)", () => {
  const matchesEditorBox = (paneText: string) => paneText.includes("│ >");
  const matchesEmptyEditorBox = (paneText: string) => paneText.includes("│ >          │");
  const submissionAdapterId = "submission-box-test";
  declareInputBox(submissionAdapterId, {
    fingerprint: "Send /help for help information.",
    match: matchesEditorBox,
    emptyMatch: matchesEmptyEditorBox,
    readinessTimeoutMs: 500,
  });

  async function submissionSlot(d: HerdrDriver, cwd: string, taskId: string) {
    return d.slot(cwd, `${taskId}-worker-${submissionAdapterId}-a0-submit`, {
      group: "workers",
      owned: { role: "worker", taskId, attempt: 0, runId: "run-submit" },
    });
  }

  test("test: a pane that swallows the first enter receives a bounded re-press and the delivery completes once the prompt leaves the input line", async () => {
    const { bin, log, cwd } = makeStub(0, { submission: "second" });
    const { time } = steppedTimeSource();
    const d = new HerdrDriver(bin, 3, time);

    await d.run(await submissionSlot(d, cwd, "T1"), "echo hi");

    const calls = readFileSync(log, "utf8");
    expect(calls.match(/^pane send-keys w1:p9 Enter$/gm)).toHaveLength(2);
    expect(calls.match(/^pane send-text w1:p9 echo hi$/gm)).toHaveLength(1);
  });

  test("test: a pane that submits on the first enter sees no re-press and no added settle delay", async () => {
    const { bin, log, cwd } = makeStub(0, { submission: "first" });
    const { time, sleeps } = steppedTimeSource();
    const d = new HerdrDriver(bin, 3, time);
    await d.run(await submissionSlot(d, cwd, "T2"), "echo hi");

    const lines = readFileSync(log, "utf8").trim().split("\n");
    const enter = lines.findIndex((line) => line === "pane send-keys w1:p9 Enter");
    const verify = lines.findIndex((line, index) => index > enter && line.startsWith("pane read w1:p9"));
    expect(lines.filter((line) => line === "pane send-keys w1:p9 Enter")).toHaveLength(1);
    expect(verify).toBeGreaterThan(enter);
    expect(sleeps).toHaveLength(0);
  });

  test("test: submission that never registers within the bounded window fails closed with the existing delivery-failure error class", async () => {
    const { bin, log, cwd } = makeStub(0, { submission: "never" });
    const { time } = steppedTimeSource();
    const d = new HerdrDriver(bin, 3, time);

    await expect(d.run(await submissionSlot(d, cwd, "T3"), "echo hi")).rejects.toThrow(
      /delivery corrupted on pane .* submission never registered/,
    );

    const calls = readFileSync(log, "utf8");
    expect(calls.match(/^pane send-keys w1:p9 Enter$/gm)).toHaveLength(2);
  });

  test("test: verification runs before any re-press so a slow but successful submit is never submitted twice", async () => {
    const { bin, log, cwd } = makeStub(0, { submission: "slow" });
    const { time } = steppedTimeSource();
    const d = new HerdrDriver(bin, 3, time);

    await d.run(await submissionSlot(d, cwd, "T4"), "echo hi");

    const lines = readFileSync(log, "utf8").trim().split("\n");
    const enter = lines.findIndex((line) => line === "pane send-keys w1:p9 Enter");
    const verifies = lines.filter((line, index) => index > enter && line.startsWith("pane read w1:p9"));
    expect(verifies.length).toBeGreaterThan(1);
    expect(lines.filter((line) => line === "pane send-keys w1:p9 Enter")).toHaveLength(1);
  });

  test("banner-only evidence with an absent prompt is refused even for a declared input box", async () => {
    const inputBox = "╭────────────╮\n│ >          │\n╰────────────╯";
    const { bin, log, cwd } = makeStub(0, {
      paneReadFrames: [inputBox],
      submission: "banner-only",
    });
    const { time } = steppedTimeSource();
    const d = new HerdrDriver(bin, 3, time);

    await expect(d.run(await submissionSlot(d, cwd, "T5"), "echo hi")).rejects.toThrow(
      /submission never registered/,
    );

    expect(readFileSync(log, "utf8").match(/^pane send-keys w1:p9 Enter$/gm)).toHaveLength(2);
  });

  test("a verified paste followed by the adapter-declared empty box is positive submission evidence", async () => {
    const inputBox = "╭────────────╮\n│ >          │\n╰────────────╯";
    const { bin, log, cwd } = makeStub(0, {
      paneReadFrames: [inputBox],
      submission: "empty-box",
    });
    const { time } = steppedTimeSource();
    const d = new HerdrDriver(bin, 3, time);

    await d.run(await submissionSlot(d, cwd, "T6"), "echo hi");

    expect(readFileSync(log, "utf8").match(/^pane send-keys w1:p9 Enter$/gm)).toHaveLength(1);
  });
});

describe("HerdrDriver pane-slot dispatch critical section (OBS-120)", () => {
  test("test: two simultaneous dispatches allocate distinct panes and each delivery lands in the pane bound to its own task", async () => {
    // ONE TAB PER TASK: the two concurrent dispatches now allocate in tabs of their own, so the stub
    // hands out a distinct root pane per tab (incPanes) exactly as herdr does. The property under test
    // is unchanged: the allocation lease is held from slot() through run(), so the second task cannot
    // allocate while the first delivery is still in flight.
    const { bin, log, cwd } = makeStub(0, { incPanes: true });
    const d = new HerdrDriver(bin);
    const dispatch = async (taskId: string, command: string) => {
      const slot = await d.slot(cwd, taskId, {
        group: "workers",
        owned: { role: "worker", taskId, attempt: 0, runId: "run-critical" },
      });
      // Reproduce the real dispatch seam: command preparation yields after slot() returns.
      // A correct allocation lease remains held until run(); the old split mutex does not.
      await Promise.resolve();
      await d.run(slot, command);
      return slot;
    };

    const [first, second] = await Promise.all([
      dispatch("T1", "echo task-one"),
      dispatch("T2", "echo task-two"),
    ]);

    expect(first.id).not.toBe(second.id);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    const firstDelivery = lines.findIndex((l) => l.startsWith("pane run w1:pR1 printf") && l.endsWith("echo task-one"));
    // T2's allocation is now its own `tab create`, not a split into T1's tab — the lease still gates it.
    const secondAllocation = lines.findIndex((l) => l.startsWith("tab create --label T2 "));
    expect(firstDelivery).toBeGreaterThanOrEqual(0);
    expect(secondAllocation).toBeGreaterThan(firstDelivery);
    expect(lines.some((l) => l.startsWith("pane run w1:pR2 printf") && l.endsWith("echo task-two"))).toBe(true);
    expect(first.tabId).not.toBe(second.tabId); // each task's panes live in that task's tab
  });

  test("test: a pane-identity binding that fails verification fails that dispatch rather than typing into another task's pane", async () => {
    const name = "tickmarkr:worker:T1:0:run-binding";
    const { bin, log, cwd } = makeStub(0, { dropBindingFor: name });
    const d = new HerdrDriver(bin);
    const dispatch = async () => {
      const slot = await d.slot(cwd, "T1", {
        group: "workers",
        owned: { role: "worker", taskId: "T1", attempt: 0, runId: "run-binding" },
      });
      await d.run(slot, "echo must-not-land");
    };

    await expect(dispatch()).rejects.toThrow(/identity binding/i);
    expect(readFileSync(log, "utf8")).not.toContain("pane send-text");
    expect(readFileSync(log, "utf8")).not.toContain("pane run w1:p9 printf");
  });

  test("test: the early liveness check watches the pane its task's delivery actually landed in", async () => {
    const name = "tickmarkr:worker:T1:0:run-liveness";
    const { bin, log, cwd } = makeStub(0, {
      rebindAfterDelivery: { name, pane: "w1:pOTHER" },
    });
    const d = new HerdrDriver(bin);
    const slot = await d.slot(cwd, "T1", {
      group: "workers",
      owned: { role: "worker", taskId: "T1", attempt: 0, runId: "run-liveness" },
    });

    await d.run(slot, "echo launched");
    await d.read(slot, 500);

    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("pane run w1:p9 printf");
    expect(calls).toContain("pane read w1:p9 --source recent-unwrapped --lines 500");
    expect(calls).not.toContain("pane read w1:pOTHER --source recent-unwrapped --lines 500");
  });
});

describe("HerdrDriver grouped role-tabs (VIS-04)", () => {
  test("test: closing a worker slot journals pane-close naming the slot and the pane it held under both the grouped and the per-slot-tab shapes whereas a close that leaves no row fails", async () => {
    const runId = "run-close-record";
    const { repo } = setupRepo([T("T-grouped"), T("T-tab")], {});
    Journal.create(repo, runId).append("run-start", undefined, {});
    const stub = makeStub(0, { tab: true });
    const driver = new HerdrDriver(stub.bin);
    const worktree = await driver.worktree(repo, `tickmarkr/${runId}--close`, "HEAD");

    const grouped = await driver.slot(worktree, "legacy-grouped", {
      owned: { role: "worker", taskId: "T-grouped", attempt: 0, runId },
    });
    await driver.run(grouped, ":");
    await driver.close(grouped);

    const perSlotTab = await driver.slot(worktree, "legacy-tab", {
      label: "T-tab",
      owned: { role: "worker", taskId: "T-tab", attempt: 0, runId },
    });
    await driver.run(perSlotTab, ":");
    await driver.close(perSlotTab);

    const rows = Journal.open(repo, runId).read().filter((row) => row.event === "pane-close");
    expect(rows.map(({ event, taskId, data }) => ({ event, taskId, data }))).toEqual([
      {
        event: "pane-close",
        taskId: "T-grouped",
        data: {
          slot: formatOwnedName({ role: "worker", taskId: "T-grouped", attempt: 0, runId }),
          paneId: "w1:p9",
          tabId: "w1:t1",
        },
      },
      {
        event: "pane-close",
        taskId: "T-tab",
        data: {
          slot: formatOwnedName({ role: "worker", taskId: "T-tab", attempt: 0, runId }),
          tabId: "w1:t1",
        },
      },
    ]);
  });

  test("A: concurrent same-group slots share ONE tab; second stacks via downward split + rename + cd", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true });
    const d = new HerdrDriver(bin);
    const [s1, s2] = await Promise.all([d.slot(cwd, "n1", { group: "workers" }), d.slot(cwd, "n2", { group: "workers" })]);
    const calls = readFileSync(log, "utf8");
    expect(calls.match(/tab create/g)).toHaveLength(1); // exactly one tab, even under concurrent slot()
    expect(calls).toContain("tab create --label WORKERS"); // stage-named, not first-member-named (run-104447 incident)
    expect(calls).toContain("pane split w1:p9 --direction right --no-focus"); // first join licensed at 222 cols (43-MEASUREMENT.md)
    expect(calls).not.toMatch(/pane split w1:p7 --direction right/); // subsequent joins stack down
    expect(calls).toContain("pane rename w1:p7 n2"); // split pane gets a durable label
    expect(calls).toContain(`pane split w1:p9 --direction right --no-focus --cwd ${cwd}`); // split placed in ITS OWN worktree (no separate cd)
    expect(s1.tabId).toBe("w1:t1");
    expect(s2.tabId).toBe("w1:t1"); // shared tab
    expect(s2.id).toBe("w1:p7");
    expect(s2.group).toBe("workers");
  });

  test("B: no-group slot keeps per-slot tab behavior; the tab root pane is the worker (no orphan reap)", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true });
    const d = new HerdrDriver(bin);
    const s = await d.slot(cwd, "solo");
    const calls = readFileSync(log, "utf8");
    expect(s.id).toBe("w1:p9"); // tab root pane == worker pane
    expect(s.tabId).toBe("w1:t1");
    expect(s.group).toBeUndefined();
    expect(calls).toContain(`tab create --label solo --no-focus --workspace wTEST --cwd ${cwd}`);
    expect(calls).toContain("pane rename w1:p9 solo");
    expect(calls).not.toContain("pane close w1:p0"); // no second pane to reap — the root IS the worker
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
    expect(calls).toContain("pane close w1:p9"); // n1's live pane closed
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
    expect(calls.match(/pane split w1:p9 --direction right/g)).toHaveLength(2); // n2 + n3 both first-join right off n1
    expect(calls).not.toContain("pane split w1:p7"); // never split the dead pane
    expect(s3.tabId).toBe("w1:t1");
    expect(s3.group).toBe("workers");
  });

  test("renames only the driver-owned task tab, tracking the newest live worker on join and leave", async () => {
    const { bin, log, cwd } = makeStub(0, { incTabs: true });
    const d = new HerdrDriver(bin);
    const s1 = await d.slot(cwd, "T1-worker-fake-a0-run", { group: "workers" });
    await d.slot(cwd, "T9-consult-1", { label: "OPERATOR T9" });
    const s2 = await d.slot(cwd, "T1-worker-fake-a1-run", { group: "workers" }); // a retry of the SAME task
    expect(s2.tabId).toBe(s1.tabId); // both attempts of one task share that task's tab
    await d.close(s2);
    await d.close(s1);
    const renames = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("tab rename "));
    expect(renames).toEqual([
      "tab rename w1:t1 T1",
      "tab rename w1:t1 T1↻", // the retry attempt is the newest live worker
      "tab rename w1:t1 T1",
      "tab rename w1:t1 T1",
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
    expect(calls).toContain(`tab create --label n2 --no-focus --workspace wTEST --cwd ${cwd}`); // full fallback bootstrap
    expect(calls).toContain("pane rename w1:p9 n2");
    expect(calls).toContain(`tab create --label n3 --no-focus --workspace wTEST --cwd ${cwd}`);
    expect(calls).toContain("pane rename w1:p9 n3");
    expect(s1.group).toBe("workers");
    expect(s2.id).toBe("w1:p9");
    expect(s2.group).toBeUndefined(); // degraded slot is NOT a shared-tab member
    expect(s3.group).toBeUndefined();
  });

  // OBS-45's class, live again on run-20260819-022723-…1591: once D-09 latches, every later member
  // takes the per-slot path, and that path titled the TAB with the durable PANE name — three
  // `tickmarkr:worker:T5:1:run-20260819-022723-0000000000001591` tabs (58 chars each) on one bar.
  // Every dispatch name carries role/task/attempt, so the title is derivable: the task token plus a
  // retry marker for a worker, ROLE + task for a gate pane. Names with no task identity are
  // unchanged (test D above still pins `--label n2`), and the durable pane identity never moves.
  // Legacy-shape names on purpose: a canonical name holds a dispatch lease until run(), which this
  // allocation-only test never calls.
  test("degraded per-slot tabs are TITLED for the task, never the durable slot name", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true, splitFails: true });
    const d = new HerdrDriver(bin);
    await d.slot(cwd, "T5-worker-fake-a0-run", { group: "workers" }); // gen 1 bootstraps
    const retry = await d.slot(cwd, "T5-worker-fake-a1-run", { group: "workers" }); // join fails → degrade
    const review = await d.slot(cwd, "review · T5", { group: "workers" }); // gate pane, same latched group
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain(`tab create --label T5↻1 --no-focus --workspace wTEST --cwd ${cwd}`);
    expect(calls).toContain(`tab create --label REVIEW T5 --no-focus --workspace wTEST --cwd ${cwd}`);
    expect(calls).not.toContain("--label T5-worker-fake-a1-run"); // the slot name is not a title
    expect(calls).not.toContain("--label review · T5");
    // durable identity unchanged — resolution and reconcile still read the slot name back off the pane
    expect(calls).toContain("pane rename w1:p9 T5-worker-fake-a1-run");
    expect(retry.group).toBeUndefined();
    expect(review.group).toBeUndefined();
  });

  test("rename failure reaps the split pane and falls back to a per-slot tab (A1 fail-safe)", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true, renameFails: true });
    const d = new HerdrDriver(bin);
    await d.slot(cwd, "n1", { group: "workers" });
    const s2 = await d.slot(cwd, "n2", { group: "workers" });
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("pane close w1:p7"); // the unaddressable split pane is reaped
    expect(calls).toContain(`tab create --label n2 --no-focus --workspace wTEST --cwd ${cwd}`); // fallback bootstrap
    expect(calls).toContain("pane rename w1:p9 n2");
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

// DEFECT-01: `tickmarkr resume` with keepPanes:run re-dispatches at attempt=0 into a durable label a
// prior (SIGKILLed) process's pane still holds. 0.7.5's `pane rename` never collides, so the fresh pane
// takes the label AND the stale pane keeps it — the driver must sweep the stale same-label pane(s) and
// verify the fresh pane is the sole holder (else `pane list` would resolve the label ambiguously).
describe("HerdrDriver pane-label reclaim (DEFECT-01)", () => {
  test("reclaim resolves: pane rename fresh → sweep close the stale same-label pane → fresh is sole holder", async () => {
    const { bin, log, cwd } = makeStub(0, { takenNames: ["T1-worker-fake-a0-tag"] });
    const d = new HerdrDriver(bin);
    const slot = await d.slot(cwd, "T1-worker-fake-a0-tag"); // MUST resolve, not throw
    expect(slot.id).toBe("w1:p9"); // the fresh tab-create root pane, not the stale w1:pSTALE
    const lines = readFileSync(log, "utf8").trim().split("\n");
    const rename = lines.findIndex((l) => l === "pane rename w1:p9 T1-worker-fake-a0-tag");
    const close = lines.findIndex((l) => l.startsWith("pane close w1:pSTALE"));
    expect(rename).toBeGreaterThanOrEqual(0); // fresh pane labeled…
    expect(close).toBeGreaterThan(rename); // …then the stale same-label pane swept
  });

  test("reclaim fail-closed: a stale close that does not free the label rejects (no ambiguous resolution)", async () => {
    const { bin, log, cwd } = makeStub(0, { takenNames: ["T2-worker-fake-a0-tag"], paneCloseNoop: true });
    const d = new HerdrDriver(bin);
    await expect(d.slot(cwd, "T2-worker-fake-a0-tag")).rejects.toThrow(/reclaim failed/);
    expect(readFileSync(log, "utf8").match(/^pane close w1:pSTALE/gm)).toHaveLength(1); // swept once, never looped
  });

  test("a fresh dispatch with no stale label performs no reclaim close (sweep is a no-op)", async () => {
    const { bin, log, cwd } = makeStub();
    const d = new HerdrDriver(bin);
    const slot = await d.slot(cwd, "T3-worker-fake-a0-tag"); // resolves cleanly
    expect(slot.id).toBe("w1:p9");
    expect(readFileSync(log, "utf8")).not.toContain("pane close"); // nothing stale to sweep
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
    expect(calls).toContain("pane split w1:p9 --direction right --no-focus"); // D-10 width law: first join right when licensed
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

// T2 watch pane: one live status surface per run — split off the invoking orchestrator pane and
// placed BESIDE it, never a separate tab. A second request for the same canonical watch name must
// reuse it.
describe("HerdrDriver narrator pane (T2)", () => {
  const SIDE_SPLIT = "pane split wTEST:pCALLER --direction right --ratio 0.5 --no-focus";

  test("narrator places its board beside the invoking pane; a second daemon retires that board and re-splits it", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true, incTabs: true });
    const d = new HerdrDriver(bin);
    const first = await d.narrator(cwd, "tickmarkr status --watch run-watch", "run-watch");
    const second = await new HerdrDriver(bin).narrator(cwd, "tickmarkr status --watch run-watch", "run-watch");
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain(SIDE_SPLIT); // beside the caller, half the width, every time
    expect(calls).not.toContain("pane swap"); // a right split needs none — the board lands right
    expect(calls).toContain("pane rename w1:p7 tickmarkr:watch:run:0:run-watch");
    expect(calls).not.toContain("tab create");
    // ONE live board throughout: the second daemon closed the board it found BEFORE splitting its own,
    // rather than adopting a pane whose running command it cannot read (the stub recycles the pane id).
    expect(calls.split("\n").filter((l) => /^pane (split|close) /.test(l))).toEqual([
      SIDE_SPLIT,
      "pane close w1:p7",
      SIDE_SPLIT,
    ]);
    // the watch is a shell dispatch like any other: atomic, nonce-acknowledged, never typed — and
    // EVERY board that goes live is launched with the run-bound command this call supplied.
    expect(calls.match(/pane run w1:p7 printf .*tickmarkr status --watch run-watch/g)).toHaveLength(2);
    expect(calls).not.toMatch(/pane send-keys w1:p7 Enter/);
    expect(second).toEqual(first); // the replacement wears the same canonical name
    expect(first.tabId).toBeUndefined();
    await d.close(first);
    expect(readFileSync(log, "utf8").match(/^pane close w1:p7$/gm)).toHaveLength(2);
  });

  // A pane wearing THIS run's canonical name is not proof of THIS run's board: every pre-v1.94 daemon
  // launched a bare `tickmarkr status --watch`, which resolves the NEWEST journal, so the operator would
  // be watching whatever run started last under this run's label. A live pane's command cannot be read
  // back, so the name is never taken as evidence — the board is retired and re-split, command and all.
  test("a surviving watch wearing this run's own name is retired too, never adopted with an unverified command", async () => {
    const { bin, log, cwd } = makeStub(0, { survivingWatch: { name: "tickmarkr:watch:run:0:run-new", pane: "w1:pBARE" } });
    const slot = await new HerdrDriver(bin).narrator(cwd, "tickmarkr status --watch run-new", "run-new");
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("pane close w1:pBARE"); // the bare-command watcher does not survive
    expect(calls).toContain("pane split wTEST:pCALLER"); // a FRESH board took its place
    expect(slot.id).toBe("w1:p7");
    expect(calls).toMatch(/pane run w1:p7 printf .*tickmarkr status --watch run-new/); // run-bound, and actually launched
  });

  // A swallowed close leaves the old board alive and splits a second one beside it, each narrating a
  // different run — and nothing sweeps the survivor later: panesToClose skips role "watch" by design
  // (types.ts). So the retirement is verified GONE by re-reading the listing, not by trusting an exit
  // code, and a board that will not die fails the placement instead of gaining a twin.
  test("a prior board that survives its close blocks the replacement split (never two boards)", async () => {
    for (const fixture of [
      { label: "a close that reports failure", opts: { paneCloseFails: true } },
      { label: "a close that reports success and frees nothing", opts: { paneCloseNoop: true } },
    ]) {
      const { bin, log, cwd } = makeStub(0, { survivingWatch: { name: "tickmarkr:watch:run:0:run-old", pane: "w1:pOLD" }, ...fixture.opts });
      await expect(new HerdrDriver(bin).narrator(cwd, "tickmarkr status --watch run-new", "run-new"))
        .rejects.toThrow(/survived close/i); // propagates; the daemon swallows and runs boardless
      expect(readFileSync(log, "utf8"), fixture.label).not.toContain("pane split");
    }
  });

  // v1.99 T2: the split alone leaves the board UNDER the caller — the swap is the geometry. A swap
  // that failed used to be invisible: the daemon would report the stack it asked for while the
  // operator watched the board sit below the narration. So the swap is verified, the cleanup close is
  // verified too (a close that fails, or reports success and frees nothing, leaves the operator the
  // stray split the daemon claims it took back), and a failure costs the board rather than the truth.
  test("test: a split the driver cannot finish is closed and runs no watch command, while a successful placement runs exactly one run-bound watch command in the named board pane", async () => {
    // `pane list` witnesses live panes here: the split registers w1:p7 the moment herdr returns it,
    // so "the split is gone" is read off the fixture's own pane registry, not off the close call.
    const listed = (stub: { panes: string }) => readFileSync(stub.panes, "utf8").split("\n").filter((l) => l.startsWith("w1:p7 "));

    // The swap-decline cases that used to live here are GONE WITH THE SWAP, not skipped: a right
    // split lands the board beside the caller in one operation, so there is no second call that can
    // report success while moving nothing. What remains below is the failure that still exists —
    // a split pane that must be cleaned up, here triggered by the rename that follows the split.

    // the two ways a cleanup close leaves the split on screen. Neither may be swallowed: the failure
    // the operator is told about has to be the one their tab actually shows.
    for (const [why, opts] of [
      ["a close herdr rejects", { paneCloseFails: true }],
      ["a close that reports success and frees nothing", { paneCloseNoop: true }],
    ] as const) {
      const stuck = makeStub(0, { tab: true, renameFails: true, ...opts });
      const warned: string[] = [];
      const console0 = console.error;
      console.error = (...a: unknown[]) => void warned.push(a.join(" "));
      try {
        await expect(
          new HerdrDriver(stuck.bin).narrator(stuck.cwd, "tickmarkr status --watch run-board", "run-board"),
          why,
        ).rejects.toThrow(/rename failed[\s\S]*split pane w1:p7 survived its close/i);
      } finally {
        console.error = console0;
      }
      const stuckCalls = readFileSync(stuck.log, "utf8").split("\n");
      const closeAt = stuckCalls.lastIndexOf("pane close w1:p7");
      expect(closeAt, why).toBeGreaterThanOrEqual(0); // it did try
      expect(stuckCalls.slice(closeAt + 1), why).toContain("pane list"); // and production verified after it
      expect(listed(stuck), why).toHaveLength(1); // and the pane the operator can see is still there
      // the daemon swallows narrator failures, so the stray pane is announced where the operator
      // can still read it rather than dying inside that catch.
      expect(warned.join("\n"), why).toMatch(/watch split w1:p7 survived its close/);
    }

    const ok = makeStub(0, { tab: true });
    const slot = await new HerdrDriver(ok.bin).narrator(ok.cwd, "tickmarkr status --watch run-board", "run-board");
    const okCalls = readFileSync(ok.log, "utf8");
    expect(okCalls).toContain(SIDE_SPLIT);
    expect(okCalls).not.toContain("pane swap"); // one operation places it; nothing to verify after
    expect(slot).toEqual({ id: "w1:p7", name: "tickmarkr:watch:run:0:run-board", cwd: ok.cwd });
    expect(okCalls).toContain("pane rename w1:p7 tickmarkr:watch:run:0:run-board"); // the named board pane
    expect(okCalls.match(/pane run w1:p7 printf .*tickmarkr status --watch run-board/g)).toHaveLength(1);
    expect(okCalls).not.toContain("pane close w1:p7"); // a board that placed is kept, not closed
    expect(listed(ok)).toContain("w1:p7 tickmarkr:watch:run:0:run-board"); // the board is live and named
    // the placement never asks how wide the caller is again — width chose the arrangement twice and
    // was wrong twice, so no layout read of the caller pane remains on this path.
    expect(okCalls).not.toContain("pane layout --pane wTEST:pCALLER");
  });

  // QUEUE-v194: the watch command names its run, so a surviving prior-run pane is running the OLD
  // run's board. Relabelling it (what this path used to do) leaves run-old's numbers under run-new's
  // name — the wrong-run incident. It is retired and re-split, so the live command names the new run.
  test("a new run retires a surviving prior-run watch and opens one bound to itself", async () => {
    const oldName = "tickmarkr:watch:run:0:run-old";
    const { bin, log, cwd } = makeStub(0, { survivingWatch: { name: oldName, pane: "w1:pOLD" } });
    const next = await new HerdrDriver(bin).narrator(cwd, "tickmarkr status --watch run-new", "run-new");
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("pane list");
    expect(calls).toContain("pane close w1:pOLD"); // never renamed into this run's name
    expect(calls).not.toContain("pane rename w1:pOLD");
    expect(calls).toContain("pane rename w1:p7 tickmarkr:watch:run:0:run-new");
    // the ACTIVE command in the live watch pane names the newer run, not the one it replaced
    expect(calls).toMatch(/pane run w1:p7 printf .*tickmarkr status --watch run-new/);
    expect(calls).not.toMatch(/status --watch run-old/);
    expect(next).toEqual({ id: "w1:p7", name: "tickmarkr:watch:run:0:run-new", cwd });
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

// One tab per TASK: a task's worker and every gate pane it earns (judge, review, consult) share that
// task's tab. Before this, exactly one of three slot() call sites passed a group, so judge/review/
// consult each opened a tab of their own and a task's panes scattered across the workspace.
//
// The integration cases use the LEGACY production name shapes ("T31-worker-…", "judge · T31") rather
// than canonical `tickmarkr:role:task:n:run` ones on purpose: a canonical name takes a dispatch lease
// that slot() holds until run(), so opening several in one test would deadlock on the lease, not on
// grouping. taskGroupOf is unit-tested over BOTH shapes below so the canonical path is not left unproven.
describe("HerdrDriver per-task tabs", () => {
  test("test: the task group is derived for every task role and withheld for every non-task name, proven member by member over both name shapes — canonical and legacy", () => {
    for (const role of ["worker", "judge", "review", "consult"]) {
      expect(taskGroupOf(`tickmarkr:${role}:T31:0:run-x`)).toBe("T31");
    }
    expect(taskGroupOf("T31-worker-fake-a0-abc")).toBe("T31");
    expect(taskGroupOf("judge \u00b7 T31")).toBe("T31");
    // withheld: the run watch board is not a task, and an unrecognised name must not become one —
    // canonicalizeLegacyName returns role "other" with taskId set to the WHOLE string, so keying on
    // taskId alone would give every one-off pane a group tab. That bug shipped in this change's first cut.
    expect(taskGroupOf("tickmarkr:watch:run:0:run-x")).toBeUndefined();
    expect(taskGroupOf("some-name")).toBeUndefined();
    expect(taskGroupOf("")).toBeUndefined();
  });

  test("test: a worker and every gate pane for the same task share ONE tab, and a second task gets its own", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true, incTabs: true });
    const d = new HerdrDriver(bin, 3);
    const w1 = await d.slot(cwd, "T31-worker-fake-a0-abc");
    const j1 = await d.slot(cwd, "judge \u00b7 T31");
    const r1 = await d.slot(cwd, "review \u00b7 T31");
    const c1 = await d.slot(cwd, "consult \u00b7 T31");
    const w2 = await d.slot(cwd, "T22-worker-fake-a0-abc");

    expect(new Set([w1.tabId, j1.tabId, r1.tabId, c1.tabId]).size).toBe(1);
    expect(w2.tabId).not.toBe(w1.tabId);
    expect(readFileSync(log, "utf8").match(/tab create/g)).toHaveLength(2); // one per TASK, not per pane
    expect(w1.group).toBe("T31");
    expect(w2.group).toBe("T22");
  });

  test("test: gate panes do NOT consume workersPerTab, so a task never overflows its own tab", async () => {
    const { bin, log, cwd } = makeStub(0, { tab: true, incTabs: true });
    const d = new HerdrDriver(bin, 1); // cap of ONE — the gates must still join
    const w = await d.slot(cwd, "T34-worker-fake-a0-abc");
    const j = await d.slot(cwd, "judge \u00b7 T34");
    const r = await d.slot(cwd, "review \u00b7 T34");

    expect(j.tabId).toBe(w.tabId);
    expect(r.tabId).toBe(w.tabId);
    expect(readFileSync(log, "utf8")).not.toContain("--label cleanup");
  });

  test("test: a NON-gate member still consumes the cap, so explicit stage groups keep overflowing", async () => {
    // Regression guard for this change's own first cut, which let every role that was merely "not a
    // worker" bypass the cap — silently disabling overflow for any unrecognised name.
    const { bin, log, cwd } = makeStub(0, { tab: true, incTabs: true });
    const d = new HerdrDriver(bin, 2);
    await d.slot(cwd, "n1", { group: "workers" });
    await d.slot(cwd, "n2", { group: "workers" });
    await d.slot(cwd, "n3", { group: "workers" });
    expect(readFileSync(log, "utf8")).toContain("--label cleanup");
  });

  test("test: a non-task name keeps its dedicated tab and joins no group", async () => {
    const { bin, cwd } = makeStub(0, { tab: true, incTabs: true });
    const d = new HerdrDriver(bin, 3);
    const watch = await d.slot(cwd, "tickmarkr:watch:run:0:run-x");
    const bare = await d.slot(cwd, "some-name");
    for (const s of [watch, bare]) expect(s.group).toBeUndefined();
    expect(watch.tabId).not.toBe(bare.tabId);
  });
});
