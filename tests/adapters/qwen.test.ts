import { execSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeCode } from "../../src/adapters/claude-code.js";
import { isNativeCliDrive, projectCliEntries, SHIPPED_CLI_CATALOG } from "../../src/adapters/catalog.js";
import { parseWorkerResult } from "../../src/adapters/prompt.js";
import { parseQwenResult, qwen, QWEN_VERSION_IDENTITY } from "../../src/adapters/qwen.js";
import { declaredPromptGlyphForAdapter } from "../../src/adapters/types.js";
import { bannerShell } from "../../src/brand.js";

const NONCE = "ffe5ac85";
const FIXTURE_DIR = join(import.meta.dirname, "../fixtures/qwen");

function capturedArgv(path: string): string[] {
  const fields = readFileSync(path).toString().split("\0");
  fields.pop();
  return fields;
}

function makeCaptureStub(binary: "qwen" | "claude") {
  const dir = mkdtempSync(join(tmpdir(), `tickmarkr-${binary}-launch-`));
  const argv = join(dir, "argv");
  const stdin = join(dir, "stdin");
  const env = join(dir, "env");
  const executable = join(dir, binary);
  writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '0.21.15'
  exit 0
fi
printf '%s\\0' "$@" > "$CAPTURE_ARGV"
cat > "$CAPTURE_STDIN"
printf '%s' "$QWEN_CODE_SKIP_UPDATE_CHECK_ONCE" > "$CAPTURE_ENV"
`);
  chmodSync(executable, 0o755);
  return { dir, argv, stdin, env, executable };
}

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

type QwenInit = { tools: string[]; slash_commands: string[]; agents: string[] };

function initEvent(name: string): QwenInit {
  const found = (JSON.parse(fixture(name)) as Array<Record<string, unknown>>).find((event) => event.type === "system" && event.subtype === "init");
  if (!found) throw new Error(`${name} has no init event`);
  return found as QwenInit;
}

describe("qwen native drive", () => {
  test("test: the qwen headless command run against a stub qwen on PATH passes --safe-mode beside --approval-mode yolo -m the model -o json and -p with an empty argument and declares --safe-mode among its hardcoded flags whereas a form without --safe-mode or one that drops -o json fails", () => {
    const capture = makeCaptureStub("qwen");
    const prompt = join(capture.dir, "prompt.md");
    const promptText = `work\nTICKMARKR_RESULT_${NONCE} {"ok":true}`;
    writeFileSync(prompt, promptText);
    execSync(qwen.headlessCommand(prompt, "qwen3.8-max"), {
      env: {
        ...process.env,
        PATH: `${capture.dir}:${process.env.PATH ?? ""}`,
        CAPTURE_ARGV: capture.argv,
        CAPTURE_STDIN: capture.stdin,
        CAPTURE_ENV: capture.env,
      },
    });

    const assertLaunch = (argv: string[], stdin: string, env: string, flags: string[]) => {
      expect(argv).toEqual(["--safe-mode", "--approval-mode", "yolo", "-m", "qwen3.8-max", "-o", "json", "-p", ""]);
      expect(argv.join(" ")).not.toContain(NONCE);
      expect(stdin).toBe(promptText);
      expect(env).toBe("true");
      expect(flags).toContain("--safe-mode");
    };
    assertLaunch(capturedArgv(capture.argv), readFileSync(capture.stdin, "utf8"), readFileSync(capture.env, "utf8"), qwen.hardcodedFlags!.flags);

    expect(() => assertLaunch(
      ["--approval-mode", "yolo", "-m", "qwen3.8-max", "-o", "json", "-p", ""],
      promptText,
      "true",
      qwen.hardcodedFlags!.flags,
    )).toThrow();
    expect(() => assertLaunch(["--safe-mode", "--approval-mode", "yolo", "-m", "qwen3.8-max", "-p", ""], promptText, "true", qwen.hardcodedFlags!.flags)).toThrow();
    // OBS-905 / RULING-222-43: no interactive form — the pane runs the headless command like omp's, so the
    // prompt never enters argv and the JSON decoder reads every driver's transcript.
    expect(qwen.interactiveCommand(prompt, "qwen3.8-max")).toBeNull();
    expect(qwen.hardcodedFlags!.flags).not.toContain("-i");
  });

  test("test: the shipped safe-mode capture's init event lists the same tool set as the live capture's including write_file edit and run_shell_command while its slash commands and agents are fewer so a worker loses no tool under --safe-mode whereas a fixture pair whose tool sets differ fails", () => {
    const assertSameTools = (left: QwenInit, right: QwenInit) => {
      expect([...left.tools].sort()).toEqual([...right.tools].sort());
    };
    const safe = initEvent("safe-mode.stdout");
    const live = initEvent("live.stdout");

    assertSameTools(safe, live);
    expect(safe.tools).toEqual(expect.arrayContaining(["write_file", "edit", "run_shell_command"]));
    expect(safe.slash_commands.length).toBeLessThan(live.slash_commands.length);
    expect(safe.agents.length).toBeLessThan(live.agents.length);
    expect(() => assertSameTools({ ...safe, tools: safe.tools.filter((tool) => tool !== "write_file") }, live)).toThrow();
  });

  test("test: an assistant text block that carries the API error marker after leading prose classifies startup-failure naming the error text while a block that only mentions the words without the marker does not whereas a decoder that requires the marker at the start of the block fails", () => {
    const leadingProse = "Leading prose before the real marker.\n[API Error: delayed boom]";
    const stream = (text: string) => JSON.stringify([
      { type: "assistant", message: { content: [{ type: "text", text }] } },
      { type: "result", subtype: "success", is_error: false, permission_denials: [], stats: { models: { "qwen3.8-max": { api: { totalErrors: 0 } } } } },
    ]);

    expect(parseQwenResult(stream(leadingProse), NONCE)).toMatchObject({
      ok: false,
      cause: "startup-failure",
      summary: "[API Error: delayed boom]",
    });
    expect(parseQwenResult(stream("The words API Error are harmless without the marker."), NONCE).cause).not.toBe("startup-failure");
    expect(leadingProse.startsWith("[API Error:")).toBe(false);
  });

  test("test: the replayed unknown-model and closed-port captures parse as ok false with cause startup-failure naming the API error text although each ran exit 0 with subtype success while the real-model PONG control shows no failure sign and a stream whose assistant text carries the nonce trailer parses ok true from that decoded text whereas a parser that trusts subtype success or scans the raw JSON bytes for the trailer fails", () => {
    const unknown = fixture("unknown-model-live.stdout");
    const closedPort = fixture("closed-port.stdout");
    const control = fixture("control-real-model.stdout");

    expect(parseQwenResult(unknown, NONCE)).toMatchObject({
      ok: false,
      cause: "startup-failure",
      summary: expect.stringContaining("[API Error: 401 Invalid API-key provided"),
    });
    expect(parseQwenResult(closedPort, NONCE)).toMatchObject({
      ok: false,
      cause: "startup-failure",
      summary: expect.stringContaining("[API Error: Connection error"),
    });
    expect(parseQwenResult(control, NONCE).cause).not.toBe("startup-failure");
    expect(control).toContain('"text":"PONG"');

    const trailer = `TICKMARKR_RESULT_${NONCE} {"ok":true,"summary":"decoded","deviations":[]}`;
    const stream = JSON.stringify([
      { type: "assistant", message: { content: [{ type: "text", text: trailer }] } },
      { type: "result", subtype: "success", is_error: false, permission_denials: [], stats: { models: { "qwen3.8-max": { api: { totalErrors: 0 } } } } },
    ]);
    expect(parseQwenResult(stream, NONCE)).toMatchObject({ ok: true, summary: "decoded" });
    expect(parseWorkerResult(stream, NONCE).ok).toBe(false);
    expect(parseQwenResult(JSON.stringify({ type: "assistant", text: trailer }), NONCE)).toMatchObject({
      ok: false,
      cause: "malformed-verdict",
    });
    expect(parseQwenResult(`not-json ${trailer}`, NONCE)).toMatchObject({
      ok: false,
      cause: "malformed-verdict",
    });
  });

  test("qwen failure classification covers every recorded fail-closed signal", () => {
    const event = (over: Record<string, unknown>) => JSON.stringify([{
      type: "result", subtype: "success", is_error: false, permission_denials: [],
      stats: { models: { m: { api: { totalErrors: 0 } } } },
      ...over,
    }]);
    expect(parseQwenResult(event({ subtype: "error" }), NONCE).cause).toBe("startup-failure");
    expect(parseQwenResult(event({ is_error: true }), NONCE).cause).toBe("startup-failure");
    expect(parseQwenResult(event({ permission_denials: ["write refused"] }), NONCE).summary).toContain("write refused");
    expect(parseQwenResult(event({ stats: { models: { m: { api: { totalErrors: 1 } } } } }), NONCE).cause).toBe("startup-failure");
  });

  test("qwen version probing accepts only the recorded bare-semver identity", async () => {
    const capture = makeCaptureStub("qwen");
    const priorPath = process.env.PATH;
    process.env.PATH = `${capture.dir}:${priorPath ?? ""}`;
    try {
      await expect(qwen.probe()).resolves.toMatchObject({ installed: true, authed: true, version: "0.21.15" });
      writeFileSync(capture.executable, "#!/bin/sh\nprintf '%s\\n' 'not-qwen 0.21.15'\n");
      chmodSync(capture.executable, 0o755);
      await expect(qwen.probe()).resolves.toMatchObject({ installed: false, authed: false });
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  });

  test("test: the catalog lists qwen as a native drive with vendor alibaba and a prompt glyph declaration and the doctor candidate audit keeps gemini as its advisory fixture so the four guards still see an advisory class whereas a catalog that leaves qwen a bare string a glyph table without qwen or a fixture that names qwen fails", () => {
    const qwenEntry = SHIPPED_CLI_CATALOG.find((entry) => entry.id === "qwen");
    expect(qwenEntry?.vendor).toBe("alibaba");
    expect(qwenEntry?.identity).toBe(QWEN_VERSION_IDENTITY.source);
    expect(qwenEntry?.drive && isNativeCliDrive(qwenEntry.drive)).toBe(true);
    expect(declaredPromptGlyphForAdapter("qwen")).toBe(">");

    const projections = projectCliEntries(SHIPPED_CLI_CATALOG);
    expect(projections.routable.map((entry) => entry.id)).toContain("qwen");
    expect(projections.advisory.map((entry) => entry.id)).toContain("gemini");
    expect(projections.advisory.map((entry) => entry.id)).not.toContain("qwen");
  });

  test("test: the claude-code headless command delivers the prompt file on stdin so the nonce is absent from its argv and the interactive and resume commands carry the promptSuggestionEnabled false settings pair with a flag following it and hardcodedFlags declares --settings for the capability probe whereas a headless form that inlines the prompt a pane form without the pair or an undeclared flag fails", () => {
    const capture = makeCaptureStub("claude");
    const prompt = join(capture.dir, "prompt.md");
    const promptText = `TICKMARKR_RESULT_${NONCE} {"ok":true}`;
    writeFileSync(prompt, promptText);
    execSync(claudeCode.headlessCommand(prompt, "fable"), {
      env: {
        ...process.env,
        PATH: `${capture.dir}:${process.env.PATH ?? ""}`,
        CAPTURE_ARGV: capture.argv,
        CAPTURE_STDIN: capture.stdin,
        CAPTURE_ENV: capture.env,
      },
    });

    const argv = capturedArgv(capture.argv);
    const stdin = readFileSync(capture.stdin, "utf8");
    const settings = `--settings '{"promptSuggestionEnabled":false}'`;
    const paneCommands = [
      claudeCode.interactiveCommand(prompt, "fable")!,
      claudeCode.resumeCommand!("session", prompt, "fable"),
    ];
    const assertLaunchContract = (headlessArgv: string[], headlessStdin: string, panes: string[], flags: string[]) => {
      expect(headlessArgv.slice(0, 2)).toEqual(["-p", ""]);
      expect(headlessArgv.join(" ")).not.toContain(NONCE);
      expect(headlessStdin).toBe(promptText);
      for (const command of panes) {
        expect(command).toContain(settings);
        expect(command).toMatch(/--settings '\{"promptSuggestionEnabled":false\}' --[A-Za-z]/);
      }
      expect(flags).toContain("--settings");
    };

    assertLaunchContract(argv, stdin, paneCommands, claudeCode.hardcodedFlags!.flags);
    expect(() => assertLaunchContract(["-p", promptText, "--model", "fable"], "", paneCommands, claudeCode.hardcodedFlags!.flags)).toThrow();
    expect(() => assertLaunchContract(argv, stdin, paneCommands.map((command) => command.replace(` ${settings}`, "")), claudeCode.hardcodedFlags!.flags)).toThrow();
    expect(() => assertLaunchContract(argv, stdin, paneCommands, claudeCode.hardcodedFlags!.flags.filter((flag) => flag !== "--settings"))).toThrow();
  });
  // OBS-903 / RULING-222-42: what the daemon hands parse() is the launch script's whole captured stream —
  // banner, the subprocess driver's interleaved stderr, qwen's JSON array, the TICKMARKR_EXIT line — never
  // the bare array the earlier replays fed it. The clause-4 probe's live PONG completion read "unparseable".
  const YOLO_WARNING = "Warning: running headless with --yolo / approval-mode=yolo and no sandbox. All tool calls (shell, write, edit) auto-execute at this process's privilege level. Enable a sandbox via --sandbox / QWEN_SANDBOX, or set QWEN_CODE_SUPPRESS_YOLO_WARNING=1 to silence this notice.\n";
  const wrapAsDaemonStream = (stdout: string, exitCode: number): string => {
    const banner = execSync(bannerShell(), { shell: "/bin/bash", encoding: "utf8" });
    return `${banner}${YOLO_WARNING}${stdout}\nTICKMARKR_EXIT_${NONCE}:${exitCode}\n`;
  };

  test("test: a qwen event stream wrapped the way the daemon captures it (ANSI banner before, the driver's stderr warning interleaved, the nonce exit line after) decodes to ok true on a trailer and to cause startup-failure naming error.message on a no-auth result event, whereas a parser that JSON-parses the whole buffer reads both as malformed", () => {
    const trailer = `TICKMARKR_RESULT_${NONCE} {"ok":true,"summary":"decoded through the wrapper","deviations":[]}`;
    const success = JSON.stringify([
      { type: "system", subtype: "init", model: "qwen3.8-max" },
      { type: "assistant", message: { content: [{ type: "text", text: trailer }] } },
      { type: "result", subtype: "success", is_error: false, permission_denials: [], stats: { models: { "qwen3.8-max": { api: { totalErrors: 0 } } } } },
    ]);
    const noAuth = JSON.stringify([
      { type: "result", subtype: "error_during_execution", is_error: true, usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [], error: { message: "No auth type is selected. Please configure an auth type (e.g. via settings or `--auth-type`) before running in non-interactive mode." } },
    ]);
    const wrappedSuccess = wrapAsDaemonStream(success, 0);
    expect(wrappedSuccess).toMatch(/\x1b\[/); // the banner's ANSI is really in front of the array
    expect(() => JSON.parse(wrappedSuccess)).toThrow(); // the whole-buffer parse the old code relied on
    expect(parseQwenResult(wrappedSuccess, NONCE)).toMatchObject({ ok: true, summary: "decoded through the wrapper" });
    expect(parseQwenResult(wrapAsDaemonStream(noAuth, 1), NONCE)).toMatchObject({
      ok: false,
      cause: "startup-failure",
      summary: expect.stringContaining("No auth type is selected"),
    });
    // The bare shapes keep their verdicts; junk with no array inside is still malformed.
    expect(parseQwenResult(success, NONCE)).toMatchObject({ ok: true });
    expect(parseQwenResult(`${YOLO_WARNING}[not an array\nTICKMARKR_EXIT_${NONCE}:0\n`, NONCE)).toMatchObject({ ok: false, cause: "malformed-verdict" });
  });

  test("test: the verbatim 2026-09-04 worker-form captures replay through the daemon wrapper — the live PONG completions decode (never malformed, never startup-failure) and the empty-HOME capture classifies startup-failure naming the no-auth message", () => {
    for (const name of ["live", "dead-endpoint", "safe-mode"]) {
      const stdout = fixture(`${name}.stdout`);
      expect(stdout).toContain('"text":"PONG"');
      const parsed = parseQwenResult(wrapAsDaemonStream(stdout, 0), NONCE);
      expect(parsed.cause, name).not.toBe("malformed-verdict");
      expect(parsed.cause, name).not.toBe("startup-failure");
      expect(parsed.summary, name).not.toContain("unparseable");
    }
    expect(parseQwenResult(wrapAsDaemonStream(fixture("no-auth-home.stdout"), 1), NONCE)).toMatchObject({
      ok: false,
      cause: "startup-failure",
      summary: expect.stringContaining("No auth type is selected"),
    });
  });

  test("every qwen replay test reads its captures from tests/fixtures/qwen with no existence guard and the fixture init events carry no operator slash command or agent names as the diff shows in the test and fixture hunks", () => {
    const source = readFileSync(join(import.meta.dirname, "qwen.test.ts"), "utf8");
    expect(source.includes("test." + "skipIf")).toBe(false);
    expect(source.includes("exists" + "Sync")).toBe(false);
    expect(source.includes(".planning/" + "assessments/2026-09-03-qwen-cli-probe")).toBe(false);
    expect(source.includes(".planning/" + "assessments/2026-09-04-qwen-live-worker-form")).toBe(false);

    for (const name of readdirSync(FIXTURE_DIR).filter((candidate) => candidate.endsWith(".stdout"))) {
      for (const event of JSON.parse(fixture(name)) as Array<Record<string, unknown>>) {
        if (event.type !== "system" || event.subtype !== "init") continue;
        expect(event.slash_commands, name).toEqual(Array((event.slash_commands as string[]).length).fill("scrubbed"));
        expect(event.agents, name).toEqual(Array((event.agents as string[]).length).fill("scrubbed"));
      }
    }
  });
});
