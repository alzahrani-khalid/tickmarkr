import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { ENTRY, prepareBuiltCli } from "../helpers/built-cli.js";
import { shellFixture } from "../fixtures/cockpit/final/capture-fixture.js";

/**
 * OBS-965 on a REAL tty: pty-spawn the BUILT CLI, write one SGR pointer report, then Down, and read
 * the selection move off the frame. Zero tokens — the cockpit observes a fixture journal, no agent
 * runs. A PassThrough fake cannot show this defect (16 KiB buffer); only a tty.ReadStream
 * (highWaterMark 0, readStop after every chunk) goes deaf, so the proof has to be a pty.
 *
 * The report must be ALONE in its chunk — a busy child coalesces two writes into one read, and one
 * chunk carrying both never went deaf. The barrier is the FRAME, which both kernels let us observe:
 * the report is a press on the task row below the selection, so the cockpit paints that row selected
 * once it has read the report; only then is Down written. (A stdin offset is not a consumption
 * counter on Linux — tty_read never advances the file position — so it is diagnostics only.)
 */
const DRIVER = String.raw`
import fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time
SELFCHECK = sys.argv[1:2] == ["--selfcheck"]
result = {"painted": False, "before": None, "target": None, "pressed": False, "moved": False, "after": [], "exited": False, "offsets": {}}
class Deadline(Exception): pass
# ARMED is the ONLY thing that lets a signal raise. The handler is installed before anything else and
# never swapped: while ARMED it raises Deadline exactly once and disarms in the same handler call; when
# not ARMED it only records. The try body disarms as its last statement and the except block as its
# first, so by the time finally runs, ARMED is False on every path (normal, Deadline, other exception)
# and no instruction of cleanup() — not even its entry — can be interrupted by a raise.
ARMED = False
def on_signal(signum, frame):
    global ARMED
    if ARMED:
        ARMED = False
        raise Deadline("signal %d" % signum)
    result.setdefault("signalsDuringCleanup", []).append(signum)
signal.signal(signal.SIGTERM, on_signal); signal.signal(signal.SIGALRM, on_signal)
me = os.getpid()
pid = None
reaped = False
def reap():
    # TERM -> bounded wait -> KILL -> wait until waitpid RETURNS THE PID. Falling out without that reap
    # is a reported driver failure, never silent.
    global reaped
    if reaped or pid is None: return
    for sig, bound in ((signal.SIGTERM, 1.5), (signal.SIGKILL, 10.0)):
        try: os.kill(pid, sig)
        except ProcessLookupError: pass
        until = time.monotonic() + bound
        while time.monotonic() < until:
            try: done, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError: done = pid
            if done == pid: reaped = True; result["reapedBy"] = sig; return
            time.sleep(0.02)
    result["driverFailure"] = "child %d not reaped 10s after SIGKILL" % pid
def cleanup():
    global ARMED
    ARMED = False        # one store, already False on every path in; from here every signal is recorded
    signal.alarm(0)
    if SELFCHECK:        # deliver both signals INSIDE cleanup, synchronized with its state, not with a timer
        os.kill(me, signal.SIGALRM); os.kill(me, signal.SIGTERM)
    reap()
if SELFCHECK:
    # An INSTANCE of the claim: a child that has acknowledged ignoring SIGTERM (escalation required),
    # SIGALRM pending at cleanup ENTRY, and SIGALRM+SIGTERM delivered inside cleanup.
    rd, wr = os.pipe()
    pid = os.fork()
    if pid == 0:
        # A plain child first: drop the driver's inherited handlers (a forked child keeps them and would
        # survive TERM by inheritance, which is not the control). THEN the control: TERM must not be enough.
        signal.signal(signal.SIGTERM, signal.SIG_DFL); signal.signal(signal.SIGALRM, signal.SIG_DFL)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)   # CONTROL
        os.write(wr, b"r")
        while True: time.sleep(1)
    os.close(wr); ready = os.read(rd, 1) == b"r"; os.close(rd)
    try:
        ARMED = True; signal.alarm(45)
        ARMED = False
    except BaseException as e:
        ARMED = False; result["error"] = repr(e)
    finally:
        os.kill(me, signal.SIGALRM)   # pending when cleanup() is entered: the first-line probe, recorded not raised
        cleanup()
    try: os.kill(pid, 0); gone = False
    except ProcessLookupError: gone = True
    try: os.waitpid(pid, os.WNOHANG); waitpid_says_reaped = False
    except ChildProcessError: waitpid_says_reaped = True
    seen = set(result.get("signalsDuringCleanup", []))
    result.update({"selfcheck": True, "childReady": ready, "reaped": reaped, "childGone": gone, "waitpidSaysReaped": waitpid_says_reaped})
    ok = ready and reaped and gone and waitpid_says_reaped and result.get("reapedBy") == signal.SIGKILL and {signal.SIGALRM, signal.SIGTERM} <= seen and "driverFailure" not in result and "error" not in result
    result["ok"] = ok
    print("DEAF_BOARD_SELFCHECK " + json.dumps(result))
    sys.exit(0 if ok else 1)
node, entry, cwd, run_id = sys.argv[1:5]
buf = b""
def pump(pred, timeout):
    global buf
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred(): return True
        ready, _, _ = select.select([fd], [], [], 0.05)
        if fd in ready:
            try: chunk = os.read(fd, 65536)
            except OSError: return pred()
            if not chunk: return pred()
            buf += chunk
    return pred()
def stdin_offset():
    # macOS diagnostics only (RULING-231-19 measured the live board this way); never gates.
    if sys.platform != "darwin": return None
    try: out = subprocess.run(["lsof", "-a", "-o", "-Fo", "-p", str(pid), "-d", "0"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError): return None
    for line in out.splitlines():
        if line.startswith("o0t"): return int(line[3:])
    return None
ansi = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
def plain(raw): return ansi.sub("", raw.decode("utf8", "replace")).replace("\r", "")
def selections(raw): return re.findall(r"❯ (\S+)", plain(raw))
try:
    ARMED = True
    signal.alarm(45)   # always inside the 60 s spawnSync timeout, so cleanup below runs
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        env = dict(os.environ, TERM="xterm-256color", NO_COLOR="1")
        try: os.execve(node, [node, entry, "ui", run_id, "--view", "run"], env)
        finally: os._exit(127)
    result["painted"] = pump(lambda: b"q Quit" in buf and len(selections(buf)) > 0, 20)
    lines = plain(buf).split("\n")
    row = next((i for i, line in enumerate(lines) if "❯ " in line), None)
    if row is not None:
        result["before"] = selections(buf)[-1]
        below = lines[row + 1]
        hit = re.search(r"│\s+(T\S+)", below)
        if hit: result["target"] = hit.group(1); column = below.index(hit.group(1)) + 2
    result["offsets"]["painted"] = stdin_offset()
    if result["target"]:
        mark = len(buf)
        os.write(fd, ("\x1b[<0;%d;%dM" % (column, row + 2)).encode())   # press the row below: ONE report, alone
        result["pressed"] = pump(lambda: result["target"] in selections(buf[mark:]), 8)   # the frame says it was read
        result["offsets"]["pressed"] = stdin_offset()
        mark = len(buf)
        os.write(fd, b"\x1b[B")   # Down — the key the deaf board never heard
        result["moved"] = pump(lambda: any(s != result["target"] for s in selections(buf[mark:])), 6)
        result["after"] = [s for s in selections(buf[mark:]) if s != result["target"]][:1]
        result["offsets"]["down"] = stdin_offset()
    os.write(fd, b"q")
    for _ in range(100):
        done, status = os.waitpid(pid, os.WNOHANG)
        if done == pid: result["exited"] = True; reaped = True; break
        pump(lambda: False, 0.05)
    ARMED = False
except BaseException as e:
    ARMED = False
    result["deadline" if isinstance(e, Deadline) else "error"] = repr(e)
finally:
    cleanup()
    print("DEAF_BOARD_RESULT " + json.dumps(result))
`;

