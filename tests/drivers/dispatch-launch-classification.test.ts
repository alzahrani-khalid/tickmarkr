// OBS-342 CONTROL. The original RED control at ad53e3fc proved that the adapter's launch predicate
// was handed the wrapper emitted by paneDispatchCommand rather than the adapter command it describes.
// The assertion now lives at the production classification seam: the command builder records LAUNCH,
// Herdr consumes that fact, and no wrapper byte is asked to restate it.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { claudeCode, CLAUDE_INPUT_BOX } from "../../src/adapters/claude-code.js";
import { shq } from "../../src/adapters/types.js";
import * as brand from "../../src/brand.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { DeliveryReadinessError, HerdrDriver } from "../../src/drivers/herdr.js";

const roots: string[] = [];
const priorWorkspace = process.env.HERDR_WORKSPACE_ID;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (priorWorkspace === undefined) delete process.env.HERDR_WORKSPACE_ID;
  else process.env.HERDR_WORKSPACE_ID = priorWorkspace;
});

function productionWindowTime() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    // Spend the real declared window in injected time after the first unstable pair of reads. The
    // test keeps 30_000 as the bound; it does not make the production contract smaller to run fast.
    sleep: async () => { nowMs += CLAUDE_INPUT_BOX.readinessTimeoutMs!; },
  };
}

function makeHerdrStub() {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-obs342-"));
  roots.push(root);
  const cwd = join(root, "worktree");
  const bin = join(root, "herdr");
  const log = join(root, "herdr.log");
  const panes = join(root, "panes.txt");
  mkdirSync(cwd);
  writeFileSync(bin, `#!/usr/bin/env bash
echo "$@" >> '${log}'
pane_list() {
  out=""
  while IFS=' ' read -r pid label; do
    [ -z "$pid" ] && continue
    row=$(printf '{"pane_id":"%s","label":"%s","tab_id":"w1:t1","workspace_id":"wTEST"}' "$pid" "$label")
    if [ -z "$out" ]; then out="$row"; else out="$out,$row"; fi
  done < '${panes}' 2>/dev/null
  printf '{"result":{"panes":[%s]}}\n' "$out"
}
case "$1 $2" in
  "tab create") echo '{"result":{"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p9"}}}' ;;
  "tab close") echo '{}' ;;
  "pane rename") printf '%s %s\\n' "$3" "$4" >> '${panes}'; echo '{}' ;;
  "pane list") pane_list ;;
  "pane run") /bin/bash -c "$4" >/dev/null 2>&1 || :; echo '{}' ;;
  "pane wait-output") exit 1 ;;
  "pane read") printf '' ;;
  "pane send-text"|"pane send-keys") echo '{}' ;;
  *) echo '{}' ;;
esac
`);
  chmodSync(bin, 0o755);
  process.env.HERDR_WORKSPACE_ID = "wTEST";
  return { root, cwd, bin, log };
}

function driverFor(bin: string) {
  return new HerdrDriver(bin, 3, productionWindowTime());
}

function recordedLaunch(command: string): string {
  // Dynamic lookup keeps this test collectable before the wished-for API exists, so RED is a
  // behavioral failure at the missing intent seam rather than an import/transform error.
  const record = (brand as typeof brand & { paneLaunchCommand?: (cmd: string) => string }).paneLaunchCommand;
  expect(record, "brand must carry the daemon's launch fact beside the command it builds").toBeTypeOf("function");
  return record!(command);
}

async function workerSlot(driver: HerdrDriver, cwd: string, taskId: string) {
  return driver.slot(cwd, `${taskId}-worker-claude-code-a0-obs342`);
}

