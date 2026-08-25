import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";

// OBS-552: seat-send.sh is the shipped verified-delivery path, and its send receipt could not fail.
// `herdr agent prompt`'s exit code and stderr were both discarded, so a refusal that never touched the
// input box left an empty prompt line — byte-identical to a clean submit — and the script exited 0
// announcing DELIVERED_SUBMITTED, or QUEUED_BEHIND_TURN when the seat read `working`, which also
// explained away the silence that followed. Measured against a live seat whose occupant herdr detects
// but will not drive: `agent prompt` → `agent_not_ready`, nothing typed; `pane run` → delivered.
//
// These drive the REAL shipped script against a fake `herdr` on PATH — the makeStub idiom from
// tests/drivers/herdr.test.ts, applied to a shipped asset rather than the driver.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "skills/tickmarkr-overseer/scripts/seat-send.sh");

type StubOpts = {
  /** what `agent prompt` does: deliver | refuse pre-write | fail ambiguously */
  prompt?: "ok" | "not_ready" | "ambiguous";
  /** what `pane run` does when the fallback reaches for it */
  paneRun?: "ok" | "fail";
  /** the seat's scraped lifecycle state */
  status?: "idle" | "working";
  /** text the stub reports on the prompt line (a draft or a ghost) */
  promptLine?: string;
  /** pane id `agent get` resolves to; empty string → unresolvable */
  paneId?: string;
  /** replay a captured screen for `agent read` instead of the synthetic one-liner */
  readFixture?: string;
};

function makeStub(opts: StubOpts = {}): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-seat-send-"));
  const log = join(dir, "log.txt");
  const status = opts.status ?? "idle";
  const paneId = opts.paneId === undefined ? "w1:p9" : opts.paneId;
  const line = opts.promptLine ?? "";
  const promptCase =
    opts.prompt === "not_ready"
      ? `echo '{"error":{"code":"agent_not_ready","message":"agent w1:p9 is not an active named agent"}}' >&2; exit 1`
      : opts.prompt === "ambiguous"
        ? `echo 'broker timeout' >&2; exit 1`
        : `echo '{}'`;
  const paneRunCase = opts.paneRun === "fail" ? `echo 'pane closed' >&2; exit 1` : `echo '{}'`;
  const bin = join(dir, "herdr");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
echo "$@" >> '${log}'
case "$1 $2" in
  "agent get") echo '{"result":{"agent":{"agent":"prime-agent","agent_status":"${status}"${paneId ? `,"pane_id":"${paneId}"` : ""}}}}' ;;
  "agent read") ${opts.readFixture ? `cat '${opts.readFixture}'` : `printf '%s\\n' '  ❯ ${line}'`} ;;
  "agent prompt") ${promptCase} ;;
  "agent send-keys") echo '{}' ;;
  "pane run") ${paneRunCase} ;;
  *) echo '{}' ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin: dir, log };
}