const python = spawnSync("python3", ["-c", "import pty"], { encoding: "utf8" }).status === 0;

describe.skipIf(process.env.TICKMARKR_E2E !== "1")("e2e: the cockpit on a real tty keeps hearing keys after a pointer report (OBS-965)", () => {
  test.skipIf(!python)("pointer report, then Down: the built CLI moves the selection", () => {
    // Pre-check the driver's own cleanup: a child that ignores SIGTERM, SIGALRM and SIGTERM delivered
    // during cleanup, and the child must still be reaped (waitpid returned its pid) — every exit path
    // of the real run below goes through that same cleanup().
    const check = spawnSync("python3", ["-", "--selfcheck"], { input: DRIVER, encoding: "utf8", timeout: 30_000, killSignal: "SIGTERM" });
    const checkLine = check.stdout.split("\n").find(l => l.startsWith("DEAF_BOARD_SELFCHECK "));
    if (!checkLine) expect.fail(`cleanup self-check produced no result\nstatus: ${check.status}\nstderr:\n${check.stderr}`);
    const selfcheck = JSON.parse(checkLine.slice("DEAF_BOARD_SELFCHECK ".length)) as { childReady: boolean; reaped: boolean; childGone: boolean; waitpidSaysReaped: boolean; reapedBy?: number; driverFailure?: string; error?: string; signalsDuringCleanup?: number[] };
    // reapedBy 9: SIGKILL escalation actually happened (the child ignored SIGTERM); 14 and 15: SIGALRM and
    // SIGTERM were both handled while cleanup ran, recorded instead of raised.
    expect(selfcheck, `driver cleanup reaps a SIGTERM-ignoring child with signals landing mid-cleanup ${checkLine}`).toMatchObject({ childReady: true, reaped: true, childGone: true, waitpidSaysReaped: true, reapedBy: 9 });
    expect(selfcheck.signalsDuringCleanup, checkLine).toEqual(expect.arrayContaining([14, 15]));
    expect(selfcheck.driverFailure, checkLine).toBeUndefined();
    expect(selfcheck.error, checkLine).toBeUndefined();
    expect(check.status, checkLine).toBe(0);
    prepareBuiltCli();
    const f = shellFixture();
    try {
      const r = spawnSync("python3", ["-", process.execPath, ENTRY, f.cwd, f.runId], { input: DRIVER, encoding: "utf8", timeout: 60_000, killSignal: "SIGTERM" });
      const line = r.stdout.split("\n").find(l => l.startsWith("DEAF_BOARD_RESULT "));
      if (!line) expect.fail(`pty driver produced no result\nstatus: ${r.status}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`);
      const result = JSON.parse(line.slice("DEAF_BOARD_RESULT ".length)) as { painted: boolean; before: string | null; target: string | null; pressed: boolean; moved: boolean; after: string[]; exited: boolean; offsets: Record<string, number | null>; deadline?: string; driverFailure?: string };
      const evidence = JSON.stringify(result);
      expect(result.driverFailure, `the driver reaped its child ${evidence}`).toBeUndefined();
      expect(result.painted, `the run view painted with a selected row ${evidence}`).toBe(true);
      expect(result.target, `a task row sits below the selection ${evidence}`).not.toBeNull();
      expect(result.pressed, `the press report was read on its own: the frame selected the pressed row before Down was sent ${evidence}`).toBe(true);
      expect(result.moved, `Down after a pointer-only chunk moved the selection ${evidence}`).toBe(true);
      expect(result.after[0]).not.toBe(result.target);
      expect(result.exited, `q still quits ${evidence}`).toBe(true);
    } finally { f.close(); }
  }, 90_000);
});
