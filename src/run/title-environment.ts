import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A2 (D-787): the process-title mode every shell child receives. On Darwin, children get one
 * `--require` of the shipped title-preload.cjs appended to their NODE_OPTIONS, so a Node child's
 * process.title writes stay in JavaScript instead of each checking in with LaunchServices (npm's own
 * entry keeps its native, secret-hiding title — see title-preload.cts). Everything here fails OPEN to
 * the native mode, which is exactly what children received before A2: another platform, the operator's
 * opt-out, a missing artifact, inherited options the preflight cannot vouch for, or a preflight the
 * runner's own node refused.
 *
 * `shell` (git.ts) applies this to the child it spawns and `runnerInputsHash` (cache.ts) hashes the same
 * value, so a cached verdict or baseline is only ever answered by one produced under the identical mode
 * and preload content.
 */
export const NATIVE_PROCESS_TITLE_ENV = "TICKMARKR_NATIVE_PROCESS_TITLE";
/** The preflight's kill ceiling, never a predicted duration: one `node -e ""` start. */
export const TITLE_PREFLIGHT_TIMEOUT_MS = 10_000;

export type TitleMode = "native" | "preload";
export interface TitleEnvironment {
  mode: TitleMode;
  /** Content identity of the preload a child loads; null in native mode. */
  identity: string | null;
  /** The NODE_OPTIONS the child receives: the inherited value less any managed preload in native mode;
   *  undefined when nothing is left, so the child's NODE_OPTIONS is unset rather than empty. */
  nodeOptions: string | undefined;
}

interface TitleSeams {
  platform: NodeJS.Platform;
  preloadPath: string;
  /** Undefined until a test sets it: the standard library binding is read at CALL time, so a suite that
   *  mocks `node:child_process` without `spawnSync` still imports this module. */
  probe?: typeof spawnSync;
}
const shipped = (): TitleSeams => ({
  platform: process.platform,
  preloadPath: fileURLToPath(new URL("./title-preload.cjs", import.meta.url)),
});
let seams = shipped();
const preflights = new Map<string, boolean>();
export const setTitleEnvironmentForTests = (overrides: Partial<TitleSeams>): void => {
  seams = { ...seams, ...overrides };
  preflights.clear();
};
export const resetTitleEnvironmentForTests = (): void => {
  seams = shipped();
  preflights.clear();
};

/** NODE_OPTIONS splits on spaces outside double quotes; inside them a backslash escapes `"` and `\`. */
export const quoteNodeOption = (value: string): string => `"${value.replace(/[\\"]/g, "\\$&")}"`;
/** The one option this install adds: its preload, at an absolute path. */
const preloadOption = (): string => `--require ${quoteNodeOption(seams.preloadPath)}`;

/**
 * D-827: does the runner's own node load this preload? Probed at most once per process per (node execPath,
 * preload content identity, mode) — neither the operator's options nor a payload's cwd key it — so a
 * refusal is sticky for that triple. The probe certifies only the context it reproduces: the preload alone,
 * at its absolute path, run in the preload's own directory. `certifiable` sends every payload whose own
 * options could change how that loads — the permission model, other code loaders, a policy or config file,
 * any cwd-relative path — to native before any probe, so what reaches a payload loads the same from the
 * probe's cwd and from the payload's (D-835: an absolute preload with none of those certifies every cwd).
 * A bounded synchronous probe that never goes through `shell` or its spawn seam, so payload start timing,
 * recorded spawn commands and the lease census see payloads only. A refusal — nonzero exit, signal, the ceiling, or a spawn error — selects native payloads without
 * re-probing; a payload is never started twice to find out.
 */
function preflight(env: NodeJS.ProcessEnv, identity: string): boolean {
  const key = [process.execPath, identity, "preload"].join("\0");
  let accepted = preflights.get(key);
  if (accepted === undefined) {
    try {
      const probe = (seams.probe ?? spawnSync)(process.execPath, ["-e", ""], {
        cwd: dirname(seams.preloadPath), env: { ...env, NODE_OPTIONS: preloadOption() },
        stdio: "ignore", timeout: TITLE_PREFLIGHT_TIMEOUT_MS, killSignal: "SIGKILL",
      });
      accepted = probe.status === 0 && !probe.error;
    } catch {
      accepted = false;
    }
    preflights.set(key, accepted);
  }
  return accepted;
}

