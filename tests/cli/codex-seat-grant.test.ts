// Queue row 406; D-2187 add.99 and add.100: a codex judge or review seat grants exactly the real `.vite-temp` leaf under
// its resolved dependency root, through production runLlm with a token-free fake `codex` on PATH.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { codex } from "../../src/adapters/codex.js";
import { claudeCode } from "../../src/adapters/claude-code.js";
import { runLlm, SeatLaunchError } from "../../src/gates/llm.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

// Logs each launch's argv; given a grant, runs a writer under enforcement built ONLY from the emitted grant (D-2187
// add.131): on macOS the kernel's sandbox-exec (Seatbelt, codex's own mechanism there) denies every write outside the
// granted roots; elsewhere each probed path outside them sits in a directory made read-only for the launch (and an
// existing file is made read-only too). Where neither enforces (no Seatbelt and running as root) the fake still writes
// and loads the config module but attempts no probe, says so, and the probe cell is skipped. The writer writes and loads a Vite-shaped config bundle in the granted root, then
// attempts each independent write listed in probes.json beside the fake — every probe is a real filesystem write.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "argv.jsonl"), JSON.stringify(args) + "\\n");
const grant = args.find((a) => a.startsWith("sandbox_workspace_write.writable_roots="));
if (!grant) { console.log("NO-GRANT"); process.exit(0); }
const roots = JSON.parse(grant.slice(grant.indexOf("=") + 1));
const probesFile = path.join(__dirname, "probes.json");
const probes = fs.existsSync(probesFile) ? JSON.parse(fs.readFileSync(probesFile, "utf8")) : [];
const argv = [path.join(__dirname, "writer.js"), JSON.stringify([roots, probes])];
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } };
const granted = (p) => roots.some((r) => real(p) === r || real(p).startsWith(r + "/"));
let mode, run;
if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
  const allow = roots.map((r) => "(subpath " + JSON.stringify(r) + ")").join(" ");
  const profile = "(version 1)(allow default)(deny file-write*)(allow file-write* " + allow + " (literal " + JSON.stringify("/dev/null") + "))";
  mode = "seatbelt";
  run = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, ...argv], { encoding: "utf8" });
} else if (typeof process.getuid === "function" && process.getuid() !== 0) {
  mode = "permissions";
  const locked = [...new Set(probes.filter((p) => !granted(p)).flatMap((p) => fs.existsSync(p) ? [real(p), path.dirname(real(p))] : [path.dirname(real(p))]))];
  const modes = locked.map((p) => [p, fs.statSync(p).mode & 0o7777]);
  for (const [p] of modes) fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o555 : 0o444);
  try { run = spawnSync(process.execPath, argv, { encoding: "utf8" }); }
  finally { for (const [p, m] of modes) fs.chmodSync(p, m); }
} else {
  // No enforcement binds: the config module is still written and loaded, but no probe is attempted (a real write
  // would land), so the independent-probe cell is skipped with this reason.
  mode = "none:no Seatbelt on " + process.platform + " and running as root, so file permissions do not bind";
  run = spawnSync(process.execPath, [argv[0], JSON.stringify([roots, []])], { encoding: "utf8" });
}
process.stdout.write(run.stdout + "SANDBOX:" + mode + "\\n");
process.stderr.write(run.stderr);
`;
const WRITER = `const fs = require("node:fs"), path = require("node:path"), { pathToFileURL } = require("node:url");
const [roots, probes] = JSON.parse(process.argv[2]);
for (const p of probes) { try { fs.writeFileSync(p, "probe"); console.log("WROTE:" + p); } catch (e) { console.log("DENIED:" + p + ":" + e.code); } }
const mod = path.join(roots[0], "vitest.config.ts.timestamp-1-abc.mjs");
fs.writeFileSync(mod, "export default { loaded: 42 };\\n");
import(pathToFileURL(mod).href).then((m) => console.log("LOADED:" + m.default.loaded));
`;

let bin = "";
beforeEach(() => {
  bin = makeTestTempDir("codex-seat-fake-");
  writeFileSync(join(bin, "codex"), FAKE_CODEX, { mode: 0o755 });
  writeFileSync(join(bin, "writer.js"), WRITER);
  mkdirSync(join(bin, "codex-home"));
  vi.stubEnv("CODEX_HOME", join(bin, "codex-home"));
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  // production seats run in a login shell, which rebuilds PATH from the profile: put the fake first there too
  writeFileSync(join(bin, ".bash_profile"), `export PATH=${JSON.stringify(bin)}:"$PATH"\n`);
  vi.stubEnv("HOME", bin);
  vi.stubEnv("TICKMARKR_SEAT", undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const launches = (): string[][] => existsSync(join(bin, "argv.jsonl"))
  ? readFileSync(join(bin, "argv.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];
const grants = (argv: string[]) => argv.filter((a) => a.includes("writable_roots"));
const prompt = (head: string) => `${head}\n## Task T1: seat grant\nVERDICT_NONCE: abc12345`;

