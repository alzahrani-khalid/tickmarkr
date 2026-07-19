import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function spawnStatusWatch(binary: string, entry: string, cwd: string) {
  const child = spawn(binary, [entry, "status", "--watch"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  await once(child, "spawn");
  return child;
}

// OBS-11 regression: an unref'd sleep timer let the event loop drain after the first frame,
// so a REAL (non-injected-sleep) `tickmarkr status --watch` printed once and exited 0. The unit
// suite injects opts.sleep and can never see that — only a real child process can. Zero tokens:
// status is a pure reader over a fixture .tickmarkr/.
describe("status --watch process liveness (OBS-11)", () => {
  it("rejects loudly when the status-watch binary does not exist", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-watch-"));
    const entry = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));

    await expect(spawnStatusWatch(join(repo, "missing-tsx"), entry, repo)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a real --watch process is still alive after several refresh intervals", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-watch-"));
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(
      join(repo, ".tickmarkr", "graph.json"),
      JSON.stringify({
        version: 1,
        spec: { source: "prd", paths: ["x"], hash: "0".repeat(64) },
        tasks: [
          {
            id: "T1",
            title: "t",
            goal: "g",
            shape: "docs",
            complexity: 1,
            deps: [],
            files: [],
            context: [],
            acceptance: ["a"],
            gates: ["build", "test", "lint", "evidence", "scope"],
            status: "pending",
          },
        ],
      }),
    );
    // repo root via import.meta, never the process cwd — the HYG-06 operator-state guard forbids
    // cwd+state-dir combos in tests; this test only ever touches the mkdtemp fixture
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const tsx = join(root, "node_modules", ".bin", "tsx");
    const entry = join(root, "src", "cli", "index.ts");
    const child = await spawnStatusWatch(tsx, entry, repo);
    const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    // 2s refresh: the pre-fix binary exits right after frame 1 (well under 5.5s); the fixed one is still looping
    const outcome = await Promise.race([
      exited.then((c) => ({ exited: true as const, code: c })),
      new Promise<{ exited: false }>((r) => setTimeout(() => r({ exited: false }), 5_500)),
    ]);
    child.kill("SIGKILL");
    expect(outcome.exited).toBe(false);
  }, 20_000);
});
