import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { ORCA_FIXTURE_VERSION, type OrcaExec, type OrcaFamily } from "../../src/drivers/orca.js";

// A deterministic in-process stand-in for the `orca` CLI, replaying the envelope shapes RECORDED
// against live Orca 1.4.195 (.planning/assessments/2026-09-02-orca-1.4.195-capture/).
// Envelope shapes are based on the spike and the documented CLI contract:
//   status   → {ok, result:{runtime:{reachable, runtimeId, appVersion}}, _meta:{runtimeId}}
//   create   → {ok, result:{terminal:{handle, tabId, paneKey, worktreeId:"<repoId>::<path>",
//              title:<owned title>, surface:"visible", hostPlatform, executionHostId}}, _meta}
//              — no status field on the receipt
//   list     → {ok, result:{terminals:[{handle, tabId, worktreeId, worktreePath, title:<PANE
//              title, shell-controlled>, connected, writable, orphaned}], visualLayouts:[{root:{
//              tabs:[{tabId, title:<owned TAB title — the durable one>, panes:{handle}}]}}],
//              _meta} when --include-visual-layouts is passed. `--worktree` is OPTIONAL here
//              (`orca terminal list --help`, 1.4.186): omitted, the WHOLE terminal table answers,
//              across every checkout — which is the only listing an older run's leftover appears in.
//              Supplied, it scopes the rows AND their visual layouts to that one checkout.
//   read     → {ok, result:{terminal:{handle, status, tail[], truncated, limited, oldestCursor,
//              nextCursor, latestCursor, returnedLineCount}}, _meta} — a read of a CLOSED terminal
//              answers ok:true with that terminal's OWN dead record and retained scrollback (C4)
//   show     → {ok, result:{terminal:{handle, tabId, title:<PANE title>, connected, writable,
//              orphaned, worktreeId, worktreePath}}, _meta} — liveness only; NO status, NO agent
//   send     → {ok, result:{send:{handle, accepted:true, bytesWritten}}, _meta}
//   wait     → satisfied → {ok, result:{wait:{handle, condition, satisfied:true, status, exitCode}},
//              _meta}; elapsed → rc 1 + {ok:false, error:{code:"timeout",message:"timeout"}, _meta}
//              by default, with the recorded 1.4.186 ok:true satisfied:false receipt selectable
//   close    → {ok, result:{close:{handle, tabId, ptyKilled:<boolean>}}, _meta}; ptyKilled:false
//              is a successful close of an exited/no-live-PTY terminal
//   worktree create → the checkout verb Orca really exposes (`orca worktree create --help`,
//              1.4.186): `--name <name>` REQUIRED, `--repo <selector>` inferred when omitted,
//              `--base-branch <ref>` defaulting to the repo base. It MAKES a checkout — in Orca's
//              own worktree root, on a branch derived from --name — and answers with the record
//              shape `orca worktree list --json` returns: {ok, result:{worktree:{id:"<repoId>::
//              <path>", repoId, path, head, branch:"refs/heads/<name>", displayName, isBare,
//              isMainWorktree, git:{path, head, branch, ...}}}, _meta}. The driver never calls it;
//              it is here so a driver that DELEGATES checkout creation can be run for real.
//   EVERY refusal exits the process rc 1 with the structured ok:false body on stdout
//             (terminal_not_writable recorded on dead sends; terminal_handle_stale is the
//             documented restart signal for handles the runtime no longer knows).
// Zero tokens, zero subprocesses: the driver's exec seam is replaced, so `npm test` stays hermetic.

export const ORCA_FIXTURE_NONCE = "V21T1";
export const ORCA_LITERAL_MARKER = `TICKMARKR_MARK_${ORCA_FIXTURE_NONCE}`;

