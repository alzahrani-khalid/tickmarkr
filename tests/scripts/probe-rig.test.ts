import { describe, expect, test } from "vitest";
import {
  buildLoopSafePadding,
  isVendorRefusal,
  parseWorkspaceId,
  scoreProbeCell,
  withScratchWorkspace,
} from "../../scripts/probe-rig.mjs";

// HYG-09 (D-07): the probe rig cannot leak tabs into the operator's workspace. These tests prove the
// extracted lifecycle tears down the scratch workspace in a finally on every path — including the throw
// path that today exits before any teardown (the six-orphaned-VIS09-tabs incident). Zero-token: the
// herdrSh is a recording stub, never the real herdr binary.

describe("HYG-09 probe rig: scratch-workspace finally-close (zero-token, stubbed herdrSh)", () => {
  // recording stub herdrSh — answers `workspace create` with a parsed id, records every call
  function stubHerdr(createId = "w-scratch-9") {
    const calls: string[] = [];
    const herdrSh = (cmd: string) => {
      calls.push(cmd);
      if (/^workspace create/.test(cmd)) {
        return {
          code: 0,
          stdout: JSON.stringify({ result: { workspace: { workspace_id: createId }, tab: { tab_id: `${createId}:t1` }, root_pane: { pane_id: `${createId}:p1` } } }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    return { herdrSh, calls };
  }

  test("rig workspace closes when the body throws — the six-orphaned-tabs incident made impossible", async () => {
    const { herdrSh, calls } = stubHerdr();
    const boom = new Error("rig body exploded (e.g. a die() path)");
    // the throw propagates AFTER the finally teardown ran
    await expect(withScratchWorkspace(herdrSh, async () => { throw boom; })).rejects.toBe(boom);
    // the workspace was created then closed in a finally — even though the body threw
    expect(calls[0]).toBe("workspace create --no-focus");
    const closeIdx = calls.findIndex((c) => /^workspace close /.test(c));
    expect(closeIdx).toBeGreaterThan(0);
    expect(calls[closeIdx]).toBe("workspace close w-scratch-9"); // the id parsed from the create response
  });

  test("rig workspace closes on success and returns fn's value", async () => {
    const { herdrSh, calls } = stubHerdr("w-ok");
    const val = await withScratchWorkspace(herdrSh, async (wsId) => {
      expect(wsId).toBe("w-ok");
      return "harvest-ok";
    });
    expect(val).toBe("harvest-ok");
    expect(calls).toContain("workspace create --no-focus");
    expect(calls).toContain("workspace close w-ok");
    const createIdx = calls.indexOf("workspace create --no-focus");
    const closeIdx = calls.indexOf("workspace close w-ok");
    expect(closeIdx).toBeGreaterThan(createIdx); // close runs AFTER the body, in the finally
  });

  test("workspace create failure → no close attempted, error propagates (fail loud, don't close what was never created)", async () => {
    const calls: string[] = [];
    const herdrSh = (cmd: string) => {
      calls.push(cmd);
      return { code: 1, stdout: "", stderr: "herdr refused" };
    };
    await expect(withScratchWorkspace(herdrSh, async () => "unreachable")).rejects.toThrow(/workspace create --no-focus failed/);
    // create was attempted; close was NOT (nothing was created to tear down)
    expect(calls).toEqual(["workspace create --no-focus"]);
  });

  test("parseWorkspaceId reads result.workspace.workspace_id and fails closed on garbage", () => {
    expect(parseWorkspaceId(JSON.stringify({ result: { workspace: { workspace_id: "w3" } } }))).toBe("w3");
    expect(parseWorkspaceId("not json")).toBeNull();
    expect(parseWorkspaceId(JSON.stringify({ result: { workspace: {} } }))).toBeNull();
  });

  test("a sync rig body (spawnSync-shaped, like the real script) is also closed in the finally", async () => {
    // the real measure-trailer-width.mjs is sync (spawnSync); withScratchWorkspace must handle a
    // non-promise return just like an async one.
    const { herdrSh, calls } = stubHerdr();
    const val = withScratchWorkspace(herdrSh, () => "sync-harvest");
    expect(await val).toBe("sync-harvest");
    expect(calls).toContain("workspace close w-scratch-9");
  });
});

// OBS-07 (v1.25 T4): padding must not trip vendor loop detectors; a refusal is a verdict, not a retry.
describe("OBS-07 probe rig: loop-safe padding + refusal is a verdict", () => {
  test("generated padding payload has no character run longer than 8 and no repeated 12-char substring", () => {
    const padding = buildLoopSafePadding();
    expect(padding.length).toBeGreaterThan(40);

    // no identical-character run longer than 8 (the old "xxxx…" padding failed this hard)
    let run = 1;
    let maxRun = 1;
    for (let i = 1; i < padding.length; i++) {
      if (padding[i] === padding[i - 1]) {
        run += 1;
        if (run > maxRun) maxRun = run;
      } else {
        run = 1;
      }
    }
    expect(maxRun).toBeLessThanOrEqual(8);

    // no 12-char substring appears more than once (loop-detector-safe by construction)
    const seen = new Set<string>();
    for (let i = 0; i <= padding.length - 12; i++) {
      const sub = padding.slice(i, i + 12);
      expect(seen.has(sub)).toBe(false);
      seen.add(sub);
    }
  });

  test("a probe response matching a vendor-refusal fingerprint yields a not-measurable cell and schedules no retry", () => {
    // cursor's OBS-07 fingerprint (live: "Agent Looping Detected — the model got stuck in a repeating response pattern")
    const raw = [
      "PROBE_TPUT_COLS=80",
      "PROBE_AGENT_START",
      "Error: Agent Looping Detected — the model got stuck in a repeating response pattern",
      "PROBE_AGENT_DONE",
    ].join("\n");

    expect(isVendorRefusal(raw)).toBe(true);

    const cell = scoreProbeCell({ raw, parseOk: false, cols: 80, summaryLen: 0 });
    expect(cell.status).toBe("not measurable");
    expect(cell.measurable).toBe(false);
    expect(cell.refused).toBe(true);
    expect(cell.parseOk).toBe(false);
    expect(cell.retry).toBe(false); // never schedule another invocation for this cell
    expect(cell.cols).toBe(80);
  });

  test("successful cell keeps measured-width semantics (cols/parseOk) and does not mark refused", () => {
    const raw = "PROBE_AGENT_START\nTICKMARKR_RESULT_vis09probe {\"ok\":true}\nPROBE_AGENT_DONE";
    expect(isVendorRefusal(raw)).toBe(false);
    const cell = scoreProbeCell({ raw, parseOk: true, cols: 42, summaryLen: 120 });
    expect(cell.refused).toBe(false);
    expect(cell.measurable).toBe(true);
    expect(cell.parseOk).toBe(true);
    expect(cell.cols).toBe(42);
    expect(cell.summaryLen).toBe(120);
    expect(cell.retry).toBe(false);
    expect(cell.status).toBe("ok");
  });
});
