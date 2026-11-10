// Queue rows 353 and 367 R3 (D-2187 condition 2): every render cell reads a doctor cache built by the real
// doctor probe loop from the committed captured fixtures; only the runner seam (sh) is injected.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { stringify } from "yaml";
import * as registry from "../../src/adapters/registry.js";
import { channelsFromConfig, type WorkerAdapter } from "../../src/adapters/types.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { assembleFleetEditor, fleet, type FleetIO } from "../../src/cli/commands/fleet.js";
import { loadConfig } from "../../src/config/config.js";
import { modelMark, openStagedDeny, runFleetInkEditor } from "../../src/tui/ink/fleet-app.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

const FIXTURES = join(__dirname, "..", "fixtures", "probe-failures", "2026-11-08");
const read = (cell: string, stream: string) => readFileSync(join(FIXTURES, `${cell}.${stream}`), "utf8");
const captured = (cell: string) => ({ code: Number(read(cell, "rc").trim()), stdout: read(cell, "stdout"), stderr: read(cell, "stderr") });
type Runner = { code: number; stdout: string; stderr: string; timedOut?: boolean };

// One adapter per captured cell, each with one configured model; the runner returns the captured facts.
const CELLS: Record<string, Runner> = {
  clap: captured("launch-fault-argv"),
  commander: captured("launch-fault-argv-claude"),
  slow: { ...captured("timeout-stdin-held"), timedOut: true },
  signedout: captured("signed-out-empty-home"),
  signedtimer: { ...captured("signed-out-empty-home"), timedOut: true },
};
const CLAP = "error: unexpected argument '--no-daemon' found";
const COMMANDER = "error: unknown option '--tickmarkr-no-such-flag'";
const TWICE = "probe timed out twice (60000ms)";

vi.mock("../../src/run/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/git.js")>();
  return {
    ...actual,
    sh: vi.fn((cmd: string, cwd: string, timeoutMs?: number) => {
      if (!cmd.startsWith("__PROBE_CELL__:")) return actual.sh(cmd, cwd, timeoutMs);
      return Promise.resolve(CELLS[cmd.slice("__PROBE_CELL__:".length)]);
    }),
  };
});

const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY);
  else delete (process.stderr as { isTTY?: boolean }).isTTY;
});

async function world() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(registry, "detectCandidateClis").mockReturnValue([]);
  vi.spyOn(registry, "resolveShellBinary").mockReturnValue({ all: [] });
  vi.stubEnv("NO_COLOR", "1");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: false });
  const repo = makeRepo({ "keep.txt": "x\n" });
  const globalDir = makeTestTempDir("probe-failure-render-");
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), stringify({
    tiers: Object.fromEntries(Object.keys(CELLS).map((id) => [id, { vendor: id, channel: "sub", models: { m: "mid" } }])),
  }));
  const adapters: WorkerAdapter[] = Object.keys(CELLS).map((id) => ({
    id, vendor: id,
    probe: async () => ({ installed: true, authed: true, models: [] }),
    channels: (cfg) => channelsFromConfig(id, cfg),
    headlessCommand: () => `__PROBE_CELL__:${id}`,
    interactiveCommand: () => null,
    trustDialog: { kind: "none", reason: "fixture has no trust dialog" },
    invoke: () => ({ command: "unused" }),
    parse: () => ({ ok: false, summary: "unused", deviations: [], raw: "" }),
  }) as WorkerAdapter);
  // The doctor cache is built by the production probe loop from the captured runner facts.
  const doctorOut = strip(await doctor([], repo, adapters, { banner: false, globalDir }));
  const reused = registry.initDoctorReuse(repo, false, loadConfig(repo, { globalDir }));
  expect(reused.reuse).toBe(true);
  const initOut = registry.formatDoctorReport(repo, loadConfig(repo, { globalDir }), reused.health!, adapters, { wrote: false });
  const whyOut = await fleet(["--print", "--why", "--global-dir", globalDir], repo, adapters) as string;
  return { repo, globalDir, adapters, doctorOut, initOut, whyOut };
}