/**
 * The C2 read fixture, at the fake's default pageSize of 6 — exactly two cursor pages:
 *
 *   page 1 (lines 0-5) ends mid-token:              "TICKMARKR_MA"
 *   page 2 (lines 6-11) opens with the rest:        "RK_<nonce> · TICKMARKR_RESULT_<nonce> {"ok":`
 *   and the trailer itself is renderer-wrapped onto the next line behind margin chrome.
 *
 * So the literal marker exists only once the two PAGES are concatenated and the wrapped lines are
 * joined, and the trailer regex matches only once the margin chrome is stripped. A single unpaged
 * tail read of the last lines sees neither.
 */
export function pagedMarkerLines(nonce = ORCA_FIXTURE_NONCE): string[] {
  return [
    "[orca] terminal ready",
    "working 1/3",
    "working 2/3",
    "working 3/3",
    "about to emit",
    "TICKMARKR_MA",
    `RK_${nonce} · TICKMARKR_RESULT_${nonce} {"ok":`,
    `│ true,"summary":"orca fixture trailer","deviations":[]}`,
    "$ ",
    "$ ",
    "$ ",
    "$ ",
  ];
}

export interface FakeTerminalSpec {
  handle: string;
  /** the owned TAB title — the durable identity. Never appears on list rows or show records. */
  title: string;
  worktree: string;
  /** the shell-controlled PANE title list rows and show report. Real shells overwrite it to the
   *  running command's name ("bash") as soon as output is drawn; default "bash". */
  paneTitle?: string;
  /** durable tab identity handed out by create; default `<handle>-tab`. */
  tabId?: string;
  /** the READ record's status: "running" | "exited" | "unknown" | "" (absent). Default "running". */
  status?: string;
  lines?: string[];
  /** show liveness override. Default derives from status: connected unless exited. */
  connected?: boolean;
  writable?: boolean;
  orphaned?: boolean;
  /** show reports agentWait only when true; absent otherwise (recorded: no agent field at all). */
  agentWait?: boolean;
  /** the tui-idle wait condition is satisfied; absent/false means it returns the elapsed receipt. */
  tuiIdle?: boolean;
  /** conditions the runtime answers satisfied regardless of liveness (the show/wait race: a
   *  terminal can exit between a show poll and the wait that observes it). */
  waitConditions?: string[];
}

export interface FakeOrcaOpts {
  runtimeId?: string;
  appVersion?: string;
  /** `status` may be ok:true while the installed app reports no reachable runtime. */
  reachable?: boolean;
  /** what the ambient `--worktree active`/`current` selectors resolve to — whatever checkout the UI
   *  has focused. Absent: the selector falls back to the invoking CLI child's own cwd. Neither is
   *  ever the slot's checkout except by luck, which is the whole point of the `path:` selector. */
  activeWorktree?: string;
  terminals?: FakeTerminalSpec[];
  pageSize?: number;
  /** per-response-family raw override: malformed, truncated, or ok:false bytes */
  raw?: Partial<Record<OrcaFamily, string>>;
  /** every invocation answers like an absent CLI: rc 127, this text on stderr, nothing on stdout */
  cliMissing?: string;
  /** after N reads of a handle, that terminal starts reporting `flippedStatus` (a terminal that
   *  dies mid-sweep — the per-page validation fixture) */
  flipStatusAfterReads?: number;
  flippedStatus?: string;
  /** handle the next `terminal create` hands back */
  nextHandle?: string;
  /** create receipt surface. Default: "visible" (1.4.195). null omits the field. */
  createSurface?: string | null;
  /** elapsed wait transport. Default: 1.4.195 timeout refusal; old receipt remains selectable. */
  elapsedWaitTransport?: "1.4.195-timeout" | "1.4.186-satisfied-false";
  /** where `worktree create` puts the checkout — Orca's own root, never the caller's choice.
   *  Default: an `orca-worktrees` directory beside the repo. */
  worktreeRoot?: string;
}

interface FakeTerminal extends FakeTerminalSpec { lines: string[] }

const KNOWN_FAMILIES = new Set<string>(["status", "create", "list", "read", "send", "wait", "show", "close", "worktree"]);

