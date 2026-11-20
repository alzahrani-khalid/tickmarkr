// The other lines of the one screen opened, the views of a change by hand that are not a shape's line (queue rows
// 499, 500; D-2187 add.363; contract 5.4, 5.5): the judge, the review and the consult as an order, the mode as its
// three values, a KEPT OUT rule with x to remove it. The 2.26.1 tick lists that lived here are gone (row 499).
import { type BillingChannel, channelKey } from "../adapters/types.js";
import { S, type Style, width } from "./draw.js";
import { disallowedBy, exclusionCollector, observedSeat } from "../route/preference.js";
import { MODE_SAYS, namesOf } from "./hand.js";
import type { KeptRule } from "./kept.js";
import { ROUTING_MODES } from "../config/config.js";
import { type FleetModel, splitKey, verdictOf } from "./model.js";
import { holderIn, parsedLayers } from "./needs.js";
import { judgesOf, type OneLine } from "./one-screen.js";
import { resolveSeats, type SeatSkip, SKIP_REASONS, type SkipReason } from "../route/seat-resolver.js";
import { gateReviewerFloor } from "../gates/review.js";
import { modelColumns } from "./models-view.js";
import { preferIndex } from "../route/router.js";
import { facts, flow, pad, price, score, V } from "./line-view.js";

// The other lines of the one screen opened (queue rows 499, 500; D-2187 add.363; contract 5.4): the judge,
// the review and the consult as an order, with no choice rows (by complexity is for a shape's line only);
// the mode as its three values, each saying what it does; a KEPT OUT rule with its reason, the models it keeps
// out now and x to remove it. Pure, as the shape's view: the keys live in screen.ts.
export type Other = "judge" | "review" | "consult" | "mode";
export const OTHER: Record<Other, { label: string; job: string; path: string[] }> = {
  judge: { label: "acceptance (judge)", job: "who judges each task against its acceptance criteria", path: ["judge"] },
  review: { label: "review", job: "who reviews each task, of another vendor than its writer", path: ["review", "prefer"] },
  consult: { label: "consult", job: "who is asked when a task stalls or the gates conflict", path: ["consult", "prefer"] },
  mode: { label: "mode", job: "the bar every shape keeps, unless it has one of its own", path: ["routing", "mode"] },
};
export interface OtherViewInput { M: FleetModel; id: Other; chosen: readonly string[]; project: string; cursor: number; note?: string }
export type OtherSlot = { kind: "value"; value: string } | { kind: "model"; key: string; row: number } | { kind: "add" };
/** The cursor's places: the mode's three values; else the rows in order, then + (none for the judge, which is one row). */
export function otherSlots(inp: Pick<OtherViewInput, "id" | "chosen">): OtherSlot[] {
  if (inp.id === "mode") return ROUTING_MODES.map((value): OtherSlot => ({ kind: "value", value }));
  return [...inp.chosen.map((key, row): OtherSlot => ({ kind: "model", key, row })), ...(inp.id === "judge" ? [] : [{ kind: "add" } as const])];
}
/** The cursor takes a row's first two cells only. */
const cursored = (row: OneLine): OneLine => [{ ...S("▸ ", "accent"), selected: true },
  ...[{ ...row[0], text: row[0].text.slice(2) }, ...row.slice(1)].filter((s) => s.text !== "").map((s) => ({ ...s, selected: true }))];