/** The real fleet editor over the doctor cache; `pane(id)` moves the rail cursor to that adapter's models. */
async function editor(w: Awaited<ReturnType<typeof world>>) {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean; setRawMode: () => void; ref: () => typeof input; unref: () => typeof input;
  };
  input.isTTY = true;
  input.setRawMode = () => {};
  input.ref = input.unref = () => input;
  const writes: string[] = [];
  const output = {
    isTTY: true, columns: 320, rows: 60,
    write(chunk: string) { writes.push(strip(chunk)); return true; },
    on() { return output; }, off() { return output; }, removeListener() { return output; },
  } as unknown as NodeJS.WriteStream;
  const assembled = await assembleFleetEditor(w.repo, w.adapters, { input, output, debug: true } as FleetIO, { globalDir: w.globalDir });
  if ("unavailable" in assembled) throw new Error(assembled.unavailable);
  const done = runFleetInkEditor(assembled.props);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    input.write("\x03");
    await done;
    input.destroy();
  };
  onTestFinished(close);
  const settle = async () => {
    for (let idle = 0, turns = 0; idle < 5 && turns < 500; turns++) {
      const count = writes.length;
      await new Promise((resolve) => setTimeout(resolve, 2));
      idle = count === writes.length ? idle + 1 : 0;
    }
  };
  const key = async (bytes: string) => {
    for (const token of bytes.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? []) {
      input.write(token);
      await settle();
    }
  };
  await settle();
  const ids = assembled.props.modelGroups.map((group) => group.adapter);
  const frame = async (bytes: string) => {
    await key(bytes);
    return writes.findLast((text) => text.includes("tickmarkr fleet")) ?? "";
  };
  // rail rows: All models, Shapes, Steering, then one per adapter group
  const pane = (id: string) => frame(LEFT + "\x1b[A".repeat(ids.length + 3) + DOWN.repeat(3 + ids.indexOf(id)));
  return {
    row: (id: string) => assembled.props.modelGroups.find((group) => group.adapter === id)!.rows[0]!,
    /** The shape picker's greyed ledger line for the adapter's model — the footer detail on that picker row. */
    ledger: (id: string) => (assembled.props.candidatesForShape("implement", assembled.props.initialMode, assembled.props.initialMap,
      openStagedDeny()).ledger ?? []).find((line) => line.startsWith(`${id}/m `)) ?? "",
    pane,
    /** Space on the row, then each reach outcome whose notice replaces the footer detail: the refused
     *  admission (in), a successful exclusion (out · all seats) and the unchanged reach (out · all seats again). */
    async reach(id: string) {
      await pane(id);
      const space = await frame(RIGHT + " ");
      const refused = await frame("\r");
      const excluded = await frame(" " + DOWN + DOWN + "\r");
      const unchanged = await frame(" " + DOWN + DOWN + "\r");
      return { space, refused, excluded, unchanged };
    },
    close,
  };
}

const modelLine = (out: string, id: string) => {
  const lines = out.split("\n");
  const start = lines.indexOf(`  ${id}`);
  expect(start, `${id} section in:\n${out}`).toBeGreaterThan(-1);
  return lines[start + 1] ?? "";
};