const ALLOWED_FLAGS: Record<string, Set<string>> = {
  status: new Set(["--json"]),
  create: new Set(["--worktree", "--title", "--command", "--json"]),
  list: new Set(["--worktree", "--include-visual-layouts", "--limit", "--json"]),
  read: new Set(["--terminal", "--cursor", "--limit", "--json"]),
  send: new Set(["--terminal", "--text", "--enter", "--json"]),
  wait: new Set(["--terminal", "--for", "--timeout-ms", "--json"]),
  show: new Set(["--terminal", "--json"]),
  close: new Set(["--terminal", "--json"]),
  worktree: new Set(["--name", "--repo", "--base-branch", "--json"]),
};

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** Orca resolves a `--worktree path:` selector against the FILESYSTEM, so a checkout named through
 *  a symlinked spelling (`/tmp/x` vs `/private/tmp/x`, any symlinked parent) still answers with its
 *  own rows and its own layout. Matching the raw strings here would hand the driver a listing real
 *  Orca never produces, and would silently make the driver's own canonicalization untestable. */
function sameCheckout(a: string, b: string): boolean {
  const canon = (p: string): string => {
    try {
      return realpathSync(resolve(p));
    } catch {
      return resolve(p);
    }
  };
  return canon(a) === canon(b);
}

export class FakeOrca {
  /** every argv the driver issued, in order */
  readonly calls: string[][] = [];
  /** text submitted by a successful `terminal send --enter`, per handle */
  readonly sent = new Map<string, string[]>();
  /** text typed without `--enter`; real Orca writes the bytes but nothing is submitted. */
  readonly typed = new Map<string, string[]>();
  runtimeId: string;
  /** the live terminal table — tests seed scrollback and flip status directly on these records */
  terminals: FakeTerminal[];
  private pageSize: number;
  private reads = new Map<string, number>();
  private seq = 0;
  private closed = new Set<string>(); // closed handles keep answering close ok:true (recorded)

  constructor(private opts: FakeOrcaOpts = {}) {
    this.runtimeId = opts.runtimeId ?? "rt-1";
    this.pageSize = opts.pageSize ?? 6;
    this.terminals = (opts.terminals ?? []).map((t) => ({ ...t, lines: t.lines ?? [] }));
  }

  /** The fake-runtime restart: a NEW runtime identity, and whatever terminal table it now serves.
   *  Every envelope afterwards carries the new `_meta.runtimeId`, which is how the driver learns. */
  restart(runtimeId: string, terminals?: FakeTerminalSpec[]): void {
    this.runtimeId = runtimeId;
    if (terminals) this.terminals = terminals.map((t) => ({ ...t, lines: t.lines ?? [] }));
    this.reads.clear();
    this.closed.clear();
  }

  of(handle: string): FakeTerminal | undefined {
    return this.terminals.find((t) => t.handle === handle);
  }

  /** the terminal the most recent `terminal create` produced */
  last(): FakeTerminal | undefined {
    return this.terminals[this.terminals.length - 1];
  }

  /** argv families the driver issued (`terminal read` → "read"), in order */
  families(): string[] {
    return this.calls.map((a) => (a[0] === "terminal" ? a[1] : a[0]));
  }

  countOf(family: string): number {
    return this.families().filter((f) => f === family).length;
  }

  private envelope(result: unknown): string {
    return JSON.stringify({ ok: true, result, _meta: { runtimeId: this.runtimeId } });
  }

  /** Recorded refusal transport: process exit 1 with the structured ok:false body on stdout. */
  private refusal(code: string, message = code): { code: number; stdout: string; stderr: string } {
    return { code: 1, stdout: JSON.stringify({ ok: false, error: { code, message }, _meta: { runtimeId: this.runtimeId } }), stderr: "" };
  }

  private ok(result: unknown): { code: number; stdout: string; stderr: string } {
    return { code: 0, stdout: this.envelope(result), stderr: "" };
  }

