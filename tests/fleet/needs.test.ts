// The closed list of items, called directly: what is asked, and what a yes would change.
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { SHAPES } from "../../src/graph/schema.js";
import { buildFleetModel } from "../../src/fleet/model.js";
import { needs, recommendedPools } from "../../src/fleet/needs.js";
import { teamRows } from "../../src/fleet/screen.js";
import { health, POOL, source } from "./world.js";

/** The probe results of a machine where only these CLIs are installed. */
const only = (keep: string[]) => Object.fromEntries(Object.entries(health()).map(([a, v]) => [a, keep.includes(a) ? v : { installed: false, authed: false, models: [] }])) as ReturnType<typeof health>;
const everyModel = Object.entries(health()).flatMap(([a, v]) => v.models.map((m) => `${a}:${m}`));
const CONSULT = "consult:\n  prefer: [claude-code:fable]\n";

describe("NEEDS YOU", () => {
  test("with no probe on record the only item asks for one, and nothing is proposed", () => {
    const items = needs(buildFleetModel(source({ health: null }).inputs));
    expect(items.map((n) => n.id)).toEqual(["probe"]);
    expect(items[0].edits).toBeUndefined();
  });
  test("nothing is asked when every shape, gate and the consult has a working model", () => {
    const M = buildFleetModel(source({ repoText: "consult:\n  prefer: [claude-code:fable]\n" }).inputs);
    expect(M.consult).toBe("claude-code:fable");
    expect(needs(M)).toEqual([]);
  });
  test("a consult.prefer model that answers and still cannot take the seat is said so, in words that read", () => {
    const M = buildFleetModel(source({ repoText: "consult:\n  prefer: [codex:gpt-6-astra]\n" }).inputs);
    const item = needs({ ...M, consult: null } as typeof M).find((n) => n.id === "consult")!;
    expect(item.title).toBe("The consult has no model: codex:gpt-6-astra answers but cannot take the consult seat.");
    expect(item.ask).toBe("Name another model in consult.prefer, then press r.");
    expect(`${item.title} ${item.ask}`).not.toMatch(/passed|^, | , then/);
  });
});

