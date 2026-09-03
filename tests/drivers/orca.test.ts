import { describe, expect, test } from "vitest";
import { trailerPattern } from "../../src/adapters/prompt.js";
import {
  joinWrapped,
  mapAgentState,
  NOT_WRITABLE_CODE,
  OrcaDriver,
  OrcaError,
  OrcaUnavailableError,
  ORCA_RESPONSE_FAMILIES,
  parseEnvelope,
  STALE_HANDLE_CODE,
  STALE_HANDLE_CODES,
  STATUS_GOVERNED_METHODS,
  TERMINAL_GONE_CODE,
  type OrcaFamily,
} from "../../src/drivers/orca.js";
import { formatOwnedName, type Slot } from "../../src/drivers/types.js";
import { FakeOrca, ORCA_FIXTURE_NONCE, ORCA_LITERAL_MARKER, pagedMarkerLines, steppedTime, type FakeOrcaOpts } from "../helpers/fake-orca.js";

const WT = "/tmp/orca-wt/T1";
const OTHER_WT = "/tmp/orca-wt/T2";
const TITLE = formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId: "run-orca" });
const OTHER_TITLE = formatOwnedName({ role: "worker", taskId: "T2", attempt: 0, runId: "run-orca" });
const TRAILER_RE = trailerPattern(ORCA_FIXTURE_NONCE);

function rig(opts: FakeOrcaOpts = {}): { fake: FakeOrca; driver: OrcaDriver } {
  const fake = new FakeOrca(opts);
  return { fake, driver: new OrcaDriver({ exec: fake.exec, time: steppedTime() }) };
}

/** A slot whose first run() created its terminal, with `lines` seeded as that terminal's scrollback. */
async function bound(
  driver: OrcaDriver,
  fake: FakeOrca,
  lines: string[] = [],
  cwd = WT,
  title = TITLE,
): Promise<Slot> {
  const slot = await driver.slot(cwd, title);
  await driver.run(slot, "bash");
  fake.last()!.lines = lines;
  return slot;
}

const MALFORMED = "orca: panic: runtime bridge closed";
const TRUNCATED = '{"ok":true,"result":{"terminal":{"handle":"term_1","stat';
const OK_FALSE = '{"ok":false,"error":{"code":"runtime_unreachable","message":"orca runtime is not answering"},"_meta":{"runtimeId":"rt-1"}}';
const MISSING_RUNTIME = '{"ok":true,"result":{},"_meta":{}}';