type ReachNotices = { space: string; refused: string; excluded: string; unchanged: string };
// Rows 353 and 367 R3: the four reach-action notices replace the footer detail, so each names the failed class.
function expectReachNotices(n: ReachNotices, says: string, already: string) {
  const id = says.slice(0, says.indexOf(" "));
  expect(n.space).toContain(`${says} — out only; re-probe with tickmarkr doctor before setting in`);
  expect(n.refused).toContain(`${says} — cannot set in; re-probe with tickmarkr doctor`);
  expect(n.excluded).toContain(`${says} — set out · all seats; re-probe with tickmarkr doctor before setting in`);
  expect(n.unchanged).toContain(`${id} is already out · all seats${already}`);
}
// ...while the captured signed-out row keeps the base's sign-out wording in all four (its long 401 tail clips the rest).
function expectSignedOutNotices(n: ReachNotices) {
  expect(n.space).toContain("signedout:m is unauthed (");
  expect(n.refused).toContain("signedout:m is unauthed (");
  expect(n.excluded).toContain("signedout:m is unauthed (");
  expect(n.unchanged).toContain("signedout:m is already out · all seats — unauthed (");
  for (const shown of Object.values(n)) expect(shown).not.toMatch(/launch fault|timed out \(/i);
}

test("doctor and the fleet editor render a launch fault distinct from signed out with its reason in the footer", async () => {
  const w = await world();
  const cache = registry.readDoctor(w.repo)!;
  expect(cache.clap.modelAuth!.m).toMatchObject({ authed: false, failure: "launch-fault", reason: CLAP });
  expect(cache.commander.modelAuth!.m).toMatchObject({ authed: false, failure: "launch-fault", reason: COMMANDER });
  expect(cache.signedout.modelAuth!.m.failure).toBeUndefined();
  // Both launch faults keep every adapter signed in and the channel unroutable.
  for (const id of ["clap", "commander"]) {
    expect(cache[id].authed).toBe(true);
    expect(registry.discoverChannels(loadConfig(w.repo, { globalDir: w.globalDir }), w.adapters, cache)
      .some((c) => c.adapter === id)).toBe(false);
  }

  for (const out of [w.doctorOut, w.initOut]) {
    // The model row says launch fault (the 40-column cell truncates the line), never unauthed.
    expect(modelLine(out, "clap")).toMatch(/^\s+m\s+mid\s.*launch fault: error: unexpected argument/);
    expect(modelLine(out, "commander")).toMatch(/^\s+m\s+mid\s.*launch fault: error: unknown option/);
    for (const id of ["clap", "commander"]) expect(modelLine(out, id)).not.toContain("unauthed");
    expect(modelLine(out, "signedout")).toMatch(/^\s+m\s+mid\s.*unauthed: /);
    // The footer names the FULL rejected line, once per launch-faulted adapter, and no other adapter.
    const footers = out.split("\n").filter((line) => line.includes("rejected tickmarkr's own launch argument"));
    expect(footers).toHaveLength(2);
    expect(footers[0]).toContain(`launch fault: clap rejected tickmarkr's own launch argument — ${CLAP} — this is not a sign-out`);
    expect(footers[1]).toContain(`launch fault: commander rejected tickmarkr's own launch argument — ${COMMANDER} — this is not a sign-out`);
  }
  // fleet --print --why member reasons say launch fault, the signed-out member still says unauthed.
  expect(w.whyOut).toContain(`clap:m: skipped — launch fault (${CLAP})`);
  expect(w.whyOut).toContain(`commander:m: skipped — launch fault (${COMMANDER})`);
  expect(w.whyOut).toMatch(/signedout:m: skipped — unauthed \(.*401 Unauthorized/);

  const s = await editor(w);
  for (const [id, line] of [["clap", CLAP], ["commander", COMMANDER]] as const) {
    expect(s.row(id).evidence).toMatchObject({ unauthed: line, failure: "launch-fault" });
    expect(modelMark({ ...s.row(id), reach: "in" })).toBe("warn");
    const frame = await s.pane(id);
    expect(frame).toMatch(new RegExp(`! ${id}/m\\s`));
    expect(frame).toContain(`LAUNCH FAULT — ${line}`);
    expect(frame).toContain(`${id}:m · mid · LAUNCH FAULT — ${line} · launch fault — error:`);
    expect(frame).not.toMatch(/unauthed/i);
    // Every reach notice that replaces the footer detail names the launch fault, never a sign-out.
    const notices = await s.reach(id);
    expectReachNotices(notices, `${id}:m — launch fault (${line})`, ` — launch fault (${line})`);
    for (const shown of Object.values(notices)) expect(shown).not.toMatch(/unauthed/i);
    expect(s.ledger(id)).toContain(`launch fault (${line}) — re-probe with tickmarkr doctor`);
    expect(s.ledger(id)).not.toContain("unauthed");
  }
  expect(modelMark({ ...s.row("signedout"), reach: "in" })).toBe("fail");
  const signedOut = await s.pane("signedout");
  expect(signedOut).toMatch(/✗ signedout\/m\s/);
  expect(signedOut).toContain("UNAUTHED — ");
  expect(signedOut).not.toContain("LAUNCH FAULT");
  expectSignedOutNotices(await s.reach("signedout"));
  expect(s.ledger("signedout")).toMatch(/ unauthed \(.*401 Unauthorized.*\) — re-probe with tickmarkr doctor$/);
  await s.close();
});

test("a timed out probe renders as a timeout while the captured signed out cli still renders signed out", async () => {
  const w = await world();
  const cache = registry.readDoctor(w.repo)!;
  // The runner's timer kill is a timeout even over the captured signed-out text.
  for (const id of ["slow", "signedtimer"]) {
    expect(cache[id].modelAuth!.m).toMatchObject({ authed: false, failure: "timeout", reason: TWICE });
    expect(cache[id].authed).toBe(true);
  }
  expect(cache.signedout.modelAuth!.m).toMatchObject({ authed: false });
  expect(cache.signedout.modelAuth!.m.reason).toContain("401 Unauthorized");

  for (const out of [w.doctorOut, w.initOut]) {
    for (const id of ["slow", "signedtimer"]) {
      expect(modelLine(out, id)).toMatch(new RegExp(`^\\s+m\\s+mid\\s.*timed out: ${TWICE.replace(/[()]/g, "\\$&")}`));
      expect(modelLine(out, id)).not.toContain("unauthed");
    }
    expect(modelLine(out, "signedout")).toMatch(/^\s+m\s+mid\s.*unauthed: /);
    expect(modelLine(out, "signedout")).not.toContain("timed out:");
  }
  expect(w.whyOut).toContain(`slow:m: skipped — timed out (${TWICE})`);
  expect(w.whyOut).toContain(`signedtimer:m: skipped — timed out (${TWICE})`);
  expect(w.whyOut).toMatch(/signedout:m: skipped — unauthed \(.*401 Unauthorized/);

  const s = await editor(w);
  for (const id of ["slow", "signedtimer"]) {
    expect(modelMark({ ...s.row(id), reach: "in" })).toBe("warn");
    const frame = await s.pane(id);
    expect(frame).toMatch(new RegExp(`! ${id}/m\\s`));
    expect(frame).toContain(`TIMED OUT — ${TWICE}`);
    expect(frame).toContain(`${id}:m · mid · TIMED OUT — ${TWICE} · timed out — ${TWICE} — Space sets out only`);
    expect(frame).not.toMatch(/unauthed/i);
    const notices = await s.reach(id);
    expectReachNotices(notices, `${id}:m — timed out (${TWICE})`, ` — timed out (${TWICE})`);
    for (const shown of Object.values(notices)) expect(shown).not.toMatch(/unauthed/i);
    expect(s.ledger(id)).toContain(`timed out (${TWICE}) — re-probe with tickmarkr doctor`);
    expect(s.ledger(id)).not.toContain("unauthed");
  }
  const signedOut = await s.pane("signedout");
  expect(signedOut).toMatch(/✗ signedout\/m\s/);
  expect(signedOut).toContain("UNAUTHED — ");
  expect(signedOut).not.toContain("TIMED OUT");
  expectSignedOutNotices(await s.reach("signedout"));
  expect(s.ledger("signedout")).toMatch(/ unauthed \(.*401 Unauthorized.*\) — re-probe with tickmarkr doctor$/);
  await s.close();
});