/** NODE_OPTIONS as Node splits it: on spaces outside double quotes, each quoted segment unescaped. */
const optionTokens = (options: string): string[] => (options.match(/(?:[^\s"]|"(?:[^"\\]|\\.)*")+/g) ?? [])
  .map((token) => token.replace(/"((?:[^"\\]|\\.)*)"/g, (_, quoted: string) => quoted.replace(/\\(.)/g, "$1")));
/** Node accepts `_` for `-` in an option's name (`--experimental_permission` is Node 20's permission flag), so
 * a name is classified in its hyphen spelling; the value after `=` is left as written. */
const hyphenated = (token: string): string => token.replace(/^--[^=]*/, (name) => name.replace(/_/g, "-"));
/** Options that gate file access, load other code, or read a policy or config file. */
const LOADING_OPTION = /^(?:-r|--(?:require|import|(?:experimental-)?loader|(?:experimental-)?permission[\w-]*|allow-[\w-]+|(?:experimental-)?policy[\w-]*|experimental-(?:default-)?config-file))(?:=|$)/;
/** A path a cwd resolves: not absolute, and a directory step or a leading `.` or `~` (Node expands neither). */
const cwdRelative = (value: string): boolean => !value.startsWith("/") && /^[.~]|\//.test(value);
/** Can the one canonical probe vouch for a payload under the operator's own options? No when any token
 * loads, permits or resolves against the cwd — a separate value token or an `=` value alike. */
const certifiable = (own: string | undefined): boolean => optionTokens(own ?? "").every((token) =>
  !LOADING_OPTION.test(hyphenated(token)) && !cwdRelative(/^-[^=]*=/.test(token) ? token.slice(token.indexOf("=") + 1) : token));

/** One `--require "<path>"` option in the quoted form quoteNodeOption writes. */
const QUOTED_REQUIRE = /(?:^|\s+)--require "((?:[^"\\]|\\.)*)"(?=\s|$)/g;
/** A tickmarkr-managed preload, positively identified: this install's, or another install's shipped
 * `dist/run/title-preload.cjs` whose package.json names it tickmarkr (a nested shell under another install).
 * A user's own file of the same name is never one, so their hook keeps running in every mode. */
const managed = (path: string): boolean => {
  if (path === seams.preloadPath) return true;
  if (!/[\\/]dist[\\/]run[\\/]title-preload\.cjs$/.test(path)) return false;
  try {
    return (JSON.parse(readFileSync(join(dirname(path), "../../package.json"), "utf8")) as { name?: unknown }).name === "tickmarkr";
  } catch {
    return false;
  }
};
/** The operator's own options: every inherited managed preload removed; every other option byte-identical,
 * and the value untouched without one. */
const withoutManaged = (options: string | undefined): string | undefined => {
  const stripped = options?.replace(QUOTED_REQUIRE, (whole, quoted: string) => managed(quoted.replace(/\\(.)/g, "$1")) ? "" : whole);
  return stripped === options ? options : stripped!.trim() || undefined;
};

/**
 * The title mode a child spawned from `env` receives, and the NODE_OPTIONS that carries it. A nested shell
 * inherits its parent's preload, so every mode first removes it: native gets none (the opt-out, options the
 * probe cannot vouch for, a refusal or a missing artifact must hold in a nested shell too) and preload mode
 * exactly one, this one.
 */
export function titleEnvironment(env: NodeJS.ProcessEnv): TitleEnvironment {
  const own = withoutManaged(env.NODE_OPTIONS);
  const native: TitleEnvironment = { mode: "native", identity: null, nodeOptions: own };
  if (seams.platform !== "darwin" || env[NATIVE_PROCESS_TITLE_ENV] === "1" || !certifiable(own)) return native;
  let identity: string;
  try {
    identity = createHash("sha256").update(readFileSync(seams.preloadPath)).digest("hex").slice(0, 16);
  } catch {
    return native; // a missing or unreadable artifact keeps the native setter
  }
  if (!preflight(env, identity)) return native;
  return { mode: "preload", identity, nodeOptions: [own?.trim(), preloadOption()].filter(Boolean).join(" ") };
}
