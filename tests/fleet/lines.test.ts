// The fleet's model of a line (queue rows 499, 501, 502; D-2187 add.363): the contract's section 4 cells.
import { describe, expect, test } from "vitest";
import type { ModelFacts } from "../../src/adapters/types.js";
import { costNotes, keptOut, lineOf, shareWords } from "../../src/fleet/lines.js";
import { cleanHealth } from "../../src/fleet/load.js";
import { buildFleetModel, type FleetInputs } from "../../src/fleet/model.js";
import { health, source } from "./world.js";

const F = "claude-code:claude-fable-5-2", O = "claude-code:claude-opus-5-5", A = "codex:gpt-6-astra", S = "codex:gpt-6.1-sol";
const TERRA = "codex:gpt-5.6-terra";
const EXTRA = { "claude-code": ["claude-fable-5-2", "claude-opus-5-5"], codex: ["gpt-6.1-sol"] };
const TIERS = "tiers:\n  claude-code:\n    models:\n      claude-fable-5-2: frontier\n      claude-opus-5-5: frontier\n  codex:\n    models:\n      gpt-6.1-sol: frontier\n";
const BASE: Record<string, Partial<ModelFacts>> = { [F]: { score: 64.6 }, [O]: { score: 59.1 }, [A]: { score: 56.9, priceIn: 10, priceOut: 50 }, [S]: { score: 54.6, priceIn: 2, priceOut: 10 } };
const split = (key: string): [string, string] => [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];

function model(opts: { channels?: string[]; mode?: string; facts?: Record<string, Partial<ModelFacts>>; more?: string; rawFacts?: Record<string, unknown>; failing?: Record<string, string> } = {}) {
  const h = health([], EXTRA);
  for (const [key, f] of Object.entries(opts.facts ?? BASE)) {
    const [a, m] = split(key);
    h[a] = { ...h[a], modelFacts: { ...h[a].modelFacts, [m]: { as: m, ...f } } };
  }
  for (const [key, reason] of Object.entries(opts.failing ?? {})) {
    const [a, m] = split(key);
    h[a] = { ...h[a], modelAuth: { ...h[a].modelAuth, [m]: { authed: false, reason, probedAt: "2026-11-10T00:00:00Z" } } };
  }
  const cleaned = opts.rawFacts ? cleanHealth(Object.fromEntries(Object.entries(h).map(([a, e]) => [a, { ...e, ...(opts.rawFacts![a] ? { modelFacts: opts.rawFacts![a] } : {}) }]))) : h;
  const userText = `${TIERS}${opts.more ?? ""}routing:\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: ${opts.mode ?? "complexity"}\n        channels: [${(opts.channels ?? [F, O, A, S]).join(", ")}]\n`;
  return buildFleetModel(source({ userText, health: cleaned }).inputs);
}
const line = (opts: Parameters<typeof model>[0] = {}) => lineOf(model(opts), "implement");

