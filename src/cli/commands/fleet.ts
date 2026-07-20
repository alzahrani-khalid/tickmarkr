import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { allAdapters, discoverChannels, doctorAgeMs, initDoctorReuse, readAutoPrefer } from "../../adapters/registry.js";
import { fleetUnclassifiedModels } from "../../adapters/model-lints.js";
import { GLYPHS, bold, legend as legendText, toggleActive, toggleInactive } from "../../brand.js";
import type { WorkerAdapter } from "../../adapters/types.js";
import {
  fleetEditableFromConfig,
  fleetEditableEquals,
  fleetRepoOverlayFromDelta,
  formatFleetPrint,
  globalConfigDir,
  harvestFleetProvenance,
  overlayBytesLoadError,
  overlayPreferShapes,
  readOverlayFile,
  repoOverlayPath,
  repoOverlayYaml,
  ROUTING_MODES,
  type FleetEditable,
  type MapEntry,
  type RoutingMode,
  type Tier,
  unifiedYamlDiff,
} from "../../config/config.js";
import { SHAPES, TIERS, type Shape, type Task } from "../../graph/schema.js";
import { candidateRow, costSignal, shapeCandidates } from "./fleet-picker.js";
import { route } from "../../route/router.js";
import { resolveRunMode, type ResolvedRunMode } from "../../run/daemon.js";
import { loadRoutingProfile } from "../../run/journal.js";

const NON_TTY_MSG = "tickmarkr fleet: interactive fleet editor requires a TTY — use `tickmarkr fleet --print` for non-interactive output";
const QUIT = "fleet: quit without writing";

type Key = { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean; shift?: boolean };

export type FleetInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  pause: () => unknown;
  resume: () => unknown;
};
export type FleetOutput = { isTTY?: boolean; write: (chunk: string) => unknown };
export type FleetIO = { input?: FleetInput; output?: FleetOutput };

const isDeniedAdapter = (id: string, editable: FleetEditable) => editable.denyAdapters.includes(id);
const isDeniedModel = (adapter: string, model: string, editable: FleetEditable) =>
  editable.denyModels.includes(`${adapter}:${model}`);

// v1.60 T3: every preview surface ranks with the SAME exploration setting as the candidate picker
// (rankCandidates routes noExplore so repeated calls agree) — a due probe must never make a
// step-4/5 row disagree with the picker's rank-1 for the same shape and channel set.
const PREVIEW_EXPLORE = { noExplore: true } as const;

function previewTask(shape: Shape): Task {
  return {
    id: "fleet-preview",
    title: "fleet preview",
    goal: "preview",
    shape,
    complexity: 3,
    acceptance: ["done"],
    deps: [],
    files: [],
    context: [],
    gates: ["build", "test", "lint", "evidence", "scope", "acceptance", "review"],
    humanGate: false,
    status: "pending",
    evidence: { commits: [], artifacts: [], gateResults: [] },
  };
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return "no probe data";
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `${mins}m old`;
  return `${Math.floor(mins / 60)}h old`;
}

function currentRepoOverlayText(repoRoot: string): string {
  const p = repoOverlayPath(repoRoot);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function provenanceMap(editable: FleetEditable): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [adapter, models] of Object.entries(editable.tiers)) {
    for (const [model, v] of Object.entries(models)) {
      if (v?.provenance) {
        out[adapter] ??= {};
        out[adapter][model] = v.provenance;
      }
    }
  }
  return out;
}

// v1.51 T4: serializeFleetOverlay predates routing.mode — splice the mode line under routing:
// so a repo-declared mode survives fleet writes and a mode selection lands as routing.mode.
function withModeLine(yaml: string, mode: RoutingMode | undefined): string {
  if (!mode) return yaml;
  if (/^routing:$/m.test(yaml)) return yaml.replace(/^routing:$/m, `routing:\n  mode: ${mode}`);
  return `routing:\n  mode: ${mode}\n${yaml}`;
}