  private tabId(t: FakeTerminal): string {
    return t.tabId ?? `${t.handle}-tab`;
  }

  private reportedStatus(t: FakeTerminal): string {
    const flip = this.opts.flipStatusAfterReads;
    if (flip !== undefined && (this.reads.get(t.handle) ?? 0) > flip) return this.opts.flippedStatus ?? "exited";
    return t.status ?? "running";
  }

  private connected(t: FakeTerminal): boolean {
    return t.connected ?? this.reportedStatus(t) !== "exited";
  }

  /** list/show row: the SHELL-CONTROLLED pane title, never the owned tab title. */
  private row(t: FakeTerminal, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const rec: Record<string, unknown> = {
      handle: t.handle,
      tabId: this.tabId(t),
      worktreeId: `repo-fixture::${t.worktree}`,
      worktreePath: t.worktree,
      title: t.paneTitle ?? "bash",
      connected: this.connected(t),
      writable: t.writable ?? this.reportedStatus(t) !== "exited",
      orphaned: t.orphaned === true,
      ...extra,
    };
    if (t.agentWait === true) rec.agentWait = true;
    return rec;
  }

  /** The recorded visualLayouts shape: the owned title survives at TAB identity only. */
  private visualLayouts(scoped: FakeTerminal[] = this.terminals): unknown {
    const byWorktree = new Map<string, FakeTerminal[]>();
    for (const t of scoped) {
      byWorktree.set(t.worktree, [...(byWorktree.get(t.worktree) ?? []), t]);
    }
    return [...byWorktree].map(([wt, ts]) => ({
      worktreeId: `repo-fixture::${wt}`,
      worktreePath: wt,
      root: {
        type: "group",
        groupId: `headless-terminals:repo-fixture::${wt}`,
        activeTabId: this.tabId(ts[0]),
        tabs: ts.map((t) => ({
          tabId: this.tabId(t),
          title: t.title,
          activeLeafId: `${t.handle}-leaf`,
          panes: {
            type: "terminal",
            handle: t.handle,
            tabId: this.tabId(t),
            leafId: `${t.handle}-leaf`,
            title: t.paneTitle ?? "bash",
            connected: this.connected(t),
            active: true,
          },
        })),
      },
    }));
  }

  private page(t: FakeTerminal, cursor: string | undefined, lines: number): Record<string, unknown> {
    const total = t.lines.length;
    const cap = Math.min(Number.isFinite(lines) && lines > 0 ? lines : this.pageSize, this.pageSize);
    if (cursor === undefined) {
      // unpaged tail read: the NEWEST lines, plus the cursor that says where the buffer starts
      const tail = t.lines.slice(Math.max(0, total - cap));
      return { tail, truncated: tail.length < total, limited: false, oldestCursor: "0", nextCursor: String(total), latestCursor: String(total), returnedLineCount: tail.length };
    }
    const from = Math.max(0, Number(cursor) || 0);
    const tail = t.lines.slice(from, from + cap);
    const next = from + tail.length;
    return { tail, truncated: false, limited: next < total, oldestCursor: "0", nextCursor: String(next), latestCursor: String(total), returnedLineCount: tail.length };
  }

  readonly exec: OrcaExec = async (args, cwd) => {
    this.calls.push([...args]);
    if (this.opts.cliMissing !== undefined) return { code: 127, stdout: "", stderr: this.opts.cliMissing };
    const family = args[0] === "terminal" ? args[1] : args[0];
    if (!KNOWN_FAMILIES.has(family)) return { code: 2, stdout: "", stderr: `orca: unknown verb ${args.join(" ")}` };
    const contractError = this.contractError(family, args);
    if (contractError) return { code: 2, stdout: "", stderr: `orca: ${contractError}` };
    const override = this.opts.raw?.[family as OrcaFamily];
    if (override !== undefined) return { code: 0, stdout: override, stderr: "" };
    return this.answer(family, args, cwd);
  };