/** A main checkout with installed packages and git metadata, and a worktree whose node_modules is the provisioned link. */
function provisioned(): { main: string; worktree: string; deps: string } {
  const main = makeTestTempDir("codex-seat-main-");
  mkdirSync(join(main, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(main, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  mkdirSync(join(main, ".git"));
  writeFileSync(join(main, ".git", "config"), "[core]\n");
  const worktree = makeTestTempDir("codex-seat-wt-");
  symlinkSync(join(main, "node_modules"), join(worktree, "node_modules"));
  return { main, worktree, deps: realpathSync(join(main, "node_modules")) };
}

test("a codex judge or review seat grants exactly the real vite temp leaf and a fake codex launched from an absent leaf writes and loads a config module there", async () => {
  const { worktree, deps } = provisioned();
  const leaf = join(deps, ".vite-temp");
  expect(existsSync(leaf)).toBe(false);
  // review from an absent leaf, then judge with the leaf present: each grants the same one real leaf
  for (const head of ["TICKMARKR-REVIEW", "TICKMARKR-JUDGE"]) {
    const output = await runLlm(codex, "fixture-model", prompt(head), worktree, undefined, 10_000);
    expect(output, head).toContain("LOADED:42");
    const argv = launches().at(-1)!;
    expect(grants(argv), head).toEqual([`sandbox_workspace_write.writable_roots=${JSON.stringify([leaf])}`]);
    const st = lstatSync(leaf);
    expect(st.isDirectory() && !st.isSymbolicLink()).toBe(true);
    expect(existsSync(join(leaf, "vitest.config.ts.timestamp-1-abc.mjs"))).toBe(true);
  }
}, 30_000);

test("independent package and git metadata writes under the emitted grant are denied beside the config module the seat writes and loads", async (ctx) => {
  const { main, worktree, deps } = provisioned();
  // Every installed package path, the dependency root itself and git metadata, through both the real and linked paths.
  const probes = [join(deps, "probe.js"), join(deps, "pkg", "index.js"), join(deps, "pkg", "probe.js"),
    join(main, ".git", "config"), join(main, ".git", "probe"), join(worktree, "node_modules", "pkg", "probe.js")];
  writeFileSync(join(bin, "probes.json"), JSON.stringify(probes));
  const probed = await runLlm(codex, "fixture-model", prompt("TICKMARKR-REVIEW"), worktree, undefined, 10_000);
  const none = /SANDBOX:none:(.*)/.exec(probed);
  if (none) { console.log(`skipped: ${none[1]}`); ctx.skip(); return; }
  expect(probed).toContain("LOADED:42");
  const seatbelt = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
  expect(probed).toMatch(seatbelt ? /SANDBOX:seatbelt/ : /SANDBOX:permissions/);
  for (const p of probes) {
    expect(probed, p).toMatch(new RegExp(`DENIED:${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(EPERM|EACCES)`));
    expect(probed, p).not.toContain(`WROTE:${p}`);
  }
  expect(readFileSync(join(deps, "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  expect(readFileSync(join(main, ".git", "config"), "utf8")).toBe("[core]\n");
  for (const p of [join(deps, "probe.js"), join(deps, "pkg", "probe.js"), join(main, ".git", "probe")]) expect(existsSync(p), p).toBe(false);
}, 30_000);

test("a leaf that is a symlink to a package or to git metadata or not a directory refuses the launch while worker and claude launches are unchanged", async () => {
  const refusals: Array<[string, (deps: string, main: string) => void]> = [
    ["symlink to a package", (deps) => symlinkSync(join(deps, "pkg"), join(deps, ".vite-temp"))],
    ["symlink to git metadata", (deps, main) => symlinkSync(join(main, ".git"), join(deps, ".vite-temp"))],
    ["regular file", (deps) => writeFileSync(join(deps, ".vite-temp"), "")],
  ];
  for (const [name, plant] of refusals) {
    const { main, worktree, deps } = provisioned();
    plant(deps, main);
    for (const head of ["TICKMARKR-REVIEW", "TICKMARKR-JUDGE"]) {
      const before = launches().length;
      const refused = await runLlm(codex, "fixture-model", prompt(head), worktree, undefined, 10_000).catch((e: unknown) => e);
      expect(refused, `${name} ${head}`).toBeInstanceOf(SeatLaunchError);
      expect(launches().length, `${name}: nothing launched, nothing granted`).toBe(before);
    }
    expect(readFileSync(join(deps, "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(readFileSync(join(main, ".git", "config"), "utf8")).toBe("[core]\n");
  }
  // Controls: a consult seat, the codex worker builders and a Claude seat launch exactly as at the base.
  const { worktree, deps } = provisioned();
  expect(await runLlm(codex, "fixture-model", "consult prompt\nVERDICT_NONCE: abc12345", worktree, undefined, 10_000)).toContain("NO-GRANT");
  expect(grants(launches().at(-1)!)).toEqual([]);
  expect(existsSync(join(deps, ".vite-temp"))).toBe(false);
  const pf = join(bin, "prompt.md");
  const worker = codex.invoke({} as never, worktree, { model: "m", channel: "sub", tier: "mid" } as never, { promptFile: pf }).command;
  expect(worker).not.toContain(".vite-temp");
  expect(codex.headlessCommand(pf, "m")).not.toContain("writable_roots");
  expect(claudeCode.headlessCommand(pf, "m")).not.toContain(".vite-temp");
  expect(claudeCode.invoke({} as never, worktree, { model: "m", channel: "sub", tier: "mid" } as never, { promptFile: pf }).command).not.toContain(".vite-temp");
}, 30_000);
