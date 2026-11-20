// Config edits: a list or a map changed in the YAML text of its layer the way a careful hand
// would, so comments, order and every untouched byte survive.
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { loadConfigWithMode } from "../../src/config/config.js";
import { applyEdits, applyLayer, combineEdits, type Edit, EditRefused } from "../../src/fleet/edits.js";
import { handEdits, recordedVendor } from "../../src/fleet/hand.js";
import { buildFleetModel } from "../../src/fleet/model.js";

describe("answers and the one write path", () => {
  test("several yes answers that touch the same list are combined: one never undoes another", () => {
    const cfg = { routing: { deny: { models: ["a", "b", "c"] } } };
    const path = ["routing", "deny", "models"];
    const edits: Edit[] = [{ layer: "repo", path, value: ["b", "c"], label: "drop a" }, { layer: "repo", path, value: ["a", "b", "d"], label: "drop c, add d" }];
    expect(combineEdits(cfg, edits)[0].value).toEqual(["b", "d"]);
  });
  test("a list keeps its order and comments; a map keeps the keys the edit does not name; pin, pool and prefer are one slot", () => {
    const before = "routing:\n  map:\n    plan:\n      escalate: false\n      pin: { via: claude-code, model: fable }\n  deny:\n    models:\n      # keep\n      - a\n      - b\n";
    const after = applyLayer(before, [
      { layer: "repo", path: ["routing", "deny", "models"], value: ["a", "c"], label: "" },
      { layer: "repo", path: ["routing", "map", "plan"], value: { pool: { mode: "any", channels: ["codex:gpt-6-astra"] } }, label: "" },
    ]);
    expect(after).toContain("# keep\n      - a\n      - c");
    expect(after).toContain("escalate: false");
    expect(after).not.toContain("pin:");
  });
  test("an edit never reaches another shape through a YAML alias, and one that changes nothing leaves aliases alone", () => {
    const before = [
      "routing:", "  map:", "    plan: &team", "      pool:", "        mode: any", "        channels: &frontier", "          - codex:gpt-6-astra   # the lead", "          - claude-code:opus",
      "    spec: *team", "    docs:", "      pool:", "        mode: any", "        channels: *frontier", "",
    ].join("\n");
    const pool = (channels: string[]) => ({ pool: { mode: "any", channels } });
    const wider = ["codex:gpt-6-astra", "claude-code:opus", "codex:gpt-6-sol"];
    const channels = (text: string, shape: string) => (parse(text) as { routing: { map: Record<string, { pool: { channels: string[] } }> } }).routing.map[shape].pool.channels;
    for (const shape of ["plan", "spec", "docs"]) {
      const after = applyLayer(before, [{ layer: "repo", path: ["routing", "map", shape], value: pool(wider), label: "" }]);
      for (const other of ["plan", "spec", "docs"]) expect(channels(after, other), `edit ${shape}, read ${other}`).toEqual(other === shape ? wider : wider.slice(0, 2));
      expect(after, shape).toContain("- codex:gpt-6-astra   # the lead");
    }
    // nothing to change: not a byte moves, and every alias is still an alias
    expect(applyLayer(before, [{ layer: "repo", path: ["routing", "map", "plan"], value: pool(wider.slice(0, 2)), label: "" }])).toBe(before);
    expect(applyLayer(before, [{ layer: "repo", path: ["routing", "map", "spec"], value: pool(wider.slice(0, 2)), label: "" }])).toBe(before);
  });
});

