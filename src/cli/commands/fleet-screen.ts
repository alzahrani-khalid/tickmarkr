// `tickmarkr fleet`: one screen. YOUR TEAM, then NEEDS YOU. This command owns the files the screen
// reads and the one guarded write; the screen itself is pure (src/fleet/screen.ts).
import { parseArgs } from "node:util";
import { allAdapters } from "../../adapters/registry.js";
import type { WorkerAdapter } from "../../adapters/types.js";
import { globalConfigDir, loadConfigWithMode } from "../../config/config.js";
import type { Layer, Texts } from "../../fleet/edits.js";
import { type FloorChoice, floorOf, type HandChoice, handLines } from "../../fleet/hand.js";
import { dismissNeed, loadFleetSource, restoreNeed, UnreadableConfig } from "../../fleet/load.js";
import { keptOut, type Line, lineOf } from "../../fleet/lines.js";
import { evidenceAgeDays } from "../../fleet/model.js";
import { freeSeat, othersOf } from "../../fleet/rules.js";
import { disallowedBy, observedSeat, type PreferenceRole } from "../../route/preference.js";
import { SHAPES, type Shape } from "../../graph/schema.js";
import { derive, errorFiles, errorWhere, initialScreen, type Kept, plainOne, plainSave, resumeScreen, type ScreenSource, teamRows } from "../../fleet/screen.js";
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
    // (keptOut: candidates a rule keeps from the line; --set refuses one a KEPT OUT rule keeps out, rule K2; rows 499, 502; D-2187 add.363)
    // rows 499, 501, 502 (D-2187 add.363): how each shape is given out, and the rules in force
    hardFrom: d.base.cfg.routing.hardFrom, similarWithin: d.base.cfg.routing.similarWithin,
    lines: handLines(d.base).map((l) => ({ line: l.id, ...(l.layer ? { layer: l.layer } : {}), ...(l.deny ? { deny: true } : {}), ...(l.setting ? { setting: true } : {}), ...(l.mode ? { mode: l.mode } : {}), ...(l.floor ? { floor: l.floor.tier ?? null, floorSetFor: l.floor.own ? "this shape" : "the mode" } : {}), one: l.one, models: l.current, candidates: l.candidates, ...(Object.keys(l.barred).length ? { keptOut: l.barred } : {}),
      ...(SHAPES.includes(l.id as Shape) ? givenOut(lineOf(d.base!, l.id as Shape)) : {}) })),
    keptOut: keptOut(d.base), unsaved: 0,
  }, null, 2);
}

/** A shape's line as --json carries it: a null stands where a fact is not recorded. */
function givenOut(line: Line): Record<string, unknown> {
  return {
    givenOut: line.givenOut,
    ...(line.groups ? { groups: line.groups.map((g) => ({ range: g.range, by: line.by, noScore: line.noScore,
      models: g.models.map((m) => ({ model: m.model, cli: m.cli, score: m.score, priceIn: m.priceIn, priceOut: m.priceOut, share: m.share, shareWords: m.shareWords, standIns: m.standIns })) })) } : {}),
    ...(line.order ? { order: line.order } : {}),
    ...(line.note.length ? { note: line.note } : {}),
  };
}

/**
 * `--set <line>=<models>`: the same change Enter on a line makes, checked the same way. A shape's line is
 * named with its way first (`any:`, `ordered:`, `complexity:`), or bare, keeping its way (none: by
 * complexity); `hardFrom=<2-10>` is the one number. It removes no KEPT OUT rule (rule K2; rows 499, 502;
 * D-2187 add.363): a model a rule keeps out, or a deny list that leaves out a saved entry, is refused by name.
 */