describe("a line that reads wrong and that no yes can change still has an item, and the item says what to do", () => {
  const item = (over: Parameters<typeof source>[0], id: string) => needs(buildFleetModel(source(over).inputs)).find((n) => n.id === id);
  test("one vendor's CLI installed: the review has no model and the judge checks its own vendor; each item names the CLI to install and what it brings", () => {
    const over = { repoText: `${POOL}${CONSULT}`, health: only(["claude-code"]) };
    const review = item(over, "review")!;
    expect(review.title).toBe("The review has no model: no working model may review this team's work.");
    expect(review.ask).toBe("Install codex, then press r. You get: 3,600 more sample tasks get a reviewer.");
    expect(review.edits).toBeUndefined();
    expect(review.detail).toContain("Review is required (review.required): a task with no reviewer cannot pass its review gate.");
    const own = item(over, "ownvendor")!;
    expect(own.title).toBe("The judge checks its own vendor's work on 3,200 of 3,200 sample tasks.");
    expect(own.ask).toBe("Install codex, then press r. You get: 3,200 more sample tasks get a judge of another vendor.");
    expect(own.edits).toBeUndefined();
    // the same on a machine with no config yet: the first setup cannot give it a second vendor
    const fresh = { health: only(["claude-code"]) };
    expect(needs(buildFleetModel(source(fresh).inputs)).map((n) => n.id)).toEqual(["setup", "ownvendor", "review"]);
    expect(item(fresh, "review")!.ask).toBe("Install codex, then press r. You get: 3,600 more sample tasks get a reviewer.");
  });
  test("no CLI installed: every shape has its item, which says to install one; the judge's item names its CLI", () => {
    for (const over of [{ repoText: POOL, health: only([]) }, { health: only([]) }]) {
      const items = needs(buildFleetModel(source(over).inputs));
      expect(items.map((n) => n.id)).toEqual(["noseat", "judge", "review", "consult"]);
      expect(items.every((n) => !n.edits)).toBe(true);
      expect(items[0]).toMatchObject({ title: "every shape: no working model.", ask: "No agent CLI is installed. Install one, then press r." });
      expect(items[1].ask).toBe("No other working model may judge. Install claude-code, then press r.");
      // no CLI is named that a first-time user has not heard of: a gateway that carries several vendors would score best
      expect(items[2].ask).toBe("A reviewer is from another vendor than the worker's: install a second vendor's CLI too, then press r.");
      expect(items[3].ask).toBe("Nothing to do here yet: once a model answers the probe, this item offers it.");
      expect(items.map((n) => n.ask).join(" ")).not.toMatch(/Fix one|Fix it|omp|cursor-agent|prime-agent/);
    }
  });
  test("every model answers and a rule keeps each one out: the items say where to look, never 'fix one'", () => {
    const denied = { userText: `routing:\n  deny:\n    adapters: [${Object.keys(health()).join(", ")}]\n` };
    const items = needs(buildFleetModel(source(denied).inputs));
    const ask = (id: string) => items.find((n) => n.id === id)!.ask;
    // (the instruction comes from the cause: the deny rules that keep the models out, named, and where to change them)
    expect(ask("noseat")).toMatch(/^No working model may take them\. \d+ models that could take this: the deny rules [^.]+ keep them out\. Press e and change them on their deny lines\.$/);
    expect(ask("review")).toMatch(/^No working model of another vendor may review\. \d+ models that could take this: the deny rules [^.]+ keep them out\. Press e and change them on their deny lines\.$/);
    expect(ask("consult")).toMatch(/^No working model may consult\. \d+ models that could take this: the deny rules [^.]+ keep them out\. Press e and change them on their deny lines\.$/);
    expect(ask("judge")).toBe("No other working model may judge. The deny rule claude-code keeps it out: press e and change it on that deny line.");
    expect(items.map((n) => n.ask).join(" ")).not.toMatch(/Fix one|Fix it/);
  });
  test("every model timed out: the items name the model to probe, never 'it' for a model the title does not name", () => {
    const over = { repoText: POOL, health: health(everyModel) };
    expect(item(over, "noseat")!.ask).toBe("Press r to probe fable. You get: a working model for 8 shapes.");
    expect(item(over, "review")!.ask).toMatch(/^Press r to probe [\w.-]+\. You get: [\d,]+ more sample tasks get a reviewer\.$/);
    // the judge's title names its model, so its instruction may say "it"
    expect(item(over, "judge")).toMatchObject({ title: "The judge (acceptance) does not answer: claude-code:fable, no answer.", ask: "No other working model may judge. Press r to probe it." });
  });
  test("where only some tasks lack a reviewer the title counts them, and the gain is what the model's return adds", () => {
    // a second vendor that may review the cheaper work only: a third of the sample tasks has no reviewer
    const some = item({ health: only(["claude-code", "grok"]) }, "review")!;
    expect(some.title).toBe("1,200 of 3,600 sample tasks have no reviewer.");
    expect(some.ask).toBe("Install codex, then press r. You get: 1,200 more sample tasks get a reviewer.");
    expect(some.edits).toBeUndefined();
    // what the details say holds for these tasks only: a model of another vendor does work here, and reviews the rest
    expect(some.detail).toContain("There is nothing a yes could change: for these tasks no working model that may review them is from another vendor than their worker.");
    expect(some.detail.join(" ")).not.toContain("no working model that may review is from another vendor");
  });
  test("the other vendors' models timed out: the review's item names the model to probe; a team where every line reads ok has none of these items", () => {
    // the other vendors' models timed out: the review line reads wrong although a model to restore is listed too
    const over = { repoText: `${POOL}review:\n  prefer: [codex:gpt-6-astra]\n${CONSULT}`, health: health(everyModel.filter((k) => !k.startsWith("claude-code:"))) };
    expect(item(over, "review")!.ask).toBe("Press r to probe gpt-6-astra. You get: 3,600 more sample tasks get a reviewer.");
    const ok = needs(buildFleetModel(source({ repoText: CONSULT }).inputs));
    expect(ok.filter((n) => ["review", "ownvendor", "noseat"].includes(n.id))).toEqual([]);
  });
  test("in each of those worlds, every line of the team that does not read ok has an item about that line", () => {
    const worlds = [{ repoText: `${POOL}${CONSULT}`, health: only(["claude-code"]) }, { health: only(["claude-code"]) }, { repoText: POOL, health: only([]) }, { health: only([]) },
      { repoText: POOL, health: health(everyModel) }, { repoText: `${POOL}${CONSULT}`, health: only(["codex"]) }, { health: only(["codex", "kimi"]) }, { health: only(["claude-code", "grok"]) }, { repoText: `${POOL}${CONSULT}`, health: only(["codex", "grok"]) },
      { repoText: CONSULT, userText: `routing:\n  deny:\n    workers:\n      adapters: [${Object.keys(health()).join(", ")}]\n` }, { repoText: CONSULT, userText: "routing:\n  allow: {}\n" }];
    const ids: Record<string, string[]> = { acceptance: ["judge", "ownvendor", "setup"], review: ["review"], consult: ["consult", "setup"], overseer: ["consult", "setup"] };
    let wrong = 0;
    for (const [i, over] of worlds.entries()) {
      const M = buildFleetModel(source(over).inputs), items = needs(M).map((n) => n.id);
      for (const row of teamRows(M).filter((r) => !r.status.startsWith("ok"))) {
        wrong++;
        const want = row.section === "workers" ? (row.status === "NO MODEL" ? ["noseat", "setup"] : ["floor", "setup"]) : ids[row.label.split(" ")[0]];
        expect(items.some((id) => want.includes(id)), `world ${i}: ${row.label} = ${row.status}; items: ${items.join(", ")}`).toBe(true);
      }
    }
    expect(wrong).toBeGreaterThan(15);
  });
  test("no CLI installed and the judge or the consult is a gateway's model: no item names that gateway to install, and each says what to do", () => {
    // every CLI that carries several vendors, as the judge and as the consult; the rule over the class: no "install <gateway>"
    const gateways = Object.entries(DEFAULT_CONFIG.tiers).filter(([, t]) => t.vendor === "mixed").map(([a, t]) => `${a}:${Object.keys(t.models)[0]}`);
    expect(gateways.length).toBeGreaterThanOrEqual(3);
    for (const key of gateways) {
      const [adapter, model] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      const items = needs(buildFleetModel(source({ repoText: `${POOL}judge:\n  adapter: ${adapter}\n  model: ${JSON.stringify(model)}\nconsult:\n  prefer: [${JSON.stringify(key)}]\n`, health: only([]) }).inputs));
      const asks = items.map((n) => n.ask).join(" ");
      expect(asks, key).not.toContain(`nstall ${adapter}`);
      const say = "Its CLI is not installed: install one vendor's own agent CLI, name one of its models here, then press r.";
      expect(items.find((n) => n.id === "judge")!.ask, key).toBe(`No other working model may judge. ${say}`);
      expect(items.find((n) => n.id === "consult")!.ask, key).toBe(say);
    }
  });
  test("a gateway is named by its own catalog entry, never by a config's vendor: with tiers.<gateway>.vendor set to openai no item says to install it", () => {
    for (const gw of ["opencode", "omp", "prime-agent"]) {
      const model = Object.keys(DEFAULT_CONFIG.tiers[gw].models)[0], key = `${gw}:${model}`;
      const vendor = `tiers:\n  ${gw}:\n    vendor: openai\n`;
      // no CLI installed, that gateway's model as judge and consult
      const lone = `${vendor}${POOL}judge:\n  adapter: ${gw}\n  model: ${JSON.stringify(model)}\nconsult:\n  prefer: [${JSON.stringify(key)}]\n`;
      // only claude-code installed and only claude-code and that gateway in tiers; with and without a deny rule for the gateway
      const pair = `tiers:\n${Object.keys(DEFAULT_CONFIG.tiers).filter((a) => a !== "claude-code" && a !== gw).map((a) => `  ${a}: null\n`).join("")}  ${gw}:\n    vendor: openai\n${POOL}${CONSULT}`;
      for (const over of [{ repoText: lone, health: only([]) }, { repoText: pair, health: only(["claude-code"]) },
        { repoText: pair, health: only(["claude-code"]), userText: `routing:\n  deny:\n    adapters: [${gw}]\n` }]) {
        const asks = needs(buildFleetModel(source(over).inputs)).map((n) => n.ask).join(" ");
        expect(asks, gw).not.toMatch(new RegExp(`nstall ${gw}`));
        expect(asks, gw).toMatch(/install a second vendor's CLI|install one vendor's own agent CLI|Install a second vendor's CLI/);
      }
    }
    // a one-vendor CLI is still named
    expect(item({ repoText: `${POOL}${CONSULT}`, health: only(["claude-code"]) }, "review")!.ask).toContain("Install codex");
  });
  test("every model answers and the allowlist keeps the judge out: the item says to add it to routing.allow, never to change a deny line", () => {
    const items = needs(buildFleetModel(source({ repoText: CONSULT, userText: "routing:\n  allow: {}\n" }).inputs));
    const judge = items.find((n) => n.id === "judge")!;
    expect(judge.title).toBe("The judge (acceptance) is not on the allowlist: claude-code:fable.");
    expect(judge.ask).not.toContain("deny line");
    expect(judge.ask).toBe("No other working model may judge. It is not on the allowlist: add claude-code:fable to routing.allow in the config, then press r.");
  });
  test("a judge that answers while no shape has a worker: the acceptance line reads NO MODEL and has an item that says it follows the workers", () => {
    const M = buildFleetModel(source({ repoText: CONSULT, userText: `routing:\n  deny:\n    workers:\n      adapters: [${Object.keys(health()).join(", ")}]\n` }).inputs);
    expect(teamRows(M).find((r) => r.label === "acceptance (judge)")!.status).toBe("NO MODEL");
    const judge = needs(M).find((n) => n.id === "judge")!;
    expect(judge.title).toBe("The judge (acceptance) has no work: claude-code:fable answers, and no task has a worker for it to check.");
    expect(judge.edits).toBeUndefined();
  });
  test("no task has a worker while models may review: the review's item says it follows the workers and points to the shapes' item, never to a reviewer rule", () => {
    // a rule keeps every model from work only; every shape's pool names a model no CLI lists
    const pinned = `routing:\n  map:\n${SHAPES.map((s) => `    ${s}:\n      pool:\n        mode: ordered\n        channels: [codex:missing-model]\n`).join("")}`;
    for (const over of [{ repoText: CONSULT, userText: `routing:\n  deny:\n    workers:\n      adapters: [${Object.keys(health()).join(", ")}]\n` }, { repoText: `${pinned}${CONSULT}` }]) {
      const M = buildFleetModel(source(over).inputs);
      expect(M.sample().routed).toBe(0);
      const items = needs(M), review = items.find((n) => n.id === "review")!;
      expect(review.title).toMatch(/^The review has no work: \d+ working models may review, and no task has a worker for them to check\.$/);
      expect(review.ask).toBe("It follows the workers: once a shape has a working model, the review has work. The item about the shapes says what to do.");
      expect(review.ask).not.toContain("open review");
      expect(items.some((n) => n.id === "noseat" || n.id === "setup")).toBe(true);
    }
  });
  test("over a grid of worlds every line that reads wrong has an item, and its instruction names a reason the world contains", () => {
    const all = Object.keys(health()).join(", "), others = Object.keys(health()).filter((a) => a !== "claude-code");
    const pinned = `routing:\n  map:\n${SHAPES.map((s) => `    ${s}:\n      pool:\n        mode: ordered\n        channels: [codex:missing-model]\n`).join("")}`;
    const only1 = only(["claude-code"]);
    // [world, a word its wrong lines' items must say, a word none may say]
    const grid: Array<[Parameters<typeof source>[0], RegExp, RegExp]> = [
      [{ repoText: `${POOL}${CONSULT}`, health: only1 }, /Install codex|install a second vendor/, /open review|deny rule|allowlist/],
      [{ repoText: POOL, health: health(everyModel) }, /probe/, /deny rule|allowlist/],
      [{ repoText: CONSULT, userText: `routing:\n  deny:\n    adapters: [${all}]\n` }, /deny rule/, /open review|open judge|allowlist|Install/],
      [{ repoText: CONSULT, userText: "routing:\n  allow: {}\n" }, /allow/, /deny line|Install/],
      [{ repoText: CONSULT, userText: `routing:\n  deny:\n    workers:\n      adapters: [${all}]\n` }, /follows the workers|deny rule/, /open review|Install/],
      [{ repoText: `${pinned}${CONSULT}` }, /follows the workers|missing-model|Use /, /open review|Install/],
      // the reviewer's three worlds: only claude-code installed, every other CLI also kept out by a rule
      [{ repoText: `${POOL}${CONSULT}`, health: only1, userText: `routing:\n  deny:\n    adapters: [${others.join(", ")}]\n` }, /deny rule/, /open review|open judge|editor/],
      [{ repoText: `${POOL}${CONSULT}`, health: only1, userText: `routing:\n  deny:\n    models: [${everyModel.filter((k) => !k.startsWith("claude-code:")).map((k) => JSON.stringify(k)).join(", ")}]\n` }, /deny rule/, /open review|open judge/],
      [{ repoText: `${POOL}${CONSULT}`, health: only1, userText: "routing:\n  allow:\n    adapters: [claude-code]\n" }, /routing\.allow/, /open review|open judge|deny line/],
    ];
    for (const [i, [over, must, never]] of grid.entries()) {
      const M = buildFleetModel(source(over).inputs), items = needs(M);
      const wrong = teamRows(M).filter((r) => !r.status.startsWith("ok"));
      expect(wrong.length, `world ${i}`).toBeGreaterThan(0);
      const asks = items.filter((n) => ["noseat", "judge", "ownvendor", "review", "consult"].includes(n.id) && !n.edits).map((n) => n.ask);
      expect(asks.length, `world ${i}`).toBeGreaterThan(0);
      expect(asks.join(" "), `world ${i}`).toMatch(must);
      expect(asks.join(" "), `world ${i}`).not.toMatch(never);
      expect(asks.join(" "), `world ${i}`).not.toMatch(/Fix one|Fix it|each model says what keeps it out/);
    }
  });
  test("a vendor that works other tasks is still a candidate to review the tasks that lack a reviewer: the item names the rule that keeps its models out", () => {
    const tiers = `tiers:\n${Object.keys(DEFAULT_CONFIG.tiers).filter((a) => !["claude-code", "codex"].includes(a)).map((a) => `  ${a}: null\n`).join("")}`;
    const base = `${tiers}${CONSULT}routing:\n  map:\n    implement:\n      pool:\n        mode: ordered\n        channels: [codex:gpt-5.6-terra]\n`;
    const rules: Array<[string, RegExp]> = [
      ["  deny:\n    models: [codex:gpt-6-astra, codex:gpt-6-sol, codex:gpt-5.6-sol]\n", /the deny rules codex:gpt-6-astra, codex:gpt-6-sol and codex:gpt-5\.6-sol keep them out\. Press e and change them on their deny lines\./],
      ["  allow:\n    adapters: [claude-code]\n    models: [codex:gpt-6-luna, codex:gpt-5.6-luna, codex:gpt-5.6-terra]\n", /the allowlist keeps them out\. Add them to routing\.allow/],
    ];
    for (const [rule, says] of rules) {
      const M = buildFleetModel(source({ repoText: base + rule }).inputs);
      expect(M.sample().noReviewer).toBe(1200);
      // removing the rule restores every missing reviewer: the rule is the cause, and the item says so
      expect(buildFleetModel(source({ repoText: base }).inputs).sample().noReviewer).toBe(0);
      const ask = needs(M).find((n) => n.id === "review")!.ask;
      expect(ask).toMatch(says);
      expect(ask).not.toMatch(/no model of another vendor|Install/);
    }
  });
  test("a vendor that works and sits below the review floor of the tasks that lack a reviewer: the item names the floor, never 'no model of another vendor'", () => {
    for (const adapter of ["grok", "codex"]) {
      const prune = Object.keys(DEFAULT_CONFIG.tiers).filter((a) => !["claude-code", adapter].includes(a)).map((a) => `  ${a}: null\n`).join("");
      const models = Object.keys(DEFAULT_CONFIG.tiers[adapter].models);
      const cfg = (raised: boolean) => `tiers:\n${prune}  ${adapter}:\n    models:\n${models.map((m, i) => `      ${JSON.stringify(m)}: ${raised && i === 0 ? "frontier" : "mid"}\n`).join("")}${CONSULT}`;
      const M = buildFleetModel(source({ repoText: cfg(false) }).inputs);
      expect(M.sample().noReviewer, adapter).toBe(1200);
      const ask = needs(M).find((n) => n.id === "review")!.ask;
      expect(ask, adapter).toMatch(/below these tasks' review floor, frontier .*at frontier or above/);
      expect(ask, adapter).not.toMatch(/no model of another vendor|Install|install a second vendor/);
      // raising one of that vendor's models to the floor reviews every task: the floor was the cause
      expect(buildFleetModel(source({ repoText: cfg(true) }).inputs).sample().noReviewer, adapter).toBe(0);
    }
  });
  test("a probe record that holds nothing but 'not installed' for a CLI is read, never a crash", () => {
    // what an older doctor.json or a hand-written one may hold: no list of models, no sign-in state
    const bare = Object.fromEntries(Object.entries(health()).map(([a, v]) => [a, a === "claude-code" ? v : { installed: false }])) as ReturnType<typeof health>;
    expect(item({ repoText: `${POOL}${CONSULT}`, health: bare }, "review")!.ask).toBe("Install codex, then press r. You get: 3,600 more sample tasks get a reviewer.");
  });
  test("a remedy that does not name its CLI is said with the model it is about: out of credit, an unmapped failure", () => {
    // every model of another vendor failed its probe for a reason of its own; the review's title names no model
    const failing = (reason: string) => { const h = health(); for (const [a, v] of Object.entries(h)) if (a !== "claude-code") for (const m of Object.keys(v.modelAuth!)) v.modelAuth![m] = { authed: false, reason, probedAt: "2026-11-10T00:00:00Z" }; return h; };
    const over = (reason: string) => ({ repoText: `${POOL}review:\n  prefer: [codex:gpt-6-astra]\n${CONSULT}`, health: failing(reason) });
    expect(item(over("insufficient balance"), "review")!.ask).toBe("gpt-6-astra: out of credit. Recharge the account, then press r. You get: 3,600 more sample tasks get a reviewer.");
    // "it" is the model just named
    expect(item(over("weird failure nobody mapped"), "review")!.ask).toBe("gpt-6-astra: probe failed. Probe it again, then press r. You get: 3,600 more sample tasks get a reviewer.");
    for (const reason of ["insufficient balance", "weird failure nobody mapped", "429 quota exceeded for this billing period"]) {
      const asks = needs(buildFleetModel(source(over(reason)).inputs)).filter((n) => ["review", "ownvendor", "noseat"].includes(n.id) && !n.edits).map((n) => n.ask);
      expect(asks.length, reason).toBeGreaterThan(0);
      for (const ask of asks) expect(ask, reason).toMatch(/^(Press r to probe \S+\.|(Install|Sign in to) \S+, then press r\.|\S+: [^.]+\. [^.]+, then press r\.|No )/);
    }
  });
  test("one rule that does nothing is 'it', several are 'them'", () => {
    const one = item({ repoText: CONSULT, userText: "routing:\n  deny:\n    models: [nosuch:model]\n" }, "tidy")!;
    expect(`${one.title} ${one.ask}`).toBe("1 deny rule does nothing. Remove it? No task changes worker.");
    const two = item({ repoText: CONSULT, userText: "routing:\n  deny:\n    models: [nosuch:model, nosuch:other]\n" }, "tidy")!;
    expect(`${two.title} ${two.ask}`).toBe("2 deny rules do nothing. Remove them? No task changes worker.");
  });
});

describe("answers and the one write path", () => {
  test("the recommended pools: at or above the floor, one model per vendor first, six at most", () => {
    const M = buildFleetModel(source({ repoText: "routing:\n  mode: partner-led\n" }).inputs);
    const pool = recommendedPools(M).plan;
    const atFloor = M.pools.worker.filter((c) => c.tier === "frontier").length;
    expect(atFloor).toBeGreaterThan(6);
    expect(pool).toHaveLength(6);
    for (const k of pool) expect(M.seat(k)!.tier, k).toBe("frontier");
    // as many different vendors as six places allow come before any vendor's second model
    const vendors = new Set(M.pools.worker.filter((c) => c.tier === "frontier").map((c) => M.provider(`${c.adapter}:${c.model}`)));
    const lead = pool.slice(0, Math.min(6, vendors.size)).map((k) => M.provider(k));
    expect(new Set(lead).size).toBe(lead.length);
  });
});
