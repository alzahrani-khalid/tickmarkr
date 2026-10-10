import { execFileSync, spawn } from "node:child_process";
import { expect, test } from "vitest";
import { workerReapHost } from "../../src/run/stall.js";
import { runnerPids } from "../../src/run/suite-census.js";

// Queue row 127: ps prints an argv's U+2028/U+2029 raw (the claude worker passes its whole prompt as an argument), and
// JS `.` never matches them without the s flag. One such row made the reap snapshot unparseable, so every reap read null.
const LS = "\u2028";

// macOS ps vis-encodes U+2028 unless the locale is UTF-8 (the operator's daemon runs in one), so the probe pins one.
test("P1 a live process whose argv holds U+2028 leaves the reap snapshot readable and lists it", async () => {
  const locale = process.env.LC_ALL;
  process.env.LC_ALL = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", `tkr-row127${LS}probe`], { stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (process.platform === "darwin") {
      const raw = execFileSync("ps", ["-o", "command=", "-p", String(child.pid)], { encoding: "utf8" });
      expect(raw).toContain(LS); // sanity: the character reached ps raw, so the snapshot below meets it
    }
    const rows = await workerReapHost.snapshot();
    expect(rows).toBeDefined();
    expect(rows!.some((row) => row.pid === child.pid)).toBe(true);
  } finally {
    child.kill("SIGKILL");
    if (locale === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = locale;
  }
});

test.each([
  ["P2 a runner row whose argv holds U+2028 is counted", `  12     1 S    npx vitest run${LS}tail\n`, [12]],
  ["P2' control: a plain runner row", "  13     1 S    npx vitest run\n", [13]],
  ["P2'' control: a zombie row stays out", `  14     1 Z    npx vitest run${LS}tail\n`, []],
])("%s", (_name, snapshot, pids) => {
  expect(runnerPids(snapshot)).toEqual(pids);
});