/** One of the other lines opened, as its body and its footer (the note and the keys). */
export function otherParts(inp: OtherViewInput, w = 100): { body: OneLine[]; footer: OneLine[] } {
  const { M, id, chosen } = inp, slots = otherSlots(inp), at = Math.max(0, Math.min(inp.cursor, slots.length - 1));
  const mark = (i: number, row: OneLine): OneLine => (i === at ? cursored(row) : row);
  const blank: OneLine = [S(" ")], { label, job, path } = OTHER[id];
  const said = (head: string, texts: readonly OneLine[]) => texts.flatMap((t, i) => flow([S(pad(i === 0 ? `  ${head}` : "", 14), "head"), ...t], w, 14));
  const out: OneLine[] = [...flow([S(label, "head"), S(`  ${job}`, "dim")], w, 0), blank];
  if (id === "mode") {
    const now = chosen[0] ?? M.mode.mode;
    ROUTING_MODES.forEach((v, i) => out.push(...flow(mark(i, [S("  "), S(v === now ? "(•) " : "( ) ", v === now ? "ok" : "dim"),
      V(pad(v, 14), v === now ? "ok" : "dim"), S(MODE_SAYS[v], v === now ? undefined : "dim")]), w, 20)));
    out.push(blank, ...flow([S("  A bar set for one shape still beats the mode: ", "dim"), V("routing.floors", "dim")], w, 2));
  } else {
    const cliWide = (k: string) => !k.includes(":"), names = namesOf(M, chosen.filter((k) => !cliWide(k)));
    const nameAt = (i: number) => (cliWide(chosen[i]) ? "every model" : names[chosen.slice(0, i).filter((k) => !cliWide(k)).length]);
    // Each entry read through the resolution the run makes (rows 499; D-2187 add.413): the review per writer of the
    // sample tasks (another vendor, a known vendor, at its writer's level), the consult in strict order, the judge as
    // judgesOf names it. An entry that resolves for nobody reads the reason of the model it names that got furthest.
    const unavailable = (key: string): string => {
      const [a, m] = splitKey(key), h = M.health?.[a], v = M.seat(key)?.verdict ?? verdictOf(M.health, a, m, M.inputs.now);
      if (M.health && !h?.installed) return "not installed";
      if (M.health && !h?.authed) return "not signed in";
      return v.state === "pass" ? "not offered" : v.state === "never" ? "not checked yet" : v.text;
    };
    const WORDS: Record<SkipReason, (s: SeatSkip) => string> = {
      denied: (x) => (x.detail?.startsWith("routing.allow") ? "not allowed yet" : "kept out"), "not-configured": () => "not listed",
      // with no probe at all, nothing has been checked: never "not installed" (D-2187 add.413)
      "not-installed": () => (M.health ? "not installed" : "not checked yet"), "adapter-unauthed": () => (M.health ? "not signed in" : "not checked yet"), "model-unavailable": (x) => unavailable(x.channel ?? x.entry),
      "excluded-vendor": () => "vendor excluded", "unknown-vendor": () => "vendor unknown", author: () => "not independent of its writer",
      // the bar a reviewer must meet names its cause, as gateReviewerFloor returns it: review.floor is the configured bar
      "below-floor": (x) => (barBy.get(x) === "config" ? "below the review bar" : "below its writer's level"), excluded: () => "excluded",
    };
    const view = { cfg: M.cfg, adapters: M.inputs.adapters, health: M.health };
    const writers = M.sample().workers.flatMap((x) => M.pools.worker.filter((c) => channelKey(c) === x.key));
    // a skip below the bar remembers what raised the bar for its writer (the writer's level, or review.floor)
    const barBy = new WeakMap<SeatSkip, string>();
    // per writer only, as task review resolves: with no writer no task is reviewed, and nobody is asked first (D-2187 add.413)
    const review = (pool: readonly BillingChannel[], prefer: readonly string[]) => writers.map((w) => {
      const bar = gateReviewerFloor({}, M.cfg, w, M.pools.review), r = resolveSeats({ role: "review", pool, prefer, ...view, author: w, authors: [channelKey(w)], floor: bar.floor });
      for (const x of r.skips) barBy.set(x, bar.cause);
      return r;
    });
    // the entry alone, over the whole pool (a writer must be found in it): it works when a model it names is ranked
    const resolve = (prefer: readonly string[]) => (id === "review" ? review(M.pools.review, prefer)
      : [resolveSeats({ role: "consult", pool: M.pools.consult, ...view, cfg: { ...M.cfg, consult: { ...M.cfg.consult, prefer: [...prefer] } } })]);
    const alone = (k: string) => resolve([k]);
    // the whole order as the run resolves it: each channel belongs to the first row that names it (D-2187 add.414)
    const whole = id === "judge" ? [] : resolve(chosen).flatMap((r) => r.ranked);
    // the rows that are asked first: the entry each actual pick is read by
    const firsts = new Set(id === "review" ? review(M.pools.review, chosen).flatMap((r) => (r.pick ? [preferIndex(r.pick, chosen)] : []))
      : id === "consult" && M.consult ? [preferIndex(observedSeat(M.health, ...splitKey(M.consult)), chosen)] : []);
    const { judges } = judgesOf(M);
    // a model that cannot work reads its reason in place of its job (5.4)
    const why = (k: string, i: number): [string, Style | undefined] | null => {
      if (id === "judge") {
        const [a, m] = splitKey(k), d = disallowedBy(observedSeat(M.health, a, m), M.cfg.routing, "judge");
        if (d) return [d.by === "allow" ? "not allowed yet" : "kept out", "warn"];
        if (!M.seat(k) && !M.health?.[a]?.models?.includes(m)) return ["not listed", "warn"];
        return M.pools.judge.some((c) => channelKey(c) === k) ? null : [unavailable(k), "warn"];
      }
      // an entry written again further down is the same entry: the run ranks it once (D-2187 add.413)
      const first = chosen.indexOf(k);
      if (first < i) return [`same as row ${first + 1}`, undefined];
      if (id === "review" && !writers.length) return ["no task to review", "warn"];
      const rs = alone(k);
      const own = rs.flatMap((r) => r.ranked).filter((c) => preferIndex(c, [k]) === 0);
      if (own.length) {
        // a row that resolves to no channel an earlier row has not already taken adds nothing: it is never a backup (D-2187 add.414)
        if (whole.some((c) => preferIndex(c, chosen) === i)) return null;
        const by = Math.min(...own.map((c) => preferIndex(c, chosen)));
        return by < i ? [`same as row ${by + 1}`, undefined] : null;
      }
      const skip = rs.flatMap((r) => r.skips).sort((x, y) => SKIP_REASONS.indexOf(y.reason) - SKIP_REASONS.indexOf(x.reason))[0];
      return [skip ? WORDS[skip.reason](skip) : cliWide(k) ? "no model answers" : "not listed", "warn"];
    };
    const jobOf = (k: string, i: number): [string, Style | undefined] =>
      why(k, i) ?? (id === "judge" ? (judges.includes(k) ? ["judges", "ok"] : ["passed over", "warn"]) : firsts.has(i) ? ["asked first", "ok"] : ["backup", undefined]);
    const jw = Math.max(16, ...chosen.map((k, i) => width(jobOf(k, i)[0]) + 2));
    out.push(...flow([S(`     ${pad("JOB", jw)}${pad("MODEL", 20)}${pad("CLI", 14)}${pad("SCORE", 8)}PRICE IN / OUT`, "dim")], w, 5));
    chosen.forEach((k, i) => {
      const [j, st] = jobOf(k, i), f = cliWide(k) ? { score: null, priceIn: null, priceOut: null } : facts(M, k);
      // a CLI-wide entry is drawn whole in the CLI cell, and names every model of it
      out.push(...flow(mark(i, [S(`  ${pad(String(i + 1), 3)}`), S(pad(j, jw), st), cliWide(k) ? S(pad(nameAt(i), 20), "dim") : V(pad(nameAt(i), 20)), V(pad(cliWide(k) ? k : splitKey(k)[0], 14)),
        ...(cliWide(k) ? [] : [S(pad(score(f.score), 8)), S(price(f.priceIn, f.priceOut))])]), w, 2));
    });
    if (!chosen.length) out.push([S(`  nothing is written here yet`, "dim")]);
    if (id !== "judge") out.push(...flow(mark(chosen.length, [S(`  ${pad(String(chosen.length + 1), 3)}${pad("backup", jw)}+ add a model`, "dim")]), w, 2));
    out.push(blank);
    const result: OneLine[] = [];
    if (id === "judge") {
      // the judge as the one screen names it: who judges, and the independent judge for a task its vendor wrote
      const { judges, when } = judgesOf(M), jn = namesOf(M, judges);
      if (!judges.length) result.push([S("Nobody can judge a task: no model answers as the judge.")]);
      else if (judges.length === 1) result.push([V(jn[0]), S(" judges every task.")]);
      else {
        judges.forEach((k, i) => result.push([V(jn[i]), S(` judges a task${when(k)}.`)]));
        result.push([S("A task is never judged by the vendor that wrote it: the independent judge takes it.")]);
      }
    } else if (id === "review") {
      const rs = M.sample().reviewers.map((x) => x.key), rn = namesOf(M, rs);
      result.push(!writers.length ? [S("Nobody reviews yet: no model writes the tasks.")] : rs.length ? [...rn.flatMap((n, i) => [...(i ? [S(" + ")] : []), V(n)]), S(" review the tasks; each task goes to one of another vendor than its writer.")]
        : [S("Nobody can review a task: no model of another vendor answers.")]);
    } else {
      // the backup as the run ranks it: the next model of the pool an entry names, a CLI-wide one included
      const others = M.pools.consult.filter((c) => preferIndex(c, chosen) < chosen.length && channelKey(c) !== M.consult
        && !disallowedBy(observedSeat(M.health, c.adapter, c.model), M.cfg.routing, "consult")).sort((a, b) => preferIndex(a, chosen) - preferIndex(b, chosen)).map(channelKey);
      if (!M.consult) result.push([S("Nobody can consult: no model on this line answers.")]);
      else {
        result.push([V(M.name(M.consult)), S(" is asked first.")]);
        result.push(others.length ? [S("If it stops working, "), V(M.name(others[0])), S(" is asked.")] : [S("There is no backup: if it stops, nobody can consult.")]);
      }
    }
    out.push(...said("RESULT", result));
  }
  const held = holderIn(parsedLayers(M.inputs))(path);
  out.push(...flow(held === "user"
    ? [S(pad("  APPLIES TO", 14), "head"), S(`every project with no ${label} of its own; `, "dim"), V(inp.project, "dim"), S(" has none", "dim")]
    : [S(pad("  APPLIES TO", 14), "head"), S("this project only", "dim")], w, 14), blank);
  const footer: OneLine[] = inp.note ? flow([S("  "), S(inp.note, "accent")], w, 2) : [];
  footer.push(...flow([S(id === "mode" ? "↑↓ move · Enter choose · Esc back" : id === "judge" ? "↑↓ move · Enter pick the model · Esc back"
    : "↑↓ move · Enter pick the model for a row · [ ] move the row · x remove · Esc back", "dim")], w, 0));
  return { body: out, footer };
}