describe("the fleet's model of a line", () => {
  test("the base line by complexity: the strongest takes all of the very complex tasks; each of the other three takes about a third of the rest", () => {
    const l = line();
    expect(l.givenOut).toBe("complexity");
    expect(l.by).toBe("score");
    expect(l.groups!.map((g) => g.range)).toEqual([[8, 10], [1, 7]]);
    // counted over each group's OWN range of the routed sample (120 very complex, 280 the rest), never over all 400
    expect(l.groups!.map((g) => g.models.map((m) => [m.key, m.share.n, m.share.of, m.shareWords]))).toEqual([
      [[F, 120, 120, "all of them"]],
      [[O, 94, 280, "about a third"], [A, 93, 280, "about a third"], [S, 93, 280, "about a third"]],
    ]);
    expect(l.why).toEqual([
      "Scores within 5 points count as similar, and similar models share the same tasks.",
      "claude-fable-5-2 scores 5.5 above the next model, so it is kept for the hardest tasks.",
    ]);
    expect(l.note).toEqual(["gpt-6-astra costs 5 times gpt-6.1-sol for a similar score."]);
    expect(l.groups![1].models[1]).toMatchObject({ cli: "codex", model: "gpt-6-astra", score: 56.9, priceIn: 10, priceOut: 50, standIns: [] });
    // the sample is the graph: a shape with no pool keeps its counts, an any line its base counts
    const any = line({ mode: "any" });
    expect(any.order!.gets).toEqual([{ key: F, n: 198 }, { key: A, n: 202 }]);
  });

  test("share words follow the contract's closed share table at each row's value; just outside each row the words change", () => {
    expect(shareWords(600, 600)).toBe("all of them");
    expect(shareWords(599, 600)).toBe("about 9 in 10");
    expect(shareWords(0, 600)).toBe("none");
    expect(shareWords(1, 600)).toBe("about 1 in 10");
    const rows: Array<[number, string, string, string]> = [
      // n of 600 at the row's value, its words, then the words at 36 more and 36 fewer (0.06 outside)
      [300, "about half", "about 6 in 10", "about 4 in 10"],
      [200, "about a third", "about 4 in 10", "about a quarter"],
      [400, "about two thirds", "about three quarters", "about 6 in 10"],
      [150, "about a quarter", "about a third", "about a fifth"],
      [450, "about three quarters", "about 8 in 10", "about two thirds"],
      [120, "about a fifth", "about a quarter", "about 1 in 10"],
    ];
    for (const [n, at, above, below] of rows) {
      expect(shareWords(n, 600), `${n}`).toBe(at);
      expect(shareWords(n + 36, 600), `${n}+`).toBe(above);
      expect(shareWords(n - 36, 600), `${n}-`).toBe(below);
    }
    // within 0.05 is inside the row; 0.051 is outside
    expect(shareWords(550, 1000)).toBe("about half");
    expect(shareWords(551, 1000)).toBe("about 6 in 10");
    expect(shareWords(450, 1000)).toBe("about half");
    expect(shareWords(449, 1000)).toBe("about 4 in 10");
    // a tie between a third and a quarter reads a third
    expect(shareWords(7, 24)).toBe("about a third");
  });

  test("the cost note names a model at 3 times its group's lowest list price above zero; not at 2.9 times; not for a missing or zero price", () => {
    const withA = (f: Partial<ModelFacts>, s: Partial<ModelFacts> = { score: 54.6, priceOut: 10 }) => line({ facts: { ...BASE, [A]: { score: 56.9, ...f }, [S]: s } }).note;
    expect(withA({ priceOut: 30 })).toEqual(["gpt-6-astra costs 3 times gpt-6.1-sol for a similar score."]);
    expect(withA({ priceOut: 29 })).toEqual([]);
    // D-2187 add.379: decimal list prices compare at exactly three times, without binary rounding.
    for (const [low, high, noted] of [
      [0.1, 0.3, true], [0.05, 0.15, true], [0.2, 0.6, true], [0.1, 0.29, false],
      [0.1, 0.29999999999999993, false], [1e-7, 3e-7, true], [1e21, 3e21, true],
    ] as const) {
      expect(withA({ priceOut: high }, { score: 54.6, priceOut: low }), `${high} / ${low}`)
        .toEqual(noted ? ["gpt-6-astra costs 3 times gpt-6.1-sol for a similar score."] : []);
    }
    expect(withA({})).toEqual([]); // a missing price is neither named nor compared
    expect(withA({ priceOut: 50 }, { score: 54.6, priceOut: 0 })).toEqual([]); // zero takes part in no multiple
    expect(line({ facts: { ...BASE, [A]: { score: 56.9, priceIn: 0, priceOut: 0 } } }).groups![1].models[1]).toMatchObject({ priceIn: 0, priceOut: 0 });
    expect(costNotes([{ name: "z", priceOut: 0 }, { name: "a", priceOut: 10 }, { name: "b", priceOut: 30 }])).toEqual(["b costs 3 times a for a similar score."]);
    expect(costNotes([{ name: "z", priceOut: 0 }, { name: "a", priceOut: 10 }]).join()).not.toMatch(/Infinity|NaN/);
  });

  test("on the five fixtures a line saved as any names who gets its tasks; each model that gets none carries its one reason", () => {
    const base = line({ mode: "any" });
    expect(base.givenOut).toBe("any");
    expect(base.order).toEqual({ gets: [{ key: F, n: 198 }, { key: A, n: 202 }], none: [
      { key: O, reason: "claude-fable-5-2, of the same vendor, is written before it" },
      { key: S, reason: "gpt-6-astra, of the same vendor, is written before it" },
    ] });
    expect(line({ mode: "any", channels: [A, TERRA] }).order).toEqual({ gets: [{ key: TERRA, n: 400 }],
      none: [{ key: A, reason: "gpt-5.6-terra, a lighter model of the same vendor, comes first" }] });
    // (the API route: gpt-6-astra billed per use, written into the codex tiers block)
    const metered = lineOf(buildFleetModel(source({ userText: `${TIERS}    modelOverrides:\n      gpt-6-astra:\n        channel: api\nrouting:\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: any\n        channels: [${F}, ${A}]\n`, health: model().health }).inputs), "implement");
    expect(metered.order).toEqual({ gets: [{ key: F, n: 400 }], none: [{ key: A, reason: "it costs more than claude-fable-5-2" }] });
    expect(line({ mode: "any", channels: [F, A], failing: { [A]: "token expired" } }).order).toEqual({ gets: [{ key: F, n: 400 }], none: [{ key: A, reason: "does not answer: sign-in expired" }] });
    const kept = lineOf(buildFleetModel(source({ userText: `${TIERS}routing:\n  deny:\n    models: [${A}]\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: any\n        channels: [${F}, ${A}]\n`, health: model().health }).inputs), "implement");
    expect(kept.order).toEqual({ gets: [{ key: F, n: 400 }], none: [{ key: A, reason: `kept out by ${A}` }] });
  });

  test("a line holding a model that has no score is grouped by level and names it, never by a guessed score", () => {
    const l = line({ channels: [F, O, A, TERRA], facts: { [F]: { score: 64.6 }, [A]: { score: 56.9 }, [TERRA]: { score: 41 } } });
    expect(l.by).toBe("level");
    expect(l.noScore).toEqual([O]);
    expect(l.groups!.map((g) => g.models.map((m) => m.key))).toEqual([[F, O, A], [TERRA]]);
    expect(l.groups![0].models[1].score).toBeNull();
    expect(l.why).toEqual(["claude-opus-5-5 has no score, so the models are grouped by level: frontier, then mid, then cheap."]);
  });

  test("a malformed modelFacts is dropped by the fleet's cleanHealth and is never read as a score", () => {
    const raw = { "claude-code": { "claude-fable-5-2": { as: "claude-fable-5-2", score: 64.6, name: "Claude Fable 5.2" }, "claude-opus-5-5": { as: "claude-opus-5-5", score: "59.1" } },
      codex: { "gpt-6-astra": { score: 56.9 }, "gpt-6.1-sol": { as: "gpt-6.1-sol", score: 54.6, priceOut: Number.NaN } } };
    const h = cleanHealth({ codex: { installed: true, authed: true, models: [], modelFacts: raw.codex }, "claude-code": { installed: true, authed: true, models: [], modelFacts: raw["claude-code"] } })!;
    expect(h["claude-code"].modelFacts).toEqual({ "claude-fable-5-2": { as: "claude-fable-5-2", score: 64.6, name: "Claude Fable 5.2" } });
    expect(h.codex.modelFacts).toBeUndefined();
    expect(cleanHealth({ codex: { installed: true, authed: true, models: [], modelFacts: [1, 2] } })!.codex.modelFacts).toBeUndefined();
    const l = line({ facts: {}, rawFacts: raw });
    expect(l.by).toBe("level");
    expect(l.noScore).toEqual([O, A, S]);
  });

  test("a model that gets none is kept out by the identity its probe recorded, denied or failed alike", () => {
    const FA = "claude-code:fable";
    const of = (routing: string, auth: Record<string, unknown>) => {
      const h = health([]);
      h["claude-code"] = { ...h["claude-code"], modelAuth: { ...h["claude-code"].modelAuth, fable: { probedAt: "2026-11-10T00:00:00Z", ...auth } } };
      const userText = `routing:\n${routing}  map:\n    implement:\n      prefer: null\n      pool:\n        mode: any\n        channels: [${TERRA}, ${FA}]\n`;
      return lineOf(buildFleetModel(source({ userText, health: h }).inputs), "implement").order!.none;
    };
    const astra = { authed: true, identity: "gpt-6-astra" }, failed = { authed: false, reason: "token expired", identity: "claude-fable-5-2" };
    expect(of("  deny:\n    models: [gpt-6-astra]\n", astra)).toEqual([{ key: FA, reason: "kept out by gpt-6-astra" }]);
    expect(of("  deny:\n    models: [claude-code:gpt-6-astra]\n", astra)).toEqual([{ key: FA, reason: "kept out by claude-code:gpt-6-astra" }]);
    expect(of("  deny:\n    workers:\n      models: [gpt-6-astra]\n", astra)).toEqual([{ key: FA, reason: "kept out by gpt-6-astra" }]);
    expect(of(`  allow:\n    models: [${TERRA}, claude-code:claude-fable-5-2]\n`, failed)).toEqual([{ key: FA, reason: "does not answer: sign-in expired" }]);
    expect(of("  deny:\n    models: [claude-fable-5-1]\n", failed)).toEqual([{ key: FA, reason: "does not answer: sign-in expired" }]);
  });

  // Closed inventory of every pre-ranking drop in discoverChannels() and route()'s pool branch
  // (rows 499, 501, 502; D-2187 add.363, add.379). Each row is one place, with its one reason.
  // A passing probe must never read "does not answer". route()'s missing offered entry is explained
  // by these same drops; its task-floor and in-run-exclusion filters cannot fire here: the sample
  // carries neither. Its task i has complexity (i mod 10) + 1 (src/fleet/model.ts); the unchanged
  // base cell above protects shares counted over each group's OWN range: 120/120 and 94,93,93/280.
  const beforeRanking: Array<{ place: string; reason: string; edit: (inputs: FleetInputs) => void }> = [
    // Replay the reviewer's three discovery reproducers first.
    { place: "discoverChannels: servable excludes a passing model", reason: "not in codex's served model list",
      edit: (i) => { i.health!.codex.servable = ["gpt-5.6-terra"]; } },
    { place: "invalidConfiguredModels: modelsHidden excludes an absent passing model", reason: "hidden from codex's model list",
      edit: (i) => { i.health!.codex.models = i.health!.codex.models.filter((m) => m !== "gpt-6-astra"); i.health!.codex.modelsHidden = ["gpt-6-astra"]; } },
    { place: "invalidConfiguredModels: a validated overlapping list excludes a passing model", reason: "not in codex's validated model list",
      edit: (i) => { i.health!.codex.models = ["gpt-5.6-terra"]; i.health!.codex.modelsDetectedAt = "2026-11-10T00:00:00Z"; } },
    { place: "adapter channels: no configured level", reason: "no CLI in your settings lists it",
      edit: (i) => { i.userText = i.userText.replace("      gpt-6.1-sol: frontier\n", "      gpt-6.1-sol: frontier\n      gpt-6-astra: null\n"); } },
    { place: "discoverChannels: no probe record", reason: "does not answer: not checked yet",
      edit: (i) => { delete i.health!.codex; } },
    { place: "discoverChannels: CLI not installed", reason: "does not answer: CLI not installed",
      edit: (i) => { i.health!.codex.installed = false; } },
    { place: "discoverChannels: CLI signed out", reason: "does not answer: CLI signed out",
      edit: (i) => { i.health!.codex.authed = false; } },
    { place: "discoverChannels: failed model auth", reason: "does not answer: sign-in expired",
      edit: (i) => { i.health!.codex.modelAuth!["gpt-6-astra"] = { authed: false, reason: "token expired", probedAt: "2026-11-10T00:00:00Z" }; } },
    { place: "discoverChannels: unverified model auth", reason: "does not answer: not checked yet",
      edit: (i) => { delete i.health!.codex.modelAuth!["gpt-6-astra"]; } },
    { place: "discoverChannels and route admission: deny", reason: `kept out by ${A}`,
      edit: (i) => { i.userText = i.userText.replace("routing:\n", `routing:\n  deny:\n    workers:\n      models: [${A}]\n`); } },
    { place: "discoverChannels and route admission: allow", reason: "not allowed yet",
      edit: (i) => { i.userText = i.userText.replace("routing:\n", "routing:\n  allow:\n    adapters: [claude-code]\n"); } },
    { place: "discoverChannels: no loaded adapter", reason: "no codex adapter is loaded",
      edit: (i) => { i.adapters = i.adapters.filter((a) => a.id !== "codex"); } },
    { place: "adapter channels: a configured model is not offered", reason: "codex does not offer this model for worker tasks",
      edit: (i) => { i.adapters = i.adapters.map((a) => a.id !== "codex" ? a : { ...a, channels: (cfg) => a.channels(cfg).filter((c) => c.model !== "gpt-6-astra") }); } },
  ];
  test.each(beforeRanking)("an any line explains the actual pre-ranking cause: $place", ({ reason, edit }) => {
    const inputs = source({ userText: `${TIERS}routing:\n  map:\n    implement:\n      prefer: null\n      pool:\n        mode: any\n        channels: [${F}, ${A}]\n`, health: health([], EXTRA) }).inputs;
    edit(inputs);
    const M = buildFleetModel(inputs);
    const order = lineOf(M, "implement").order!;
    expect(order).toEqual({ gets: [{ key: F, n: 400 }], none: [{ key: A, reason }] });
    if (M.seat(A)?.verdict.state === "pass") expect(order.none![0].reason).not.toContain("does not answer");
  });

  test("an unrecognised missing worker offer names the cause without inventing a failed probe", () => {
    const M = model({ mode: "any", channels: [F, A] });
    expect(M.seat(A)!.verdict.state).toBe("pass");
    // Simulate an additional pool filter, beyond the closed discovery inventory above.
    M.pools.worker = M.pools.worker.filter((c) => `${c.adapter}:${c.model}` !== A);
    expect(lineOf(M, "implement").order).toEqual({ gets: [{ key: F, n: 400 }],
      none: [{ key: A, reason: "codex does not offer this model for worker tasks" }] });
  });

  test("keptOut carries each rule's recorded reason through YAML aliases: a list, an entry and a map", () => {
    const reasons = (userText: string) => keptOut(buildFleetModel(source({ userText }).inputs)).map((r) => [r.rule, r.reason]);
    // an aliased list: the comment above the key where it is defined
    expect(reasons("lists:\n  # list reason\n  models: &blocked\n    - grok:grok-4.5\nrouting:\n  deny:\n    models: *blocked\n")).toEqual([["grok:grok-4.5", "# list reason"]]);
    // an aliased list whose entry carries its own comment
    expect(reasons("lists:\n  models: &blocked\n    - kimi:kimi-code/k3\n    # entry reason\n    - grok:grok-4.5\nrouting:\n  deny:\n    models: *blocked\n"))
      .toEqual([["kimi:kimi-code/k3", null], ["grok:grok-4.5", "# entry reason"]]);
    // an entry written as an alias, its comment immediately above it
    expect(reasons("seat: &seat grok:grok-4.5\nrouting:\n  deny:\n    models:\n      - kimi:kimi-code/k3\n      # entry reason\n      - *seat\n"))
      .toEqual([["kimi:kimi-code/k3", null], ["grok:grok-4.5", "# entry reason"]]);
    // an aliased map: the comment above its list
    expect(reasons("rules: &rules\n  adapters: [cursor-agent]\n  # list reason\n  models: [grok:grok-4.5]\nrouting:\n  deny: *rules\n")).toContainEqual(["grok:grok-4.5", "# list reason"]);
    // a comment above routing is not every entry's reason
    expect(reasons("# the routing block\nrouting:\n  deny:\n    models: [grok:grok-4.5]\n")).toEqual([["grok:grok-4.5", null]]);
  });

  test.each([
    "key: &key models\nrouting:\n  deny:\n    # key reason\n    ? *key\n    : [grok:grok-4.5]\n",
    "key: &key routing\n? *key\n: deny:\n    models:\n      # entry reason\n      - grok:grok-4.5\n",
  ])("an aliased YAML key keeps the rule listed with no reason: %s", (userText) => {
    // D-2187 add.379 / K3: alias KEYS are outside the supported block forms; no comment means no reason.
    expect(keptOut(buildFleetModel(source({ userText }).inputs)))
      .toEqual([{ rule: "grok:grok-4.5", list: "routing.deny.models", reason: null }]);
  });

  // D-2187 add.382: the closed table of forms. Each row is a reviewer's reproducer with the value it names;
  // in every row the rule itself is still listed.
  const STALE = "routing:\n  deny:\n    # stale user reason\n    models: [grok:grok-4.5]\n";
  const deny = (body: string) => `routing:\n  deny:\n${body}`;
  const forms: Array<{ form: string; userText?: string; repoText?: string; want: Array<[string, string | null]> }> = [
    { form: "an aliased list: a later entry does not read the first entry's comment",
      userText: "lists:\n  models: &blocked\n    # kimi only\n    - kimi:kimi-code/k3\n    - grok:grok-4.5\nrouting:\n  deny:\n    models: *blocked\n",
      want: [["kimi:kimi-code/k3", "# kimi only"], ["grok:grok-4.5", null]] },
    { form: "an aliased list: a later entry reads the list's key comment, not the first entry's",
      userText: "lists:\n  # list reason\n  models: &blocked\n    # kimi only\n    - kimi:kimi-code/k3\n    - grok:grok-4.5\nrouting:\n  deny:\n    models: *blocked\n",
      want: [["kimi:kimi-code/k3", "# kimi only"], ["grok:grok-4.5", "# list reason"]] },
    { form: "a repository list under an aliased key: no reason, never the user layer's",
      userText: STALE, repoText: "key: &k models\nrouting:\n  deny:\n    ? *k\n    : [grok:grok-4.5]\n", want: [["grok:grok-4.5", null]] },
    { form: "a repository list through a merge key: no reason, never the user layer's",
      userText: STALE, repoText: "%YAML 1.1\n---\nbase: &b\n  models:\n    - grok:grok-4.5\nrouting:\n  deny:\n    <<: *b\n", want: [["grok:grok-4.5", null]] },
    { form: "a comment separated from an entry by a blank line",
      userText: deny("    models:\n      - kimi:kimi-code/k3\n      # stray above blank line\n\n      - grok:grok-4.5\n"), want: [["kimi:kimi-code/k3", null], ["grok:grok-4.5", null]] },
    { form: "a comment separated from the list's key by a blank line",
      userText: deny("    # stray above blank line\n\n    models:\n      - grok:grok-4.5\n"), want: [["grok:grok-4.5", null]] },
    { form: "a header, a blank line, then the entry's own comment",
      userText: deny("    models:\n      # section header\n\n      # entry reason\n      - kimi:kimi-code/k3\n"), want: [["kimi:kimi-code/k3", "# entry reason"]] },
    { form: "a comment on the key's own line",
      userText: deny("    models: # inline key note\n      - grok:grok-4.5\n      - codex:gpt-6-astra\n"), want: [["grok:grok-4.5", null], ["codex:gpt-6-astra", null]] },
    { form: "a comment inside a flow map",
      userText: "routing:\n  deny: {\n    # flow map note\n    models: [grok:grok-4.5]\n  }\n", want: [["grok:grok-4.5", null]] },
    { form: "a comment inside a flow sequence",
      userText: deny("    models: [\n      # flow seq note\n      codex:gpt-6-astra\n    ]\n"), want: [["codex:gpt-6-astra", null]] },
    { form: "duplicate entries each read their own comment",
      userText: deny("    models:\n      # first\n      - grok:grok-4.5\n      # second\n      - grok:grok-4.5\n"), want: [["grok:grok-4.5", "# first"], ["grok:grok-4.5", "# second"]] },
  ];
  test.each(forms)("keptOut reads a reason only by the closed table of forms: $form", ({ userText, repoText, want }) => {
    const rows = keptOut(buildFleetModel(source({ userText: userText ?? "", repoText: repoText ?? "" }).inputs)).filter((r) => r.list === "routing.deny.models");
    expect(rows.map((r) => [r.rule, r.reason])).toEqual(want);
  });
});