function handFrom(src: ScreenSource, sets: readonly string[]): { hand: HandChoice[] } | { refused: string } {
  const base = derive(src, initialScreen()).base;
  if (!base) return { hand: [] };
  const lines = handLines(base), hand: HandChoice[] = [];
  const guard = "--set removes no KEPT OUT rule: remove it from its own line of KEPT OUT on the screen (tickmarkr fleet), or in the config file";
  for (const set of sets) {
    // (a line is named as the screen and --json name it; a capital or a space around it is not a different line)
    const cut = set.indexOf("="), id = set.slice(0, cut).trim().toLowerCase(), line = lines.find((l) => l.id === id);
    // hardFrom=<2-10>: where very complex starts, one number for every line given out by complexity (rows 501, 502)
    if (cut > 0 && id === "hardfrom") {
      const to = set.slice(cut + 1).trim(), n = Number(to);
      if (!/^\d+$/.test(to) || n < 2 || n > 10) return { refused: `hardFrom is a whole number from 2 to 10, and ${JSON.stringify(to)} was given` };
      if (n === base.cfg.routing.hardFrom) return { refused: `hardFrom is already ${n}` };
      if (hand.some((x) => x.line === "hardFrom")) return { refused: "hardFrom is set twice" };
      hand.push({ line: "hardFrom", chosen: [String(n)] });
      continue;
    }
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
    // a shape may name how its line is given out before its models: plan=complexity:codex:a,claude-code:b (row 502)
    const turned = line?.mode ? /^(any|ordered|complexity):/.exec(set.slice(cut + 1))?.[1] as "any" | "ordered" | "complexity" | undefined : undefined;
    const models = set.slice(cut + 1 + (turned ? turned.length + 1 : 0)).split(",").map((x) => x.trim()).filter(Boolean);
    if (cut < 1 || !line) return { refused: `${JSON.stringify(set)} names no line — the lines are ${lines.map((l) => l.id).join(", ")}, written <line>=<adapter:model>[,…], and hardFrom=<2 to 10>` };
    if (!models.length && !line.deny) return { refused: `${id} needs ${line.setting ? "a value" : "at least one model"}` };
    // Rules first, in the contract's closed order, before any probe or working-model check (a rule that keeps it out,
    // then not allowed yet): every model named, one the line already names or one whose probe failed included, is asked the router's own
    // rule check: one a deny rule keeps out is refused by the rule's name, and no rule is lifted (K2). One only
    // not allowed yet is allowed by name, as on the screen.
    const ruled = line.deny || line.setting ? [] : models.filter((k) => k.indexOf(":") > 0).map((k) => ({ k, ...keptBy(base, k, line.role) })).filter((r) => r.why.length || !r.freed);
    const kept = ruled.find((r) => !r.freed || r.why.some((w) => w !== "the allowlist"));
    if (kept) return { refused: `${kept.k} is kept from ${id} by ${kept.why.filter((w) => w !== "the allowlist").join(" and ") || "a rule"} — ${guard}` };
    // (only after the rules: a model a rule keeps out is refused by that rule, however many are named)
    if (line.one && models.length > 1) return { refused: `${id} is one model, and ${models.length} were given` };
    const not = models.filter((k) => !line.candidates.includes(k));
    if (not.length) {
      // a model's bare name, as the screen draws it, is not its key: when one key here ends in it, that key is offered
      const meant = [...new Set(not)].map((k) => line.candidates.filter((c) => c.slice(c.indexOf(":") + 1) === k || c.endsWith(`/${k}`))).filter((m) => m.length === 1).map((m) => m[0]);
      return { refused: `${[...new Set(not)].join(", ")} ${new Set(not).size === 1 ? "is" : "are"} not ${line.deny || line.setting ? `something ${id} can name` : `${new Set(not).size === 1 ? "a working model" : "working models"} that may take ${id}`}${meant.length ? ` — did you mean ${meant.join(", ")}?` : ""} — tickmarkr fleet --json lists them under lines` };
    }
    const floored = hand.find((x) => x.line === line.id && !x.chosen.length && x.floor);
    if (hand.some((x) => x.line === line.id) && !floored) return { refused: `${id} is set twice` };
    const added = ruled.map((r) => r.k).filter((k) => !line.current.includes(k));
    // a KEPT OUT list may gain entries; one that leaves out a saved entry, or empties the list, is refused by the entry's name (K2)
    const lost = line.deny ? line.current.filter((k) => !models.includes(k)) : [];
    if (lost.length) return { refused: `${id} would no longer keep out ${lost.join(", ")}, which ${lost.length === 1 ? "is" : "are"} saved — ${guard}` };
    if (new Set(models).size !== models.length) return { refused: `${id} names a model twice` };
    // a bare list keeps the line's way; a shape with no line of its own yet is given out by complexity (row 502)
    // (a pin is given out in order: one model takes every task; contract section 4. A way named on a pin is a change:
    // the pin becomes a pool of that way, as before)
    const slot = base.cfg.routing.map[line.id as Shape], way = slot?.pool ? line.mode : slot?.pin ? "ordered" : undefined;
    const mode = line.mode && (turned ?? way ?? "complexity");
    const allows = added.length ? { allows: added } : {};
    if (models.length === line.current.length && models.every((k, i) => k === line.current[i]) && mode === (way ?? line.mode) && !(slot?.pin && turned)) return { refused: line.setting ? `${id} is already ${models[0]}` : `${id} already has exactly those models, in that order` };
    if (floored) Object.assign(floored, { chosen: models, ...(mode ? { mode } : {}), ...allows });
    else hand.push({ line: line.id, chosen: models, ...(mode ? { mode } : {}), ...allows });
  }
  return { hand };
}