/**
 * The models a rule keeps out now: each model the config knows that this entry of this list matches, read from every
 * exclusion of the model, not the first one a role records (another rule may keep it out as well; row 500). A worker
 * reads every list, the workers' lists included.
 */
export const keptBy = (M: FleetModel, rule: string, list: string): string[] =>
  // every model the config or the probe knows, matched by the identity the probe observed, as the run matches it (D-2187 add.413)
  modelColumns(M, "kept", []).flatMap((c) => c.rows).filter((r) => exclusionCollector(observedSeat(M.health, r.cli, r.model), M.cfg.routing, "worker")
    .some((e) => e.by === "deny" && e.entry === rule && e.configPath === list)).map((r) => r.key);

/** A KEPT OUT rule opened (row 500; K2, K3): the rule, its reason, its reach, the models it keeps out now; x removes it, the only way the screen does. */
export function keptView(inp: { M: FleetModel; rule: KeptRule; note?: string; more?: boolean }, w = 100): { body: OneLine[]; footer: OneLine[] } {
  const { M, rule } = inp, keeps = keptBy(M, rule.rule, rule.list), names = namesOf(M, keeps);
  const row = (head: string, segs: OneLine) => flow([S(pad(`  ${head}`, 14), "head"), ...segs], w, 14);
  // a reason of any length is wrapped, never cut: the view scrolls (row 500)
  const reason = row("REASON", rule.reason !== null ? [V(rule.reason)] : [S(rule.says ?? "no reason is written above it", "dim")]);
  return {
    body: [
      ...flow([S("KEPT OUT  ", "head"), V(rule.rule, "head")], w, 0), [S(" ")], ...reason,
      ...row("LIST", [V(rule.list), S(rule.workersOnly ? " · workers only: kept from all work; it may still judge, review and consult" : " · kept from everything", "dim")]),
      ...row("KEEPS OUT", keeps.length ? names.flatMap((n, i) => [...(i ? [S(", ")] : []), V(n)]) : [S("no model now", "dim")]),
      [S(" ")],
    ],
    // the removal stays in view at the foot; a body longer than its room scrolls with ↑↓ and PgUp PgDn (row 500)
    footer: [...(inp.note ? flow([S("  "), S(inp.note, "accent")], w, 2) : []),
      ...flow([S(inp.more ? "x remove this rule · ↑↓ PgUp PgDn more · Esc back" : "x remove this rule · Esc back", "dim")], w, 0)],
  };
}
