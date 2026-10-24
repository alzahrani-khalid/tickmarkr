import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const SCRIPT = resolve("skills/tickmarkr-overseer/scripts/watch-artifacts.sh");
const live: ChildProcess[] = [];

afterEach(() => {
  for (const proc of live.splice(0)) if (proc.exitCode === null) proc.kill("SIGKILL");
});

test("test: watch-artifacts armed with --changed-from on an artifact that already carries its end marker does not fire until the file's content differs from the armed baseline and then fires once whereas the shipped watcher that fires instantly on the pre-existing marker fails", async () => {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-watch-artifact-"));
  const artifact = join(repo, "REPORT.md");
  const initial = "old finding\nREPORT-END\n";
  writeFileSync(artifact, initial);
  const baseline = createHash("sha1").update(initial).digest("hex");

  const proc = spawn("bash", [SCRIPT, "--changed-from", baseline, "REPORT-END", "8", "0.1", artifact], {
    cwd: repo,
    env: { ...process.env, TKR_ARMING_SEAT: "overseer" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.push(proc);
  let output = "";
  proc.stdout?.on("data", (chunk) => { output += String(chunk); });
  proc.stderr?.on("data", (chunk) => { output += String(chunk); });

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 450));
  expect(proc.exitCode).toBeNull();
  expect(output).not.toContain("WAKE:");

  appendFileSync(artifact, "revised evidence\nREPORT-END\n");
  await vi.waitFor(() => expect(proc.exitCode).toBe(0), { timeout: 5_000, interval: 50 });
  expect(output.match(/WAKE:/g)).toHaveLength(1);
  expect(output).toContain("artifact(s) complete");
});

// Queue row 240; D-2138 add.4: these executables are first on PATH; no live host is contacted.
type CloseFixtureOptions = {
  host?: "orca" | "herdr"; count?: number; marker?: boolean; stoodDown?: boolean;
  ledger?: boolean; liveTitle?: string; liveCheckout?: string; liveAddress?: string;
  refusal?: string; wrongReceipt?: boolean; keepTab?: boolean; nextMission?: string;
  stoodMission?: string; truncated?: boolean; sharedTab?: boolean;
};
function closeFixture(options: CloseFixtureOptions = {}) {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-close-artifact-"));
  const host = options.host ?? "orca", count = options.count ?? 1;
  const pids = join(repo, ".tickmarkr", "overseer", "pids");
  mkdirSync(pids, { recursive: true });
  const addresses = Array.from({ length: count }, (_, i) => host === "orca" ? `terminal:${i + 1}` : `w1:p${i + 1}`);
  const artifacts = addresses.map((_, i) => join(repo, `artifact-${i}.md`));
  const state = { host, seats: addresses.map((address, i) => ({
    address: options.liveAddress ?? address, title: options.liveTitle ?? (options.sharedTab ? "CONSULT pair" : `SEAT ${i}`), checkout: options.liveCheckout ?? repo,
    tab: options.sharedTab ? "tab-0" : `tab-${i}`, closed: false,
  })), ...options };
  writeFileSync(join(repo, "host-state.json"), JSON.stringify(state));
  for (const [i, address] of addresses.entries()) {
    writeFileSync(artifacts[i], options.marker === false ? "pending\n" : "delivered\nREPORT-END\n");
    if (options.ledger !== false) writeFileSync(join(pids, `seat-${i}.handle`),
      `host=${host}\naddress=${address}\ntitle=${options.sharedTab ? "CONSULT pair" : `SEAT ${i}`}\ncheckout=${repo}\nmission=current\ntab=${options.sharedTab ? "tab-0" : `tab-${i}`}\n${options.nextMission ? `next_mission=${options.nextMission}\n` : ""}`);
    if (options.stoodDown !== false) writeFileSync(join(pids, `seat-${i}.stood-down`), `mission=${options.stoodMission ?? "current"}\n`);
  }
  const executable = `#!/usr/bin/env node
const fs = require("fs");
const file = ${JSON.stringify(join(repo, "host-state.json"))};
const log = ${JSON.stringify(join(repo, "calls.jsonl"))};
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify(args) + "\\n");
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const envelope = result => ({ok:true, _meta:{runtimeId:"rt-1"}, result});
let response;
if (args[0] === "terminal" && args[1] === "list") response = envelope({
  truncated: !!state.truncated,
  terminals: state.seats.filter(s=>!s.closed).map(s=>({handle:s.address, worktreePath:s.checkout, tabId:s.tab})),
  visualLayouts: [{worktreePath: state.seats[0].checkout, root: {first:{tabs: [...new Set(state.seats.map(s=>s.tab))].map(id=>({id, seats:state.seats.filter(s=>s.tab===id)})).filter(t=>state.keepTab || t.seats.some(s=>!s.closed)).map(t=>({id:t.id,title:t.seats[0].title,panes:t.seats.filter(s=>!s.closed).map(s=>({type:"terminal",handle:s.address,title:"bash"}))}))}}}],
});
else if (args[0] === "terminal" && args[1] === "close") {
  const address = args[args.indexOf("--terminal")+1];
  const seat = state.seats.find(s=>s.address===address);
  if(seat) seat.closed = true;
  save();
  response = state.refusal ? {ok:false,_meta:{runtimeId:"rt-1"},error:{code:"runtime_error",message:state.refusal}} : envelope({close:{handle:state.wrongReceipt?"foreign-handle":address}});
} else if (args[0] === "terminal" && args[1] === "read") response = envelope({terminal:{status:"running"}});
else if (args[0] === "pane" && args[1] === "list") response = envelope({panes:state.seats.filter(s=>!s.closed).map(s=>({pane_id:s.address,label:s.title,cwd:s.checkout,tab_id:s.tab}))});
else if (args[0] === "pane" && args[1] === "close") {
  const seat = state.seats.find(s=>s.address===args[2]);
  if(seat) seat.closed=true;
  save(); response=envelope({closed:args[2]});
} else if (args[0] === "tab" && args[1] === "close") response=envelope({closed:args[2]});
else if (args[0] === "tab" && args[1] === "list") response=envelope({tabs:state.seats.filter(s=>!s.closed).map(s=>({tab_id:s.tab}))});
else { process.stderr.write("unexpected command"); process.exit(3); }
process.stdout.write(JSON.stringify(response));
if(response.ok===false) process.exitCode=1;
`;
  writeFileSync(join(repo, host), executable);
  chmodSync(join(repo, host), 0o755);
  const calls = (): string[][] => existsSync(join(repo, "calls.jsonl"))
    ? readFileSync(join(repo, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as string[]) : [];
  return { repo, host, pids, addresses, artifacts, calls };
}
async function runCloseFixture(f: ReturnType<typeof closeFixture>, env: Record<string, string> = {}, files = f.artifacts) {
  const proc = spawn("bash", [SCRIPT, "REPORT-END", env.CAP ?? "3", "0.03", ...files], {
    cwd: f.repo,
    env: { ...process.env, ORCA_TERMINAL_HANDLE: "launching-operator", HERDR_PANE_ID: "launching-operator",
      TKR_CLOSE_PANES: "", TKR_CLOSE_TERMINALS: "", TKR_WAKE_ON_ANY: "0", TKR_STATE_DIR: join(f.repo, ".tickmarkr"),
      TKR_ARMING_SEAT: "overseer", PATH: `${f.repo}:${process.env.PATH}`,
      [f.host === "orca" ? "TKR_CLOSE_TERMINALS" : "TKR_CLOSE_PANES"]: f.addresses.join(","), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.push(proc);
  let output = "";
  proc.stdout?.on("data", data => { output += String(data); });
  proc.stderr?.on("data", data => { output += String(data); });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    proc.once("error", reject);
    proc.once("close", resolveExit);
  });
  return { code, output, calls: f.calls(), closes: f.calls().filter(a => a[1] === "close") };
}

test("test: the artifact watcher given one recorded address per artifact closes a completed, stood-down seat whose live title and checkout match its spawn record, on Orca through the terminal close command followed by a terminal list and on herdr through the pane close command, on the all-complete exit and on the wake-on-any exit of a single artifact, and closes nothing for a marked artifact whose seat has not stood down, a recycled handle the live list shows under an operator's title, a still-pending sibling under wake-on-any, a timeout or an artifact without its marker, while a seat reused for a named next mission stays open as long as its stand-down file names the earlier mission and closes once it stands down for the current one, so a watcher that closes on a bare address, on an earlier mission's stand-down, before stand-down, at a timeout or never on Orca fails", async () => {
  for (const host of ["orca", "herdr"] as const) for (const any of ["0", "1"]) {
    const f = closeFixture({ host }), result = await runCloseFixture(f, { TKR_WAKE_ON_ANY: any });
    expect(result.code).toBe(0);
    expect(result.output).toContain(`CLOSED ${f.addresses[0]}`);
    if (host === "orca") {
      expect(result.closes).toEqual([["terminal", "close", "--terminal", f.addresses[0], "--json"]]);
      expect(result.calls.map(a => a.slice(0, 2).join(" "))).toEqual(["terminal list", "terminal close", "terminal list", "terminal list"]);
      expect(result.calls[0]).toContain("--include-visual-layouts");
      expect(result.calls[2]).not.toContain("--include-visual-layouts");
      expect(result.calls[3]).toContain("--include-visual-layouts");
      expect(result.output).toContain("handle absent from terminal list; owned tab tab-0 absent from visual layout");
    } else {
      expect(result.closes).toEqual([["pane", "close", f.addresses[0]], ["tab", "close", "tab-0"]]);
      expect(result.calls.map(a => a.slice(0, 2).join(" "))).toEqual(["pane list", "pane close", "pane list", "tab close", "tab list"]);
    }
  }
  // The all-complete path maps addresses in argument order too, and the any path leaves its pending sibling.
  for (const host of ["orca", "herdr"] as const) {
    const both = closeFixture({ host, count: 2 });
    const complete = await runCloseFixture(both);
    expect(complete.output).toContain(`CLOSED ${both.addresses[0]}`);
    expect(complete.output).toContain(`CLOSED ${both.addresses[1]}`);
    const siblings = closeFixture({ host, count: 2 });
    writeFileSync(siblings.artifacts[0], "still pending\n");
    const partial = await runCloseFixture(siblings, { TKR_WAKE_ON_ANY: "1" });
    expect(partial.output).toContain("1 still outstanding");
    expect(partial.output).toContain(`CLOSED ${siblings.addresses[1]}`);
    expect(partial.closes.some(a => a.includes(siblings.addresses[0]))).toBe(false);
    const shared = closeFixture({ host, count: 2, sharedTab: true });
    writeFileSync(shared.artifacts[0], "still pending\n");
    const sharedPartial = await runCloseFixture(shared, { TKR_WAKE_ON_ANY: "1" });
    expect(sharedPartial.output).toContain(`CLOSED ${shared.addresses[1]}`);
    expect(sharedPartial.closes.some(a => a.includes(shared.addresses[0]))).toBe(false);
    expect(sharedPartial.closes.some(a => a[0] === "tab")).toBe(false);
    const sharedComplete = closeFixture({ host, count: 2, sharedTab: true });
    const sharedResult = await runCloseFixture(sharedComplete);
    expect(sharedResult.output).toContain(`CLOSED ${sharedComplete.addresses[0]}`);
    expect(sharedResult.output).toContain(`CLOSED ${sharedComplete.addresses[1]}`);
    if (host === "orca") expect(sharedResult.output).toContain("owned tab tab-0 absent from visual layout");
    for (const options of [
      { stoodDown: false }, { ledger: false }, { liveTitle: "OPERATOR thinking" }, { liveCheckout: "/operator/checkout" },
      { liveAddress: "different-live-handle" }, { stoodMission: "earlier" }, { nextMission: "named-next" },
      { marker: false },
    ]) {
      const f = closeFixture({ host, ...options });
      // Queue row 240; D-2138 add.4: ownership refusals need both stable-content polls;
      // reserve the short deadline for the missing-marker timeout control.
      const result = await runCloseFixture(f, { ...(options.marker === false ? { CAP: "1" } : {}), TKR_WAKE_ON_ANY: "1" });
      expect(result.closes, `${host} ${JSON.stringify(options)}: ${result.output}`).toEqual([]);
      if (options.marker !== false) expect(result.output).toContain("LEFT OPEN");
      if (host === "orca" && options.liveAddress) {
        expect(result.calls).toContainEqual(["terminal", "read", "--terminal", options.liveAddress, "--screen", "--json"]);
        expect(result.output).toContain("read-only re-resolution by title");
      }
    }
    const own = closeFixture({ host });
    expect((await runCloseFixture(own, { [host === "orca" ? "ORCA_TERMINAL_HANDLE" : "HERDR_PANE_ID"]: own.addresses[0] })).closes).toEqual([]);
    const arming = closeFixture({ host });
    expect((await runCloseFixture(arming, { TKR_ARMING_SEAT: "seat-0" })).closes).toEqual([]);
    const timeout = closeFixture({ host, count: 2 });
    writeFileSync(timeout.artifacts[1], "pending\n");
    const timed = await runCloseFixture(timeout, { CAP: "1" });
    expect(timed.output).toContain("cap 1s reached");
    expect(timed.closes).toEqual([]); // one marked sibling is still never closed on a timeout
    const reuse = closeFixture({ host, stoodMission: "earlier" });
    expect((await runCloseFixture(reuse)).closes).toEqual([]);
    writeFileSync(join(reuse.pids, "seat-0.stood-down"), "mission=current\n");
    expect((await runCloseFixture(reuse)).output).toContain(`CLOSED ${reuse.addresses[0]}`);
    for (const count of [0, 2]) {
      const f = closeFixture({ host, count: 2 });
      const list = count === 0 ? f.addresses[0] : `${f.addresses.join(",")},extra`;
      const refused = await runCloseFixture(f, { [host === "orca" ? "TKR_CLOSE_TERMINALS" : "TKR_CLOSE_PANES"]: list });
      expect(refused.code).toBe(2);
      expect(refused.output).toContain("one recorded address per artifact");
      expect(refused.calls).toEqual([]);
    }
  }
  const nonterminal = closeFixture();
  writeFileSync(nonterminal.artifacts[0], "delivered?\nREPORT-END\nstill writing\n");
  const unfinished = await runCloseFixture(nonterminal, { CAP: "1", TKR_WAKE_ON_ANY: "1" });
  expect(unfinished.output).toContain("cap 1s reached");
  expect(unfinished.closes).toEqual([]);
  const refusal = closeFixture({ refusal: "tab_not_found" });
  expect((await runCloseFixture(refusal)).output).toContain("CLOSED terminal:1: receipt runtime_error: tab_not_found");
  for (const options of [{ wrongReceipt: true }, { refusal: "permission denied" }, { keepTab: true }, { truncated: true }]) {
    const result = await runCloseFixture(closeFixture(options));
    expect(result.output).not.toContain("  CLOSED");
    expect(result.output).toMatch(/LEFT OPEN|CLOSE UNPROVEN/);
  }
}, 120_000);
