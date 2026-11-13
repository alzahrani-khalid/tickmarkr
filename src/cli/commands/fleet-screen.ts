// `tickmarkr fleet`: one screen. YOUR TEAM, then NEEDS YOU. This command owns the files the screen
// reads and the one guarded write; the screen itself is pure (src/fleet/screen.ts).
import { parseArgs } from "node:util";
import { allAdapters } from "../../adapters/registry.js";
import type { WorkerAdapter } from "../../adapters/types.js";
import { globalConfigDir, loadConfigWithMode } from "../../config/config.js";
import type { Layer, Texts } from "../../fleet/edits.js";
import { type FloorChoice, floorOf, type HandChoice, handLines } from "../../fleet/hand.js";
import { dismissNeed, loadFleetSource, restoreNeed } from "../../fleet/load.js";
import { evidenceAgeDays } from "../../fleet/model.js";
import { derive, errorFiles, errorWhere, initialScreen, type Kept, plainReview, plainScreen, resumeScreen, type ScreenSource, teamRows } from "../../fleet/screen.js";
import { doctor } from "./doctor.js";
import { fleet, type FleetIO, type FleetInput, type FleetOutput, writeFleetOverlay } from "./fleet.js";

export type FleetScreenIO = FleetIO & {
  /** test seam: the interactive mount (the Ink app in production) */
  runScreen?: typeof import("../../tui/ink/fleet-screen.js").runFleetScreen;
  now?: number;
};
type Result = string | { out: string; code: number };

/**
 * The guarded write. Two checks before either file is touched: neither config file has changed
 * since the screen read it (`onDisk` is a load made now; the answers were made against `src`, and
 * saving over a newer file would undo whoever changed it), and the candidate bytes of both layers load.
 */
export function saveFleet(src: ScreenSource, texts: Texts, touched: readonly Layer[], onDisk: ScreenSource): string {
  const moved = (["repo", "user"] as const).filter((l) => (l === "repo" ? onDisk.inputs.repoText !== src.inputs.repoText : onDisk.inputs.userText !== src.inputs.userText));
  if (moved.length) throw new Error(`${moved.map((l) => src.labels?.[l] ?? src.paths[l]).join(" and ")} changed while this screen was open. This is the new file: answer again.`);
  loadConfigWithMode("/", { userOverlayText: texts.userText, repoOverlayText: texts.repoText });
  const name = (l: Layer): string => src.labels?.[l] ?? src.paths[l];
  const done: Layer[] = [];
  for (const layer of touched) {
    try {
      writeFleetOverlay(src.paths[layer], () => (layer === "repo" ? texts.repoText : texts.userText));
      done.push(layer);
    } catch (e) {
      // the file system's reason in words a user can act on, and the truth about the other file
      const why = (e as NodeJS.ErrnoException).code === "EACCES" || (e as NodeJS.ErrnoException).code === "EPERM" ? "permission denied" : (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message.replace(src.paths[layer], "it") : String(e));
      // (the error carries the layers already written, for the caller that names them when it ends)
      throw Object.assign(new Error(`${name(layer)} could not be written (${why}). ${done.length ? `${done.map(name).join(" and ")} ${done.length === 1 ? "was" : "were"} saved.` : "Nothing was saved."}`), { saved: done });
    }
  }
  return `Saved to ${touched.map(name).join(" and ")}.`;
}

function jsonScreen(src: ScreenSource): string {
  const d = derive(src, initialScreen());
  if (!d.base) return JSON.stringify({ ok: false, error: d.error, in: errorFiles(src, d.errorIn) }, null, 2);
  const age = evidenceAgeDays(d.base);
  return JSON.stringify({
    ok: true, mode: d.base.mode.mode, working: d.base.working, probed: d.base.hasProbe, probedDaysAgo: age === undefined ? null : Math.floor(age),
    team: teamRows(d.base).map(({ section, label, models, note, status }) => ({ section, line: label, models, ...(note ? { note } : {}), status })),
    needs: d.items.map((n) => ({ id: n.id, title: n.title, ask: n.ask, answerable: !!n.edits, changes: (n.edits ?? []).map((e) => ({ layer: e.layer, path: e.path.join("."), value: e.value ?? null })) })),
    // what --set takes: each line, the models the config names on it, and the models that may take it
    // (keptOut: candidates a rule keeps from the line; naming one that is liftable lifts its rule in the same save)
    lines: handLines(d.base).map((l) => ({ line: l.id, ...(l.layer ? { layer: l.layer } : {}), ...(l.deny ? { deny: true } : {}), ...(l.setting ? { setting: true } : {}), ...(l.mode ? { mode: l.mode } : {}), ...(l.floor ? { floor: l.floor.tier ?? null, floorSetFor: l.floor.own ? "this shape" : "the mode" } : {}), one: l.one, models: l.current, candidates: l.candidates, ...(Object.keys(l.barred).length ? { keptOut: l.barred } : {}) })),
  }, null, 2);
}

