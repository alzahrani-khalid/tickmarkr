import { describe, expect, test } from "vitest";
import { MAX_BUF, SubprocessDriver } from "../../src/drivers/subprocess.js";
import { DEFAULT_FORK_CAP, FORK_CAP_ENV } from "../../src/run/git.js";

describe("SubprocessDriver", () => {
  test("run + waitOutput + read", async () => {
    const d = new SubprocessDriver();
    const slot = await d.slot("/tmp", "w1");
    await d.run(slot, "echo hello; echo 'TICKMARKR_EXIT:0'");
    expect(await d.waitOutput(slot, "TICKMARKR_EXIT:", 5000)).toBe(true);
    const out = await d.read(slot, 10);
    expect(out).toContain("hello");
    await d.close(slot);
  });

  test("waitOutput times out cleanly", async () => {
    const d = new SubprocessDriver();
    const slot = await d.slot("/tmp", "w2");
    await d.run(slot, "sleep 3");
    expect(await d.waitOutput(slot, "never-appears", 500)).toBe(false);
    await d.close(slot);
  });

  test("close after a waitOutput timeout kills the worker's whole process tree", async () => {
    const d = new SubprocessDriver();
    const slot = await d.slot("/tmp", "tree");
    let grandchild: number | undefined;
    const alive = () => {
      try { process.kill(grandchild!, 0); return true; } catch { return false; }
    };

    try {
      // The background sleep inherits bash's output pipes. Killing bash alone leaves both the process
      // and the pipe alive — the same orphan shape covered by sh() in src/run/git.ts.
      await d.run(slot, "sleep 30 & printf 'grandchild:%s\\n' $!; wait");
      expect(await d.waitOutput(slot, "grandchild:", 3000)).toBe(true);
      grandchild = Number(/grandchild:(\d+)/.exec(await d.read(slot, 10))?.[1]);
      expect(Number.isInteger(grandchild)).toBe(true);
      expect(await d.waitOutput(slot, "never-appears", 50)).toBe(false);

      await d.close(slot);
      const deadline = Date.now() + 2000;
      while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(alive()).toBe(false);
    } finally {
      await d.close(slot);
      if (grandchild && alive()) process.kill(grandchild, "SIGKILL");
    }
  });

  test("close on an already-exited slot is a safe no-op", async () => {
    const d = new SubprocessDriver();
    const slot = await d.slot("/tmp", "exited");
    await d.run(slot, "true");
    expect(await d.waitAgentStatus(slot, "done", 3000)).toBe(true);
    await expect(d.close(slot)).resolves.toBeUndefined();
    await expect(d.close(slot)).resolves.toBeUndefined();
  });

  test("chatty worker: buffer capped at MAX_BUF, trailer at tail still detected (HARD-03)", async () => {
    const d = new SubprocessDriver();
    const slot = await d.slot("/tmp", "chatty");
    // ~3MB of filler (>2× the 2MB cap) then the exit trailer at the very end.
    // awk is BSD/macOS-safe and generates the bytes in one process (fast, zero tokens).
    await d.run(slot, "awk 'BEGIN{s=sprintf(\"%99s\",\"\"); for(i=0;i<30000;i++) print s; print \"TICKMARKR_EXIT_x:0\"}'");
    expect(await d.waitOutput(slot, "TICKMARKR_EXIT_x:\\d", 15000, { regex: true })).toBe(true);
    const retained = await d.read(slot, 10_000_000);
    expect(retained.length).toBeLessThanOrEqual(MAX_BUF);
    await d.close(slot);
  });

  test("waitAgentStatus: done ⇔ process exit", async () => {
    const d = new SubprocessDriver();
    const slot = await d.slot("/tmp", "w3");
    await d.run(slot, "true");
    expect(await d.waitAgentStatus(slot, "done", 5000)).toBe(true);
    expect(await d.waitAgentStatus(slot, "blocked", 300)).toBe(false);
    await d.close(slot);
  });

  test("HARD-05: a worker that reads stdin reaches its trailer (no stdin hang)", async () => {
    const d = new SubprocessDriver();
    const slot = await d.slot("/tmp", "stdin-victim");
    // codex-shaped: reads fd 0 to EOF FIRST, then prints marker. Under default stdio ("pipe")
    // tickmarkr holds the write end open forever → marker never prints.
    await d.run(slot, "cat >/dev/null; printf 'TICKMARKR_''EXIT_x:0\n'");
    expect(await d.waitOutput(slot, "TICKMARKR_EXIT_x:\\d", 3000, { regex: true })).toBe(true);
    await d.close(slot);
  });

  test("HARD-05/D-05: a stdin-reading worker that emits no trailer exits loudly, it does not wait", async () => {
    const d = new SubprocessDriver();
    const slot = await d.slot("/tmp", "no-trailer");
    // daemon appends `; ${exitMarkerCmd}` — exit marker, NOT trailer, ends the headless wait.
    await d.run(slot, "cat >/dev/null; printf '\\nTICKMARKR_''EXIT_x:%s\\n' $?");
    expect(await d.waitOutput(slot, "TICKMARKR_EXIT_x:\\d", 3000, { regex: true })).toBe(true);
    const out = await d.read(slot, 100);
    expect(out).not.toMatch(/TICKMARKR_RESULT/);
    await d.close(slot);
  });

  test("a dispatched worker's environment carries the fork cap so its self-checks run capped", async () => {
    const before = process.env[FORK_CAP_ENV];
    delete process.env[FORK_CAP_ENV];
    const d = new SubprocessDriver();
    const slot = await d.slot("/tmp", "default-fork-cap");
    try {
      await d.run(slot, `printf '%s\\n' "\${${FORK_CAP_ENV}-unset}"`);
      expect(await d.waitAgentStatus(slot, "done", 5000)).toBe(true);
      expect((await d.read(slot, 10)).trim()).toBe(DEFAULT_FORK_CAP);
    } finally {
      await d.close(slot);
      if (before === undefined) delete process.env[FORK_CAP_ENV];
      else process.env[FORK_CAP_ENV] = before;
    }
  });

  test("an operator-set cap in the daemon environment reaches the worker unchanged rather than being overwritten by a default", async () => {
    const before = process.env[FORK_CAP_ENV];
    process.env[FORK_CAP_ENV] = "3";
    const d = new SubprocessDriver();
    const slot = await d.slot("/tmp", "operator-fork-cap");
    try {
      await d.run(slot, `printf '%s\\n' "\${${FORK_CAP_ENV}-unset}"`);
      expect(await d.waitAgentStatus(slot, "done", 5000)).toBe(true);
      expect((await d.read(slot, 10)).trim()).toBe("3");
    } finally {
      await d.close(slot);
      if (before === undefined) delete process.env[FORK_CAP_ENV];
      else process.env[FORK_CAP_ENV] = before;
    }
  });
});
