import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { codex, CODEX_NO_DAEMON } from "../../src/adapters/codex.js";
import { flagDriftWarnings } from "../../src/adapters/registry.js";
import { shq } from "../../src/adapters/types.js";
import { HerdrAppDriver } from "../../src/drivers/herdr-app.js";
import { formatOwnedName } from "../../src/drivers/types.js";
import { sh } from "../../src/run/git.js";
import { FakeHerdrApp } from "../helpers/fake-herdr-app.js";
import { makeRepo, makeTestTempDir, reapTestTempDirs } from "../helpers/tmprepo.js";

// Queue row 340; D-2180 — contract C, Codex containment. Every launch here runs a stub `codex` by explicit absolute
// path (the builder's leading `codex` token replaced), so no installed Codex CLI is ever reached.

afterEach(() => vi.unstubAllEnvs());
afterAll(() => reapTestTempDirs());

// The captured `codex --help` entry (specs/v2.20.0-herdr-app-captures.json, Q5-no-daemon-flag), verbatim.
const NO_DAEMON_HELP = "      --no-daemon\n          Run without the shared background server, even if it is already running\n";
const SPEC_CAPTURES = new URL("../../specs/v2.20.0-herdr-app-captures.json", import.meta.url);
const HOSTS: Record<string, Record<string, string | undefined>> = {
  "herdr-app": { HC_TERMINAL_ID: "t4", HC_TERMINAL_SOCKET: "/tmp/hc-codex.sock", HC_SCOPE: "launcher-scope", HERDR_ENV: undefined, TERM_PROGRAM: "ghostty", ORCA_TERMINAL_HANDLE: undefined },
  "classic herdr": { HERDR_ENV: "1", HC_TERMINAL_ID: undefined, HC_TERMINAL_SOCKET: undefined, HC_SCOPE: undefined, TERM_PROGRAM: undefined, ORCA_TERMINAL_HANDLE: undefined },
  orca: { TERM_PROGRAM: "Orca", ORCA_TERMINAL_HANDLE: "term-1", HERDR_ENV: undefined, HC_TERMINAL_ID: undefined, HC_TERMINAL_SOCKET: undefined, HC_SCOPE: undefined },
  plain: { HERDR_ENV: undefined, HC_TERMINAL_ID: undefined, HC_TERMINAL_SOCKET: undefined, HC_SCOPE: undefined, TERM_PROGRAM: undefined, ORCA_TERMINAL_HANDLE: undefined },
};
const stubbed = (command: string, stub: string): string => {
  expect(command.startsWith("codex ")).toBe(true);
  return `${shq(stub)} ${command.slice("codex ".length)}`;
};

