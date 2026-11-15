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
  test("a CLI that is signed out is one item, however many of its models the team names", () => {
    // implement's pool names two codex models: signing in to codex once brings both back
    const h = health();
    h.codex = { ...h.codex, authed: false, note: "not signed in" };
    const fixes = needs(buildFleetModel(source({ repoText: `${POOL}${CONSULT}`, health: h }).inputs)).filter((n) => n.id.startsWith("fix:"));
    expect(fixes.map((n) => n.id)).toEqual(["fix:codex:signed-out"]);
    expect(fixes[0].title).toBe("codex is signed out: gpt-6-astra, gpt-5.6-terra do not work.");
    expect(fixes[0].ask).toBe("Sign in to codex, then press r. You get: 1 shape gets a working model.");
    // one model that failed on its own keeps an item of its own, named for the model
    const one = needs(buildFleetModel(source({ repoText: `${POOL}${CONSULT}`, health: health(["codex:gpt-6-astra", "codex:gpt-5.6-terra"]) }).inputs)).filter((n) => n.id.startsWith("fix:"));
    expect(one.map((n) => n.title)).toEqual(["gpt-6-astra does not work: no answer (codex).", "gpt-5.6-terra does not work: no answer (codex)."]);
  });
  test("a key under routing.map or routing.floors that is no shape is said: it loads, does nothing, and the nearest shape is asked about", () => {
    // 'implment' was meant to give implement a pool: it loads without a word and implement keeps what it had
    const one = item({ repoText: `routing:\n  map:\n    implment:\n      pool:\n        mode: any\n        channels: [codex:gpt-6-astra]\n${CONSULT}` }, "notshape")!;
    expect(one.title).toBe("routing.map.implment names no shape: it does nothing.");
    expect(one.ask).toBe("Did you mean implement? Correct it in the config, then open fleet again.");
    expect(one.edits).toBeUndefined();
    // two of them, one in the floors; a name near no shape is answered with the list of shapes
    const two = item({ repoText: `routing:\n  map:\n    implment:\n      escalate: false\n  floors:\n    tsets: mid\n${CONSULT}` }, "notshape")!;
    expect(two.title).toBe("routing.map.implment and routing.floors.tsets name no shape: they do nothing.");
    expect(two.ask).toBe("Did you mean implement and tests? Correct them in the config, then open fleet again.");
    const far = item({ repoText: `routing:\n  floors:\n    deployment: mid\n${CONSULT}` }, "notshape")!;
    expect(far.ask).toBe("The shapes are plan, spec, implement, tests, docs, migration, ui, refactor, chore. Correct it in the config, then open fleet again.");
    // a config that names only shapes has no such item
    expect(item({ repoText: `${POOL}${CONSULT}` }, "notshape")).toBeUndefined();
  });
  test("a pool entry whose id its CLI no longer serves joins the entries to remove, counted apart and named; one its CLI still lists does not", () => {
    // implement's pool: gpt-6-astra answers; gpt-5.6-terra's probe was told 'unknown model id'
    const served = (listed: boolean, list = true) => {
      const h = health();
      h.codex.modelAuth!["gpt-5.6-terra"] = { authed: false, reason: "unknown model id gpt-5.6-terra", probedAt: "2026-11-10T00:00:00Z" } as never;
      h.codex = { ...h.codex, models: list ? h.codex.models.filter((m) => listed || m !== "gpt-5.6-terra") : [] };
      return { repoText: `${POOL}${CONSULT}`, health: h };
    };
    // the CLI's own list does not offer it either: retired, and the yes drops it from the pool
    const gone = item(served(false), "tidy")!;
    expect(gone.title).toBe("1 pool entry names an id its CLI no longer serves.");
    expect(gone.ask).toBe("Remove it? No task changes worker.");
    expect(gone.detail).toContain("codex:gpt-5.6-terra: its CLI answered that it no longer serves this id, and its own list of models does not offer it.");
    expect(gone.edits).toEqual([expect.objectContaining({ path: ["routing", "map", "implement"], value: { pool: { mode: "any", channels: ["codex:gpt-6-astra"] } }, label: "implement: drop codex:gpt-5.6-terra (no longer served)" })]);
    // the CLI still lists the id: the probe's word alone is not enough to remove it
    expect(item(served(true), "tidy")).toBeUndefined();
    // a CLI that lists no models at all: it counts, and the details say what the verdict rests on
    expect(item(served(false, false), "tidy")!.detail).toContain("codex:gpt-5.6-terra: its CLI answered that it no longer serves this id; that CLI lists no models, so this rests on the probe's answer alone.");
    // beside a rule that does nothing, each is counted apart
    const both = item({ ...served(false), userText: "routing:\n  deny:\n    models: [nosuch:model]\n" }, "tidy")!;
    expect(both.title).toBe("1 deny rule does nothing; 1 pool entry names an id its CLI no longer serves.");
    expect(both.ask).toBe("Remove them? No task changes worker.");
    // a model that only timed out keeps its place: nothing to remove
    expect(item({ repoText: `${POOL}${CONSULT}`, health: health(["codex:gpt-5.6-terra"]) }, "tidy")).toBeUndefined();
  });
  test("an id its CLI no longer serves is never 'remove the id … you get': listed, it is probed again; unlisted, nothing is promised", () => {
    // implement rests on that one id, so its return would give the shape a working model
    const only = `routing:\n  map:\n    implement:\n      pool:\n        mode: any\n        channels: [codex:gpt-5.6-terra]\n${CONSULT}`;
    const served = (listed: boolean) => {
      const h = health();
      h.codex.modelAuth!["gpt-5.6-terra"] = { authed: false, reason: "unknown model id gpt-5.6-terra", probedAt: "2026-11-10T00:00:00Z" } as never;
      h.codex = { ...h.codex, models: h.codex.models.filter((m) => listed || m !== "gpt-5.6-terra") };
      return needs(buildFleetModel(source({ repoText: only, health: h }).inputs));
    };
    // the CLI still lists it: the probe's answer is doubtful, and asking again is what may bring the shape its model
    const again = served(true).find((n) => n.id.startsWith("fix:"))!;
    expect(again.title).toBe("gpt-5.6-terra does not work: id no longer served (codex).");
    expect(again.ask).toBe("Its CLI still lists that id: press r to probe it again. You get: 1 shape gets a working model.");
    // the CLI does not list it: nothing done there brings it back, so no item says "you get"
    const gone = served(false);
    expect(gone.filter((n) => n.id.startsWith("fix:"))).toEqual([]);
    expect(gone.map((n) => n.ask).join(" ")).not.toMatch(/Remove the id/);
    // and the shape it left without a model still has an item about it
    expect(gone.some((n) => ["noseat", "tidy"].includes(n.id))).toBe(true);
  });
  test("one rule that does nothing is 'it', several are 'them'", () => {
    const one = item({ repoText: CONSULT, userText: "routing:\n  deny:\n    models: [nosuch:model]\n" }, "tidy")!;
    expect(`${one.title} ${one.ask}`).toBe("1 deny rule does nothing. Remove it? No task changes worker.");
    const two = item({ repoText: CONSULT, userText: "routing:\n  deny:\n    models: [nosuch:model, nosuch:other]\n" }, "tidy")!;
    expect(`${two.title} ${two.ask}`).toBe("2 deny rules do nothing. Remove them? No task changes worker.");
  });
});