  /** Contract-strict argv validation: unsupported flags never acquire invented fixture semantics. */
  private contractError(family: string, args: string[]): string | undefined {
    if (args.at(-1) !== "--json" || args.filter((a) => a === "--json").length !== 1) {
      return "every command must request --json exactly once as its final argument";
    }
    const unsupported = args.find((a) => a.startsWith("--") && !ALLOWED_FLAGS[family].has(a));
    if (unsupported) return `unknown option ${unsupported}`;
    if (family === "status") return args.length === 2 ? undefined : "status accepts no positional arguments";
    if (family === "worktree") {
      if (args[1] !== "create") return "worktree supports only `create` in this fixture";
      return flag(args, "--name") === undefined ? "worktree create requires --name" : undefined;
    }
    if (args[0] !== "terminal" || args[1] !== family) return `invalid ${family} invocation`;
    const required: Record<string, string[]> = {
      create: ["--worktree", "--title", "--command"],
      list: [],
      read: ["--terminal", "--limit"],
      send: ["--terminal", "--text"],
      wait: ["--terminal", "--for", "--timeout-ms"],
      show: ["--terminal"],
      close: ["--terminal"],
    };
    const missing = required[family].find((name) => flag(args, name) === undefined);
    if (missing) return `${family} requires ${missing}`;
    if (family === "wait" && !["exit", "tui-idle"].includes(flag(args, "--for") ?? "")) {
      return "wait supports --for exit|tui-idle in this fixture";
    }
    return undefined;
  }

  /** `--worktree` takes a SELECTOR: `path:<abs>` names a checkout outright, while `active`/`current`
   *  resolve whatever the UI has focused — and with nothing focused, the CLI child's own cwd. */
  private selected(selector: string | undefined, cwd: string): string | undefined {
    if (selector === undefined) return undefined;
    if (selector.startsWith("path:")) return selector.slice("path:".length);
    if (selector === "active" || selector === "current") return this.opts.activeWorktree ?? cwd;
    return selector;
  }