describe("edits through aliases and tombstones (review repair)", () => {
  const team = [
    "routing:", "  map:", "    plan: &team", "      escalate: false", "      pool:", "        mode: any", "        channels: &frontier",
    "          # the lead", "          - codex:gpt-6-astra", "          - claude-code:opus", "    spec: *team", "    docs:", "      pool:", "        mode: any", "        channels: *frontier", "",
  ].join("\n");
  const pool = (channels: string[]) => ({ pool: { mode: "any", channels } });
  const wider = ["codex:gpt-6-astra", "claude-code:opus", "codex:gpt-6-sol"];
  const map = (text: string) => (parse(text) as { routing: { map: Record<string, { escalate?: boolean; pool: { channels: string[] } }> } }).routing.map;

  test("an edit under an alias keeps the keys and the comments the alias resolved to", () => {
    const spec = applyLayer(team, [{ layer: "repo", path: ["routing", "map", "spec"], value: pool(wider), label: "" }]);
    expect(map(spec).spec).toEqual({ escalate: false, ...pool(wider) });
    expect(map(spec).plan).toEqual({ escalate: false, ...pool(wider.slice(0, 2)) });
    const docs = applyLayer(team, [{ layer: "repo", path: ["routing", "map", "docs"], value: pool(wider), label: "" }]);
    expect(map(docs).docs.pool.channels).toEqual(wider);
    expect(docs.match(/# the lead/g)).toHaveLength(2);
  });

  test("an edit that changes nothing returns the file byte for byte, aliases and flow lists included", () => {
    expect(applyLayer(team, [{ layer: "repo", path: ["routing", "floors", "spec"], value: undefined, label: "" }])).toBe(team);
    const flow = "routing:\n  map:\n    plan: &team\n      pool:\n        mode: any\n        channels: &one [ codex:gpt-6-astra ]\n    spec: *team\n";
    expect(applyLayer(flow, [{ layer: "repo", path: ["routing", "map", "plan"], value: pool(["codex:gpt-6-astra"]), label: "" }])).toBe(flow);
    expect(applyLayer(flow, [{ layer: "repo", path: ["routing", "map", "spec"], value: pool(["codex:gpt-6-astra"]), label: "" }])).toBe(flow);
  });

  test("an edit beneath a null tombstone lifts it and keeps masking what the tombstone masked", () => {
    const load = (userText: string, repoText: string) => loadConfigWithMode("/", { userOverlayText: userText, repoOverlayText: repoText }).cfg;
    const user = "routing:\n  deny:\n    models: [claude-code:opus]\n  allow:\n    adapters: [codex]\n";
    const cases: Array<[string, string[], unknown, (c: ReturnType<typeof load>) => void]> = [
      ["routing:\n  deny: null\n", ["routing", "deny", "workers", "models"], ["codex:gpt-6-astra"], (c) => {
        expect(c.routing.deny?.workers?.models).toEqual(["codex:gpt-6-astra"]);
        expect(c.routing.deny?.models ?? []).toEqual([]);
      }],
      ["routing:\n  allow: null\n", ["routing", "allow", "models"], ["codex:gpt-6-astra"], (c) => {
        expect(c.routing.allow?.models).toEqual(["codex:gpt-6-astra"]);
        expect(c.routing.allow?.adapters ?? []).toEqual([]);
      }],
      ["tiers:\n  omp:\n    modelOverrides: null\n", ["tiers", "omp", "modelOverrides", "zai/glm-5.3", "vendor"], "zai", (c) => {
        expect(c.tiers.omp.modelOverrides).toEqual({ "zai/glm-5.3": { vendor: "zai" } });
      }],
    ];
    for (const [repoText, path, value, check] of cases) {
      load(user, repoText);
      const out = applyEdits({ userText: user, repoText }, [{ layer: "repo", path, value, label: "" }]);
      check(load(out.userText, out.repoText));
    }
  });
});

describe("the write path proves its result or refuses (RULING-T5)", () => {
  const load = (userText: string, repoText: string) => loadConfigWithMode("/", { userOverlayText: userText, repoOverlayText: repoText }).cfg;
  const pool = (channels: string[]) => ({ pool: { mode: "any", channels } });
  const edit = (path: string[], value: unknown): Edit => ({ layer: "repo", path, value, label: "" });
  const refusal = (repoText: string, e: Edit, userText = "") => {
    try { applyEdits({ userText, repoText }, [e]); } catch (err) { return err as EditRefused; }
    throw new Error("not refused");
  };
  /** Lands, and the loaded config differs from before only where `at` says. */
  const lands = (repoText: string, e: Edit, at: (c: ReturnType<typeof load>) => unknown, userText = "") => {
    const out = applyEdits({ userText, repoText }, [e]);
    const before = load(userText, repoText), after = load(out.userText, out.repoText);
    expect(at(after)).not.toEqual(at(before));
    const strip = (c: ReturnType<typeof load>) => { const x = structuredClone(c) as unknown as Record<string, unknown>; const p = e.path; let o = x; for (const s of p.slice(0, -1)) o = (o[s] ??= {}) as Record<string, unknown>; delete o[p[p.length - 1]]; return x; };
    expect(strip(after)).toEqual(strip(before));
    expect(out.touched).toEqual(["repo"]);
    return out;
  };

  test("rule 1: plain map and list edits, a mode edit and a lifted tombstone land and change only their path", () => {
    lands("routing:\n  map:\n    plan:\n      escalate: false\n", edit(["routing", "map", "plan"], pool(["codex:gpt-6-astra"])), (c) => c.routing.map.plan);
    lands("routing:\n  deny:\n    models: [codex:gpt-6-luna]\n", edit(["routing", "deny", "models"], ["codex:gpt-6-luna", "codex:gpt-6-sol"]), (c) => c.routing.deny?.models);
    // the floors the mode derives are not counted as changes
    applyEdits({ userText: "", repoText: "routing:\n  mode: partner-led\n" }, [edit(["routing", "mode"], "staff-led")]);
    // masks keep every other deny list absent in the MERGED data, and a map left empty is no change
    const user = "routing:\n  deny:\n    models: [claude-code:opus]\n";
    const out = lands("routing:\n  deny: null\n", edit(["routing", "deny", "workers", "models"], ["codex:gpt-6-astra"]), (c) => c.routing.deny?.workers?.models, user);
    expect(load(out.userText, out.repoText).routing.deny?.models ?? []).toEqual([]);
    lands("routing:\n  deny: null\n", edit(["routing", "deny", "models"], ["codex:gpt-6-astra"]), (c) => c.routing.deny?.models);
  });

  test("rule 1: a change that does not load is refused naming the layer and the path; a no-op returns the texts", () => {
    // bait: without the guard's load, this file would be saved and the loader would reject it
    const r = refusal("tiers:\n  codex: null\n", edit(["tiers", "codex", "models", "gpt-9"], "mid"));
    expect(r).toBeInstanceOf(EditRefused);
    expect(r.layer).toBe("repo");
    expect(r.path).toEqual(["tiers", "codex", "models", "gpt-9"]);
    expect(r.message).toMatch(/^the repository's config: /);
    // a duplicate key: the layer does not load, so nothing is offered and nothing is written
    expect(refusal("routing:\n  map:\n    spec: {escalate: false}\n    spec: {escalate: true}\n", edit(["routing", "map", "spec"], pool(["codex:gpt-6-astra"]))).message).toMatch(/unique/);
    const team = "routing:\n  map:\n    plan: &team\n      escalate: false\n    spec: *team\n";
    expect(applyEdits({ userText: "", repoText: team }, [edit(["routing", "floors", "spec"], undefined)])).toEqual({ userText: "", repoText: team, touched: [] });
    // a tag on the edited node lands with nothing else changed
    lands("routing:\n  map:\n    spec: !shape { escalate: false }\n", edit(["routing", "map", "spec"], pool(["codex:gpt-6-astra"])), (c) => c.routing.map.spec);
  });

  test("rule 2: an edit that takes keys through a YAML merge key is refused in the 2.24.0 writer's words; one elsewhere lands", () => {
    const merged = (spec: string) => `%YAML 1.1\n---\nteam: &team\n  ${spec}\nrouting:\n  map:\n    spec:\n      <<: *team\n`;
    for (const [repoText, e] of [
      [merged("pool: {mode: any, channels: [codex:gpt-6-astra]}"), edit(["routing", "map", "spec"], pool(["codex:gpt-6-sol"]))],
      [merged("pin: {via: claude-code, model: fable}"), edit(["routing", "map", "spec"], pool(["codex:gpt-6-astra"]))],
    ] as const) {
      const r = refusal(repoText, e);
      expect(r.message).toContain("takes keys through the YAML merge key `<<: *team`");
      expect(r.layer).toBe("repo");
    }
    lands("%YAML 1.1\n---\nteam: &team\n  x: 1\nother:\n  <<: *team\nrouting:\n  map:\n    spec:\n      escalate: false\n", edit(["routing", "map", "spec"], pool(["codex:gpt-6-astra"])), (c) => c.routing.map.spec);
  });

  test("rule 3: a list keeps each kept item's node; an alias item or two equal entries is refused naming the line; no private marker", () => {
    const plain = "routing:\n  deny:\n    models:\n      # one\n      - codex:gpt-6-astra\n      # two\n      - codex:gpt-6-sol\n      # three\n      - codex:gpt-6-luna\n";
    const out = applyEdits({ userText: "", repoText: plain }, [edit(["routing", "deny", "models"], ["codex:gpt-6-astra", "codex:gpt-6-luna", "claude-code:opus"])]).repoText;
    expect(out).toContain("# one\n      - codex:gpt-6-astra\n      # three\n      - codex:gpt-6-luna\n      - claude-code:opus");
    // the reviewer's reproducers: the scalar alias item, and equal entries whose comments the rebuild lost (and wrote U+E002)
    const alias = "x: &a codex:gpt-6-astra\nrouting:\n  map:\n    plan:\n      pool:\n        mode: any\n        channels:\n          - *a # aliased\n          - codex:gpt-6-sol # kept\n";
    const dup = "routing:\n  deny:\n    models:\n      - codex:gpt-6-astra # first\n      - codex:gpt-6-astra # second\n";
    for (const [text, e, line] of [
      [alias, edit(["routing", "map", "plan"], pool(["codex:gpt-6-astra", "codex:gpt-6-sol", "claude-code:opus"])), 8],
      [dup, edit(["routing", "deny", "models"], ["codex:gpt-6-astra", "codex:gpt-6-astra", "claude-code:opus"]), 4],
    ] as const) {
      expect(() => applyLayer(text, [e])).toThrow(`(line ${line})`);
      expect(refusal(text, e).layer).toBe("repo");
    }
    for (const text of [plain, out]) expect(text).not.toMatch(/[-]/);
  });
});

describe("the write path's input is closed: eight edit shapes (D-2187 add.229)", () => {
  const load = (userText: string, repoText: string) => loadConfigWithMode("/", { userOverlayText: userText, repoOverlayText: repoText }).cfg;
  const [a, b, c, d] = ["codex:gpt-6-astra", "codex:gpt-6-sol", "codex:gpt-6-luna", "claude-code:opus"];
  const pool = (channels: string[], mode = "any") => ({ pool: { mode, channels } });
  const refused = (texts: { userText: string; repoText: string }, answers: Edit[]) => {
    try { applyEdits(texts, answers); } catch (err) { if (err instanceof EditRefused) return err; throw err; }
    throw new Error("not refused");
  };

  test("each of the eight shapes lands, and the loaded config changes only where it says", () => {
    const repoText = `routing:\n  map:\n    plan:\n      escalate: false\n      pin: {via: codex, model: gpt-6-astra}\n  floors:\n    docs: mid\n`;
    const cells: Array<[Edit, (x: ReturnType<typeof load>) => unknown, unknown]> = [
      [{ layer: "repo", path: ["judge"], value: { adapter: "codex", model: "gpt-6-sol" }, label: "" }, (x) => x.judge, { adapter: "codex", model: "gpt-6-sol" }],
      [{ layer: "repo", path: ["routing", "map", "plan"], value: pool([a, b], "ordered"), label: "" }, (x) => [x.routing.map.plan?.escalate, x.routing.map.plan?.pin, x.routing.map.plan?.pool], [false, undefined, { mode: "ordered", channels: [a, b] }]],
      [{ layer: "repo", path: ["review", "prefer"], value: [b], label: "" }, (x) => x.review.prefer, [b]],
      [{ layer: "repo", path: ["consult", "prefer"], value: [d], label: "" }, (x) => x.consult.prefer, [d]],
      [{ layer: "repo", path: ["routing", "deny", "workers", "adapters"], value: ["omp"], label: "" }, (x) => x.routing.deny?.workers?.adapters, ["omp"]],
      [{ layer: "repo", path: ["routing", "allow", "models"], value: [a], label: "" }, (x) => x.routing.allow?.models, [a]],
      [{ layer: "repo", path: ["routing", "mode"], value: "staff-led", label: "" }, (x) => x.routing.mode, "staff-led"],
      [{ layer: "repo", path: ["routing", "floors", "docs"], value: undefined, label: "" }, (x) => x.routing.floors.docs, load("", "").routing.floors.docs], // the shape's own floor gone: the mode's
      [{ layer: "repo", path: ["tiers", "codex", "models", "gpt-6-luna"], value: "cheap", label: "" }, (x) => x.tiers.codex.models["gpt-6-luna"], "cheap"],
      [{ layer: "repo", path: ["tiers", "omp", "modelOverrides", "zai/glm-5.3", "vendor"], value: "zai", label: "" }, (x) => x.tiers.omp.modelOverrides?.["zai/glm-5.3"]?.vendor, "zai"],
    ];
    for (const [e, read, want] of cells) {
      const out = applyEdits({ userText: "", repoText }, [e]);
      expect(read(load(out.userText, out.repoText)), e.path.join(".")).toEqual(want);
      expect(out.touched, e.path.join(".")).toEqual(["repo"]);
    }
  });

  test("two answers at one path combine for a pool and a list; a scalar answer replaces the earlier one", () => {
    const repoText = `routing:\n  map:\n    plan:\n      pool: {mode: any, channels: [${a}, ${b}, ${c}]}\n  deny:\n    models: [${a}, ${b}, ${c}]\n`;
    const plan = ["routing", "map", "plan"], models = ["routing", "deny", "models"];
    const out = applyEdits({ userText: "", repoText }, [
      { layer: "repo", path: plan, value: pool([b, c]), label: "drop astra" },
      { layer: "repo", path: plan, value: pool([a, b, d], "ordered"), label: "luna to opus" },
      { layer: "repo", path: models, value: [b, c], label: "" },
      { layer: "repo", path: models, value: [a, b, d], label: "" },
      { layer: "repo", path: ["routing", "mode"], value: "staff-led", label: "" },
      { layer: "repo", path: ["routing", "mode"], value: "risk-based", label: "" },
    ]);
    const cfg = load(out.userText, out.repoText);
    expect(cfg.routing.map.plan?.pool).toEqual({ mode: "ordered", channels: [b, d] });
    expect(cfg.routing.deny?.models).toEqual([b, d]);
    expect(cfg.routing.mode).toBe("risk-based");
  });

  test("an edit no screen code produces is refused by name before any document is parsed, with both texts unchanged", () => {
    const userText = "routing:\n  deny:\n    models: [claude-code:opus]\n    adapters: [omp]\n    workers:\n      adapters: [omp]\n      models: [claude-code:opus]\n  allow:\n    adapters: [codex]\n";
    const plan = ["routing", "map", "plan"];
    // the reviewers' inputs, each a round that found the generic handling wrong; and an unloadable repo text, so a parse would throw something else
    const cells: Array<[string, Edit[], string[]]> = [
      ["routing:\n  deny: null\n", [{ layer: "repo", path: ["routing"], value: { deny: {} }, label: "" }], ["routing"]],
      ["routing:\n  allow: null\n", [{ layer: "repo", path: ["routing"], value: { allow: {} }, label: "" }], ["routing"]],
      ["routing:\n  deny:\n    workers: null\n", [{ layer: "repo", path: ["routing", "deny"], value: { workers: {} }, label: "" }], ["routing", "deny"]],
      ["routing:\n  deny:\n    workers: null\n", [{ layer: "repo", path: ["routing", "deny"], value: { models: [a], workers: {} }, label: "" }], ["routing", "deny"]],
      ["routing:\n  deny: null\n", [{ layer: "repo", path: ["routing"], value: { deny: { workers: { models: [a] } } }, label: "" }], ["routing"]],
      ["routing: {map: {plan: {escalate: false}}}\n", [{ layer: "repo", path: plan, value: { escalate: true }, label: "" }], plan],
      ["routing: {map: {plan: {escalate: false}}}\n", [{ layer: "repo", path: plan, value: { pool: { channels: [a] } }, label: "" }], plan],
      ["", [{ layer: "repo", path: plan, value: pool([a]), label: "" }, { layer: "repo", path: plan, value: { escalate: true }, label: "" }], plan],
      ["", [{ layer: "repo", path: plan, value: pool([a]), label: "" }, { layer: "repo", path: [...plan, "pool", "channels"], value: [a, b], label: "" }], [...plan, "pool", "channels"]],
      ["", [{ layer: "repo", path: plan, value: pool([a], "all"), label: "" }], plan],
      ["", [{ layer: "repo", path: ["routing", "map", "nosuchshape"], value: pool([a]), label: "" }], ["routing", "map", "nosuchshape"]],
      ["", [{ layer: "repo", path: ["routing", "map", "plan", "pin"], value: undefined, label: "" }], ["routing", "map", "plan", "pin"]],
      ["", [{ layer: "repo", path: ["routing", "mode"], value: undefined, label: "" }], ["routing", "mode"]],
      ["", [{ layer: "repo", path: ["routing", "floors", "plan"], value: "huge", label: "" }], ["routing", "floors", "plan"]],
      ["", [{ layer: "repo", path: ["tiers", "codex"], value: { models: { "gpt-6-astra": "mid" } }, label: "" }], ["tiers", "codex"]],
      ["", [{ layer: "repo", path: ["judge"], value: { adapter: "codex", model: "gpt-6-sol", effort: "high" }, label: "" }], ["judge"]],
      ["", [{ layer: "repo", path: ["review", "prefer"], value: [a, 3], label: "" }], ["review", "prefer"]],
    ];
    for (const [repoText, answers, path] of cells) {
      for (const text of [repoText, `${repoText}\n: : not yaml [\n`]) {
        const err = refused({ userText, repoText: text }, answers);
        expect(err.message, path.join(".")).toContain("fleet does not make this edit");
        expect(err.path, path.join(".")).toEqual(path);
        expect(err.layer).toBe("repo");
      }
    }
    // the same lists through the eight shapes land, and a tombstone above them keeps every list it masked
    const out = applyEdits({ userText, repoText: "routing:\n  deny: null\n" }, [{ layer: "repo", path: ["routing", "deny", "workers", "models"], value: [a], label: "" }]);
    const deny = load(out.userText, out.repoText).routing.deny;
    expect(deny?.workers?.models).toEqual([a]);
    expect([deny?.models ?? [], deny?.adapters ?? [], deny?.workers?.adapters ?? []]).toEqual([[], [], []]);
  });

  test("the closed set of edits takes the mode complexity and the routing.hardFrom edit, a whole number from 2 to 10", () => {
    const load = (t: { userText: string; repoText: string }) => loadConfigWithMode("/", { userOverlayText: t.userText, repoOverlayText: t.repoText }).cfg;
    const texts = { userText: "", repoText: "" };
    const pooled = applyEdits(texts, [{ layer: "repo", path: ["routing", "map", "implement"], value: { pool: { mode: "complexity", channels: ["codex:gpt-6-astra"] } }, label: "" }]);
    expect(load(pooled).routing.map.implement?.pool).toEqual({ mode: "complexity", channels: ["codex:gpt-6-astra"] });
    const hard = applyEdits(texts, [{ layer: "user", path: ["routing", "hardFrom"], value: 9, label: "" }]);
    expect(load(hard).routing.hardFrom).toBe(9);
    for (const value of [1, 11, 8.5, "9"]) {
      expect(() => applyEdits(texts, [{ layer: "user", path: ["routing", "hardFrom"], value, label: "" }]), String(value)).toThrow("fleet does not make this edit");
    }
    expect(() => applyEdits(texts, [{ layer: "user", path: ["routing", "similarWithin"], value: 3, label: "" }])).toThrow("fleet does not make this edit");
  });

  test("one path on both layers is refused; one identical layer and path still combines", () => {
    const models = ["routing", "deny", "models"];
    const texts = { userText: "routing:\n  deny:\n    models: [x:1, x:2]\n", repoText: "routing:\n  deny:\n    models: [x:1, x:2]\n" };
    expect(refused(texts, [{ layer: "user", path: models, value: ["x:2"], label: "" }, { layer: "repo", path: models, value: ["x:1", "x:2", "x:4"], label: "" }]).path).toEqual(models);
    const out = applyEdits(texts, [{ layer: "repo", path: models, value: ["x:2"], label: "" }, { layer: "repo", path: models, value: ["x:1", "x:2", "x:4"], label: "" }]);
    expect(load(out.userText, out.repoText).routing.deny?.models).toEqual(["x:2", "x:4"]);
  });
});

describe("no edit writes through an object prototype (row 522; D-2187 add.444)", () => {
  test("an edit path holding a reserved object key is refused by name and writes nothing anywhere", () => {
    const texts = { userText: "", repoText: "tiers:\n  codex:\n    channel: sub\n" };
    const protoKeys = () => Object.getOwnPropertyNames(Object.prototype).sort();
    const keysBefore = protoKeys();
    for (const bad of ["__proto__", "constructor", "prototype"]) {
      for (const path of [["tiers", bad, "models", "m"], ["tiers", "codex", "models", bad], ["tiers", bad, "channel"], ["tiers", bad, "vendor"], ["tiers", "codex", "modelOverrides", bad, "vendor"]]) {
        const value = path.at(-1) === "channel" ? "api" : path.at(-1) === "vendor" ? "openai" : "frontier";
        const e: Edit = { layer: "repo", path, value, label: "" };
        let err: unknown;
        try { applyEdits(texts, [e]); } catch (x) { err = x; }
        expect(err, path.join(".")).toBeInstanceOf(EditRefused);
        expect((err as Error).message, path.join(".")).toContain(bad);
        expect(() => applyLayer(texts.repoText, [e]), path.join(".")).toThrow(EditRefused);
        expect(() => combineEdits({}, [e, e]), path.join(".")).not.toThrow();
      }
    }
    expect(protoKeys()).toEqual(keysBefore);
    const probe = {} as Record<string, unknown>;
    for (const k of ["models", "channel", "vendor", "m", "modelOverrides"]) expect(probe[k], k).toBeUndefined();
  });
  test("an answered rule path through any inherited object key modifies no shared object before it is refused", () => {
    const M = buildFleetModel({ userText: "", repoText: "", health: null, adapters: [], now: 0 });
    const proto = Object.prototype as unknown as Record<string, Record<string, unknown>>;
    const keys = Object.getOwnPropertyNames(Object.prototype);
    const touched: string[] = [];
    for (const scope of ["allow", "deny"]) for (const key of keys) {
      const target = proto[key];
      const isTarget = target !== null && (typeof target === "object" || typeof target === "function");
      const before = isTarget ? Object.getOwnPropertyDescriptor(target, "models") : undefined;
      const e: Edit = { layer: "repo", path: ["routing", scope, key, "models"], value: ["codex:gpt-6-astra"], label: "" };
      try {
        handEdits(M, [], [e]);
        if (isTarget && Object.hasOwn(target, "models")) touched.push(e.path.join("."));
        expect(() => applyEdits(M.inputs, [e]), e.path.join(".")).toThrow(EditRefused);
      } finally {
        if (isTarget) { if (before) Object.defineProperty(target, "models", before); else delete target.models; }
      }
    }
    expect(touched).toEqual([]);
    expect(({} as Record<string, unknown>).models).toBeUndefined();
  });
});

describe("names a user or a probe supplies are own keys, read and written (row 522; D-2187 add.444)", () => {
  const BUILTIN = ["__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "toLocaleString"];
  const layerOf = (M: ReturnType<typeof buildFleetModel>, line: string, path: string) => handEdits(M, [{ line, chosen: ["frontier"] }]).find((e) => e.path.join(".") === path)?.layer;
  test("combining two answers keeps a value's own __proto__ key, so the combined edit is still refused by name", () => {
    const protoBefore = Object.getOwnPropertyNames(Object.prototype).sort();
    const j1: Edit = { layer: "repo", path: ["judge"], value: { adapter: "codex", model: "gpt-6-sol" }, label: "a" };
    const j2: Edit = { layer: "repo", path: ["judge"], value: JSON.parse('{"adapter":"codex","model":"gpt-6-astra","__proto__":{"polluted":true}}'), label: "b" };
    const m1: Edit = { layer: "repo", path: ["routing", "map", "implement"], value: { pool: { mode: "any", channels: ["codex:gpt-6-sol"] } }, label: "a" };
    const m2: Edit = { layer: "repo", path: ["routing", "map", "implement"], value: JSON.parse('{"__proto__":{"x":1},"pool":{"mode":"any","channels":["codex:gpt-6-astra"],"__proto__":{"y":1}}}'), label: "b" };
    for (const [a, b] of [[j1, j2], [m1, m2]]) {
      const combined = combineEdits({}, [a, b]);
      const v = combined[0].value as Record<string, unknown>;
      expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
      expect(v.polluted).toBeUndefined();
      expect(Object.keys(v)).toContain("__proto__");
      expect(() => applyEdits({ userText: "", repoText: "" }, combined)).toThrow(EditRefused);
      expect(() => applyLayer("", combined)).toThrow(EditRefused);
    }
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(protoBefore);
  });
  test("a level for a model named like a built-in property goes to the layer that names it, never to one that only inherits it", () => {
    for (const k of BUILTIN) {
      const p = `tiers.codex.models.${k}`;
      const userOnly = buildFleetModel({ userText: "tiers:\n  codex:\n    models:\n      gpt-6-sol: frontier\n", repoText: "", health: null, adapters: [], now: 0 });
      expect(layerOf(userOnly, `tier:codex:${k}`, p), k).toBe("repo");
      const userOwns = buildFleetModel({ userText: `tiers:\n  codex:\n    models:\n      ${k}: mid\n`, repoText: "tiers:\n  codex:\n    models:\n      gpt-6-sol: frontier\n", health: null, adapters: [], now: 0 });
      expect(layerOf(userOwns, `tier:codex:${k}`, p), k).toBe("user");
      const texts = { userText: "tiers:\n  mygw:\n    vendor: null\n    channel: api\n    models:\n      zai/glm-5.3: frontier\n    modelOverrides:\n      zai/glm-5.3:\n        vendor: zai\n", repoText: "routing:\n  mode: partner-led\n" };
      const h = { mygw: { installed: true, authed: true, models: [k], modelAuth: { [k]: { authed: true, probedAt: "2026-11-10T00:00:00Z", identity: `openai/${k}` } } } };
      const M = buildFleetModel({ ...texts, health: h as never, adapters: [], now: 0 });
      const edits = handEdits(M, [{ line: `tier:mygw:${k}`, chosen: ["frontier"] }]);
      expect(new Set(edits.map((e) => e.layer)), k).toEqual(new Set(["repo"]));
      const out = applyEdits(texts, edits);
      expect(() => loadConfigWithMode("/", { userOverlayText: out.userText, repoOverlayText: "" }), k).not.toThrow();
    }
    for (const k of ["__proto__", "constructor"]) {
      const M = buildFleetModel({ userText: "tiers:\n  codex:\n    models:\n      gpt-6-sol: frontier\n", repoText: "", health: null, adapters: [], now: 0 });
      let err: unknown;
      try { applyEdits(M.inputs, handEdits(M, [{ line: `tier:codex:${k}`, chosen: ["frontier"] }])); } catch (x) { err = x; }
      expect(err, k).toBeInstanceOf(EditRefused);
      expect((err as EditRefused).layer, k).toBe("repo");
    }
  });
  test("a model the probe recorded identities beside, named like any Object property, reads no identity it inherits", () => {
    for (const k of [...BUILTIN, "__proto__", "constructor", "prototype"]) {
      const h = { codex: { installed: true, authed: true, models: [k], modelAuth: {}, modelIdentities: { other: "openai/gpt-6-astra" } } };
      const M = buildFleetModel({ userText: "", repoText: "", health: h as never, adapters: [], now: 0 });
      expect(() => recordedVendor(M, "codex", k), k).not.toThrow();
      expect(() => handEdits(M, [{ line: `tier:codex:${k}`, chosen: ["frontier"] }]), k).not.toThrow();
    }
  });
});