/** What keeps `key` from `role` by the router's own rule check, asked on a copy of the rules: nothing is lifted (K2). */
function keptBy(M: NonNullable<ReturnType<typeof derive>["base"]>, key: string, role: PreferenceRole): { freed: boolean; why: string[] } {
  const cut = key.indexOf(":"), seat = observedSeat(M.health, key.slice(0, cut), key.slice(cut + 1));
  return disallowedBy(seat, M.cfg.routing, role) ? freeSeat(structuredClone(M.cfg.routing) as typeof M.cfg.routing, seat, key, role, othersOf(M, key)) : { freed: true, why: [] };
}

/** `--yes <id>…` and `--set <line>=<models>…`: the review as text; with `--save`, the write. */
function answer(load: () => ScreenSource, ids: string[], sets: string[], save: boolean): Result {
  const src = load();
  const set = handFrom(src, sets);
  if ("refused" in set) return { out: `tickmarkr fleet --set: ${set.refused}`, code: 1 };
  const d = derive(src, { ...initialScreen(), yes: ids, hand: set.hand });
  if (!d.base) return { out: `tickmarkr fleet: the config does not load — ${d.error}\n${errorWhere(src, d.errorIn)}`, code: 1 };
  if (ids.some((id) => !id.trim())) return { out: "tickmarkr fleet --yes: an id is missing after --yes — tickmarkr fleet --json lists the ids", code: 1 };
  const unknown = ids.filter((id) => !d.said.some((n) => n.id === id));
  if (unknown.length) return { out: `tickmarkr fleet --yes: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not something this fleet asks a yes about — tickmarkr fleet --json lists the ids`, code: 1 };
  const review = plainSave(src, ids, set.hand, 100);
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
  // --json prints the screen and changes nothing: beside an answer it would report as if nothing had been asked
  if (values.json && (values.yes?.length || values.set?.length || values.save)) return { out: "tickmarkr fleet: --json prints the screen and changes nothing — it does not go with --yes, --set or --save", code: 1 };
  if (values.save && !values.yes?.length && !values.set?.length) return { out: "tickmarkr fleet: --save needs --yes <id> or --set <line>=<models>", code: 1 };
  if (values.fresh) await probe();
  // A config that does not load is an error for a script too: the same text, and a non-zero exit.
  const loads = (src: ScreenSource): boolean => derive(src, initialScreen()).base !== undefined;
  const reported = (src: ScreenSource, out: string): Result => (loads(src) ? out : { out, code: 1 });
  if (values.json) {
    // (a config file that cannot be read is an answer in the same form, not a line of text where JSON was asked for)
    try { const src = load(); return reported(src, jsonScreen(src)); }
    catch (e) { if (e instanceof UnreadableConfig) return { out: JSON.stringify({ ok: false, error: e.message, in: [e.path] }, null, 2), code: 1 }; throw e; }
  }
  if (values.yes?.length || values.set?.length) return answer(load, values.yes ?? [], values.set ?? [], values.save ?? false);
  // Without a terminal the screen is printed, never refused: an agent in a pipe reads the same thing.
  if (values.plain || input.isTTY !== true || output.isTTY !== true) { const src = load(); return reported(src, plainOne(src, 100)); }

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