/** `--set <line>=<models>`: the same change the e key makes, checked the same way. */
function handFrom(src: ScreenSource, sets: readonly string[]): { hand: HandChoice[] } | { refused: string } {
  const base = derive(src, initialScreen()).base;
  if (!base) return { hand: [] };
  const lines = handLines(base), hand: HandChoice[] = [];
  for (const set of sets) {
    const cut = set.indexOf("="), id = set.slice(0, cut), line = lines.find((l) => l.id === id);
    // <shape>.floor=<tier|mode>: the f key. It joins what the same command sets on that shape's models.
    const shape = id.endsWith(".floor") ? lines.find((l) => l.id === id.slice(0, -6) && l.floor) : undefined;
    if (shape) {
      const to = set.slice(cut + 1).trim() as FloorChoice;
      if (!["mode", "cheap", "mid", "frontier"].includes(to)) return { refused: `${id} is cheap, mid, frontier or mode (what the routing mode says), and ${JSON.stringify(to)} was given` };
      if (to === floorOf(shape)) return { refused: `${id} is already ${to === "mode" ? "what the routing mode says" : to}` };
      const mine = hand.find((x) => x.line === shape.id);
      if (mine?.floor) return { refused: `${id} is set twice` };
      if (mine) mine.floor = to; else hand.push({ line: shape.id, chosen: [], floor: to });
      continue;
    }
    // a shape may name its pool's mode before its models, as the o key turns it: plan=ordered:codex:a,claude-code:b
    const turned = line?.mode ? /^(any|ordered):/.exec(set.slice(cut + 1))?.[1] as "any" | "ordered" | undefined : undefined;
    const models = set.slice(cut + 1 + (turned ? turned.length + 1 : 0)).split(",").map((x) => x.trim()).filter(Boolean);
    if (cut < 1 || !line) return { refused: `${JSON.stringify(set)} names no line — the lines are ${lines.map((l) => l.id).join(", ")}, written <line>=<adapter:model>[,…]` };
    if (!models.length && !line.deny) return { refused: `${id} needs ${line.setting ? "a value" : "at least one model"}` };
    if (line.one && models.length > 1) return { refused: `${id} is one model, and ${models.length} were given` };
    const not = models.filter((k) => !line.candidates.includes(k));
    if (not.length) return { refused: `${not.join(", ")} ${not.length === 1 ? "is" : "are"} not ${line.deny || line.setting ? `something ${id} can name` : `a working model that may take ${id}`} — tickmarkr fleet --json lists them under lines` };
    const floored = hand.find((x) => x.line === line.id && !x.chosen.length && x.floor);
    if (hand.some((x) => x.line === line.id) && !floored) return { refused: `${id} is set twice` };
    // (a model the line already names stays where it is, kept out as it was: only one that is added needs its rule lifted)
    const kept = models.find((k) => line.barred[k] && !line.barred[k].liftable && !line.current.includes(k));
    if (kept) return { refused: `${kept} is kept from ${id} by ${line.barred[kept].why} — change that deny list first (--set ${lines.filter((l) => l.deny).map((l) => l.id).join(", --set ")})` };
    if (new Set(models).size !== models.length) return { refused: `${id} names a model twice` };
    const mode = line.mode && (turned ?? line.mode);
    if (models.length === line.current.length && models.every((k, i) => k === line.current[i]) && mode === line.mode) return { refused: `${id} already has exactly those models, in that order` };
    if (floored) Object.assign(floored, { chosen: models, ...(mode ? { mode } : {}) });
    else hand.push({ line: line.id, chosen: models, ...(mode ? { mode } : {}) });
  }
  return { hand };
}

/** `--yes <id>…` and `--set <line>=<models>…`: the review as text; with `--save`, the write. */
function answer(load: () => ScreenSource, ids: string[], sets: string[], save: boolean): Result {
  const src = load();
  const set = handFrom(src, sets);
  if ("refused" in set) return { out: `tickmarkr fleet --set: ${set.refused}`, code: 1 };
  const d = derive(src, { ...initialScreen(), yes: ids, hand: set.hand });
  if (!d.base) return { out: `tickmarkr fleet: the config does not load — ${d.error}\n${errorWhere(src, d.errorIn)}`, code: 1 };
  const unknown = ids.filter((id) => !d.said.some((n) => n.id === id));
  if (unknown.length) return { out: `tickmarkr fleet --yes: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not something this fleet asks a yes about — tickmarkr fleet --json lists the ids`, code: 1 };
  const review = plainReview(src, ids, set.hand, 100);
  if (d.refused || !d.texts) return { out: review, code: 1 };
  return save ? `${review}\n\n${saveFleet(src, d.texts, d.texts.touched, load())}` : `${review}\n\nNothing was saved. Add --save to save it.`;
}

