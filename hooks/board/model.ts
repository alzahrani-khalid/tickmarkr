import type { BoardState, StatusSnapshot, Task } from "./state";

export type StatusRead = { exitCode: number; stdout: string } | { rejected: unknown };

/**
 * queue row 281: display text for a snapshot string (park reasons carry model text). Every C0 control but tab and
 * newline, DEL and every C1 control shows as its visible escape, as the CLI's visibleControls does, so no OSC or CSI
 * sequence reaches a terminal. The snapshot keeps the raw bytes, so Copy still copies the exact command.
 */
export const visible = (text: unknown): string => String(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, c => {
  const code = c.charCodeAt(0);
  return `\\${code < 0x80 ? "x" : "u"}${code.toString(16).padStart(code < 0x80 ? 2 : 4, "0")}`;
});

/** Each read is a replacement, including a failed read. Never retain a previous verdict. */
export function readState(ran: StatusRead): BoardState {
  if ("rejected" in ran) return { error: `status process rejected: ${String(ran.rejected)}` };
  if (ran.exitCode !== 0) return { error: `status exited with code ${ran.exitCode}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(ran.stdout);
  } catch (error) {
    return { error: `malformed status JSON: ${String(error)}` };
  }
  const version = parsed !== null && typeof parsed === "object" && "version" in parsed ? parsed.version : undefined;
  if (version !== 1) return { error: `unsupported status version: ${String(version)}` };
  return { snapshot: parsed as StatusSnapshot };
}

export function headline(s: BoardState): { word: string; color: "success" | "warning" | "error" } {
  if ("error" in s) return { word: visible(`STATUS UNREADABLE — ${s.error}`), color: "error" };
  const { verdict, daemon, lifecycle } = s.snapshot;
  const down = daemon === "dead" && lifecycle === "RUNNING";
  const debt = verdict.outstanding;
  const suffix = !debt.known ? " · owed unknown" : debt.debt > 0 ? ` · owes ${debt.debt}` : "";
  return {
    word: visible((verdict.green ? "GREEN" : down ? "DAEMON DOWN" : lifecycle) + suffix),
    color: verdict.green ? "success" : down || lifecycle !== "RUNNING" ? "error" : "warning",
  };
}

export const badgeWidth = (ids: readonly string[], fit = 1): number =>
  Math.max(6, Math.ceil(Math.max(0, ...ids.map(id => [...id].length)) * (fit > 1 ? 1.5 : 1)) + 1);

export function triesText(task: Pick<Task, "tries">): string {
  const { round, budget, launches } = task.tries;
  return round === null ? "–" : `${round}/${budget}${launches > round ? ` · ${launches} in all` : ""}`;
}

export const needsYou = (s: BoardState) => "error" in s ? [] : s.snapshot.parks.map(park => ({
  task: visible(park.taskId), kind: park.kind && visible(park.kind), reason: park.reason && visible(park.reason), commands: park.commands,
}));

export const copyAllowed = (s: BoardState, command: string): boolean =>
  "snapshot" in s && s.snapshot.parks.some(park => park.commands.some(offered => offered.command === command));

export function countdownText(s: BoardState, now: number): string | null {
  const window = "snapshot" in s ? s.snapshot.approvalWindow : null;
  if (!window) return null;
  const left = Math.max(0, Math.ceil((Date.parse(window.closesAt) - now) / 1000));
  return left > 0
    ? `approval window closes in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} — then the run ends PARTIAL`
    : "approval window closing — the run ends PARTIAL unless released";
}

export function durationText(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}m`
    : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

export function etaText(s: BoardState, _now: number): string | null {
  if ("error" in s || s.snapshot.lifecycle !== "RUNNING") return null;
  const { tasks, parks } = s.snapshot;
  const durations = tasks.filter(task => task.state === "merged" && task.startedAt !== null && task.endedAt !== null)
    .map(task => Date.parse(task.endedAt!) - Date.parse(task.startedAt!))
    .filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!durations.length) return "ETA unknown until the first merge";
  const middle = Math.floor(durations.length / 2);
  const median = durations.length % 2 ? durations[middle]! : (durations[middle - 1]! + durations[middle]!) / 2;
  const unmerged = new Map(tasks.filter(task => task.state !== "merged").map(task => [task.id, task]));
  const lengths = new Map<string, number>();
  const depth = (id: string, visiting = new Set<string>()): number => {
    if (!unmerged.has(id) || visiting.has(id)) return 0;
    if (lengths.has(id)) return lengths.get(id)!;
    const next = new Set(visiting).add(id);
    const length = 1 + Math.max(0, ...unmerged.get(id)!.deps.map(dep => depth(dep, next)));
    lengths.set(id, length);
    return length;
  };
  const chain = Math.max(0, ...[...unmerged.keys()].map(id => depth(id)));
  const stopped = parks.length ? ` · clock stopped on ${visible(parks.map(park => park.taskId).join(", "))}` : "";
  return `ETA ${durationText(median * chain)}${stopped}`;
}