  private answer(family: string, args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
    if (family === "status") {
      return this.ok({
        runtime: {
          reachable: this.opts.reachable !== false,
          runtimeId: this.runtimeId,
          appVersion: this.opts.appVersion ?? ORCA_FIXTURE_VERSION,
        },
      });
    }
    if (family === "create") {
      const worktree = this.selected(flag(args, "--worktree"), cwd) ?? cwd;
      const t: FakeTerminal = {
        handle: this.opts.nextHandle ?? `term_${++this.seq}`,
        title: flag(args, "--title") ?? "",
        worktree,
        status: "running",
        lines: [],
      };
      this.terminals.push(t);
      // Recorded create receipt: durable tabId + composite worktree identity; status is absent.
      const terminal: Record<string, unknown> = {
        handle: t.handle,
        tabId: this.tabId(t),
        paneKey: `${this.tabId(t)}:${t.handle}-leaf`,
        worktreeId: `repo-fixture::${t.worktree}`,
        title: t.title,
        hostPlatform: "darwin",
        executionHostId: "local",
      };
      if (this.opts.createSurface !== null) terminal.surface = this.opts.createSurface ?? "visible";
      return this.ok({ terminal });
    }
    if (family === "worktree") {
      // Orca creates the checkout ITSELF: its own root, and a branch derived from --name — the
      // caller names neither. Real `git worktree add` so the receipt's path/head/branch are facts.
      const name = flag(args, "--name") ?? "";
      const repo = this.selected(flag(args, "--repo"), cwd) ?? cwd;
      const path = join(this.opts.worktreeRoot ?? join(repo, "..", "orca-worktrees"), name);
      const base = flag(args, "--base-branch");
      try {
        execFileSync("git", ["worktree", "add", "-B", name, path, ...(base ? [base] : [])], { cwd: repo, stdio: "pipe" });
      } catch (e) {
        return this.refusal("worktree_create_failed", String(e));
      }
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
      const branch = `refs/heads/${name}`;
      const git = { path, head, branch, isBare: false, isMainWorktree: false };
      return this.ok({ worktree: { id: `repo-fixture::${path}`, repoId: "repo-fixture", displayName: name, ...git, git } });
    }
    if (family === "list") {
      const wt = this.selected(flag(args, "--worktree"), cwd);
      const listed = wt === undefined ? this.terminals : this.terminals.filter((t) => sameCheckout(t.worktree, wt));
      const result: Record<string, unknown> = { terminals: listed.map((t) => this.row(t)), topologyRevisions: {}, totalCount: listed.length, truncated: false };
      if (args.includes("--include-visual-layouts")) result.visualLayouts = this.visualLayouts(listed);
      return this.ok(result);
    }
    let handle = flag(args, "--terminal") ?? "";
    const t = this.of(handle);
    // A handle the live runtime does not know is stale — the documented restart signal, and like
    // every recorded refusal it exits rc 1 with the structured body on stdout.
    if (!t) return this.refusal("terminal_handle_stale", `no such terminal ${handle}`);
    if (family === "read") {
      this.reads.set(handle, (this.reads.get(handle) ?? 0) + 1);
      const status = this.reportedStatus(t);
      // Recorded read record: handle, status, tail, cursors — no titles, no liveness fields.
      const rec: Record<string, unknown> = { handle, ...this.page(t, flag(args, "--cursor"), Number(flag(args, "--limit"))) };
      if (status !== "") rec.status = status;
      return this.ok({ terminal: rec });
    }
    if (family === "show") return this.ok({ terminal: this.row(t) });
    if (family === "send") {
      if (t.writable === false || this.reportedStatus(t) !== "running") {
        return this.refusal("terminal_not_writable", `terminal ${handle} is not writable`);
      }
      const text = flag(args, "--text") ?? "";
      const enter = args.includes("--enter");
      if (enter) this.sent.set(handle, [...(this.sent.get(handle) ?? []), text]);
      else this.typed.set(handle, [...(this.typed.get(handle) ?? []), text]);
      // Recorded send receipt: accepted + bytesWritten (the trailing newline of --enter included).
      return this.ok({ send: { handle, accepted: true, bytesWritten: Buffer.byteLength(text, "utf8") + (enter ? 1 : 0) } });
    }
    if (family === "wait") {
      const condition = flag(args, "--for") ?? "";
      const satisfied = t.waitConditions?.includes(condition)
        || (condition === "exit" && this.reportedStatus(t) === "exited")
        || (condition === "tui-idle" && t.tuiIdle === true);
      if (!satisfied) {
        if (this.opts.elapsedWaitTransport !== "1.4.186-satisfied-false") {
          return this.refusal("timeout", "timeout");
        }
        return {
          code: 1,
          stdout: this.envelope({
            wait: {
              handle,
              condition,
              satisfied: false,
              status: this.reportedStatus(t),
              ...(condition === "tui-idle" && t.agentWait === true ? { blockedReason: "prompt" } : {}),
            },
          }),
          stderr: "",
        };
      }
      return this.ok({
        wait: {
          handle,
          condition,
          satisfied: true,
          status: condition === "exit" ? "exited" : this.reportedStatus(t),
          ...(condition === "exit" ? { exitCode: 0 } : {}),
        },
      });
    }
    if (family === "close") {
      if (!this.closed.has(handle)) {
        this.terminals = this.terminals.filter((x) => x.handle !== handle); // recorded: closed rows vanish
        this.closed.add(handle);
      }
      // Recorded close receipt; an exited/no-live-PTY leaf is still removed but reports false.
      return this.ok({ close: { handle, tabId: this.tabId(t), ptyKilled: this.reportedStatus(t) === "running" } });
    }
    return this.refusal("unsupported", family);
  }
}

/** Stepped clock: sleeping advances it, so bounded polling loops terminate without real waiting. */
export function steppedTime(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let ms = 0;
  return { now: () => ms, sleep: async (n) => { ms += Math.max(1, n); } };
}
