import { isolatedBuild } from "../fixtures/screen-soak/isolated-build.js";
// VIS-10: every pane-establishing dispatch must seed and seal the new shell before its first launch.
// Parse call structure instead of searching an arbitrary character window after the create call: text
// proximity cannot prove ordering and passed when an unsealed command preceded a nearby seal.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test, vi } from "vitest";

const src = readFileSync(fileURLToPath(new URL("../../src/drivers/herdr.ts", import.meta.url)), "utf8");

interface PlacementDispatch { create: string; firstLaunch?: string }

function placementDispatches(source: string): PlacementDispatch[] {
  const file = ts.createSourceFile("herdr.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const dispatches: PlacementDispatch[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.body) {
      const commands: Array<{ at: number; text: string }> = [];
      const collect = (child: ts.Node): void => {
        if (ts.isCallExpression(child)
            && ts.isPropertyAccessExpression(child.expression)
            && child.expression.expression.kind === ts.SyntaxKind.ThisKeyword
            && child.expression.name.text === "herdr"
            && child.arguments[0]) {
          commands.push({ at: child.getStart(file), text: child.arguments[0].getText(file) });
        }
        ts.forEachChild(child, collect);
      };
      collect(node.body);
      for (const command of commands.filter(({ text }) => /`(?:tab create|pane split)\b/.test(text))) {
        dispatches.push({
          create: command.text,
          firstLaunch: commands.find(({ at, text }) => at > command.at && /`pane run\b/.test(text))?.text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return dispatches;
}

const sealedBeforeLaunch = (source: string): boolean => {
  const dispatches = placementDispatches(source);
  return dispatches.length > 0 && dispatches.every(({ create, firstLaunch }) =>
    (!/`tab create\b/.test(create) || /--workspace\b/.test(create))
    && firstLaunch !== undefined
    && /HERDR_WORKSPACE_ID[\s\S]*herdrSealShellPrefix\(\)/.test(firstLaunch));
};

describe("driver placement audit (VIS-10 structural guarantee)", () => {
  test("test: the placement audit asserts the sealed-launch property from the parsed dispatch structure so a launch whose seal follows the command within the old character window still fails the audit whereas the shipped window grep passes it", () => {
    expect(sealedBeforeLaunch(src)).toBe(true);

    const broken = `class Driver {
      async slot(pane: string, cmd: string) {
        await this.herdr(\`pane split \${pane}\`);
        await this.herdr(\`pane run \${pane} \${cmd}\`);
        await this.herdr(\`pane run \${pane} export HERDR_WORKSPACE_ID=x; \${herdrSealShellPrefix()}\`);
        return pane;
      }
    }`;
    const createAt = broken.indexOf("pane split");
    expect(broken.slice(createAt, createAt + 2_500)).toMatch(/HERDR_WORKSPACE_ID/); // old audit passes
    expect(sealedBeforeLaunch(broken)).toBe(false); // parsed first launch is still unsealed
  });
});


import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { boardHost, type HostPane } from "../fixtures/screen-soak/board-host.js";
import { root } from "../fixtures/screen-soak/test-support.js";
import { makeRepo, setupRepo, T } from "../helpers/tmprepo.js";
import { runLiveCockpit } from "../../src/tui/cockpit/live.js";
import type { ShellDelivery } from "../../src/tui/cockpit/live-runtime.js";
import { formatOwnedName, type Slot, type FocusTarget } from "../../src/drivers/types.js";
import { HerdrDriver, tabLabelFor } from "../../src/drivers/herdr.js";
import { OrcaDriver } from "../../src/drivers/orca.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import { FakeOrca, steppedTime } from "../helpers/fake-orca.js";
import { ev, rawOf } from "../fixtures/operator-state/fixture.js";

const readEvidence = (path: string | undefined): string => {
  if (!path) return "(no log)";
  try { return readFileSync(path, "utf8").trimEnd() || "(empty)"; } catch { return "(absent)"; }
};
/** A Node board's stdout never reaches the pane log: tty-bootstrap captures it as the pane's screen frame. */
const readScreen = (path: string | undefined): string => {
  if (!path) return "(no frame)";
  try { return (JSON.parse(readFileSync(path, "utf8")) as { frame: string }).frame.trimEnd() || "(empty)"; } catch { return "(absent)"; }
};

/** The fake board's own stdout/stderr, pane by pane, then its owner record and the stop/ack messages under that owner's token. */
function keptBoardEvidence(host: ReturnType<typeof boardHost>, repo: string, runId: string): string {
  const supervision = join(repo, ".tickmarkr", "supervision");
  const owner = readEvidence(join(supervision, `watch-board.${runId}.json`));
  let token = "unknown";
  try { token = (JSON.parse(owner) as { token: string }).token; } catch { /* the owner line above says why */ }
  return [
    ...(host.read().panes as Array<HostPane & { log?: string }>).map(pane =>
      `pane ${pane.pane_id} screen stdout:\n${readScreen(pane.frame)}\npane ${pane.pane_id} stdout/stderr:\n${readEvidence(pane.log)}`),
    `owner: ${owner}`,
    `stop: ${readEvidence(join(supervision, `watch-board.${token}.stop`))}`,
    `ack: ${readEvidence(join(supervision, `watch-board.${token}.ack`))}`,
  ].join("\n");
}

/** C-16 (D-697) tolerance, kept: an unacknowledged kept-board close prints the board's pane log and owner stop/ack
 *  evidence so the next occurrence carries its own diagnosis (root cause queued for v2.6.4). Any other close error fails. */
async function closeKeptBoard(close: Promise<void>, host: ReturnType<typeof boardHost>, repo: string, runId: string): Promise<void> {
  try { await close; } catch (error) {
    if (!String(error).includes("watch cleanup unacknowledged")) throw error;
    console.warn(`tolerated unacknowledged kept-board close: ${String(error)}\n${keptBoardEvidence(host, repo, runId)}`);
  }
}

test("test: placement-audit prints the fake board stdout/stderr pane log plus owner stop/ack evidence for its tolerated unacknowledged close whereas a different close error still fails", async () => {
  const host = boardHost();
  const repo = makeRepo({ "base.txt": "kept board evidence" });
  const runId = "run-keep-evidence";
  const printed = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    // A board that exits without ever acknowledging: its streams are all that can explain it. A real Node process
    // runs through tty-bootstrap, so its stdout lands in the screen frame while stderr and shell output land in the log.
    const node = `node -e 'process.stdout.write("kept-board-stdout\\n"); process.stderr.write("kept-board-stderr\\n")'`;
    const board = await host.driver().narrator(repo, `echo kept-board-shell; ${node}`, runId);
    const [pane] = host.read().panes as Array<HostPane & { log?: string }>;
    await expect.poll(() => readEvidence(pane?.log), { timeout: 5000 }).toContain("kept-board-stderr");
    await expect.poll(() => readScreen(pane?.frame), { timeout: 5000 }).toBe("kept-board-stdout");
    expect(readEvidence(pane?.log)).not.toContain("kept-board-stdout");
    // A stepped clock spends the acknowledgement window at once; ownership still comes from the owner record on disk.
    const closer = new HerdrDriver(join(root, "tests/fixtures/screen-soak/fake-herdr.mjs"), 3, steppedTime());
    await closeKeptBoard(closer.close(board), host, repo, runId);
    expect(printed).toHaveBeenCalledTimes(1);
    const text = String(printed.mock.calls[0]![0]);
    const token = (JSON.parse(readFileSync(join(repo, ".tickmarkr", "supervision", `watch-board.${runId}.json`), "utf8")) as { token: string }).token;
    expect(text).toContain(`watch cleanup unacknowledged for ${board.name}`);
    expect(text).toContain(`pane ${board.id} screen stdout:\nkept-board-stdout\npane ${board.id} stdout/stderr:\n`);
    expect(text.split(`pane ${board.id} stdout/stderr:\n`)[1]).toContain("kept-board-shell\nkept-board-stderr\nowner: ");
    expect(text).toContain(`owner: {"repo":`);
    expect(text).toContain(`stop: {"token":"${token}"}`);
    expect(text).toContain("ack: (absent)");
    expect(host.read().panes.map(p => p.pane_id)).toEqual([board.id]); // the unacknowledged board stays protected
    host.write({ ...host.read(), panes: [] });
    await expect(closeKeptBoard(closer.close(board), host, repo, runId)).rejects.toThrow(/closed without presence acknowledgement/);
    expect(printed).toHaveBeenCalledTimes(1);
  } finally { printed.mockRestore(); host.dispose(); }
});

test("Run’s o action reaches the new driver focus capability using recorded run/task/attempt ownership and verifies the actual target before focus. Fake Herdr/Orca fixtures distinguish matching, foreign, closed and unsupported panes without title-text guesses, and daemon source commands preserve grouping, right/no-focus launch, canonical names, titles at most 20 characters and keepPanes forever. A selected task focusing a same-title foreign pane or a placement failure advertised as an opened board fails.", async () => {
  const host = boardHost();
  const repo = makeRepo({ "base.txt": "focus fixture" });
  const runId = "run-focus";
  const name = formatOwnedName({ role: "worker", taskId: "T1", attempt: 3, runId });
  const slot = { id: "wC6:pTASK", name, cwd: repo, tabId: "wC6:tTASK" };
  const pane = { pane_id: slot.id, label: name, workspace_id: "wC6", cwd: repo, tab_id: slot.tabId };
  const dir = join(repo, ".tickmarkr", "runs", runId); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "journal.jsonl"), rawOf([
    ev("run-start"), ev("task-dispatch", { attempt: 3, worktree: repo }, "T1"),
    ev("worker-launch", { attempt: 3, slot, driver: "herdr", workspace: "wC6" }, "T1"),
  ]));
  const driver = host.driver();
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode: (value: boolean) => unknown; ref: () => unknown; unref: () => unknown };
  input.isTTY = true; input.isRaw = false; input.setRawMode = value => { input.isRaw = value; return input; }; input.ref = () => input; input.unref = () => input;
  let frame = "", delivery: ShellDelivery | undefined;
  const output = new Writable({ write(chunk, _encoding, done) { frame = (frame + chunk.toString()).slice(-20000); done(); } }) as Writable & { isTTY: boolean; columns: number; rows: number };
  output.isTTY = true; output.columns = 120; output.rows = 40;
  const focused: FocusTarget[] = [];
  const options = { input: input as unknown as NodeJS.ReadStream, output: output as unknown as NodeJS.WriteStream, cwd: repo, runId, binaryVersion: "fixture",
    initialView: "run" as const, onDelivery: (value: ShellDelivery) => { delivery = value; },
    focusDriver: async (target: FocusTarget, selectedDriver: string) => { expect(selectedDriver).toBe("herdr"); focused.push(target); return driver.focus(target); },
  };
  const mounted = runLiveCockpit(options);
  try {
    await expect.poll(() => frame, { timeout: 5000 }).toContain("RUN / RUNNING");
    for (const [mode, panes, unsupportedFocus] of [
      ["focused", [pane], false],
      ["foreign", [{ ...pane, label: formatOwnedName({ role: "worker", taskId: "T1", attempt: 3, runId: "run-foreign" }) }], false],
      ["closed", [], false],
      ["unsupported", [pane], true],
    ] as const) {
      host.write({ ...host.read(), panes: [...panes], focused: undefined, unsupportedFocus });
      frame = ""; input.write("o");
      await expect.poll(() => frame, { timeout: 5000 }).toContain(mode === "focused" ? "Focused T1" : `Pane ${mode}`);
      expect(host.read().focused).toBe(mode === "focused" ? slot.id : undefined);
      delivery!.key({ input: "", key: { escape: true } });
    }
    expect(focused).toHaveLength(4);
    for (const target of focused) expect(target).toEqual({ repo, runId, taskId: "T1", attempt: 3, slot, workspace: "wC6" });
    expect(host.calls().filter(args => args[1] === "focus")).toHaveLength(2); // matching plus host-unsupported only
    for (const role of ["worker", "judge", "review", "consult"] as const) expect([...tabLabelFor(formatOwnedName({ role, taskId: "T" + "9".repeat(64), attempt: 999, runId }))].length).toBeLessThanOrEqual(20);
    host.write({ ...host.read(), panes: [], failSplit: true });
    await expect(driver.narrator(repo, "true", "run-placement-fail")).rejects.toThrow(/split failed/);
    expect(host.read().panes).toEqual([]);
  } finally {
    input.write("q"); await mounted; input.destroy(); output.destroy(); host.dispose();
  }
  for (const [worktree, status, expected] of [[repo, "running", "unsupported"], [repo + "-foreign", "running", "foreign"], [repo, "exited", "closed"]]) {
    const fake = new FakeOrca({ terminals: [{ handle: "term-focus", title: name, paneTitle: "same short title", worktree, status }] });
    const orca = new OrcaDriver({ exec: fake.exec, time: steppedTime() });
    expect((await orca.focus({ repo, runId, taskId: "T1", attempt: 3, slot })).status).toBe(expected);
    expect(fake.countOf("create")).toBe(0); expect(fake.countOf("send")).toBe(0); expect(fake.countOf("close")).toBe(0);
  }
  const preservation = boardHost();
  let board: Slot | undefined;
  try {
    const { repo: keptRepo, fake } = setupRepo([T("T1", { humanGate: true })], {}, "visibility: { keepPanes: forever }\n");
    const herdr = preservation.driver();
    class KeptBoard extends SubprocessDriver {
      async narrator(cwd: string, command: string, id?: string) { board = await herdr.narrator(cwd, command, id); return board; }
      override close(value: Slot) { return value.name.includes(":watch:") ? herdr.close(value) : super.close(value); }
    }
    const { runDaemon } = await import(join(isolatedBuild(), "dist/run/daemon.js"));
    await runDaemon(keptRepo, { adapters: [fake], driver: new KeptBoard(), runId: "run-keep-forever" });
    expect(board).toBeDefined();
    expect(preservation.read().panes).toHaveLength(1);
    expect(preservation.calls().filter(args => args[1] === "close")).toEqual([]);
    // Test-owned teardown after proving the forever contract. C-16 (D-697): on public macOS CI the kept board
    // sometimes never acknowledges the stop, even given 20 s, so close fails closed and protects the pane; that
    // is not this case's subject. The tolerated close prints the board's evidence; any other close error still fails.
    await closeKeptBoard(herdr.close(board!), preservation, keptRepo, "run-keep-forever");
  } finally { preservation.dispose(); }
  expect((await new SubprocessDriver().focus()).status).toBe("unsupported");
}, 30000);