function run(stub: { bin: string }, target = "w1:p9", msg = "hold the merge"): { code: number; out: string } {
  try {
    const out = execFileSync("bash", [SCRIPT, target, msg], {
      env: { ...process.env, PATH: `${stub.bin}:${process.env.PATH}` },
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

const calls = (log: string): string[] => readFileSync(log, "utf8").trim().split("\n");

describe("seat-send.sh delivery outcomes (OBS-552)", () => {
  test("a delivering agent prompt reports DELIVERED_SUBMITTED and never reaches for the pane surface", () => {
    const stub = makeStub({ prompt: "ok" });
    const r = run(stub);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^DELIVERED_SUBMITTED /);
    expect(r.out).not.toContain("via pane run");
    expect(calls(stub.log).some((c) => c.startsWith("pane run"))).toBe(false);
  });

  test("an explicit pre-write agent_not_ready falls back to pane run EXACTLY once and names the surface", () => {
    const stub = makeStub({ prompt: "not_ready" });
    const r = run(stub);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^DELIVERED_SUBMITTED /);
    expect(r.out).toContain("via pane run w1:p9");
    expect(r.out).toContain("agent_not_ready");
    const paneRuns = calls(stub.log).filter((c) => c.startsWith("pane run"));
    expect(paneRuns).toHaveLength(1); // one delivery, never a retry loop
    expect(paneRuns[0]).toContain("hold the merge");
  });

  test("an AMBIGUOUS non-zero prompt never falls back — the write may have landed, so it surfaces and stops", () => {
    const stub = makeStub({ prompt: "ambiguous" });
    const r = run(stub);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^SEND_UNVERIFIED /);
    expect(r.out).toContain("broker timeout"); // the discarded cause is now the report
    expect(r.out).toMatch(/NOT retrying/);
    expect(calls(stub.log).some((c) => c.startsWith("pane run"))).toBe(false);
  });

  test("the false success this fixes: a pre-write refusal into a WORKING seat must not read as QUEUED_BEHIND_TURN", () => {
    // The shipped defect's exact shape — `working` set QUEUED=1, the refusal wrote nothing, the empty
    // prompt line matched no draft, and the script exited 0 blaming the seat's turn for the silence.
    const stub = makeStub({ prompt: "not_ready", status: "working" });
    const r = run(stub);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^QUEUED_BEHIND_TURN /);
    // it may only say QUEUED once the message actually left through some surface, and it names which
    expect(r.out).toContain("via pane run w1:p9");
    expect(calls(stub.log).filter((c) => c.startsWith("pane run"))).toHaveLength(1);
  });

  test("a foreign draft in the box is still refused before any send, fallback or not", () => {
    // no apostrophe on purpose: the stub embeds this in a single-quoted shell string
    const stub = makeStub({ prompt: "ok", promptLine: "a foreign unsent line" });
    const r = run(stub);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/^REFUSED_BOX_OCCUPIED /);
    expect(calls(stub.log).some((c) => c.startsWith("agent prompt"))).toBe(false);
    expect(calls(stub.log).some((c) => c.startsWith("pane run"))).toBe(false);
  });

  test("when the fallback also fails, BOTH causes are surfaced and nothing claims delivery", () => {
    const stub = makeStub({ prompt: "not_ready", paneRun: "fail" });
    const r = run(stub);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^SEND_FAILED /);
    expect(r.out).toContain("agent_not_ready"); // cause 1
    expect(r.out).toContain("pane closed"); // cause 2
    expect(r.out).not.toContain("DELIVERED");
  });

  test("a pre-write refusal with no resolvable pane refuses rather than guessing a target", () => {
    const stub = makeStub({ prompt: "not_ready", paneId: "" });
    const r = run(stub);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^SEND_REFUSED /);
    expect(r.out).toContain("no pane id resolved");
    expect(calls(stub.log).some((c) => c.startsWith("pane run"))).toBe(false);
  });

  // OBS-552 ADDENDUM — the residual the first fix could not see. `agent prompt` returns RC 0, so no
  // refusal branch fires; kimi moves the text into a STAGED queue and EMPTIES the ordinary box, so the
  // prompt-line discriminator reads "clear of our text" and the receipt announced DELIVERED_SUBMITTED
  // while six consecutive directives never ran and the pane revision never moved off 3.
  // Captured screen + provenance: tests/fixtures/kimi-staged-queue/.
  describe("staged-queue receipt (captured kimi negative control)", () => {
    const FIXTURE = join(ROOT, "tests/fixtures/kimi-staged-queue/visible.txt");
    const V196_RECEIPT = join(ROOT, "tests/fixtures/kimi-staged-queue/seat-send-v1.96.sh");
    // the fixture's staged entry, whose rendered text must be a PREFIX of the message under test
    const STAGED_MSG =
      "Verify that yourself before you redo that write — read /tmp/ORCH-CORRECTION-02.md and confirm on disk";

    test("a directive sitting in the staged queue fails closed as SEND_UNVERIFIED, never DELIVERED", () => {
      const stub = makeStub({ prompt: "ok", readFixture: FIXTURE });
      const r = run(stub, "w1:p9", STAGED_MSG);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/^SEND_UNVERIFIED /);
      expect(r.out).not.toContain("DELIVERED_SUBMITTED");
      expect(r.out).toContain("STAGED in the seat's queue");
      expect(r.out).toContain("Do NOT re-send");
    });

    test("it never retries and never reaches for another surface — the queue may drain and run it twice", () => {
      const stub = makeStub({ prompt: "ok", readFixture: FIXTURE });
      run(stub, "w1:p9", STAGED_MSG);
      const c = calls(stub.log);
      expect(c.filter((l) => l.startsWith("agent prompt"))).toHaveLength(1); // the one send, no more
      expect(c.some((l) => l.startsWith("pane run"))).toBe(false);
      expect(c.some((l) => l.startsWith("agent send-keys"))).toBe(false); // no bare enter into a staged box
    });

    test("a WORKING seat's queue cannot be excused as QUEUED_BEHIND_TURN either", () => {
      const stub = makeStub({ prompt: "ok", status: "working", readFixture: FIXTURE });
      const r = run(stub, "w1:p9", STAGED_MSG);
      expect(r.code).toBe(1);
      expect(r.out).not.toContain("QUEUED_BEHIND_TURN");
      expect(r.out).toMatch(/^SEND_UNVERIFIED /);
    });

    test("a foreign entry blocking the queue is reported too — nothing sent now is running", () => {
      const stub = makeStub({ prompt: "ok", readFixture: FIXTURE });
      const r = run(stub, "w1:p9", "an unrelated directive");
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/^SEND_UNVERIFIED /);
      expect(r.out).toContain("not draining");
    });

    // RED CAPABILITY, and the reason the fixture earns its place: the receipt as shipped in 1.96.0
    // returns the false success against this exact input. A guard whose control is not an instance of
    // what it catches does not get built (control-must-be-an-instance).
    test("the 1.96.0 receipt reports DELIVERED_SUBMITTED against this same input — the defect, pinned", () => {
      const stub = makeStub({ prompt: "ok", readFixture: FIXTURE });
      const out = execFileSync("bash", [V196_RECEIPT, "w1:p9", STAGED_MSG], {
        env: { ...process.env, PATH: `${stub.bin}:${process.env.PATH}` },
        encoding: "utf8",
        stdio: "pipe",
      });
      expect(out).toMatch(/^DELIVERED_SUBMITTED /); // exit 0, nothing running — the residual
    });
  });

  test("the shipped script and an installed repo twin, when present, are byte-identical", () => {
    const shipped = readFileSync(SCRIPT);
    expect(shipped.byteLength).toBeGreaterThan(0);
    const twin = join(ROOT, ".claude/skills/tickmarkr-overseer/scripts/seat-send.sh");
    if (existsSync(twin)) expect(readFileSync(twin)).toEqual(shipped);
  });

  // OBS-603 — the THIRD member of the "something other than a live draft renders on a ❯ line" class
  // that the staged-queue and ghost discriminators already cover. claude-code echoes a SUBMITTED
  // message into the transcript with the same ❯ glyph, ABOVE the live input box, and a long one still
  // occupies the 14-line window. `head -1` returned that echo and produced TWO false verdicts against
  // one delivered message: SEND_UNSUBMITTED on the send that made the echo, then REFUSED_BOX_OCCUPIED
  // on the NEXT send — which is the worse half, because it refuses to deliver at all and leaves the
  // seat unreachable until the echo scrolls out. Both reactions the script warns against are then
  // wrong: re-sending appends and submits both, escalating reports a failure that never happened.
  // The live box is ALWAYS the LAST ❯ line, so tail -1 is correct in both states.
  // Captured screen: tests/fixtures/claude-submitted-echo/.
  describe("submitted-echo screen (captured claude-code negative control, OBS-603)", () => {
    const FIXTURE = join(ROOT, "tests/fixtures/claude-submitted-echo/pane-read.txt");
    // the fixture's echoed message, whose rendered first line must be a PREFIX of the message under test
    const ECHOED_MSG =
      "OVSR-ADOPT-2011: fresh OVERSEER live in wZ:pBX (tab 'OVERSEER 2.1.1') after an operator /clear;" +
      " predecessor stood down 12:40. YOU KEEP THE LOOP - I have touched no compile/plan/run/resume/approve" +
      " and will not. Verified from disk, not from your report: graph T1 files[] carries" +
      " tests/run/notify-identity.test.ts (surface 20); daemon pid 36490 alive with cwd in-repo.";

    test("a submitted message's own echo is not read as a draft sitting unsent", () => {
      const stub = makeStub({ prompt: "ok", status: "working", readFixture: FIXTURE });
      const r = run(stub, "w1:p9", ECHOED_MSG);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^QUEUED_BEHIND_TURN /); // working seat, empty box => queued, not sitting
      expect(r.out).not.toContain("SEND_UNSUBMITTED");
    });

    test("the echo does not read as an OCCUPIED box — the next directive still delivers", () => {
      const stub = makeStub({ prompt: "ok", status: "working", readFixture: FIXTURE });
      const r = run(stub, "w1:p9", ECHOED_MSG);
      expect(r.out).not.toContain("REFUSED_BOX_OCCUPIED");
      expect(calls(stub.log).filter((l) => l.startsWith("agent prompt"))).toHaveLength(1);
    });

    test("an idle seat with the same screen reports plain delivery", () => {
      const stub = makeStub({ prompt: "ok", status: "idle", readFixture: FIXTURE });
      const r = run(stub, "w1:p9", ECHOED_MSG);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^DELIVERED_SUBMITTED /);
    });
  });
});