// v1.51 T4: one gloss per routing mode on the fleet mode screen — mirrors the preset compiler.
const MODE_GLOSS: Record<RoutingMode, string> = {
  "partner-led": "every shape frontier · explore off",
  "risk-based": "risk-tiered default floors",
  "staff-led": "implement/refactor one band down · integrity shapes hold frontier",
};

const isAbort = (k: Key) => k.name === "escape" || k.name === "q" || (k.ctrl === true && k.name === "c");
const isNext = (k: Key) => k.name === "return" || k.name === "enter";
const isToggle = (k: Key) => k.name === "space";

function moveCursor(k: Key, cursor: number, count: number): number {
  if (count === 0) return cursor;
  if (k.name === "down" || k.name === "j") return Math.min(cursor + 1, count - 1);
  if (k.name === "up" || k.name === "k") return Math.max(cursor - 1, 0);
  return cursor;
}

// step title (bold) + one dim key legend + rows; exactly one pointer glyph on the cursor row
function listFrame(title: string, legend: string, rows: string[], cursor: number): string[] {
  const lines = [bold(title), legendText(legend)];
  rows.forEach((r, i) => lines.push(i === cursor ? `${GLYPHS.pointer} ${bold(r)}` : `  ${r}`));
  return lines;
}

// Keypress terminal over the (injectable) input stream. Keypress events are decoded by
// node's own emitKeypressEvents ON THE STREAM — no readline interface is held in keypress
// mode, so the production path and the test seam are the same decoder (OBS-69).
function openTerm(input: FleetInput, output: FleetOutput) {
  emitKeypressEvents(input);
  const queue: Key[] = [];
  let pending: ((k: Key) => void) | null = null;
  const onKeypress = (str: string | undefined, key: Key | undefined) => {
    const k: Key = key && (key.name !== undefined || key.sequence !== undefined) ? key : { name: str, sequence: str };
    if (pending) {
      const fn = pending;
      pending = null;
      fn(k);
    } else queue.push(k);
  };
  const setRaw = (on: boolean) => void input.setRawMode?.(on);
  input.on("keypress", onKeypress);
  setRaw(true);
  input.resume();
  let prevLines = 0;
  return {
    key(): Promise<Key> {
      const buffered = queue.shift();
      if (buffered) return Promise.resolve(buffered);
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
    frame(lines: string[]): void {
      const erase = prevLines > 0 ? `\x1b[${prevLines}F\x1b[0J` : "";
      output.write(`${erase}${lines.join("\n")}\n`);
      prevLines = lines.length;
    },
    // typed entry leaves keypress mode: raw off, transient line interface, closed after the
    // question; keys the line editor leaked into the decoder are dropped (type-ahead kept)
    async askTyped(prompt: string): Promise<string> {
      const typedFrom = queue.length;
      setRaw(false);
      const rl = createInterface({
        input: input as unknown as NodeJS.ReadableStream,
        output: output as unknown as NodeJS.WritableStream,
      });
      try {
        return (await rl.question(prompt)).trim();
      } finally {
        rl.close();
        setRaw(true);
        // rl.close() pauses the input stream — without a resume the next key() await has
        // nothing keeping the event loop alive and the process silently exits 0 (OBS-77)
        input.resume();
        queue.splice(typedFrom);
        prevLines = 0;
      }
    },
    // every exit path: raw mode off, zero keypress listeners, stream paused (OBS-70)
    close(): void {
      input.off("keypress", onKeypress);
      setRaw(false);
      input.pause();
    },
  };
}

export async function fleet(
  argv: string[],
  cwd = process.cwd(),
  adapters: WorkerAdapter[] = allAdapters(),
  io: FleetIO = {},
): Promise<string | { out: string; code: number }> {
  const { values } = parseArgs({
    args: argv,
    options: {
      print: { type: "boolean" },
      "global-dir": { type: "string" },
      fresh: { type: "boolean" },
    },
  });
  const globalDir = values["global-dir"] ?? globalConfigDir();
  const print = values.print ?? false;
  const input = io.input ?? (process.stdin as FleetInput);
  const output = io.output ?? (process.stdout as FleetOutput);
  const interactive = input.isTTY === true && output.isTTY === true;

  if (print) {
    // v1.51 T4: the print surface names the mode and its source layer right under the header —
    // comment-prefixed so the YAML body stays machine-parseable and regex-stable.
    const rm = resolveRunMode(cwd, { globalDir });
    const body = formatFleetPrint(cwd, { globalDir });
    const nl = body.indexOf("\n");
    return `${body.slice(0, nl)}\n# mode: ${rm.mode.mode} (${rm.source})${body.slice(nl)}`;
  }

  if (!interactive) return { out: NON_TTY_MSG, code: 1 };

  const fresh = values.fresh ?? false;
  const { reuse, health: cached } = initDoctorReuse(cwd, fresh);
  if (!reuse || !cached) {
    return {
      out: "tickmarkr fleet: probe data missing or stale — run `tickmarkr doctor` first (fleet never re-probes; doctor is the sensor)",
      code: 1,
    };
  }

  const rm = resolveRunMode(cwd, { globalDir });
  const cfg = rm.cfg;
  // OBS-88: harvest existing `# note` comments from the overlay bytes at session load — the
  // session must know about every prior note, not only its own edits, or the next write strips them
  const harvested = harvestFleetProvenance(currentRepoOverlayText(cwd));
  const initial = fleetEditableFromConfig(cfg, harvested.tiers);
  const editable = structuredClone(initial) as FleetEditable;
  const health = cached;
  const term = openTerm(input, output);

  try {
    // step 1/6 — probe data
    const ageLine = formatAge(doctorAgeMs(cwd));
    term.frame(listFrame(
      "step 1/6 · probe data",
      "enter continue · r refresh via doctor · esc/q quit",
      [`probe data: ${ageLine} (.tickmarkr/doctor.json)`],
      0,
    ));
    for (;;) {
      const k = await term.key();
      if (isAbort(k)) return QUIT;
      if (k.name === "r") {
        return "fleet: run `tickmarkr doctor` to refresh probe data, then re-run `tickmarkr fleet` (doctor is the sensor; fleet never re-probes)";
      }
      if (isNext(k)) break;
    }

    // step 2/6 — agent CLIs (space toggles adapter deny)
    const installed = adapters.filter((a) => health[a.id]?.installed);
    const adapterRows = () =>
      installed.map((a) => {
        const h = health[a.id];
        const on = !isDeniedAdapter(a.id, editable);
        return `${on ? toggleActive() : toggleInactive()} ${a.id}  ${h?.version ?? "installed"}  ${h?.authed ? "authed" : "unauthed"}`;
      });
    const listLegend = "↑↓/jk move · space toggle · enter next · esc/q quit";
    let aCursor = 0;
    term.frame(listFrame("step 2/6 · agent CLIs", listLegend, adapterRows(), aCursor));
    for (;;) {
      const k = await term.key();
      if (isAbort(k)) return QUIT;
      if (isNext(k)) break;
      let changed = false;
      const moved = moveCursor(k, aCursor, installed.length);
      if (moved !== aCursor) {
        aCursor = moved;
        changed = true;
      } else if (isToggle(k) && installed.length > 0) {
        const id = installed[aCursor].id;
        const idx = editable.denyAdapters.indexOf(id);
        if (idx === -1) editable.denyAdapters.push(id);
        else editable.denyAdapters.splice(idx, 1);
        editable.denyAdapters.sort();
        changed = true;
      }
      if (changed) term.frame(listFrame("step 2/6 · agent CLIs", listLegend, adapterRows(), aCursor));
    }

    // step 3/6 — models per enabled adapter (space toggles deny, t assigns tier from the row)
    const enabledAdapters = installed.filter((a) => !isDeniedAdapter(a.id, editable));
    for (const a of enabledAdapters) {
      const unclassifiedAll = fleetUnclassifiedModels(cfg, health, adapters).filter((u) => u.adapter === a.id);
      type Row = { kind: "classified" | "unclassified"; model: string; detectedAt?: string };
      const rowsData = (): Row[] => [
        ...Object.keys(editable.tiers[a.id] ?? {}).map((m) => ({ kind: "classified" as const, model: m })),
        ...unclassifiedAll
          .filter((u) => !editable.tiers[a.id]?.[u.model])
          .map((u) => ({ kind: "unclassified" as const, model: u.model, detectedAt: u.detectedAt })),
      ];
      const renderRows = (rows: Row[]) =>
        rows.map((r) => {
          if (r.kind === "unclassified") {
            return `( ) ${r.model}  ???  unclassified${r.detectedAt ? ` (${r.detectedAt})` : ""}`;
          }
          const tier = editable.tiers[a.id]?.[r.model];
          const denied = isDeniedModel(a.id, r.model, editable);
          return `${denied ? toggleInactive() : toggleActive()} ${r.model}  ${tier?.tier ?? "???"}  ${denied ? "denied" : "allowed"}`;
        });
      const title = `step 3/6 · models · ${a.id}`;
      const modelsLegend = "↑↓/jk move · space toggle · t tier · enter next · esc/q quit";
      let mCursor = 0;
      term.frame(listFrame(title, modelsLegend, renderRows(rowsData()), mCursor));
      for (;;) {
        const k = await term.key();
        if (isAbort(k)) return QUIT;
        if (isNext(k)) break;
        const rows = rowsData();
        let changed = false;
        const moved = moveCursor(k, mCursor, rows.length);
        if (moved !== mCursor) {
          mCursor = moved;
          changed = true;
        } else if (isToggle(k) && rows[mCursor]?.kind === "classified") {
          const key = `${a.id}:${rows[mCursor].model}`;
          const idx = editable.denyModels.indexOf(key);
          if (idx === -1) editable.denyModels.push(key);
          else editable.denyModels.splice(idx, 1);
          editable.denyModels.sort();
          changed = true;
        } else if (k.name === "t" && rows[mCursor]) {
          if (rows[mCursor].kind === "classified") {
            // v1.60 T2: t on a classified row is a step-3 input mistake like any other — the
            // notice renders inline and the session (with every in-session edit) stays alive
            term.frame([
              ...listFrame(title, modelsLegend, renderRows(rows), mCursor),
              "fleet: tier reassignment on classified models is not supported in v1 — edit config directly",
            ]);
            continue;
          }
          // v1.60 T2: an input mistake re-prompts the same field — a typo must never unwind
          // the whole editor and discard every in-session edit before the review screen
          let tier = (await term.askTyped(`tier (${TIERS.join("|")})> `)) as Tier;
          while (!TIERS.includes(tier)) {
            tier = (await term.askTyped(`fleet: invalid tier ${tier || "(empty)"} — tier (${TIERS.join("|")})> `)) as Tier;
          }
          let note = await term.askTyped("benchmark provenance note (required): ");
          while (!note) {
            note = await term.askTyped("fleet: a typed benchmark-provenance note is required — benchmark provenance note (required): ");
          }
          editable.tiers[a.id] ??= {};
          // stamp at typing time — the serializer writes provenance verbatim, so harvested notes
          // round-trip byte-for-byte instead of accreting a fresh date suffix every write (OBS-88)
          const today = new Date().toISOString().slice(0, 10);
          editable.tiers[a.id][rows[mCursor].model] = { tier, provenance: `${note} — fleet ${today}` };
          changed = true;
        }
        if (changed) term.frame(listFrame(title, modelsLegend, renderRows(rowsData()), mCursor));
      }
    }

    // step 4/6 — routing mode (selection is in-memory; the write happens only through the diff confirm).
    // Candidate floor tables come from the ONE preset compiler via resolveRunMode — no mode math here.
    const modeCfgs = Object.fromEntries(
      ROUTING_MODES.map((m) => [m, m === rm.mode.mode ? rm : resolveRunMode(cwd, { flag: m, globalDir })]),
    ) as Record<RoutingMode, ResolvedRunMode>;
    // v1.56 T3: both screens preview-route through ONE lens — the same live channel set, learned
    // profile, and per-mode resolved floors — so the mode spend context and the shape rows can
    // never disagree about what the router would do.
    const channels = discoverChannels(cfg, adapters, health);
    const profile = loadRoutingProfile(cwd, cfg, { preview: true });
    const previewCfg = (m: RoutingMode) => ({ ...cfg, routing: { ...cfg.routing, map: editable.map, floors: modeCfgs[m].cfg.routing.floors } });
    // Estimated spend context under the highlighted mode: tier mix across all nine preview shapes,
    // then channel economics — dollars only for api-routed shapes (plan.ts's rough per-task
    // pricing table); a sub channel is flat-rate quota and never renders as a dollar amount.
    const modeSpend = (cand: RoutingMode): string => {
      const tierCount: Partial<Record<Tier, number>> = {};
      let subs = 0;
      let apiN = 0;
      let apiUsd = 0;
      for (const shape of SHAPES) {
        try {
          const a = route(previewTask(shape), previewCfg(cand), channels, profile, undefined, undefined, PREVIEW_EXPLORE).assignment;
          tierCount[a.tier] = (tierCount[a.tier] ?? 0) + 1;
          if (a.channel === "sub") subs += 1;
          else {
            apiN += 1;
            apiUsd += cfg.pricing[a.tier] ?? 0;
          }
        } catch {
          // unroutable under this mode's floors — the shape screen names the error per row
        }
      }
      const mix = [...TIERS].reverse().flatMap((t) => (tierCount[t] ? [`${tierCount[t]} ${t}`] : [])).join(" · ");
      const parts: string[] = [];
      if (subs) parts.push(`${subs === SHAPES.length ? "all" : subs} sub (flat-rate quota)`);
      if (apiN) parts.push(`${apiN} api · est. cost (API shapes only, rough): ~$${apiUsd.toFixed(2)}`);
      const unroutable = SHAPES.length - subs - apiN;
      if (unroutable) parts.push(`${unroutable} unroutable`);
      return `  mix: ${mix} — ${parts.join(" · ")}`;
    };
    const modeRows = () =>
      ROUTING_MODES.map((m) => `${m === rm.mode.mode ? toggleActive() : " "} ${m.padEnd(11)}  ${MODE_GLOSS[m]}`);
    // preview: the highlighted mode's resolved floor table diffed against the current mode
    const floorPreview = (cand: RoutingMode): string[] => {
      if (cand === rm.mode.mode) return [];
      const cur = cfg.routing.floors;
      const next = modeCfgs[cand].cfg.routing.floors;
      const changed = SHAPES.filter((s) => cur[s] !== next[s]);
      return [
        `  floors vs ${rm.mode.mode}:`,
        ...(changed.length ? changed.map((s) => `    ${s}: ${cur[s]} → ${next[s]}`) : ["    (no floor changes)"]),
      ];
    };
    const modeTitle = "step 4/6 · routing mode";
    const modeLegend = "↑↓/jk move · enter select · esc/q quit";
    let modeCursor = ROUTING_MODES.indexOf(rm.mode.mode);
    let selectedMode: RoutingMode = rm.mode.mode;
    const modeFrame = () => [
      ...listFrame(modeTitle, modeLegend, modeRows(), modeCursor),
      modeSpend(ROUTING_MODES[modeCursor]),
      ...floorPreview(ROUTING_MODES[modeCursor]),
    ];
    term.frame(modeFrame());
    for (;;) {
      const k = await term.key();
      if (isAbort(k)) return QUIT;
      if (isNext(k)) {
        selectedMode = ROUTING_MODES[modeCursor];
        break;
      }
      const moved = moveCursor(k, modeCursor, ROUTING_MODES.length);
      if (moved !== modeCursor) {
        modeCursor = moved;
        term.frame(modeFrame());
      }
    }

    // step 5/6 — shape routing (candidate picker for pin, typed entry for prefer);
    // previews route under the SELECTED mode's resolved floors, never a floor edit of its own
    const autoPrefer = readAutoPrefer(cwd);
    const overlayShapes = overlayPreferShapes(cwd, { globalDir });
    const shapeRows = () =>
      SHAPES.map((shape) => {
        let now: string;
        try {
          const r = route(previewTask(shape), previewCfg(selectedMode), channels, profile, undefined, undefined, PREVIEW_EXPLORE);
          now = `${r.assignment.adapter}:${r.assignment.model} (${r.assignment.channel}, ${r.assignment.tier})  ${costSignal(r.assignment, cfg.pricing)}`;
        } catch (e) {
          now = (e as Error).message;
        }
        const auto = autoPrefer?.[shape] && !overlayShapes.has(shape) ? "  (auto-prefer active)" : "";
        return `${shape}  →  ${now}${auto}`;
      });
    const shapesTitle = "step 5/6 · shape routing";
    // v1.52 T5: no map-tier editing action — routing.floors is the only band authority now.
    const shapesLegend = "↑↓/jk move · a auto · p pin · f prefer · enter next · esc/q quit";
    let sCursor = 0;
    term.frame(listFrame(shapesTitle, shapesLegend, shapeRows(), sCursor));
    for (;;) {
      const k = await term.key();
      if (isAbort(k)) return QUIT;
      if (isNext(k)) break;
      const shape = SHAPES[sCursor];
      const entry = editable.map[shape] ?? {};
      let changed = false;
      const moved = moveCursor(k, sCursor, SHAPES.length);
      if (moved !== sCursor) {
        sCursor = moved;
        changed = true;
      } else if (k.name === "a") {
        const next: MapEntry = { ...entry };
        delete next.pin;
        editable.map[shape] = next;
        changed = true;
      } else if (k.name === "p") {
        // v1.56 T2: arrow-driven candidate picker replaces the typed pin entry (operator ruling:
        // the suggestion proposes, the user disposes). Every rank is a production route() result
        // (T1 seam); a pick mutates editable only — the write still funnels through the ONE
        // diff-confirm + reload-guard path below. The picker adds no listeners of its own, so
        // every exit path inherits term.close()'s release-and-pause contract in the finally.
        const cand = shapeCandidates(previewTask(shape), previewCfg(selectedMode), channels, profile);
        let pCursor = 0;
        const pickerFrame = () =>
          listFrame(`pick · ${shape}`, "↑↓/jk move · enter pin · esc cancel · q quit", cand.map((c) => candidateRow(c, cfg.pricing)), pCursor);
        term.frame(pickerFrame());
        for (;;) {
          const pk = await term.key();
          if (pk.name === "q" || (pk.ctrl === true && pk.name === "c")) return QUIT;
          if (pk.name === "escape") break;
          if (isNext(pk) && cand.length > 0) {
            const a = cand[pCursor].assignment;
            editable.map[shape] = { pin: { via: a.adapter, model: a.model } };
            break;
          }
          const pMoved = moveCursor(pk, pCursor, cand.length);
          if (pMoved !== pCursor) {
            pCursor = pMoved;
            term.frame(pickerFrame());
          }
        }
        changed = true; // the picker replaced the frame — every exit redraws the shape screen
      } else if (k.name === "f") {
        const pref = await term.askTyped("prefer (comma-separated adapters or adapter:model)> ");
        editable.map[shape] = { ...entry, prefer: pref.split(",").map((s) => s.trim()).filter(Boolean) };
        changed = true;
      }
      if (changed) term.frame(listFrame(shapesTitle, shapesLegend, shapeRows(), sCursor));
    }

    // step 6/6 — steering (v1.54 T4): review.prefer + consult.prefer via the same typed-entry
    // pattern as the shape prefer action; edits are in-memory only and land on the merged overlay
    // below, so they ride the ONE diff-confirm + reload-guard write path (never a second writer)
    const STEER_KEYS = ["review", "consult"] as const;
    const initialSteering: Record<(typeof STEER_KEYS)[number], string[] | undefined> = {
      review: cfg.review.prefer?.slice(),
      consult: cfg.consult.prefer?.slice(),
    };
    const steering = structuredClone(initialSteering);
    const steerRows = () => STEER_KEYS.map((k) => `${k}.prefer  →  ${steering[k]?.join(", ") ?? "(none)"}`);
    const steerTitle = "step 6/6 · steering";
    const steerLegend = "↑↓/jk move · f prefer · enter next · esc/q quit";
    let stCursor = 0;
    term.frame(listFrame(steerTitle, steerLegend, steerRows(), stCursor));
    for (;;) {
      const k = await term.key();
      if (isAbort(k)) return QUIT;
      if (isNext(k)) break;
      let changed = false;
      const moved = moveCursor(k, stCursor, STEER_KEYS.length);
      if (moved !== stCursor) {
        stCursor = moved;
        changed = true;
      } else if (k.name === "f") {
        const which = STEER_KEYS[stCursor];
        const grammar = which === "consult" ? "adapter:model seats" : "adapters or adapter:model";
        const raw = await term.askTyped(`${which}.prefer (comma-separated ${grammar}, empty clears)> `);
        const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
        steering[which] = list.length ? list : undefined;
        changed = true;
      }
      if (changed) term.frame(listFrame(steerTitle, steerLegend, steerRows(), stCursor));
    }

    // review — unified diff + typed confirm (the ONLY write path; the mode screen funnels through here)
    const before = currentRepoOverlayText(cwd);
    const existing = readOverlayFile(repoOverlayPath(cwd));
    const modeChanged = selectedMode !== rm.mode.mode;
    // preserve a repo-declared mode line verbatim; write a new one only when the selection changed it
    const writeMode = modeChanged ? selectedMode : (existing as { routing?: { mode?: RoutingMode } }).routing?.mode;
    const merged = fleetEditableEquals(initial, editable)
      ? (structuredClone(existing) as Record<string, unknown>)
      : fleetRepoOverlayFromDelta(initial, editable, existing);
    // steering lands on the merged object and serializes via repoOverlayYaml's non-fleet
    // passthrough; clearing removes the prefer key (and an emptied parent block) from the overlay
    let steeringChanged = false;
    for (const key of STEER_KEYS) {
      if (JSON.stringify(steering[key]) === JSON.stringify(initialSteering[key])) continue;
      steeringChanged = true;
      const block = { ...(merged[key] as Record<string, unknown> | undefined) };
      if (steering[key]) block.prefer = steering[key];
      else delete block.prefer;
      if (Object.keys(block).length) merged[key] = block;
      else delete merged[key];
    }
    // OBS-88: session notes (which include the harvested ones attached at load) win per model;
    // harvested notes alone cover entries with no editable seat — e.g. a null tombstone's comment
    const tierNotes = structuredClone(harvested.tiers);
    for (const [ad, ms] of Object.entries(provenanceMap(editable))) {
      for (const [m, n] of Object.entries(ms)) (tierNotes[ad] ??= {})[m] = n;
    }
    const after = withModeLine(
      repoOverlayYaml(merged, tierNotes, { adapters: harvested.denyAdapters, models: harvested.denyModels }),
      writeMode,
    );
    if ((!modeChanged && !steeringChanged && fleetEditableEquals(initial, editable)) || before === after) {
      return "fleet: no overlay changes (empty diff)";
    }
    const diff = unifiedYamlDiff(before, after, repoOverlayPath(cwd));
    output.write(`\n${diff}\n`);
    const confirm = await term.askTyped("write overlay? [y/N] ");
    if (!/^y(?:es)?$/i.test(confirm)) return "fleet: discarded overlay changes";

    const path = repoOverlayPath(cwd);
    // v1.52 T2 reload guard: the exact bytes about to land must reload through the production
    // loader path, or the write is refused and the existing overlay stays untouched (OBS-75 class:
    // fleet must never persist a config that bricks every later command).
    const loadError = overlayBytesLoadError(cwd, after, { globalDir });
    if (loadError) {
      return { out: `fleet: refusing to write ${path} — the config loader rejects the proposed overlay:\n${loadError}`, code: 1 };
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, after);
    return `fleet: wrote ${path}`;
  } finally {
    term.close();
  }
}
