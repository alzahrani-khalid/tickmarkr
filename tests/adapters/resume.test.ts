import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeCode } from "../../src/adapters/claude-code.js";
import { codex } from "../../src/adapters/codex.js";
import { cursorAgent } from "../../src/adapters/cursor-agent.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { grok } from "../../src/adapters/grok.js";
import { kimi } from "../../src/adapters/kimi.js";
import { opencode } from "../../src/adapters/opencode.js";
import { pi } from "../../src/adapters/pi.js";

describe("resume commands", () => {
  test("claude-code shell-quotes the session id and new prompt", () => {
    const command = claudeCode.resumeCommand!("session'$(untrusted)", "/tmp/new prompt's.md", "fable'model");
    expect(command).toContain("claude -r 'session'\\''$(untrusted)'");
    expect(command).toContain("$(cat '/tmp/new prompt'\\''s.md')");
    expect(command).toContain("--model 'fable'\\''model'");
  });

  test("fake resumes the scripted worker from its new prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-resume-"));
    const script = join(dir, "script.json");
    const prompt = join(dir, "T1-a1.md");
    writeFileSync(script, JSON.stringify({ tasks: { T1: [
      { shell: "echo first", result: { ok: false, summary: "failed" } },
      { shell: "echo resumed", result: { ok: true, summary: "fixed" } },
    ] } }));
    writeFileSync(prompt, 'TICKMARKR_RESULT_retry {"ok":true|false}');
    const fake = new FakeAdapter(script);
    const output = execSync(fake.resumeCommand!("prior-session", prompt, "fake-1"), { encoding: "utf8" });
    expect(fake.parse(output, "retry")).toMatchObject({ ok: true, summary: "fixed" });
  });

  test("adapters without solid resume semantics omit the optional hook", () => {
    for (const adapter of [codex, cursorAgent, opencode, pi, grok]) expect(adapter.resumeCommand).toBeUndefined();
  });

  // v1.53 T3: probe-backed (2026-07-18) — `-p` + `-S <id>` compose cleanly; `-S <id>` is the
  // deterministic form, never bare `-S` (interactive picker) and never `-c` (cwd-keyed).
  test("the kimi resume command carries the captured session id with untrusted values shell quoted", () => {
    const command = kimi.resumeCommand!("session'$(untrusted)", "/tmp/new prompt's.md", "kimi'model");
    expect(command).toContain("kimi -S 'session'\\''$(untrusted)'");
    expect(command).toContain(`-p "$(cat '/tmp/new prompt'\\''s.md')"`);
    expect(command).toContain("--model 'kimi'\\''model'");
    expect(command).toContain("--output-format text");
  });

  test("the kimi session id is captured from the last valid resume trailer line of a completed run output", () => {
    const output = [
      "• The user wants a fix; a stale line may linger mid-transcript:",
      "To resume this session: kimi -r session_11111111-aaaa-bbbb-cccc-111111111111",
      '• TICKMARKR_RESULT_bullet88 {"ok":true,"summary":"done","deviations":[]}',
      "To resume this session: kimi -r session_25e8efca-cc09-4dd6-9dee-1951aec28581",
      "To resume this session: kimi -r not_a_session_id", // later but invalid — must not win
    ].join("\n");
    expect(kimi.sessionIdFrom!(output)).toBe("session_25e8efca-cc09-4dd6-9dee-1951aec28581");
  });

  test("malformed resume trailer text yields no captured session id", () => {
    for (const raw of [
      "",
      "no trailer at all",
      "To resume this session: kimi -r ",
      "To resume this session: kimi -r session_",
      "prose mentioning kimi -r session_25e8efca-cc09-4dd6-9dee-1951aec28581", // wrong line anchor
      "To resume this session: kimi -r session_25e8efca; rm -rf /", // trailing shell garbage breaks the anchor
    ]) {
      expect(kimi.sessionIdFrom!(raw)).toBeUndefined();
    }
  });
});
