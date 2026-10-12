import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compareToBaseline } from "../../src/gates/baseline.js";
import { evaluateManifestedTest } from "../../src/gates/test-manifest.js";
import { timeoutShaped } from "../../src/gates/timeout-shaped.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

function receiptFixture() {
  const repo = makeRepo({ "out.txt": "" });
  const artifactDir = makeTestTempDir("s100-receipt-");
  return async (output: string, env: NodeJS.ProcessEnv = {}, command = "cat out.txt") => {
    writeFileSync(join(repo, "out.txt"), output);
    const [row] = await compareToBaseline(repo, { build: command }, { commands: {} }, ["build"], {
      evidence: { artifactDir, env },
    });
    const receipt = row!.evidenceReceipt!;
    return { text: readFileSync(join(artifactDir, receipt.stdout.path), "utf8"), redaction: receipt.redaction };
  };
}

test("test: a secret-named variable holding 1 on true or 8080 leaves those bytes verbatim in the retained receipt artifact with redaction not material through production compareToBaseline versus RECEIPT_SECRET s3! and API_TOKEN ab12 staying withheld (S100-P1 P2 P3 F1 F2)", async () => {
  const capture = receiptFixture();
  const priorFlag = process.env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH;
  try {
    process.env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH = "1";
    const flag = await capture("1 failed | 10 passed; exit code 137");
    expect(flag.text).toBe("1 failed | 10 passed; exit code 137");
    expect(flag.redaction).toMatchObject({ material: false, counts: { secretEnv: 0 } });
  } finally {
    if (priorFlag === undefined) delete process.env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH;
    else process.env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH = priorFlag;
  }
  const otherFlags = await capture("ON TrUe 8080", { AUTH_DEBUG: "ON", X_TOKEN_REQUIRED: "TrUe", AUTH_PORT: "8080" });
  expect(otherFlags.text).toBe("ON TrUe 8080");
  expect(otherFlags.redaction).toMatchObject({ material: false, counts: { secretEnv: 0 } });
  const secrets = await capture("s3! ab12", { RECEIPT_SECRET: "s3!", API_TOKEN: "ab12" });
  expect(secrets.text).toBe("[REDACTED] [REDACTED]");
  expect(secrets.redaction).toMatchObject({ material: true, counts: { secretEnv: 2 } });
});

test("test: through production compareToBaseline an inline assignment is judged under its own name so inline AUTH_REFRESH=1 and an inline API_TOKEN=1 over an inherited xy9z keep 1 verbatim versus inline API_TOKEN=ab12 being withheld even over an inherited API_TOKEN=1 and the inherited xy9z staying withheld (S100-P6 P7 F7 F8 F9)", async () => {
  const capture = receiptFixture();
  expect((await capture("1 failed", {}, "AUTH_REFRESH=1 cat out.txt")).text).toBe("1 failed");
  const override = await capture("1 failed; xy9z", { API_TOKEN: "xy9z" }, "API_TOKEN=1 cat out.txt");
  expect(override.text).toBe("1 failed; [REDACTED]");
  expect(override.redaction.counts.secretEnv).toBe(1);
  expect((await capture("ab12", {}, "API_TOKEN=ab12 cat out.txt")).text).toBe("[REDACTED]");
  const reverse = await capture("ab12 1", { API_TOKEN: "1" }, "API_TOKEN=ab12 cat out.txt");
  expect(reverse.text).toBe("[REDACTED] 1");
  expect(reverse.redaction.counts.secretEnv).toBe(1);
});

test("test: a failing manifested run keeps its stdout-tail timeout phrase in the verdict details so they still read as timeout-shaped with the flag set through production evaluateManifestedTest versus a manifested API_TOKEN=ab12 command withholding ab12 from those details (S100-P4 F10)", async () => {
  const repo = makeRepo({ "tests/a.test.ts": "test('a', () => {});\n", ".gitignore": "node_modules/\n" });
  const bin = join(repo, "node_modules/.bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "vitest"), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const file = 'tests/a.test.ts';
if (process.argv[2] === 'list') {
  console.log(JSON.stringify([{ file: path.resolve(file), name: file }]));
  process.exit(0);
}
const now = Date.now();
fs.writeFileSync(process.env.TICKMARKR_TEST_REPORT, JSON.stringify({
  nonce: process.env.TICKMARKR_TEST_NONCE, requested: [file], started: { [file]: now },
  completed: { [file]: { at: now, status: 'failed', failures: ['ordinary assertion'] } },
  certificate: { at: now, exitCode: 1, errors: 0, diagnostics: [] },
}));
process.stdout.write(process.env.API_TOKEN === 'ab12' ? 'ab12' : 'Test timed out in 1000ms');
process.exit(1);
`, { mode: 0o755 });
  const priorFlag = process.env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH;
  const priorToken = process.env.API_TOKEN;
  try {
    process.env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH = "1";
    process.env.API_TOKEN = "1";
    const timeout = await evaluateManifestedTest("vitest run", repo, { artifactDir: makeTestTempDir("s100-manifest-") });
    expect(timeout.pass).toBe(false);
    expect(timeout.details).toContain("Test timed out in 1000ms");
    expect(timeoutShaped(timeout.details)).toBe(true);
    const secret = await evaluateManifestedTest("API_TOKEN=ab12 vitest run", repo, { artifactDir: makeTestTempDir("s100-manifest-") });
    expect(secret.pass).toBe(false);
    expect(secret.details).toContain("[REDACTED]");
    expect(secret.details).not.toContain("ab12");
  } finally {
    if (priorFlag === undefined) delete process.env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH;
    else process.env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH = priorFlag;
    if (priorToken === undefined) delete process.env.API_TOKEN;
    else process.env.API_TOKEN = priorToken;
  }
});

test("test: ordinary short values stay verbatim in the retained artifact versus a non-HOME value of eight or more characters or a complete token or a token or password assignment or a SERVICE_SECRET equal to HOME each staying withheld and never read as the HOME label (S100-P5 F3 F4 F5 F6)", async () => {
  const capture = receiptFixture();
  const ordinary = await capture("1 test vi 12345", { SHLVL: "1", NODE_ENV: "test", EDITOR: "vi", DAEMON_PID: "12345" });
  expect(ordinary.text).toBe("1 test vi 12345");
  expect(ordinary.redaction.material).toBe(false);
  const long = await capture("abcdefgh", { SERVICE_VALUE: "abcdefgh" });
  expect(long.text).toBe("[REDACTED]");
  expect((await capture("12345678", { AUTH_PORT: "12345678" })).text).toBe("[REDACTED]");
  for (const token of ["sk-abcdefghijkl", "ghp_abcdefghijklmnop", "AKIA" + "ABCDEFGHIJKLMNOP"]) {
    expect((await capture(token)).text).toBe("[REDACTED]");
  }
  expect((await capture("token=ab12 password:s3!")).text).toBe("[REDACTED] [REDACTED]");
  const home = await capture("/n/h", { HOME: "/n/h", SERVICE_SECRET: "/n/h" });
  expect(home.text).toBe("[REDACTED]");
  expect(home.text).not.toContain("$HOME");
  expect(home.redaction.counts.secretEnv).toBe(1);
});