export async function fleetCommand(argv: string[], cwd = process.cwd(), adapters: WorkerAdapter[] = allAdapters(), io: FleetScreenIO = {}): Promise<Result> {
  const { values } = parseArgs({
    args: argv,
    options: {
      plain: { type: "boolean" },
      json: { type: "boolean" },
      yes: { type: "string", multiple: true },
      set: { type: "string", multiple: true },
      save: { type: "boolean" },
      edit: { type: "boolean" },
      pick: { type: "string" },
      author: { type: "string" },
      "exclude-vendor": { type: "string", multiple: true },
      print: { type: "boolean" },
      why: { type: "boolean" },
      "global-dir": { type: "string" },
      fresh: { type: "boolean" },
    },
  });
  // The seat picker, the YAML print, the why report and the 2.24.0 editor keep their command.
  if (values.pick !== undefined || values.author !== undefined || values["exclude-vendor"]?.length || values.print || values.why || values.edit) {
    return fleet(argv.filter((a) => a !== "--edit"), cwd, adapters, io);
  }
  const globalDir = values["global-dir"] ?? globalConfigDir();
  const load = (): ScreenSource => loadFleetSource(cwd, { globalDir, adapters, ...(io.now !== undefined ? { now: io.now } : {}) });
  const input = io.input ?? (process.stdin as FleetInput), output = io.output ?? (process.stdout as FleetOutput);
  const probe = async (): Promise<void> => { output.write(`${await (io.doctor ?? doctor)([], cwd, adapters, { banner: false, compact: true, globalDir })}\n`); };
  if (values.save && !values.yes?.length && !values.set?.length) return { out: "tickmarkr fleet: --save needs --yes <id> or --set <line>=<models>", code: 1 };
  if (values.fresh) await probe();
  // A config that does not load is an error for a script too: the same text, and a non-zero exit.
  const loads = (src: ScreenSource): boolean => derive(src, initialScreen()).base !== undefined;
  const reported = (src: ScreenSource, out: string): Result => (loads(src) ? out : { out, code: 1 });
  if (values.json) { const src = load(); return reported(src, jsonScreen(src)); }
  if (values.yes?.length || values.set?.length) return answer(load, values.yes ?? [], values.set ?? [], values.save ?? false);
  // Without a terminal the screen is printed, never refused: an agent in a pipe reads the same thing.
  if (values.plain || input.isTTY !== true || output.isTTY !== true) { const src = load(); return reported(src, plainScreen(src, 100)); }

  return fleetScreenLoop(cwd, { load, probe, input: input as NodeJS.ReadStream, output: output as NodeJS.WriteStream, runScreen: io.runScreen });
}

/**
 * The screen until the user quits. A probe and a save happen here, between two openings of the
 * screen, so the screen itself never writes. `tickmarkr init` ends on this same loop.
 */
export async function fleetScreenLoop(cwd: string, opts: {
  load: () => ScreenSource; probe: () => Promise<void>; input: NodeJS.ReadStream; output: NodeJS.WriteStream; runScreen?: FleetScreenIO["runScreen"];
}): Promise<string> {
  const run = opts.runScreen ?? (await import("../../tui/ink/fleet-screen.js")).runFleetScreen;
  let src = opts.load(), note = "", keep: Kept | undefined;
  // the files this session wrote, by the names the screen gives them: the last line names these and no other
  const written = new Set<string>();
  const wrote = (layers: readonly Layer[]): void => { for (const l of layers) written.add(src.labels?.[l] ?? src.paths[l]); };
  for (;;) {
    // after a probe the screen opens with what was answered and changed before it, still unsaved
    const again = resumeScreen(src, keep);
    keep = undefined;
    const action = await run({ source: src, note: [note, again.note].filter(Boolean).join(" "), resume: again.state, input: opts.input, output: opts.output, onDismiss: (need) => dismissNeed(cwd, need), onRestore: (signature) => restoreNeed(cwd, signature) });
    if (action.kind === "probe") { await opts.probe(); src = opts.load(); note = "Probed."; keep = action.keep; continue; }
    if (action.kind === "save") {
      try { note = saveFleet(src, action.texts, action.touched, opts.load()); wrote(action.touched); }
      catch (e) { note = `Not saved: ${e instanceof Error ? e.message : String(e)}`; wrote((e as { saved?: Layer[] }).saved ?? []); }
      src = opts.load();
      continue;
    }
    const files = [...written].join(" and ");
    if (action.unsaved) return `fleet: quit; ${action.unsaved} ${action.unsaved === 1 ? "change was" : "changes were"} not saved${files ? ` (saved before that: ${files})` : ""}`;
    return files ? `fleet: saved ${files}` : "fleet: nothing changed";
  }
}

