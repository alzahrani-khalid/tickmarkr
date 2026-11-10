import { resolve, sep } from "node:path";

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * Queue row 196 (D-2102 add.1): gates inherit the launching locale. The effective value is LC_ALL, else
 * LC_CTYPE, else LANG (an empty value counts as unset). Unset, C or POSIX is the C-locale fallback;
 * C.UTF-8 is a UTF-8 locale and passes. Advisory only — doctor never sets or writes a locale.
 */
export function localeFinding(env: EnvLike): { verdict: "pass" | "warn"; detail: string } {
  const name = (["LC_ALL", "LC_CTYPE", "LANG"] as const).find((key) => env[key]);
  const value = name ? env[name] : undefined;
  if (name && value !== "C" && value !== "POSIX") return { verdict: "pass", detail: `${name}=${value}` };
  return {
    verdict: "warn",
    detail: `${name ? `${name}=${value}` : "no locale set (LC_ALL, LC_CTYPE and LANG unset)"} — gates inherit the C-locale fallback (Node formats as en-US); fix: set LANG in your shell profile, e.g. export LANG=en_US.UTF-8`,
  };
}

/** Pure advisory finding; callers resolve filesystem aliases before supplying the paths. */
export function protectedFolderFinding(
  repoRoot: string, stateDir: string, platform: NodeJS.Platform, home: string | undefined,
): { verdict: "warn"; folder: string; detail: string } | undefined {
  if (platform !== "darwin" || !home) return undefined;
  const paths = [resolve(repoRoot), resolve(stateDir)];
  for (const name of ["Desktop", "Documents", "Downloads"]) {
    const folder = resolve(home, name);
    if (paths.some(path => path === folder || path.startsWith(`${folder}${sep}`))) {
      return { verdict: "warn", folder,
        detail: `macOS protected home folder ${folder} contains the repository or its state directory; move the repository outside Desktop, Documents and Downloads, or grant the app running tickmarkr Full Disk Access` };
    }
  }
  return undefined;
}

// Queue row 193 (D-2102 add.1): a daemon launched from an agent session (the Claude Desktop Code tab, or a
// claude CLI seat on Orca or herdr) carries that session's host variables, and an agent CLI that inherits
// them gains the host's tools and effort. This CLOSED denylist is stripped at every choke point an agent
// CLI or gate command passes: the shell seam, the subprocess driver's seal, the pane seeds and the bare
// probes. Exact names only — never a prefix: an unlisted CLAUDE_CODE variable and every user auth or
// provider variable reach children byte-equal. Declared residual: a host variable a future host adds
// reaches children until it is listed here. Leaf module: imports nothing from src/.
export const HOST_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_CODE_TERMINAL_MCP_TOOLS",
  "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
  "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
  "CLAUDE_CODE_REPORT_FINDINGS",
  "CLAUDE_CODE_STARTUP_FAILURE_RESULTS",
  "CLAUDE_CODE_EAGER_FLUSH",
  "CLAUDE_CODE_DISABLE_CRON",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
  "CLAUDE_CODE_ACCOUNT_UUID",
  "CLAUDE_CODE_ORGANIZATION_UUID",
  "CLAUDE_CODE_USER_EMAIL",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_AGENT_SDK_MCP_NO_PREFIX",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_PREVIEW_CLASSIFIER_FLOOR",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
] as const;

// OBS-17 / v1.22 T3, OBS-843, queue row 340 (D-2180) and queue row 390 (D-2187 add.9): host control-plane vars that
// let a process address the operator's herdr, Orca, Herdr app or Rex session. Workers and agent seats
// (worker/judge/review/consult and every headless agent CLI) must never inherit them; only the daemon and its driver
// calls keep the live session. The HC pair addresses the launching hc terminal and HC_SCOPE is that terminal's scope
// token: inherited, a role could act as ORCH, type into it or become its child. The four REX_ names are the closed set
// a live Rex pane carries (D-2187 add.9, names read first-hand): REX_SERVER, REX_SESSION and REX_BLOCK address the
// operator's Rex session and pane, and REX_BIN_DIR locates Rex's own CLI, so all four are sealed. Removing them is not
// a security boundary — any same-user process can still address the default socket or app explicitly; core isolation
// is out of scope. TERM_PROGRAM and TERM_PROGRAM_VERSION are host description, not an addressing capability, and
// ORCA_AGENT_HOOK_* belongs to agent status transport, so they stay. Lives in this leaf module so git.ts and
// subprocess.ts share it without an import cycle; subprocess.ts re-exports the historical name.
export const HERDR_CONTROL_VARS = [
  "HERDR_ENV",
  "HERDR_SOCKET_PATH",
  "ORCA_TERMINAL_HANDLE",
  "ORCA_PANE_KEY",
  "ORCA_TAB_ID",
  "HC_TERMINAL_ID",
  "HC_TERMINAL_SOCKET",
  "HC_SCOPE",
  "REX_BIN_DIR",
  "REX_BLOCK",
  "REX_SERVER",
  "REX_SESSION",
] as const;

/** Queue row 340 (D-2180): the inherited hc scope token. Its presence is recorded as a boolean only, never its value. */
export const HC_SCOPE_ENV = "HC_SCOPE";
/** The one prescribed warning for a daemon whose launching terminal's scope was inherited; carries no token. */
export const HC_SCOPE_WARNING = "this daemon carries its launching terminal's scope and ends with it; detach with env -u HC_SCOPE";
/** Whether `env` carries an hc scope token (nonblank). */
export const hcScopePresent = (env: EnvLike): boolean => (env[HC_SCOPE_ENV] ?? "").trim() !== "";

/** D-2174 (queue row 267): the seat marker. No launch inherits it: the daemon clears it at start, and every shell and
 * the worker seal strip it; only a judge, review or consult seat launch sets it, to its own role. */
export const SEAT_MARKER_ENV = "TICKMARKR_SEAT";

/** A copy of `env` without the host-session names; the input (the daemon's own process.env) is never mutated. */
export function withoutHostSession(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of HOST_SESSION_VARS) delete out[k];
  return out;
}
