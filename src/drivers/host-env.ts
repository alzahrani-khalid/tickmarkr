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

/** A copy of `env` without the host-session names; the input (the daemon's own process.env) is never mutated. */
export function withoutHostSession(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of HOST_SESSION_VARS) delete out[k];
  return out;
}