test("both existing Codex forms request no-daemon at their declared argv positions while resume stays absent and unsupported flags fail visibly in launch and doctor", async () => {
  vi.stubEnv("CODEX_HOME", "/var/empty/tickmarkr-hermetic-codex-home");
  const dir = makeTestTempDir("codex-no-daemon-");
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, "worker prompt\nsecond line\n");
  const forms = () => ({
    headless: codex.headlessCommand(promptFile, "gpt-5.2"),
    worker: codex.invoke({} as never, dir, { model: "gpt-5.2", channel: "sub", tier: "mid" }, { promptFile }).command,
    interactive: codex.interactiveCommand(promptFile, "gpt-5.2")!,
  });

  // Declared positions: immediately after --dangerously-bypass-hook-trust in both forms — after `exec` in the headless
  // and worker forms, before the prompt positional in the TUI form. Exactly once, on every host: the builders take no
  // host input, so the same bytes are built under the Herdr app, classic herdr, Orca and a plain shell.
  const built = new Set<string>();
  for (const [host, env] of Object.entries(HOSTS)) {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    built.add(JSON.stringify(forms()));
    expect(built.size, host).toBe(1);
  }
  const { headless, worker, interactive } = forms();
  for (const cmd of [headless, worker]) {
    expect(cmd.split(" ").slice(0, 6)).toEqual(["codex", "exec", "--sandbox", "workspace-write", "--dangerously-bypass-hook-trust", CODEX_NO_DAEMON]);
    expect(cmd.split(CODEX_NO_DAEMON)).toHaveLength(2);
    expect(cmd.endsWith(`--model 'gpt-5.2' - < ${shq(promptFile)}`)).toBe(true);
    expect(cmd.split(/\s+/, 4).join(" ")).toBe("codex exec --sandbox workspace-write"); // the first-four census
  }
  expect(worker).toBe(headless.replace(" --model ", " -c 'sandbox_workspace_write.writable_roots=[]' --model "));
  expect(interactive.split(" ").slice(0, 7)).toEqual(["codex", "-a", "never", "-s", "workspace-write", "--dangerously-bypass-hook-trust", CODEX_NO_DAEMON]);
  expect(interactive.split(CODEX_NO_DAEMON)).toHaveLength(2);
  expect(interactive.endsWith(`--model 'gpt-5.2' "$(cat ${shq(promptFile)})"`)).toBe(true);
  expect(interactive.split(/\s+/, 4).join(" ")).toBe("codex -a never -s");
  // No resume form exists or is added; doctor's drift row covers the new flag like the hook-trust flag.
  expect(codex.resumeCommand).toBeUndefined();
  expect(codex.hardcodedFlags).toEqual({ binary: "codex", flags: ["--sandbox", "-a", "-s", "--model", "-c", "--disable", "--dangerously-bypass-hook-trust", CODEX_NO_DAEMON] });

  // The argv a real process receives: a stub records it, one argument per line, and reads stdin.
  const argvLog = join(dir, "argv.log");
  const accepting = join(dir, "codex-accepting");
  writeFileSync(accepting, `#!/bin/sh\nprintf '%s\\n' "$@" > ${shq(argvLog)}\ncat > /dev/null\nprintf 'ran\\n'\n`);
  chmodSync(accepting, 0o755);
  const argvOf = async (command: string): Promise<string[]> => {
    const r = await sh(stubbed(command, accepting), dir, 30_000);
    expect(r.code, r.stderr).toBe(0);
    return readFileSync(argvLog, "utf8").replace(/\n$/, "").split("\n");
  };
  for (const cmd of [headless, worker]) {
    const argv = await argvOf(cmd);
    expect(argv.indexOf(CODEX_NO_DAEMON)).toBe(4); // exec --sandbox workspace-write --dangerously-bypass-hook-trust --no-daemon
    expect(argv[0]).toBe("exec");
  }
  const tui = await argvOf(interactive);
  expect(tui.indexOf(CODEX_NO_DAEMON)).toBe(5); // -a never -s workspace-write --dangerously-bypass-hook-trust --no-daemon
  expect(tui.slice(-4)).toEqual(["--model", "gpt-5.2", "worker prompt", "second line"]);
  expect(tui.indexOf(CODEX_NO_DAEMON)).toBeLessThan(tui.length - 2);

  // Launched in a NEW hc terminal (the real HerdrAppDriver over the executing hc fake): the flag is present, the
  // launcher's addressing is absent, and only the terminal's own fresh scope survives.
  const f = new FakeHerdrApp(makeTestTempDir("hcapp-codex-"), { execute: true });
  const envProbe = join(dir, "codex-env");
  writeFileSync(envProbe, `#!/bin/sh\nfor a in "$@"; do printf 'ARG=%s\\n' "$a"; done\nprintf 'ID=%s\\nSOCKET=%s\\nSCOPE=%s\\n' "\${HC_TERMINAL_ID-unset}" "\${HC_TERMINAL_SOCKET-unset}" "\${HC_SCOPE-unset}"\n`);
  chmodSync(envProbe, 0o755);
  const repo = makeRepo({ "a.txt": "a" });
  const app = new HerdrAppDriver({ hcBin: f.hc, appBin: f.app, env: { PATH: process.env.PATH, ...HOSTS["herdr-app"] } as NodeJS.ProcessEnv });
  const slot = await app.slot(repo, formatOwnedName({ role: "worker", taskId: "T1", attempt: 0, runId: "run-codex-app" }));
  await app.run(slot, stubbed(interactive, envProbe));
  const screen = f.term("t1").screen.text.split("\n");
  expect(screen).toContain(`ARG=${CODEX_NO_DAEMON}`);
  expect(screen).toContain("ID=unset");
  expect(screen).toContain("SOCKET=unset");
  expect(screen).toContain("SCOPE=scope-own-t1");

  // An older Codex that lacks the flag: an ordinary, visible launch failure on every form — never an escaped fallback.
  const older = join(dir, "codex-older");
  writeFileSync(older, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = ${CODEX_NO_DAEMON} ]; then echo "error: unexpected argument '${CODEX_NO_DAEMON}' found" >&2; exit 2; fi; done\nprintf 'escaped\\n'\n`);
  chmodSync(older, 0o755);
  for (const cmd of [headless, worker, interactive]) {
    const r = await sh(stubbed(cmd, older), dir, 30_000);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`unexpected argument '${CODEX_NO_DAEMON}'`);
    expect(r.stdout).not.toContain("escaped");
  }

  // Doctor's advisory flag-drift row names the flag when the installed help omits it, and is silent when it lists it.
  const health = { codex: { installed: true, authed: true, models: [] } };
  const listed = [...codex.hardcodedFlags!.flags.filter((f) => f !== CODEX_NO_DAEMON).map((flag) => `  ${flag} <value>`), NO_DAEMON_HELP].join("\n");
  expect(flagDriftWarnings([codex], health, () => listed)).toEqual([]);
  expect(flagDriftWarnings([codex], health, () => listed.replace(NO_DAEMON_HELP, ""))).toEqual([
    `flag drift: codex hardcodes ${CODEX_NO_DAEMON} but codex --help no longer lists it (advisory — routing unchanged)`,
  ]);
  if (existsSync(SPEC_CAPTURES)) {
    // The installed CLI's own captured help lists every hardcoded flag; without its --no-daemon entry, doctor names it.
    const help = (JSON.parse(readFileSync(SPEC_CAPTURES, "utf8")) as { captures: Record<string, { output: string }> }).captures["Q5-no-daemon-flag"]!.output;
    expect(help).toContain(NO_DAEMON_HELP);
    expect(flagDriftWarnings([codex], health, () => help)).toEqual([]);
    expect(flagDriftWarnings([codex], health, () => help.replace(NO_DAEMON_HELP, ""))).toEqual([
      `flag drift: codex hardcodes ${CODEX_NO_DAEMON} but codex --help no longer lists it (advisory — routing unchanged)`,
    ]);
  }
}, 120_000);