describe("OrcaDriver", () => {
  test("test: status answers unknown for a running terminal or idle once tui-idle is satisfied under both recorded elapsed transports the 1.4.195 default of rc 1 ok false error code timeout as well as the selectable 1.4.186 satisfied false receipt whereas a wait refusal carrying any other code still fails closed so the shipped driver that throws on every 1.4.195 non-idle poll fails", async () => {
    for (const opts of [{}, { elapsedWaitTransport: "1.4.186-satisfied-false" as const }]) {
      const { fake, driver } = rig(opts);
      const slot = await bound(driver, fake, ["working"]);
      expect(await driver.status(slot)).toBe("unknown");

      fake.last()!.tuiIdle = true;
      expect(await driver.status(slot)).toBe("idle");
    }

    const refusingFake = new FakeOrca();
    const refusingDriver = new OrcaDriver({
      exec: async (args, cwd, timeoutMs) => {
        if (args[0] === "terminal" && args[1] === "wait" && args.includes("tui-idle")) {
          return {
            code: 1,
            stdout: JSON.stringify({
              ok: false,
              error: { code: "wait_refused", message: "not a timeout" },
              _meta: { runtimeId: refusingFake.runtimeId },
            }),
            stderr: "",
          };
        }
        return refusingFake.exec(args, cwd, timeoutMs);
      },
      time: steppedTime(),
    });
    const slot = await bound(refusingDriver, refusingFake, ["working"]);
    const err = await refusingDriver.status(slot).then((v) => v, (e: unknown) => e);
    expect(err).toBeInstanceOf(OrcaError);
    expect((err as OrcaError).family).toBe("wait");
    expect((err as OrcaError).code).toBe("wait_refused");
  });

  test("test: waitOutput finds a literal and a regex marker reassembled across two cursor-paged read chunks and across a renderer-wrapped trailer line on a running terminal while a single unpaged tail read finds neither", async () => {
    const { fake, driver } = rig();
    const slot = await bound(driver, fake, pagedMarkerLines());

    // Control: ONE unpaged tail read. Neither marker is there in any form — raw or de-wrapped —
    // because the literal's halves sit either side of a cursor page boundary and the trailer's
    // wrapped body is further back than a tail read reaches.
    const tail = await driver.read(slot, 3);
    expect(fake.calls.filter((a) => a[1] === "read").every((a) => !a.includes("--cursor"))).toBe(true);
    expect(tail).not.toContain(ORCA_LITERAL_MARKER);
    expect(joinWrapped(tail)).not.toContain(ORCA_LITERAL_MARKER);
    expect(new RegExp(TRAILER_RE).test(tail)).toBe(false);
    expect(new RegExp(TRAILER_RE).test(joinWrapped(tail))).toBe(false);

    // The paged sweep reassembles both: the literal across the two read chunks, the regex across the
    // renderer-wrapped trailer line (whose margin chrome breaks `"ok":` from `true` in the raw bytes).
    expect(await driver.waitOutput(slot, ORCA_LITERAL_MARKER, 1_000)).toBe(true);
    expect(await driver.waitOutput(slot, TRAILER_RE, 1_000, { regex: true })).toBe(true);
    const paged = fake.calls.filter((a) => a[1] === "read" && a.includes("--cursor"));
    expect(paged.length).toBeGreaterThanOrEqual(2); // two cursor-paged chunks, not one flat read
    expect(paged.map((a) => a[a.indexOf("--cursor") + 1])).toContain("0");

    // A marker that never rendered is still absent, so the matcher is not simply saying yes.
    expect(await driver.waitOutput(slot, "TICKMARKR_MARK_NEVER", 400)).toBe(false);

    // Production argv and the shim speak the real 1.4.186 contract, not an invented lookalike.
    expect(fake.calls.every((args) => args.at(-1) === "--json")).toBe(true);
    expect(fake.calls.find((args) => args[1] === "create")).toEqual([
      "terminal", "create", "--worktree", `path:${WT}`, "--title", TITLE, "--command", "bash", "--json",
    ]);
    expect(fake.calls.filter((args) => args[1] === "read").every((args) => args.includes("--limit") && !args.includes("--lines"))).toBe(true);
    const unsupported = await fake.exec(["terminal", "read", "--terminal", fake.last()!.handle, "--lines", "3", "--json"], WT);
    const inventedCreate = await fake.exec([
      "terminal", "create", "--path", WT, "--title", TITLE, "--command", "bash", "--json",
    ], WT);
    const humanDefault = await fake.exec(["status"], WT);
    const typedOnly = await fake.exec([
      "terminal", "send", "--terminal", fake.last()!.handle, "--text", "UNSUBMITTED", "--json",
    ], WT);
    expect(unsupported.code).not.toBe(0);
    expect(unsupported.stderr).toContain("unknown option --lines");
    expect(inventedCreate.code).not.toBe(0);
    expect(inventedCreate.stderr).toContain("unknown option --path");
    expect(humanDefault.code).not.toBe(0);
    expect(humanDefault.stderr).toContain("must request --json");
    // Recorded send receipt: accepted + bytesWritten. Without --enter nothing is SUBMITTED even
    // though the bytes were written — the `sent` ledger stays empty.
    expect(JSON.parse(typedOnly.stdout).result.send).toEqual({ handle: fake.last()!.handle, accepted: true, bytesWritten: "UNSUBMITTED".length });
    expect(fake.sent.get(fake.last()!.handle)).toBeUndefined();
    expect(fake.typed.get(fake.last()!.handle)).toEqual(["UNSUBMITTED"]);
  });

  test("test: for each of read, the initial and every paged read inside waitOutput, status and waitAgentStatus, a terminal whose reported status is exited or unknown yields an explicit unavailable outcome with status validated before marker matching on every page, so a dead record carrying the exact requested trailer never satisfies waitOutput while a running terminal carrying the same bytes does", async () => {
    expect([...STATUS_GOVERNED_METHODS]).toEqual(["read", "waitOutput", "status", "waitAgentStatus"]);

    const { fake, driver } = rig();
    const deadSlot = await bound(driver, fake, pagedMarkerLines());
    const dead = fake.last()!;
    const liveSlot = await bound(driver, fake, pagedMarkerLines(), OTHER_WT, OTHER_TITLE);
    const live = fake.last()!;
    expect(dead.lines).toEqual(live.lines); // byte-identical scrollback; only the record differs

    // READ leg: the read record's own `status` (recorded: "running" live, "exited" on the dead
    // record) is validated before marker matching — on the initial read and every paged read.
    for (const status of ["exited", "unknown", ""]) {
      dead.status = status; // "" renders the field absent from the record
      for (const call of [
        () => driver.read(deadSlot, 3),
        () => driver.waitOutput(deadSlot, TRAILER_RE, 1_000, { regex: true }),
        () => driver.waitOutput(deadSlot, ORCA_LITERAL_MARKER, 1_000),
        // status()/waitAgentStatus() must fail on the SAME read-status leg, even though the show
        // record's own connected/orphaned fields (untouched here) would otherwise look healthy —
        // an "unknown" or "exited" read status is never shadowed by a healthy-looking show record.
        () => driver.status(deadSlot),
        () => driver.waitAgentStatus(deadSlot, "idle", 1_000),
      ]) {
        const err = await call().then((v) => v, (e: unknown) => e);
        expect(err, `read status ${JSON.stringify(status)}`).toBeInstanceOf(OrcaUnavailableError);
        expect((err as OrcaUnavailableError).terminalStatus ?? "").toBe(status);
        expect((err as OrcaUnavailableError).message).toContain(status === "" ? "absent" : status);
      }
    }
    // SHOW leg: the recorded show response carries NO status — liveness arrives as
    // connected/orphaned, and the same unavailable outcome governs status()/waitAgentStatus().
    dead.status = "running";
    dead.connected = false; // recorded dead-show shape: connected:false, writable:false
    for (const call of [
      () => driver.status(deadSlot),
      () => driver.waitAgentStatus(deadSlot, "idle", 1_000),
      () => driver.waitAgentStatus(deadSlot, "done", 1_000),
    ]) {
      const err = await call().then((v) => v, (e: unknown) => e);
      expect(err).toBeInstanceOf(OrcaUnavailableError);
      expect((err as OrcaUnavailableError).terminalStatus).toBe("disconnected");
      expect((err as OrcaUnavailableError).message).toContain("connected");
    }
    dead.connected = true;
    dead.orphaned = true; // an orphaned record is just as unavailable
    const orphaned = await driver.status(deadSlot).then((v) => v, (e: unknown) => e);
    expect(orphaned).toBeInstanceOf(OrcaUnavailableError);
    expect((orphaned as OrcaUnavailableError).terminalStatus).toBe("orphaned");

    // The same bytes on a RUNNING terminal do satisfy waitOutput.
    expect(await driver.waitOutput(liveSlot, TRAILER_RE, 1_000, { regex: true })).toBe(true);

    // Validation is per PAGE, not per sweep: this terminal is running for the anchor read and the
    // first page (which carries the marker's first half) and dead by the second.
    const mid = rig({ flipStatusAfterReads: 2 });
    const midSlot = await bound(mid.driver, mid.fake, pagedMarkerLines());
    const midErr = await mid.driver.waitOutput(midSlot, ORCA_LITERAL_MARKER, 1_000).then((v) => v, (e: unknown) => e);
    expect(midErr).toBeInstanceOf(OrcaUnavailableError);

    // The false-clean control: a reader that validates only the INITIAL read and then pages blindly
    // reassembles the marker off a terminal that died mid-sweep.
    const lax = new FakeOrca({ flipStatusAfterReads: 2 });
    const laxDriver = new OrcaDriver({ exec: lax.exec, time: steppedTime() });
    await bound(laxDriver, lax, pagedMarkerLines());
    const handle = lax.last()!.handle;
    const page = async (args: string[]) =>
      JSON.parse((await lax.exec(["terminal", "read", "--terminal", handle, ...args, "--limit", "500", "--json"], WT)).stdout).result.terminal;
    const anchor = await page([]);
    expect(anchor.status).toBe("running"); // the control's one and only check
    let buf = "";
    let cursor = anchor.oldestCursor;
    for (;;) {
      const p = await page(["--cursor", cursor]);
      buf += `${p.tail.join("\n")}\n`;
      if (p.limited !== true) break;
      cursor = p.nextCursor;
    }
    expect(joinWrapped(buf)).toContain(ORCA_LITERAL_MARKER);

    // Finding 2 regression: Recovery/restart between read and show legs in status():
    // read leg executes on term_1 (running). Server restarts to rt-2 before show leg, where term_2 is exited.
    // status() MUST restart its observation and validate term_2's read status, throwing OrcaUnavailableError.
    const statusRaceFake = new FakeOrca({ runtimeId: "rt-1", nextHandle: "term_1" });
    const origStatusRaceExec = statusRaceFake.exec;
    const statusRaceDriver = new OrcaDriver({
      exec: async (args, cwd, timeoutMs) => {
        const res = await origStatusRaceExec(args, cwd, timeoutMs);
        if (args[0] === "terminal" && args[1] === "read" && args.some(arg => arg.includes("term_1"))) {
          // Restart server after read leg of status()
          statusRaceFake.restart("rt-2", [
            { handle: "term_2", title: TITLE, worktree: WT, status: "exited", connected: true },
          ]);
        }
        return res;
      },
      time: steppedTime(),
    });
    const raceSlot2 = await statusRaceDriver.slot(WT, TITLE);
    await statusRaceDriver.run(raceSlot2, "bash");
    const raceErr = await statusRaceDriver.status(raceSlot2).then((v) => v, (e: unknown) => e);
    expect(raceErr).toBeInstanceOf(OrcaUnavailableError);
    expect((raceErr as OrcaUnavailableError).terminalStatus).toBe("exited");

    // Check that a waitCondition returning satisfied but status "exited" or "unknown" throws OrcaUnavailableError
    for (const waitStatus of ["exited", "unknown"]) {
      const waitStatusFake = new FakeOrca({ runtimeId: "rt-1", nextHandle: "term_1" });
      const origWaitStatusExec = waitStatusFake.exec;
      const waitStatusDriver = new OrcaDriver({
        exec: async (args, cwd, timeoutMs) => {
          if (args[0] === "terminal" && args[1] === "wait" && args.includes("tui-idle")) {
            const handle = args[3];
            const body = {
              ok: true,
              result: {
                wait: {
                  handle,
                  condition: "tui-idle",
                  satisfied: true,
                  status: waitStatus,
                }
              },
              _meta: { runtimeId: "rt-1" }
            };
            return { code: 0, stdout: JSON.stringify(body), stderr: "" };
          }
          return origWaitStatusExec(args, cwd, timeoutMs);
        },
        time: steppedTime(),
      });
      const wsSlot = await waitStatusDriver.slot(WT, TITLE);
      await waitStatusDriver.run(wsSlot, "bash");
      const statusErr = await waitStatusDriver.status(wsSlot).then((v) => v, (e: unknown) => e);
      expect(statusErr, `wait receipt status ${waitStatus}`).toBeInstanceOf(OrcaUnavailableError);
      expect((statusErr as OrcaUnavailableError).terminalStatus).toBe(waitStatus);
    }
  });

  test("test: one shared envelope parser serves runtime status, terminal create, list, read, send, wait, show and close, and a table of malformed, truncated and ok-false fixtures per response family fails each invoking operation closed with raw bytes preserved for diagnostics, while a caller that reinterprets parser failure as empty output, unknown-but-successful status or a successful close fails", async () => {
    expect([...ORCA_RESPONSE_FAMILIES]).toEqual(["status", "create", "list", "read", "send", "wait", "show", "close"]);

    // The shared parser itself refuses every degenerate fixture, for every family.
    for (const family of ORCA_RESPONSE_FAMILIES) {
      for (const raw of [MALFORMED, TRUNCATED, OK_FALSE, MISSING_RUNTIME, "", "[]", '{"result":{}}']) {
        const err = (() => { try { parseEnvelope(family, raw); return null; } catch (e) { return e as OrcaError; } })();
        expect(err, `${family} accepted ${JSON.stringify(raw)}`).toBeInstanceOf(OrcaError);
        expect(err!.raw).toBe(raw);
        expect(err!.family).toBe(family);
      }
    }

    // …and every operation that invokes a family fails closed on it, raw bytes preserved.
    const invoke: Record<OrcaFamily, (opts: FakeOrcaOpts) => Promise<unknown>> = {
      status: async (o) => rig(o).driver.probeRuntime(WT),
      create: async (o) => { const r = rig(o); return r.driver.run(await r.driver.slot(WT, TITLE), "bash"); },
      read: async (o) => { const r = rig(o); return r.driver.read(await bound(r.driver, r.fake, ["x"]), 3); },
      show: async (o) => { const r = rig(o); return r.driver.status(await bound(r.driver, r.fake, ["x"])); },
      send: async (o) => { const r = rig(o); const s = await bound(r.driver, r.fake, ["x"]); return r.driver.run(s, "second turn"); },
      wait: async (o) => { const r = rig(o); return r.driver.waitAgentStatus(await bound(r.driver, r.fake, ["x"]), "done", 1_000); },
      close: async (o) => { const r = rig(o); return r.driver.close(await bound(r.driver, r.fake, ["x"])); },
      // the relist a stale handle forces is the only `terminal list` invoker
      list: async (o) => {
        const r = rig(o);
        const s = await bound(r.driver, r.fake, ["x"]);
        r.fake.restart("rt-2", [{ handle: "term_new", title: TITLE, worktree: WT }]);
        return r.driver.read(s, 3);
      },
    };
    for (const family of ORCA_RESPONSE_FAMILIES) {
      for (const raw of [MALFORMED, TRUNCATED, OK_FALSE, MISSING_RUNTIME]) {
        const err = await invoke[family]({ raw: { [family]: raw } }).then((v) => v, (e: unknown) => e);
        expect(err, `${family} survived ${raw.slice(0, 24)}`).toBeInstanceOf(OrcaError);
        expect((err as OrcaError).family).toBe(family);
        expect((err as OrcaError).raw).toBe(raw);
      }
    }

    // The false-clean controls: each reinterpretation turns a parser failure into a clean answer.
    const asEmptyOutput = (raw: string) => { try { return JSON.parse(raw).result.terminal.tail.join("\n"); } catch { return ""; } };
    const asUnknownStatus = (raw: string) => { try { return JSON.parse(raw).result.terminal.agent.state; } catch { return "unknown"; } };
    const asSuccessfulClose = (raw: string) => { try { return JSON.parse(raw).ok !== false; } catch { return true; } };
    expect(asEmptyOutput(TRUNCATED)).toBe("");
    expect(asUnknownStatus(MALFORMED)).toBe("unknown");
    expect(asSuccessfulClose(MALFORMED)).toBe(true);
    expect(asSuccessfulClose(TRUNCATED)).toBe(true);

    // Exit status is part of the recorded transport contract (refusals exit rc 1 with the
    // structured body on stdout), so both directions are pinned:
    // (1) a nonzero exit whose stdout is a STRUCTURED refusal preserves the refusal code —
    //     everything that recovers on terminal_handle_stale/terminal_not_writable/timeout
    //     depends on this branch;
    const NONZERO_REFUSAL = '{"ok":false,"error":{"code":"terminal_not_writable","message":"terminal is not writable"},"_meta":{"runtimeId":"rt-1"}}';
    // stderr is deliberately non-empty here: the refusal CODE must survive from stdout, but the raw
    // bytes propagated to the caller must still be the combined stream, not stdout alone.
    const refusing = new OrcaDriver({
      exec: async () => ({ code: 1, stdout: NONZERO_REFUSAL, stderr: "pty write failed: EIO" }),
      time: steppedTime(),
    });
    const refused = await refusing.probeRuntime(WT).then((v) => v, (e: unknown) => e);
    expect(refused).toBeInstanceOf(OrcaError);
    expect((refused as OrcaError).code).toBe("terminal_not_writable");
    expect((refused as OrcaError).raw).toContain(NONZERO_REFUSAL);
    expect((refused as OrcaError).raw).toContain("pty write failed: EIO");
    // (2) a nonzero exit with ok:true bytes on stdout is a transport failure, never a success —
    //     a shell/runtime crash can leave stale stdout behind, and rehabilitating it would create a
    //     second, non-JSON success seam beside parseEnvelope().
    const staleSuccess = JSON.stringify({ ok: true, result: { runtime: { reachable: true } }, _meta: { runtimeId: "rt-1" } });
    const transportFailure = new OrcaDriver({
      exec: async () => ({ code: 1, stdout: staleSuccess, stderr: "runtime bridge crashed" }),
      time: steppedTime(),
    });
    const transportErr = await transportFailure.probeRuntime(WT).then((v) => v, (e: unknown) => e);
    expect(transportErr).toBeInstanceOf(OrcaError);
    expect((transportErr as OrcaError).family).toBe("status");
    expect((transportErr as OrcaError).raw).toContain(staleSuccess);
    expect((transportErr as OrcaError).raw).toContain("runtime bridge crashed");
    expect((transportErr as OrcaError).code).toBeUndefined();

    // `ok:true` is not a receipt. The send and close families read what the RECORDED receipt says
    // (send:{handle,accepted,bytesWritten}, close:{handle}), so a structurally invalid or
    // explicitly negative one fails closed like any other refusal.
    const NO_RECEIPT = '{"ok":true,"result":{},"_meta":{"runtimeId":"rt-1"}}';
    const receiptTable: [OrcaFamily, string][] = [
      ["send", NO_RECEIPT],
      ["send", '{"ok":true,"result":{"send":{"handle":"term_1","accepted":false,"bytesWritten":0}},"_meta":{"runtimeId":"rt-1"}}'],
      ["send", '{"ok":true,"result":{"send":{"handle":"term_1","accepted":"yes","bytesWritten":18}},"_meta":{"runtimeId":"rt-1"}}'],
      ["send", '{"ok":true,"result":{"send":{"handle":"term_OTHER","accepted":true,"bytesWritten":18}},"_meta":{"runtimeId":"rt-1"}}'],
      ["send", '{"ok":true,"result":{"send":{"handle":"term_1","accepted":true,"bytesWritten":"18"}},"_meta":{"runtimeId":"rt-1"}}'],
      ["close", NO_RECEIPT],
      ["close", '{"ok":true,"result":{"close":{"handle":"term_OTHER","ptyKilled":true}},"_meta":{"runtimeId":"rt-1"}}'],
      ["close", '{"ok":true,"result":{"close":{"handle":"term_1","ptyKilled":"false"}},"_meta":{"runtimeId":"rt-1"}}'],
    ];
    for (const [family, raw] of receiptTable) {
      const err = await invoke[family]({ raw: { [family]: raw } }).then((v) => v, (e: unknown) => e);
      expect(err, `${family} accepted ${raw}`).toBeInstanceOf(OrcaError);
      expect((err as OrcaError).family).toBe(family);
      expect((err as OrcaError).raw).toBe(raw);
    }
    // …and the recorded affirmative receipts still pass, so the strictness is a check, not a block.
    const closing = rig();
    await expect(closing.driver.close(await bound(closing.driver, closing.fake, ["x"]))).resolves.toBeUndefined();
    const noPty = rig();
    const noPtySlot = await bound(noPty.driver, noPty.fake, ["x"]);
    const noPtyHandle = noPty.fake.last()!.handle;
    noPty.fake.last()!.status = "exited";
    await expect(noPty.driver.close(noPtySlot)).resolves.toBeUndefined();
    expect(noPty.fake.of(noPtyHandle)).toBeUndefined();

    // Handle integrity: a same-runtime response naming a DIFFERENT terminal must never be accepted
    // as this slot's bytes or state — not read, not show — even though it parses cleanly and its
    // own status/connected fields look perfectly healthy.
    const foreignHandle = "term_FOREIGN";
    const foreignRead = JSON.stringify({
      ok: true,
      result: { terminal: { handle: foreignHandle, status: "running", tail: ["should never be trusted"], oldestCursor: "0", nextCursor: "1", limited: false } },
      _meta: { runtimeId: "rt-1" },
    });
    const foreignReadRig = rig({ raw: { read: foreignRead } });
    const foreignReadSlot = await bound(foreignReadRig.driver, foreignReadRig.fake, ["x"]);
    const readMismatch = await foreignReadRig.driver.read(foreignReadSlot, 3).then((v) => v, (e: unknown) => e);
    expect(readMismatch).toBeInstanceOf(OrcaUnavailableError);
    expect((readMismatch as OrcaUnavailableError).message).toContain(foreignHandle);

    const foreignShow = JSON.stringify({
      ok: true,
      result: { terminal: { handle: foreignHandle, connected: true, orphaned: false } },
      _meta: { runtimeId: "rt-1" },
    });
    const foreignShowRig = rig({ raw: { show: foreignShow } });
    const foreignShowSlot = await bound(foreignShowRig.driver, foreignShowRig.fake, ["x"]);
    const showMismatch = await foreignShowRig.driver.status(foreignShowSlot).then((v) => v, (e: unknown) => e);
    expect(showMismatch).toBeInstanceOf(OrcaUnavailableError);
    expect((showMismatch as OrcaUnavailableError).message).toContain(foreignHandle);

    // The default 1.4.195 wait family: an elapsed wait is rc 1 with ok:false/code:timeout.
    const elapsed195 = rig();
    const elapsed195Slot = await bound(elapsed195.driver, elapsed195.fake, ["x"]);
    const elapsed195Fixture = await elapsed195.fake.exec([
      "terminal", "wait", "--terminal", elapsed195.fake.last()!.handle,
      "--for", "exit", "--timeout-ms", "400", "--json",
    ], WT);
    expect(elapsed195Fixture.code).toBe(1);
    expect(JSON.parse(elapsed195Fixture.stdout)).toMatchObject({
      ok: false,
      error: { code: "timeout" },
      _meta: { runtimeId: "rt-1" },
    });
    expect(await elapsed195.driver.waitAgentStatus(elapsed195Slot, "done", 400)).toBe(false);

    // The selectable 1.4.186 wait family: an elapsed wait is rc 1 with an otherwise-successful,
    // handle/condition/status-bearing `satisfied:false` receipt — "not yet", not a failure.
    const elapsed = rig({ elapsedWaitTransport: "1.4.186-satisfied-false" });
    const elapsedSlot = await bound(elapsed.driver, elapsed.fake, ["x"]);
    const elapsedFixture = await elapsed.fake.exec([
      "terminal", "wait", "--terminal", elapsed.fake.last()!.handle,
      "--for", "exit", "--timeout-ms", "400", "--json",
    ], WT);
    expect(elapsedFixture.code).toBe(1);
    expect(JSON.parse(elapsedFixture.stdout)).toMatchObject({
      ok: true,
      result: { wait: { handle: elapsed.fake.last()!.handle, condition: "exit", satisfied: false, status: "running" } },
      _meta: { runtimeId: "rt-1" },
    });
    expect(await elapsed.driver.waitAgentStatus(elapsedSlot, "done", 400)).toBe(false);
    const waited = rig();
    const waitedSlot = await bound(waited.driver, waited.fake, ["running"]);
    waited.fake.last()!.waitConditions = ["exit"]; // exits between the show poll and the wait
    expect(await waited.driver.waitAgentStatus(waitedSlot, "done", 1_000)).toBe(true);
    const waitCall = waited.fake.calls.find((args) => args[1] === "wait" && args.includes("exit"));
    expect(waitCall).toEqual([
      "terminal", "wait", "--terminal", waited.fake.last()!.handle,
      "--for", "exit", "--timeout-ms", "1000", "--json",
    ]);

    // A malformed elapsed receipt still fails closed: no status means it cannot prove the terminal
    // remained running while the condition elapsed.
    const unsatisfiedWaitFake = new FakeOrca({ runtimeId: "rt-1", nextHandle: "term_1" });
    const unsatisfiedWaitDriver = new OrcaDriver({
      exec: async (args, cwd, timeoutMs) => {
        if (args[0] === "terminal" && args[1] === "wait" && args.includes("exit")) {
          return {
            code: 1,
            stdout: JSON.stringify({
              ok: true,
              result: { wait: { handle: "term_1", condition: "exit", satisfied: false } },
              _meta: { runtimeId: "rt-1" }
            }),
            stderr: ""
          };
        }
        return unsatisfiedWaitFake.exec(args, cwd, timeoutMs);
      },
      time: steppedTime(),
    });
    const unsatisfiedSlot = await bound(unsatisfiedWaitDriver, unsatisfiedWaitFake, ["x"]);
    const unsatisfiedErr = await unsatisfiedWaitDriver.waitAgentStatus(unsatisfiedSlot, "done", 1000).then((v) => v, (e: unknown) => e);
    expect(unsatisfiedErr).toBeInstanceOf(OrcaUnavailableError);
    expect((unsatisfiedErr as OrcaUnavailableError).terminalStatus).toBeUndefined();
    expect((unsatisfiedErr as OrcaUnavailableError).message).toContain("elapsed wait receipt");


    // Finding 3 regression: A timeout error from status/list runtime probe must NOT be swallowed into false/unknown.
    const statusTimeoutFake = new FakeOrca({ runtimeId: "rt-1", nextHandle: "term_A" });
    const origStatusTimeoutExec = statusTimeoutFake.exec;
    let statusTimeoutCalls = 0;
    const statusTimeoutDriver = new OrcaDriver({
      exec: async (args, cwd, timeoutMs) => {
        if (args[0] === "status" && ++statusTimeoutCalls > 1) {
          return { code: 1, stdout: '{"ok":false,"error":{"code":"timeout","message":"status probe timeout"},"_meta":{"runtimeId":"rt-1"}}', stderr: "" };
        }
        return origStatusTimeoutExec(args, cwd, timeoutMs);
      },
      time: steppedTime(),
    });
    const timeoutSlot = await bound(statusTimeoutDriver, statusTimeoutFake, ["x"]);
    const swallowedErr = await statusTimeoutDriver.waitAgentStatus(timeoutSlot, "done", 1000).then((v) => v, (e: unknown) => e);
    expect(swallowedErr).toBeInstanceOf(OrcaError);
    expect((swallowedErr as OrcaError).code).toBe("timeout");
    expect((swallowedErr as OrcaError).family).toBe("status");
  });

  test("test: a handle is bound to the runtime identity that answered its create; every mutating operation both follows a runtime probe within a bounded, documented, seam-adjustable staleness window and verifies the operation RESPONSE's _meta.runtimeId equals the bound identity, failing closed — slot unavailable with the identity mismatch surfaced — on any mismatch or absent identity; on a changed runtime id or terminal_handle_stale the driver relists the slot's exact worktree and replaces the handle exactly once when one terminal matches the full owned title and worktree identity, while zero matches, duplicate matches, and an old handle value reused by the new runtime each render the slot unavailable and never address a lookalike; a driver claiming pre-operation atomicity or inventing identity-addressing syntax the CLI does not support fails", async () => {
    // Lookalikes: foreign TAB titles in this worktree (a suffix, and a pane that spells the owned
    // name while its tab is foreign — rows only ever carry shell-controlled pane titles), plus the
    // owned tab title in ANOTHER worktree. None of them is this slot's terminal.
    const lookalikes = (): { handle: string; title: string; worktree: string; paneTitle?: string; lines: string[] }[] => [
      { handle: "term_LOOKALIKE_TITLE", title: `${TITLE}-scratch`, worktree: WT, lines: ["LOOKALIKE"] },
      { handle: "term_LOOKALIKE_PANETITLE", title: "operator-scratch", worktree: WT, paneTitle: TITLE, lines: ["LOOKALIKE"] },
      { handle: "term_LOOKALIKE_WT", title: TITLE, worktree: OTHER_WT, lines: ["LOOKALIKE"] },
    ];
    const addressed = (fake: FakeOrca, handle: string) => fake.calls.some((a) => a.includes(handle));

    // (a) prove the create answer owns the binding even if the pre-create probe answered from an
    // older runtime. Binding the probe would force an unnecessary recovery on the first read.
    const answering = new FakeOrca({ runtimeId: "rt-probe", nextHandle: "term_CREATED" });
    const answeringDriver = new OrcaDriver({
      exec: async (args, cwd, timeoutMs) => {
        const result = await answering.exec(args, cwd, timeoutMs);
        if (args[0] === "status") answering.runtimeId = "rt-create";
        return result;
      },
      time: steppedTime(),
    });
    const answeringSlot = await bound(answeringDriver, answering, ["CREATE ANSWER OWNS HANDLE"]);
    expect(await answeringDriver.read(answeringSlot, 5)).toBe("CREATE ANSWER OWNS HANDLE");
    expect(answering.countOf("list")).toBe(0);

    // (b) a changed runtime id recovers to the single owned-tab + worktree match — exactly one
    // relist, of the slot's exact worktree, whose rows never carry the owned title at all.
    const one = rig({ runtimeId: "rt-1", nextHandle: "term_A" });
    const slot = await bound(one.driver, one.fake, ["before"]);
    expect(one.fake.last()!.handle).toBe("term_A");
    one.fake.restart("rt-2", [...lookalikes(), { handle: "term_B", title: TITLE, worktree: WT, lines: ["AFTER RESTART"] }]);
    expect(await one.driver.read(slot, 5)).toBe("AFTER RESTART");
    const relists = one.fake.calls.filter((a) => a[1] === "list");
    expect(relists).toHaveLength(1);
    expect(relists[0]).toEqual(["terminal", "list", "--worktree", `path:${WT}`, "--include-visual-layouts", "--limit", "10000", "--json"]);
    for (const l of lookalikes()) expect(addressed(one.fake, l.handle)).toBe(false);
    // replaced exactly once: the next read addresses the replacement directly, with no second relist
    expect(await one.driver.read(slot, 5)).toBe("AFTER RESTART");
    expect(one.fake.countOf("list")).toBe(1);

    // (b2) a SAME-runtime terminal_handle_stale refusal (recorded transport: rc 1 + structured
    // body) recovers identically — the refusal code must survive the nonzero exit to fire at all.
    const stale = rig({ runtimeId: "rt-1", nextHandle: "term_A" });
    const staleWindowSlot = await bound(stale.driver, stale.fake, ["before"]);
    stale.fake.terminals = [{ handle: "term_B2", title: TITLE, worktree: WT, lines: ["AFTER SAME-RUNTIME STALE"] }];
    expect(await stale.driver.read(staleWindowSlot, 5)).toBe("AFTER SAME-RUNTIME STALE");
    expect(stale.fake.countOf("list")).toBe(1);
    expect(stale.fake.calls.filter((a) => a[1] === "read" && a.some(x => x.includes("term_A")))).toHaveLength(1);

    // (c) a CHANGED runtime id answering ok:true for the old handle value is discarded, not read:
    // that response is a lookalike's bytes until the relist proves otherwise.
    const changed = rig({ runtimeId: "rt-1", nextHandle: "term_A" });
    const changedSlot = await bound(changed.driver, changed.fake, ["before"]);
    changed.fake.restart("rt-2", [
      { handle: "term_A", title: "operator-scratch", worktree: WT, lines: ["LOOKALIKE"] },
      { handle: "term_B", title: TITLE, worktree: WT, lines: ["REAL"] },
    ]);
    const afterChange = changed.fake.calls.length;
    expect(await changed.driver.read(changedSlot, 5)).toBe("REAL");
    expect(changed.fake.countOf("list")).toBe(1);
    // and term_A — the old value, now a foreign terminal — was never put on the wire at all: the
    // runtime identity is established BEFORE a runtime-scoped handle is addressed, not after.
    expect(changed.fake.calls.slice(afterChange).some((a) => a.some(x => x.includes("term_A")))).toBe(false);

    // (d) recovery between cursor pages rebuilds the retry as an unpaged anchor in the replacement
    // record's cursor space. The marker is before the stale cursor and cannot be found otherwise.
    const during = new FakeOrca({ runtimeId: "rt-1", nextHandle: "term_A", pageSize: 3 });
    const restartMarker = "TICKMARKR_FOUND_AFTER_MID_SWEEP_RESTART";
    let cursorPages = 0;
    const duringDriver = new OrcaDriver({
      exec: async (args, cwd, timeoutMs) => {
        const result = await during.exec(args, cwd, timeoutMs);
        if (args[0] === "terminal" && args[1] === "read" && args.includes("--cursor") && ++cursorPages === 1) {
          during.restart("rt-2", [{
            handle: "term_NEW",
            title: TITLE,
            worktree: WT,
            lines: ["replacement 0", restartMarker, "replacement 2", "replacement 3", "replacement 4", "replacement 5", "replacement 6", "replacement 7"],
          }]);
        }
        return result;
      },
      time: steppedTime(),
    });
    const duringSlot = await bound(duringDriver, during, ["old 0", "old 1", "old 2", "old 3", "old 4", "old 5", "old 6", "old 7"]);
    expect(await duringDriver.waitOutput(duringSlot, restartMarker, 1_000)).toBe(true);
    const duringReads = during.calls.filter((a) => a[0] === "terminal" && a[1] === "read");
    expect(duringReads.filter((a) => !a.includes("--cursor"))).toHaveLength(2); // original + recovered anchors
    expect(duringReads.filter((a) => a.includes("--cursor")).map((a) => a[a.indexOf("--cursor") + 1]))
      .toEqual(expect.arrayContaining(["0", "0"])); // one page pre-restart, a fresh anchor page after
    expect(during.countOf("list")).toBe(1);

    // (d2) the accumulated buffer belongs to the runtime that produced it. A restart mid-sweep must
    // not let an old prefix and a replacement's suffix join into a marker neither terminal emitted.
    const SPLIT_MARKER = "TICKMARKR_SPLIT_HALF_MARKER";
    const oldLines = ["old 0", "old 1", "TICKMARKR_SPLIT_HAL", "old 3"];
    const newLines = ["F_MARKER_TAIL", "replacement 1", "replacement 2"];
    // the false-clean control: the old runtime's page and the replacement's page, as a driver that
    // carries its buffer across the restart would hold them, de-wrap into a marker neither emitted.
    expect(joinWrapped([...oldLines.slice(0, 3), ...newLines].join("\n"))).toContain(SPLIT_MARKER);
    const poison = new FakeOrca({ runtimeId: "rt-1", nextHandle: "term_A", pageSize: 3 });
    let poisonPages = 0;
    const poisonDriver = new OrcaDriver({
      exec: async (args, cwd, timeoutMs) => {
        const result = await poison.exec(args, cwd, timeoutMs);
        if (args[0] === "terminal" && args[1] === "read" && args.includes("--cursor") && ++poisonPages === 1) {
          poison.restart("rt-2", [{ handle: "term_NEW", title: TITLE, worktree: WT, lines: newLines }]);
        }
        return result;
      },
      time: steppedTime(),
    });
    const poisonSlot = await bound(poisonDriver, poison, oldLines);
    expect(await poisonDriver.waitOutput(poisonSlot, SPLIT_MARKER, 800)).toBe(false);
    expect(poison.countOf("list")).toBe(1); // the restart WAS observed — only the stale bytes went

    // (e) a send probes runtime identity before addressing the old handle. Even when that value now
    // belongs to a foreign terminal, only the owned-tab + worktree replacement receives the text.
    const mutating = rig({ runtimeId: "rt-1", nextHandle: "term_A" });
    const mutatingSlot = await bound(mutating.driver, mutating.fake, ["before"]);
    mutating.fake.restart("rt-2", [
      { handle: "term_A", title: "operator-scratch", worktree: WT, lines: ["FOREIGN"] },
      { handle: "term_B", title: TITLE, worktree: WT, lines: ["REAL"] },
    ]);
    const afterMutRestart = mutating.fake.calls.length;
    await mutating.driver.run(mutatingSlot, "DO-NOT-MISDELIVER");
    expect(mutating.fake.calls.slice(afterMutRestart).some((a) => a.some(x => x.includes("term_A")))).toBe(false);
    expect(mutating.fake.sent.get("term_A")).toBeUndefined();
    expect(mutating.fake.sent.get("term_B")).toEqual(["DO-NOT-MISDELIVER"]);
    expect(mutating.fake.typed.get("term_B")).toBeUndefined();
    expect(mutating.fake.calls.filter((a) => a[0] === "terminal" && a[1] === "send"))
      .toEqual([["terminal", "send", "--terminal", "term_B", "--text", "DO-NOT-MISDELIVER", "--enter", "--json"]]);
    expect(mutating.fake.countOf("list")).toBe(1);

    // (e2) staleness window: a mutating operation after the staleness window expires probes again
    // before sending.
    const staleWindow = new FakeOrca({ runtimeId: "rt-1", nextHandle: "term_A" });
    const staleTime = steppedTime();
    let delayList = false;
    const staleDriver = new OrcaDriver({
      exec: async (args, cwd, timeoutMs) => {
        if (delayList && args[0] === "terminal" && args[1] === "list") {
           await staleTime.sleep(3000); // Exceeds 2000ms window
        }
        return staleWindow.exec(args, cwd, timeoutMs);
      },
      time: staleTime,
      probeStalenessMs: 2000,
    });
    const staleWindowSlot2 = await bound(staleDriver, staleWindow, ["before"]);
    // Force a relist by restarting the runtime.
    staleWindow.restart("rt-2", [{ handle: "term_B", title: TITLE, worktree: WT, lines: ["REAL"] }]);
    staleWindow.calls.length = 0;
    delayList = true;
    await staleDriver.run(staleWindowSlot2, "slow");
    // Should be: status(rt-1) -> sees rt-2 -> list(takes 3s) -> loop check sees 3s > 2s -> status(rt-2) -> send
    expect(staleWindow.families()).toEqual(["status", "list", "status", "send"]);
    
    // (e3) failure closed on mutation identity mismatch
    // If a send actually happens and the response runtime id is different, it fails closed.
    const mismatchedSend = new FakeOrca({ runtimeId: "rt-1", nextHandle: "term_A" });
    const mismatchedSendDriver = new OrcaDriver({
      exec: async (args, cwd, timeoutMs) => {
        const res = await mismatchedSend.exec(args, cwd, timeoutMs);
        if (args[0] === "terminal" && args[1] === "send") {
           // Corrupt the runtime ID in the response
           res.stdout = res.stdout.replace('"rt-1"', '"rt-alien"');
        }
        return res;
      },
      time: steppedTime(),
    });
    const mismatchSlot = await bound(mismatchedSendDriver, mismatchedSend, ["before"]);
    const mismatchErr = await mismatchedSendDriver.run(mismatchSlot, "doom").then((v) => v, (e: unknown) => e);
    expect(mismatchErr).toBeInstanceOf(OrcaUnavailableError);
    expect((mismatchErr as OrcaUnavailableError).message).toContain("runtime identity mismatch on mutation");

    // (e4) ABSENT identity is the same failure as a wrong one: a send that answers ok:true with no
    // `_meta` at all is rejected by the parser before any refusal code exists, and the bytes may
    // ALREADY have been delivered. The slot must latch unavailable — a driver that lets that error
    // escape unlatched sends the same text a second time on the next run().
    const absentIdentity = new FakeOrca({ runtimeId: "rt-1", nextHandle: "term_A" });
    const absentIdentityDriver = new OrcaDriver({
      exec: async (args, cwd, timeoutMs) => {
        const res = await absentIdentity.exec(args, cwd, timeoutMs);
        if (args[0] === "terminal" && args[1] === "send") {
          const body = JSON.parse(res.stdout);
          delete body._meta; // ok:true, receipt intact, no answering identity
          res.stdout = JSON.stringify(body);
        }
        return res;
      },
      time: steppedTime(),
    });
    const absentSlot = await bound(absentIdentityDriver, absentIdentity, ["before"]);
    const absentErr = await absentIdentityDriver.run(absentSlot, "DELIVERED-ONCE").then((v) => v, (e: unknown) => e);
    expect(absentErr).toBeInstanceOf(OrcaUnavailableError);
    expect((absentErr as OrcaUnavailableError).message).toContain("absent");
    // the fake DID deliver it — which is exactly why a second attempt must never be issued
    expect(absentIdentity.sent.get("term_A")).toEqual(["DELIVERED-ONCE"]);
    const sends = absentIdentity.countOf("send");
    await expect(absentIdentityDriver.run(absentSlot, "DELIVERED-ONCE")).rejects.toBeInstanceOf(OrcaUnavailableError);
    expect(absentIdentity.countOf("send")).toBe(sends); // no second send went on the wire
    expect(absentIdentity.sent.get("term_A")).toEqual(["DELIVERED-ONCE"]);

    // (f) zero matches / (g) duplicate matches / (h) the old handle value reused by the new runtime
    const unavailable: [string, { handle: string; title: string; worktree: string; lines?: string[] }[]][] = [
      ["zero", lookalikes()],
      ["duplicate", [...lookalikes(), { handle: "term_B", title: TITLE, worktree: WT }, { handle: "term_C", title: TITLE, worktree: WT }]],
      ["reuse", [...lookalikes(), { handle: "term_A", title: TITLE, worktree: WT, lines: ["REUSED HANDLE"] }]],
    ];
    for (const [label, table] of unavailable) {
      const r = rig({ runtimeId: "rt-1", nextHandle: "term_A" });
      const s = await bound(r.driver, r.fake, ["before"]);
      r.fake.restart("rt-2", table);
      const mark = r.fake.calls.length;
      const err = await r.driver.read(s, 5).then((v) => v, (e: unknown) => e);
      expect(err, label).toBeInstanceOf(OrcaUnavailableError);
      for (const l of lookalikes()) expect(addressed(r.fake, l.handle), `${label} addressed a lookalike`).toBe(false);
      // including "reuse": whatever now answers to term_A under rt-2 is never addressed either.
      expect(r.fake.calls.slice(mark).some((a) => a.some(x => x.includes("term_A"))), `${label} addressed the reused old handle`).toBe(false);
      // and the slot STAYS unavailable — no later call quietly resolves onto anything
      await expect(r.driver.status(s)).rejects.toBeInstanceOf(OrcaUnavailableError);
      await expect(r.driver.run(s, "anything")).rejects.toBeInstanceOf(OrcaUnavailableError);
    }
  });

  test("test: a terminal_gone refusal on a terminal operation triggers exactly one relist of the slot worktree exactly as terminal_handle_stale does whereas a driver that treats terminal_gone as a plain refusal leaves the slot failed so it fails", async () => {
    expect([...STALE_HANDLE_CODES]).toEqual([STALE_HANDLE_CODE, TERMINAL_GONE_CODE]);

    for (const code of [STALE_HANDLE_CODE, TERMINAL_GONE_CODE]) {
      const fake = new FakeOrca({ runtimeId: "rt-1", nextHandle: "term_A" });
      let refused = false;
      const driver = new OrcaDriver({
        exec: async (args, cwd, timeoutMs) => {
          if (!refused && args[0] === "terminal" && args[1] === "read" && args.includes("term_A")) {
            refused = true;
            return {
              code: 1,
              stdout: JSON.stringify({
                ok: false,
                error: { code, message: code },
                _meta: { runtimeId: fake.runtimeId },
              }),
              stderr: "",
            };
          }
          return fake.exec(args, cwd, timeoutMs);
        },
        time: steppedTime(),
      });
      const slot = await bound(driver, fake, ["before"]);
      fake.terminals = [{ handle: "term_B", title: TITLE, worktree: WT, lines: [`after ${code}`] }];

      await expect(driver.read(slot, 5)).resolves.toBe(`after ${code}`);
      expect(fake.calls.filter((a) => a[1] === "list")).toEqual([
        ["terminal", "list", "--worktree", `path:${WT}`, "--include-visual-layouts", "--limit", "10000", "--json"],
      ]);
      expect(refused).toBe(true);
      expect(fake.calls.filter((a) => a[1] === "read" && a.includes("term_B"))).toHaveLength(1);
    }
  });

  test("test: a missing runtime probe and a terminal_not_writable send each surface as explicit driver-level failures preserving the raw refusal while a driver that converts either into a successful or empty result fails", async () => {
    const missing = rig({ cliMissing: "orca: command not found" });
    const probeErr = await missing.driver.probeRuntime(WT).then((v) => v, (e: unknown) => e);
    expect(probeErr).toBeInstanceOf(OrcaError);
    expect((probeErr as OrcaError).family).toBe("status");
    expect((probeErr as OrcaError).raw).toContain("command not found");
    // the probe is not decorative: a run cannot create a terminal without it
    const orphan = await missing.driver.slot(WT, TITLE);
    await expect(missing.driver.run(orphan, "bash")).rejects.toBeInstanceOf(OrcaError);
    expect(missing.fake.countOf("create")).toBe(0);

    // Installed Orca can answer ok:true while its runtime is unreachable. That is still an explicit
    // unavailable probe and must stop before terminal create.
    const unreachable = rig({ reachable: false });
    const unreachableErr = await unreachable.driver.probeRuntime(WT).then((v) => v, (e: unknown) => e);
    expect(unreachableErr).toBeInstanceOf(OrcaError);
    expect((unreachableErr as OrcaError).raw).toContain('"reachable":false');
    const unreachableSlot = await unreachable.driver.slot(WT, TITLE);
    await expect(unreachable.driver.run(unreachableSlot, "bash")).rejects.toBeInstanceOf(OrcaError);
    expect(unreachable.fake.countOf("create")).toBe(0);

    const noRuntimeIdentity = rig({ reachable: false, runtimeId: "none" });
    await expect(noRuntimeIdentity.driver.probeRuntime(WT)).rejects.toBeInstanceOf(OrcaError);

    const refused = rig();
    const slot = await bound(refused.driver, refused.fake, ["x"]);
    const handle = refused.fake.last()!.handle;
    refused.fake.last()!.writable = false;
    const sendErr = await refused.driver.run(slot, "second turn").then((v) => v, (e: unknown) => e);
    expect(sendErr).toBeInstanceOf(OrcaError);
    expect((sendErr as OrcaError).code).toBe(NOT_WRITABLE_CODE); // the code survived the rc-1 refusal
    expect((sendErr as OrcaError).raw).toContain(NOT_WRITABLE_CODE);
    expect(refused.fake.sent.get(handle)).toBeUndefined(); // nothing was delivered

    // The false-clean controls: converting either failure produces a clean, and untrue, result.
    const asReachable = async () => { try { return await missing.driver.probeRuntime(WT); } catch { return "reachable"; } };
    const asDelivered = async () => { try { await refused.driver.run(slot, "second turn"); return true; } catch { return true; } };
    const asEmpty = async () => { try { return await missing.driver.probeRuntime(WT); } catch { return ""; } };
    expect(await asReachable()).toBe("reachable");
    expect(await asDelivered()).toBe(true);
    expect(await asEmpty()).toBe("");
    expect(refused.fake.sent.get(handle)).toBeUndefined(); // the "delivered" control delivered nothing
  });

  test("test: an agent-wait state maps to blocked and tui-idle maps to idle and an absent agent field maps to unknown while a driver that fabricates a definite status from the absent field fails", async () => {
    const { fake, driver } = rig();
    const slot = await bound(driver, fake, ["x"]);
    const term = fake.last()!;

    // blocked: the show surface reports agentWait — the only blocked signal orca declares.
    term.agentWait = true;
    expect(await driver.status(slot)).toBe("blocked");
    expect(await driver.waitAgentStatus(slot, "blocked", 1_000)).toBe(true);
    // idle: orca's own tui-idle wait condition is satisfied.
    term.agentWait = undefined;
    term.tuiIdle = true;
    expect(await driver.status(slot)).toBe("idle");
    expect(await driver.waitAgentStatus(slot, "idle", 1_000)).toBe(true);
    // absent fields: the recorded show response carries no agent field at all and no condition is
    // satisfied — unknown, never a fabricated definite status.
    term.tuiIdle = undefined;
    expect(await driver.status(slot)).toBe("unknown");
    expect(await driver.waitAgentStatus(slot, "idle", 400)).toBe(false);
    expect(mapAgentState({}, false)).toBe("unknown"); // the recorded shape: no agentWait, not idle
    expect(mapAgentState({}, true)).toBe("idle");
    expect(mapAgentState({ agentWait: true }, false)).toBe("blocked");

    // The false-clean control: a mapper that reads the absent fields as a definite state.
    const fabricating = (t: Record<string, unknown>) => (t.agentWait === undefined ? "idle" : "unknown");
    expect(fabricating({ connected: true })).toBe("idle");
    expect(mapAgentState({ connected: true }, false)).not.toBe(fabricating({ connected: true }));
  });
});