describe("dispatch launch classification (OBS-342)", () => {
  test("test: a dispatch the daemon built as a LAUNCH is classified as a launch whatever bytes the command carries, proven member by member over the closed set of command wrappers — a bare adapter-binary fixture, a `bash <script>` fixture, an env-prefixed fixture and a shell-quoted fixture — none of which may be read as a TUI turn", async () => {
    const wrappers = [
      { label: "bare adapter binary", command: "claude --model fable" },
      { label: "bash script", command: "bash /tmp/T1-dispatch.sh" },
      { label: "env-prefixed", command: "env TICKMARKR_ATTEMPT=0 claude --model fable" },
      { label: "shell-quoted", command: "'/Applications/Claude Code/claude' --model fable" },
    ] as const;

    for (const [index, fixture] of wrappers.entries()) {
      const stub = makeHerdrStub();
      const driver = driverFor(stub.bin);
      await driver.run(
        await workerSlot(driver, stub.cwd, `T${index + 1}`),
        recordedLaunch(fixture.command),
      );
      const calls = readFileSync(stub.log, "utf8");
      expect(calls, fixture.label).toContain("pane run w1:p9");
      expect(calls, fixture.label).not.toContain("pane read w1:p9");
      expect(calls, fixture.label).not.toContain("pane send-text w1:p9");
    }
  });

  test("test: a genuine TUI turn is still classified as a turn and still waits for its input box, so the fix cannot be a blanket reclassification, proven over a turn fixture on the same adapter and driver", async () => {
    const stub = makeHerdrStub();
    const driver = driverFor(stub.bin);
    const slot = await workerSlot(driver, stub.cwd, "T5");
    await driver.run(slot, recordedLaunch("opaque-bootstrap-with-no-prefix"));

    const turn = "Inspect the worktree and finish the assigned task.";
    const error = await driver.run(slot, turn).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeliveryReadinessError);
    expect((error as DeliveryReadinessError).waitedMs).toBe(CLAUDE_INPUT_BOX.readinessTimeoutMs);
    const calls = readFileSync(stub.log, "utf8");
    expect(calls).toContain("pane read w1:p9");
    expect(calls).not.toContain(`pane run w1:p9 ${turn}`);
    expect(calls).not.toContain(`pane send-text w1:p9 ${turn}`);
  });

  test("test: a claude-code worker dispatch on the herdr driver under the shipped interactive default reaches its adapter rather than timing out at the readiness window, proven with the readiness timeout left at its production value rather than shortened for the test", async () => {
    expect(DEFAULT_CONFIG.visibility.worker).toBe("interactive");
    expect(CLAUDE_INPUT_BOX.readinessTimeoutMs).toBe(30_000);

    const stub = makeHerdrStub();
    const adapterArgs = join(stub.root, "claude-args.txt");
    const prompt = join(stub.root, "prompt.md");
    const dispatch = join(stub.root, "T6-dispatch.sh");
    const fakeClaude = join(stub.root, "claude");
    writeFileSync(prompt, "Do the task.\n");
    writeFileSync(fakeClaude, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${adapterArgs}'\n`);
    chmodSync(fakeClaude, 0o755);
    writeFileSync(dispatch, brand.paneDispatchScript([
      `export PATH=${shq(stub.root)}:$PATH`,
      claudeCode.interactiveCommand!(prompt, "fable"),
    ]));

    const driver = driverFor(stub.bin);
    await driver.run(
      await workerSlot(driver, stub.cwd, "T6"),
      brand.paneDispatchCommand(dispatch),
    );

    expect(readFileSync(adapterArgs, "utf8")).toContain("fable");
    const calls = readFileSync(stub.log, "utf8");
    expect(calls).toContain("pane run w1:p9");
    expect(calls).not.toContain("pane read w1:p9");
  });

  test("test: the classification is decided by the fact the daemon recorded when it built the command, not by matching the command string, proven by a fixture whose bytes match no known launch prefix yet is still classified as a launch", async () => {
    const stub = makeHerdrStub();
    const driver = driverFor(stub.bin);
    const unknownWrapper = "future-wrapper-v99 --opaque launch.payload";

    await driver.run(
      await workerSlot(driver, stub.cwd, "T7"),
      recordedLaunch(unknownWrapper),
    );

    const calls = readFileSync(stub.log, "utf8");
    expect(calls).toContain("pane run w1:p9");
    expect(calls).not.toContain("pane read w1:p9");
    expect(CLAUDE_INPUT_BOX.launchCommand?.(unknownWrapper)).not.toBe(true);
  });
});
