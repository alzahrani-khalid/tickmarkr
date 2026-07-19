import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tickmarkrDir, graphPath, loadGraph, saveGraph } from "../../src/graph/graph.js";
import { type RunGraph, validateGraph } from "../../src/graph/schema.js";

// A valid RunGraph whose serialized size varies with `n` — alternating sizes make a torn
// read a guaranteed JSON.parse error, so the stress child can witness any non-atomic write.
const graphOf = (n: number): RunGraph =>
  validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["p.md"], hash: "h" },
    tasks: Array.from({ length: n }, (_, i) => ({
      id: `T${i}`,
      title: `task ${i} `.repeat(8),
      goal: "g",
      shape: "implement",
      complexity: 3,
      acceptance: ["a"],
    })),
  });

describe("atomic saveGraph (HARD-04)", () => {
  test("round-trips and leaves no .tmp litter", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-atomic-"));
    saveGraph(dir, graphOf(3));
    expect(loadGraph(dir).tasks).toHaveLength(3);
    // graph.json parses standalone and no sibling temp file remains
    JSON.parse(readFileSync(graphPath(dir), "utf8"));
    const litter = readdirSync(tickmarkrDir(dir)).filter((f) => f.endsWith(".tmp"));
    expect(litter).toEqual([]);
  });

  test("failed write leaves no .tmp litter", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-failsave-"));
    // Make graph.json a directory so renameSync fails deterministically after the temp is written.
    mkdirSync(graphPath(dir), { recursive: true });
    expect(() => saveGraph(dir, graphOf(2))).toThrow();
    const litter = readdirSync(tickmarkrDir(dir)).filter((f) => f.endsWith(".tmp"));
    expect(litter).toEqual([]);
  });

  // The real proof: a separate process loops JSON.parse over graph.json while the parent
  // rewrites it repeatedly with alternating sizes. A non-atomic writer exposes a torn document
  // (parse error → child exit 1). renameSync makes every observed document complete → exit 0.
  test("cross-process reader never observes a torn document", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-torn-"));
    const p = graphPath(dir);
    saveGraph(dir, graphOf(2)); // pre-seed so the child always finds a file

    const reader = `
      const { readFileSync } = require("node:fs");
      let n = 0;
      const tick = () => {
        try { JSON.parse(readFileSync(process.argv[1], "utf8")); }
        catch { process.exit(1); }
        if (++n >= 200) process.exit(0);
        setTimeout(tick, 5);
      };
      tick();
    `;
    const child = spawn(process.execPath, ["-e", reader, p], { stdio: "ignore" });
    // Pass the raw exit code through: a torn read → exit(1); a clean 200-iteration run → exit(0).
    const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));

    // Hammer the file for longer than the child's ~1s read loop so every read overlaps a write.
    const start = Date.now();
    let i = 0;
    while (Date.now() - start < 1300) {
      saveGraph(dir, graphOf(i % 2 === 0 ? 2 : 40));
      i++;
    }
    const code = await exited; // child finished its loop on its own → 0 iff no torn read seen
    expect(code).toBe(0);
  }, 5000);
});
