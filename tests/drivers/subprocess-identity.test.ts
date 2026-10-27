import { afterEach, expect, test, vi } from "vitest";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { workerReapHost } from "../../src/run/stall.js";

afterEach(() => vi.restoreAllMocks());

test("the subprocess driver's close signals its slot's process group, and after that group signal fails its fallback pid signal, only while the leader still bears the identity recorded at spawn, so a close or fallback signal reaching a reused pid fails", async () => {
  for (const mode of ["group", "reused-close", "fallback", "reused-fallback", "unreadable-spawn", "gone-close"] as const) {
    const driver = new SubprocessDriver();
    const slot = await driver.slot(process.cwd(), mode);
    let pid: number | undefined;
    let probes = 0;
    let groupFailed = false;
    const events: string[] = [];
    vi.spyOn(workerReapHost, "identity").mockImplementation(async (target) => {
      pid = target;
      probes++;
      events.push(`identity:${target}`);
      if (mode === "unreadable-spawn") return null;
      if (mode === "gone-close" && probes > 1) return undefined;
      return (mode === "reused-close" && probes > 1) || (mode === "reused-fallback" && groupFailed) ? "replacement" : "birth";
    });
    const kill = vi.spyOn(workerReapHost, "kill").mockImplementation((target) => {
      events.push(`kill:${target}`);
      if (target < 0 && (mode === "fallback" || mode === "reused-fallback")) {
        groupFailed = true;
        throw Object.assign(new Error("group missing"), { code: "ESRCH" });
      }
    });
    try {
      await driver.run(slot, "printf ready; sleep 30");
      expect(await driver.waitOutput(slot, "ready", 5_000)).toBe(true);
      expect(probes).toBe(1); // the birth identity was captured at launch
      await driver.close(slot);
      if (mode === "group" || mode === "fallback" || mode === "reused-fallback") {
        expect(kill.mock.calls[0]).toEqual([-pid!]);
        expect(events.indexOf(`kill:${-pid!}`)).toBe(2); // launch read, immediate close read, signal
      } else expect(kill).not.toHaveBeenCalled();
      if (mode === "fallback") {
        expect(kill.mock.calls).toEqual([[-pid!], [pid!]]);
        expect(events.slice(-2)).toEqual([`identity:${pid}`, `kill:${pid}`]);
      } else expect(kill).not.toHaveBeenCalledWith(pid);
      if (mode === "reused-fallback") expect(probes).toBe(3);
    } finally {
      vi.restoreAllMocks();
      if (pid !== undefined) { try { process.kill(-pid, "SIGKILL"); } catch { /* exited */ } }
      // A closed slot has retired its state; the real child listeners still drain its streams.
      await new Promise((resolve) => setTimeout(resolve, 30));
      await driver.close(slot);
    }
  }
});
