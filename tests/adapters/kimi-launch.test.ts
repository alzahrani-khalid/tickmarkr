import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { kimi, KIMI_INPUT_BOX, runKimiInteractiveSeed } from "../../src/adapters/kimi.js";
import type { Assignment } from "../../src/adapters/types.js";
import { HerdrDriver } from "../../src/drivers/herdr.js";
import type { ExecutorDriver, Slot } from "../../src/drivers/types.js";

const RECORDED_HELP = readFileSync(join(import.meta.dirname, "../fixtures/kimi/help-2.2.0.txt"), "utf8");
const WITHOUT_AUTO = RECORDED_HELP.replace(/^  --auto[^\n]*\n                                [^\n]*\n/m, "");
const MODEL = "kimi-code/k3";
const ASSIGNMENT: Assignment = { adapter: "kimi", model: MODEL, channel: "sub", tier: "frontier" };
const SEED_LINE = "Read /tmp/prompt.md and do exactly what it says.";
const priorPath = process.env.PATH;
const priorWorkspace = process.env.HERDR_WORKSPACE_ID;
const roots: string[] = [];

afterEach(() => {
  if (priorPath === undefined) delete process.env.PATH;
  else process.env.PATH = priorPath;
  if (priorWorkspace === undefined) delete process.env.HERDR_WORKSPACE_ID;
  else process.env.HERDR_WORKSPACE_ID = priorWorkspace;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeKimi() {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-kimi-launch-"));
  roots.push(root);
  const help = join(root, "help.txt");
  const calls = join(root, "kimi-calls.txt");
  const bin = join(root, "kimi");
  writeFileSync(help, RECORDED_HELP);
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n/bin/cat '${help}'\n`);
  chmodSync(bin, 0o755);
  process.env.PATH = root;
  return { root, help, calls, bin };
}

function seedDriver() {
  const commands: string[] = [];
  const slot: Slot = { id: "p1", name: "T3-worker-kimi-a0", cwd: "/tmp" };
  const banner = "Model: k3\nSend /help for help information.\n";
  const driver: Pick<ExecutorDriver, "run" | "waitOutput" | "read"> = {
    run: async (_slot, command) => { commands.push(command); },
    waitOutput: async () => true,
    read: async () => banner,
  };
  return { commands, slot, driver };
}

describe("kimi TUI permission launch", () => {
  test("test: a kimi worker's seed dispatch over a PATH kimi whose help is the recorded kimi 2.2.0 text sends the launch with the auto flag and the assigned model as its first command, and three consecutive launches through one PATH kimi whose help is switched from that text to one without the auto row and back each run that help and launch with the auto, the yolo and the auto flag, so a launch that keeps the yolo flag on kimi 2.2.0 or caches the help fails", async () => {
    const fake = fakeKimi();
    expect(WITHOUT_AUTO).not.toBe(RECORDED_HELP);
    const flags = ["--auto", "-y", "--auto"];
    for (const [index, flag] of flags.entries()) {
      writeFileSync(fake.help, index === 1 ? WITHOUT_AUTO : RECORDED_HELP);
      const { commands, slot, driver } = seedDriver();
      const result = await runKimiInteractiveSeed({ driver, slot, assignment: ASSIGNMENT, promptFile: "/tmp/prompt.md", taskTimeoutMinutes: 0.1 });
      expect(result.seedFailed).toBe(false);
      expect(commands).toEqual([`kimi ${flag} -m '${MODEL}'`, SEED_LINE]);
      expect(KIMI_INPUT_BOX.launchCommand?.(commands[0])).toBe(true);
      expect(readFileSync(fake.calls, "utf8").trim().split("\n")).toEqual(Array(index + 1).fill("--help"));
    }
  });

  test("test: the seed launch keeps the yolo flag over a help without the auto option row, over a help naming the auto flag or Never Ask mode only in a continuation row, a command row or another flag's row, and over an auto row describing another mode, so a launch that picks the auto flag from any mention of it fails", () => {
    const fake = fakeKimi();
    const continuation = WITHOUT_AUTO.replace(
      "                                automatically; risky actions, questions, and plans still ask.",
      "                                --auto Start in Never Ask mode",
    );
    const command = WITHOUT_AUTO.replace("Commands:\n", "Commands:\n  --auto                        Start in Never Ask mode\n");
    const otherFlag = WITHOUT_AUTO.replace("  -m, --model", "  --autosave                    Start in Never Ask mode\n  -m, --model");
    const otherMode = RECORDED_HELP.replace("Start in Never Ask mode", "Start in Review First mode");
    for (const help of [WITHOUT_AUTO, continuation, command, otherFlag, otherMode]) {
      writeFileSync(fake.help, help);
      expect(kimi.interactiveSeed!.launch(MODEL)).toBe(`kimi -y -m '${MODEL}'`);
    }
    expect(readFileSync(fake.calls, "utf8").trim().split("\n")).toEqual(Array(5).fill("--help"));
  });

  test("test: the seed launch keeps the yolo flag when kimi is absent from PATH, exits nonzero after printing the recorded help, prints nothing or outlives the help bound, and returns within that bound, so a launch that guesses Never Ask or waits on a hung kimi fails", () => {
    const fake = fakeKimi();
    rmSync(fake.bin);
    expect(kimi.interactiveSeed!.launch(MODEL)).toBe(`kimi -y -m '${MODEL}'`);
    writeFileSync(fake.bin, `#!/bin/sh\n/bin/cat '${fake.help}'\nexit 7\n`);
    chmodSync(fake.bin, 0o755);
    expect(kimi.interactiveSeed!.launch(MODEL)).toBe(`kimi -y -m '${MODEL}'`);
    writeFileSync(fake.bin, "#!/bin/sh\nexit 0\n");
    expect(kimi.interactiveSeed!.launch(MODEL)).toBe(`kimi -y -m '${MODEL}'`);
    writeFileSync(fake.bin, "#!/bin/sh\nexec /bin/sleep 30\n");
    const started = Date.now();
    expect(kimi.interactiveSeed!.launch(MODEL)).toBe(`kimi -y -m '${MODEL}'`);
    expect(Date.now() - started).toBeLessThan(12_000);
  }, 15_000);

  test("test: the real herdr driver, over a recording herdr executable and a kimi worker slot given no recorded launch fact, runs each launch the kimi seed builds, with either flag, as a pane command and types the seed line into the kimi input box, so a Never Ask launch the driver would type into a running interface fails", async () => {
    const fake = fakeKimi();
    process.env.PATH = `${fake.root}:/bin:/usr/bin`;
    const herdr = join(fake.root, "herdr");
    const log = join(fake.root, "herdr-calls.txt");
    const pane = join(fake.root, "pane.txt");
    const slotName = "T3-worker-kimi-a0-launch";
    const empty = "Model: k3\nSend /help for help information.\n╭──────────╮\n│ >        │\n╰──────────╯\n";
    writeFileSync(pane, empty);
    writeFileSync(herdr, `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1 $2" in
  "tab create") printf '{"result":{"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p9"}}}\\n' ;;
  "pane list") printf '{"result":{"panes":[{"pane_id":"w1:p9","label":"${slotName}","tab_id":"w1:t1","workspace_id":"wTEST"}]}}\\n' ;;
  "pane run") /bin/bash -c "$4" >/dev/null 2>&1 || :; printf '{}\\n' ;;
  "pane read") /bin/cat '${pane}' ;;
  "pane send-text") printf 'Model: k3\\nSend /help for help information.\\n╭──────────╮\\n│ > %s │\\n╰──────────╯\\n' "$4" > '${pane}'; printf '{}\\n' ;;
  "pane send-keys") printf 'Model: k3\\nSend /help for help information.\\n╭──────────╮\\n│ >        │\\n╰──────────╯\\n' > '${pane}'; printf '{}\\n' ;;
  *) printf '{}\\n' ;;
esac
`);
    chmodSync(herdr, 0o755);
    process.env.HERDR_WORKSPACE_ID = "wTEST";
    for (const [help, flag] of [[RECORDED_HELP, "--auto"], [WITHOUT_AUTO, "-y"]] as const) {
      writeFileSync(fake.help, help);
      const driver = new HerdrDriver(herdr);
      const slot = await driver.slot(fake.root, slotName);
      const before = readFileSync(log, "utf8").split("\n").length;
      const result = await runKimiInteractiveSeed({ driver, slot, assignment: ASSIGNMENT, promptFile: "/tmp/prompt.md", taskTimeoutMinutes: 0.1 });
      expect(result.seedFailed).toBe(false);
      const calls = readFileSync(log, "utf8").split("\n").slice(before - 1);
      expect(calls.some((line) => line.startsWith("pane run w1:p9 printf") && line.includes(`kimi ${flag} -m`))).toBe(true);
      expect(calls).toContain(`pane send-text w1:p9 ${SEED_LINE}`);
      expect(calls).toContain("pane send-keys w1:p9 Enter");
      expect(calls.some((line) => line.startsWith("pane send-text w1:p9 kimi "))).toBe(false);
      expect(calls.some((line) => line.startsWith("pane run w1:p9 printf") && line.includes(SEED_LINE))).toBe(false);
    }
  });
});