describe("the last run's item asks while the work has nowhere to go, and no longer", () => {
  const lastRun = [{ runId: "run-1", seat: "codex:gpt-6-astra", shapes: ["implement"], tasks: ["T7"] }] as never;
  const pool = (channels: string) => `routing:\n  mode: partner-led\n  map:\n    implement:\n      pool:\n        mode: any\n        channels: [${channels}]\n${CONSULT}`;
  const ids = (over: Parameters<typeof source>[0]) => needs(buildFleetModel(source(over).inputs), { lastRun }).map((n) => n.id);
  test("the pool's only other model is below the floor: the item offers fallbacks at the floor", () => {
    expect(ids({ repoText: pool("codex:gpt-6-astra, codex:gpt-5.6-terra") })).toContain("run:run-1:codex:gpt-6-astra");
  });
  test("the pool already holds another working model at the floor: nothing is asked, though more models at the floor exist outside it", () => {
    expect(ids({ repoText: pool("codex:gpt-6-astra, claude-code:fable") })).not.toContain("run:run-1:codex:gpt-6-astra");
  });
  test("that other model does not answer: the item is back", () => {
    expect(ids({ repoText: pool("codex:gpt-6-astra, claude-code:fable"), health: health(["claude-code:fable"]) })).toContain("run:run-1:codex:gpt-6-astra");
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
