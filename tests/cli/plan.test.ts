import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { writeDoctor } from "../../src/adapters/registry.js";
import type { BillingChannel, WorkerAdapter } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG, type TickmarkrConfig } from "../../src/config/config.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { plan } from "../../src/cli/commands/plan.js";
import { run } from "../../src/cli/commands/run.js";
import { tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { route, type RoutingPreferContext } from "../../src/route/router.js";
import { authedModels, makeRepo } from "../helpers/tmprepo.js";

const verifiedDefaultModels = (id: string) => authedModels(Object.keys(DEFAULT_CONFIG.tiers[id]?.models ?? {}));

const DOCTOR5 = Object.fromEntries(
  ["claude-code", "codex", "cursor-agent", "opencode", "pi"].map((id) => [id, { installed: true, authed: true, models: [], modelAuth: verifiedDefaultModels(id) }]),
);

// a chore task ties claude-code:haiku vs codex:gpt-5.6-luna (both cheap subs) ⇒ discovery picks haiku statically
function mkRepo(): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  saveGraph(repo, validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
  }));
  writeDoctor(repo, DOCTOR5);
  return repo;
}
// warm codex:gpt-5.6-luna for shape chore ⇒ learned would pick it over haiku
const seedWarm = (repo: string) => {
  const dir = join(tickmarkrDir(repo), "runs", "run-20200101-000000");
  mkdirSync(dir, { recursive: true });
  const row = JSON.stringify({
    taskId: "T0", shape: "chore", adapter: "codex", model: "gpt-5.6-luna", channel: "sub",
    attempts: 1, outcome: "done", durationMs: 1000, gateFails: 0, consults: 0,
  });
  writeFileSync(join(dir, "telemetry.jsonl"), Array(6).fill(row).join("\n") + "\n");
};
const withOverlay = (repo: string, yaml: string) => {
  writeFileSync(join(tickmarkrDir(repo), "config.yaml"), yaml);
};

describe("VIS-04 plan-diff preview", () => {
  test("warm + explicit learned:off: preview column still renders (VALIDATION 13-01-11)", async () => {
    // ROUTE-14 flipped the DEFAULT to on (2026-07-11); the off-path preview marker is now pinned via an explicit overlay.
    const repo = mkRepo();
    seedWarm(repo);
    withOverlay(repo, "routing: { learned: off }\n");
    const out = await plan([], repo);
    expect(out).toContain("static would pick claude-code:haiku");
    expect(out).toContain("learned picked codex:gpt-5.6-luna");
    expect(out).toMatch(/learned routing \(preview/);
  });

  test("warm + learned on: deviation line + summary without the preview marker", async () => {
    const repo = mkRepo();
    seedWarm(repo);
    withOverlay(repo, "routing: { learned: on }\n");
    const out = await plan([], repo);
    expect(out).toContain("static would pick claude-code:haiku");
    expect(out).toMatch(/learned routing: \d+\/\d+ tasks deviate/);
    expect(out).not.toMatch(/preview/);
  });

  test("cold (no telemetry): output has no learned markers and equals a sibling no-runs repo", async () => {
    const a = mkRepo();
    const b = mkRepo();
    const outA = await plan([], a);
    const outB = await plan([], b);
    expect(outA).toBe(outB);
    expect(outA).not.toContain("static would pick");
    expect(outA).not.toMatch(/learned routing/);
  });
});

describe("V-10 fleet preference visibility", () => {
  test("V-10a: active deny names excluded channel and reason; header reflects filtered count", async () => {
    const repo = mkRepo();
    withOverlay(repo, "routing:\n  deny:\n    adapters: [pi]\n");
    const out = await plan([], repo);
    expect(out).toContain("pi:zai/glm-5.2");
    expect(out).toMatch(/routing preference active: 1 channel\(s\) excluded/);
    expect(out).toMatch(/deny: pi/);
    expect(out).toMatch(/dry run \(\d+ channels available\)/);
    expect(out).not.toMatch(/dry run \(0 channels available\)/);
  });

  test("V-10b: no preference — exclusion line absent; output unchanged vs baseline prefix", async () => {
    const repo = mkRepo();
    const out = await plan([], repo);
    expect(out).not.toMatch(/routing preference active:/);
  });

  test("V-10d: empty allowlist surfaces all channels as excluded with empty-allowlist reason", async () => {
    const repo = mkRepo();
    withOverlay(repo, "routing:\n  allow:\n    adapters: []\n");
    const out = await plan([], repo);
    expect(out).toMatch(/routing preference active:/);
    expect(out).toContain("(empty allowlist)");
    expect(out).toMatch(/dry run \(0 channels available\)/);
  });
});

// HYG-07(a): servable-filtered channels must be NAMED, not silently dropped. pi advertises two models but
// doctor.json says only one is servable; the other vanishes from discoverChannels — plan must attribute it.
const DOCTOR_PI_SERVABLE = Object.fromEntries(
  ["claude-code", "codex", "cursor-agent", "opencode", "pi", "grok"].map((id) => [
    id,
    id === "pi"
      ? { installed: true, authed: true, models: [], servable: ["zai/glm-5.2"], modelAuth: authedModels(["zai/glm-5.2", "anthropic/claude-opus-4-5"]) }
      : { installed: true, authed: true, models: [], modelAuth: verifiedDefaultModels(id) },
  ]),
);
const PI_TWO_MODELS = `tiers:
  pi:
    vendor: zhipu
    channel: sub
    models:
      zai/glm-5.2: mid
      anthropic/claude-opus-4-5: frontier
`;

function mkServableRepo(): string {
  const repo = mkRepo({ "keep.txt": "x\n" });
  saveGraph(repo, validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
  }));
  writeDoctor(repo, DOCTOR_PI_SERVABLE);
  withOverlay(repo, PI_TWO_MODELS);
  return repo;
}

describe("HYG-07(a) servable attribution in plan", () => {
  test("servable-dropped channel is a named truth in plan output", async () => {
    const repo = mkServableRepo();
    const out = await plan([], repo);
    expect(out).toMatch(/servability: 1 channel\(s\) unservable/);
    expect(out).toContain("pi:anthropic/claude-opus-4-5");
    expect(out).toContain("not in pi's served model list");
  });

  test("installed-but-unauthed adapters are named in plan", async () => {
    const repo = mkRepo({ "keep.txt": "x\n" });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
    }));
    // grok installed but NOT authed — excluded from routing entirely by discoverChannels' first filter
    const health = Object.fromEntries(
      ["claude-code", "codex", "cursor-agent", "opencode", "pi", "grok"].map((id) => [
        id, id === "grok" ? { installed: true, authed: false, models: [] } : { installed: true, authed: true, models: [], modelAuth: verifiedDefaultModels(id) },
      ]),
    );
    writeDoctor(repo, health);
    const out = await plan([], repo);
    expect(out).toContain("installed but unauthed: grok");
    expect(out).toContain("channels excluded from routing");
  });

  test("pin to a servable-filtered channel names the servability reason (map pin)", async () => {
    const repo = mkRepo({ "keep.txt": "x\n" });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
    }));
    writeDoctor(repo, DOCTOR_PI_SERVABLE);
    withOverlay(repo, `routing:
  map:
    chore:
      pin: { via: pi, model: anthropic/claude-opus-4-5 }
${PI_TWO_MODELS}`);
    const out = await plan([], repo);
    // the unroutable line names WHY (unservable), not merely THAT (not available)
    expect(out).toContain("pinned pi:anthropic/claude-opus-4-5 not available");
    expect(out).toContain("unservable");
    expect(out).toContain("not in pi's served model list");
  });

  test("pin to a servable-filtered channel names the reason (task routingHints.pin degradation)", async () => {
    const repo = mkRepo({ "keep.txt": "x\n" });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"], routingHints: { pin: { via: "pi", model: "anthropic/claude-opus-4-5" } } }],
    }));
    writeDoctor(repo, DOCTOR_PI_SERVABLE);
    withOverlay(repo, PI_TWO_MODELS);
    const out = await plan([], repo);
    // task pin degrades (lint), not throws — the lint carries the servability reason
    expect(out).toContain("unservable");
    expect(out).toContain("not in pi's served model list");
  });

  test("no servable field anywhere → no servability line (compat, byte-identical to pre-HYG-07)", async () => {
    const repo = mkRepo();
    const out = await plan([], repo);
    expect(out).not.toMatch(/servability:/);
    expect(out).not.toMatch(/installed but unauthed:/);
  });
});

describe("HYG-07(b) doctor.json staleness in plan", () => {
  test("stale doctor.json (>24h) prints its age and the refresh command", async () => {
    const repo = mkServableRepo();
    // backdate doctor.json 26h — deterministic, no sleeps (utimesSync seconds-resolution epoch)
    const target = (Date.now() / 1000) - 26 * 3600;
    utimesSync(join(tickmarkrDir(repo), "doctor.json"), target, target);
    const out = await plan([], repo);
    expect(out).toMatch(/doctor\.json is \d+h old/);
    expect(out).toContain("run 'tickmarkr doctor' to refresh");
    expect(out).toContain("servability/auth may have changed");
  });

  test("fresh doctor.json prints no staleness line", async () => {
    const repo = mkServableRepo();
    const out = await plan([], repo);
    expect(out).not.toMatch(/doctor\.json is \d+h old/);
    expect(out).not.toMatch(/run 'tickmarkr doctor' to refresh/);
  });

  test("no doctor.json (probeAll fallback) prints no staleness line — fresh by construction", async () => {
    // inject a fake-only adapter list so probeAll stays zero-token; plan() takes adapters like doctor() does.
    const repo = mkRepo({ "keep.txt": "x\n" });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 2, acceptance: ["a"] }],
    }));
    const sdir = join(tickmarkrDir(repo), "script");
    mkdirSync(sdir, { recursive: true });
    const scriptPath = join(sdir, "s.json");
    writeFileSync(scriptPath, "{}");
    const fake = [new FakeAdapter(scriptPath)] as unknown as WorkerAdapter[];
    // no doctor.json written → readDoctor returns null → probeAll(fake) → cached is null → no staleness line
    const out = await plan([], repo, fake);
    expect(out).not.toMatch(/doctor\.json is/);
  });
});

// T2 (2026-07-13): a tiers entry for a model doctor marked unauthed (modelAuth[model].authed===false) must
// advertise no BillingChannel, plan must print one lint per exclusion naming the probe reason and date, and a
// floor satisfiable only by such models must fail plan fail-closed. Only claude-code is installed, so the
// whole fleet's channels come from its seed (fable/opus=frontier, sonnet=mid, haiku=cheap).
const DOCTOR_FABLE_UNAUTHED = {
  "claude-code": {
    installed: true, authed: true, models: ["fable", "opus", "sonnet", "haiku"],
    modelAuth: {
      fable: { authed: false, reason: "HTTP 403: forbidden", probedAt: "2026-07-13T09:12:00Z" },
      opus: { authed: false, reason: "insufficient credit", probedAt: "2026-07-13T09:12:00Z" },
      sonnet: { authed: true, probedAt: "2026-07-13T09:12:00Z" },
      haiku: { authed: true, probedAt: "2026-07-13T09:12:00Z" },
    },
  },
};

function mkT2Repo(shape: string): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  saveGraph(repo, validateGraph({
    version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape, complexity: 2, acceptance: ["a"] }],
  }));
  writeDoctor(repo, DOCTOR_FABLE_UNAUTHED);
  return repo;
}

describe("T2 unauthed-model exclusion in plan (2026-07-13)", () => {
  test("one lint per exclusion, each naming the probe reason and date; unauthed models never routed", async () => {
    // chore floor cheap ⇒ still routable to haiku; the two unauthed frontier models are excluded, not dispatched
    const out = await plan([], mkT2Repo("chore"));
    expect(out).toMatch(/model auth: 2 channel\(s\) unauthed/);
    expect(out).toContain("claude-code:fable (HTTP 403: forbidden — probed 2026-07-13)");
    expect(out).toContain("claude-code:opus (insufficient credit — probed 2026-07-13)");
    // the routed task line names the surviving authed cheap model, never the unauthed frontier ones
    expect(out).toMatch(/T1.*claude-code:haiku/);
    expect(out).not.toMatch(/T1.*fable/);
    expect(out).not.toMatch(/T1.*opus/);
  });

  test("a floor satisfiable only by unauthed models fails plan fail-closed (no dispatch)", async () => {
    // migration floor frontier; BOTH frontier models (fable, opus) are unauthed ⇒ no authed channel meets the floor
    const out = await plan([], mkT2Repo("migration"));
    expect(out).toMatch(/T1.*!!.*no channel at tier>=frontier/);
    expect(out).toContain("unroutable");
    expect(out).toContain("model auth: 2 channel(s) unauthed");
    // never assigned an unauthed model
    expect(out).not.toMatch(/T1.*→.*fable/);
    expect(out).not.toMatch(/T1.*→.*opus/);
  });

  test("byte-identical to pre-T2 when every model is authed (no exclusion line, unchanged routing)", async () => {
    const repo = mkRepo({ "keep.txt": "x\n" });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
    }));
    // same doctor as DOCTOR5 but with an all-authed modelAuth recorded — T2 must not alter the output
    const health = Object.fromEntries(
      ["claude-code", "codex", "cursor-agent", "opencode", "pi"].map((id) => [
        id, { installed: true, authed: true, models: [], modelAuth: verifiedDefaultModels(id) },
      ]),
    );
    writeDoctor(repo, health);
    const out = await plan([], repo);
    expect(out).not.toMatch(/model auth:/);
  });

  test("map pin to an unauthed model names the auth reason in the failure (fail-loud, config pin)", async () => {
    const repo = makeRepo({ "keep.txt": "x\n" });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
    }));
    writeDoctor(repo, DOCTOR_FABLE_UNAUTHED);
    writeFileSync(join(tickmarkrDir(repo), "config.yaml"), `routing:
  map:
    chore:
      pin: { via: claude-code, model: fable }
`);
    const out = await plan([], repo);
    // config map pin to an unauthed model throws RoutingError; plan enriches it with the auth reason + date
    expect(out).toContain("pinned claude-code:fable not available");
    expect(out).toContain("claude-code:fable is unauthed (HTTP 403: forbidden, probed 2026-07-13)");
  });
});

describe("T6 TTY auth-line truncation (2026-07-15)", () => {
  test("TTY: long probe reasons truncate to 60 chars and name .tickmarkr/doctor.json", async () => {
    const longReason = "HTTP 403: forbidden because the subscription does not include throttling access to this model endpoint";
    const health = {
      "claude-code": {
        installed: true, authed: true, models: ["fable", "haiku"],
        modelAuth: {
          ...verifiedDefaultModels("claude-code"),
          fable: { authed: false, reason: longReason, probedAt: "2026-07-13T09:12:00Z" },
          haiku: { authed: true, probedAt: "2026-07-13T09:12:00Z" },
        },
      },
    };
    const repo = makeRepo({ "keep.txt": "x\n" });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
    }));
    writeDoctor(repo, health);
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const noColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    try {
      const out = await plan([], repo);
      expect(out).toMatch(/model auth: 1 channel\(s\) unauthed/);
      expect(out).toContain("claude-code:fable (HTTP 403: forbidden because the subscription does not inclu… — probed 2026-07-13)");
      expect(out).toContain(" — see .tickmarkr/doctor.json");
      expect(out).not.toContain(longReason);
    } finally {
      if (noColor !== undefined) process.env.NO_COLOR = noColor;
      else delete process.env.NO_COLOR;
      if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });

  test("non-TTY: model auth line byte-identical to pre-T6 (golden T2 pins hold)", async () => {
    const out = await plan([], mkT2Repo("chore"));
    expect(out).toMatch(/model auth: 2 channel\(s\) unauthed/);
    expect(out).toContain("claude-code:fable (HTTP 403: forbidden — probed 2026-07-13)");
    expect(out).toContain("claude-code:opus (insufficient credit — probed 2026-07-13)");
    expect(out).not.toContain(" — see .tickmarkr/doctor.json");
  });
});

// v1.26 T1: plan-time collateral-test lint (OBS-12/21) — advisory under its own heading; never routing.
describe("v1.26 scope lints (collateral tests)", () => {
  const OBS21 = {
    "src/adapters/codex.ts": "export const codex = {};\n",
    "tests/adapters/real-adapters.test.ts":
      'import { codex } from "../../src/adapters/codex.js";\nconst cx = codex;\n',
    "docs/only.md": "docs\n",
  };

  test("OBS-21: codex.ts in files[] without real-adapters.test.ts → scope lint names both", async () => {
    const repo = makeRepo(OBS21);
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{
        id: "T2", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"],
        files: ["src/adapters/codex.ts"],
      }],
    }));
    writeDoctor(repo, DOCTOR5);
    const out = await plan([], repo);
    expect(out).toContain("scope lints:");
    expect(out).toMatch(/!\s*T2:/);
    expect(out).toContain("tests/adapters/real-adapters.test.ts");
    // routing lints section is independent — empty graphs with clean doctor should not invent one
    // from scope; if routing lints appear for other reasons, scope still has its own heading.
    const scopeIdx = out.indexOf("scope lints:");
    expect(scopeIdx).toBeGreaterThan(-1);
    expect(out.slice(scopeIdx)).toContain("real-adapters.test.ts");
  });

  test("referencing test already in files[] → no scope lints heading", async () => {
    const repo = makeRepo(OBS21);
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{
        id: "T2", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"],
        files: ["src/adapters/codex.ts", "tests/adapters/real-adapters.test.ts"],
      }],
    }));
    writeDoctor(repo, DOCTOR5);
    const out = await plan([], repo);
    expect(out).not.toContain("scope lints:");
  });

  test("docs-only task → no scope lints", async () => {
    const repo = makeRepo(OBS21);
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{
        id: "T1", title: "t", goal: "g", shape: "docs", complexity: 1, acceptance: ["a"],
        files: ["docs/only.md"],
      }],
    }));
    writeDoctor(repo, DOCTOR5);
    const out = await plan([], repo);
    expect(out).not.toContain("scope lints:");
  });
});

// v1.53 T4: source scope sweep (OBS-76) — advisory, same heading as the collateral-test lints.
describe("v1.53 source scope lints (OBS-76)", () => {
  test("source lints render in plan output under the scope lints heading", async () => {
    const repo = makeRepo({
      "src/config/config.ts": "export function modeFloor(s: string): string { return s; }\n",
      "src/route/router.ts":
        'import { modeFloor } from "../config/config.js";\nexport const floor = modeFloor("implement");\n',
    });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{
        id: "T5", title: "t", goal: "g", shape: "chore", complexity: 2,
        acceptance: ["drop every remaining modeFloor read"],
        files: ["src/config/config.ts"],
      }],
    }));
    writeDoctor(repo, DOCTOR5);
    const out = await plan([], repo);
    const scopeIdx = out.indexOf("scope lints:");
    expect(scopeIdx).toBeGreaterThan(-1);
    expect(out.slice(scopeIdx)).toMatch(/!\s*T5:/);
    expect(out.slice(scopeIdx)).toContain("src/route/router.ts");
  });
});

// v1.54 T3: dead-steering sweep — operator prefer entries that can never match render as routing lints;
// the sweep is advisory plan output only and never alters routing.
describe("v1.54 prefer-entry lints in plan", () => {
  test("prefer lints render under the routing lints heading", async () => {
    const repo = mkRepo();
    withOverlay(repo, `routing:
  map:
    chore: { prefer: [grok] }
review: { prefer: ["grok:grok-4.5"] }
consult: { prefer: ["grok:grok-4.5"] }
`);
    const out = await plan([], repo);
    const idx = out.indexOf("routing lints:");
    expect(idx).toBeGreaterThan(-1);
    const tail = out.slice(idx);
    expect(tail).toContain("routing.map.chore.prefer 'grok' names uninstalled adapter 'grok'");
    expect(tail).toContain("review.prefer 'grok:grok-4.5' names uninstalled adapter 'grok'");
    expect(tail).toContain("consult.prefer 'grok:grok-4.5' names uninstalled adapter 'grok'");
    // advisory: dead entries are named but never steer — T1 still routes to the static pick, nothing unroutable
    expect(out).toMatch(/T1.*claude-code:haiku/);
    expect(out).not.toContain("!!");
  });

  test("no operator prefer entries → no dead-steering lints (seeds stay seedPreferLints' turf)", async () => {
    const out = await plan([], mkRepo());
    expect(out).not.toContain("dead steering");
  });
});

// v1.47 T3: context-window tiers — advisory plan lint when payload estimate exceeds routed model window.
describe("v1.47 context window lints", () => {
  const FAKE_TIERS_WINDOWS = `tiers:
  fake:
    vendor: fake
    channel: sub
    models:
      fake-1: mid
    windows:
      fake-1: 500
routing:
  map:
    chore: { pin: { via: fake, model: fake-1 } }
judge: { adapter: fake, model: fake-1 }
consult: { adapter: fake, model: fake-1 }
`;

  function mkWindowRepo(largeContext: string): { repo: string; fake: FakeAdapter } {
    const repo = makeRepo({ "keep.txt": "x\n", "big-context.txt": largeContext });
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{
        id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"],
        context: ["big-context.txt"],
      }],
    }));
    withOverlay(repo, FAKE_TIERS_WINDOWS);
    const scriptPath = join(tickmarkrDir(repo), "fake.json");
    writeFileSync(scriptPath, JSON.stringify({ tasks: { T1: [{ shell: "true", result: { ok: true, summary: "ok" } }] } }));
    const fake = new FakeAdapter(scriptPath);
    writeDoctor(repo, {
      fake: { installed: true, authed: true, models: ["fake-1", "fake-2"], modelAuth: authedModels(["fake-1", "fake-2"]) },
    });
    return { repo, fake };
  }

  test("plan warns when a task payload estimate exceeds the routed model window", async () => {
    const { repo, fake } = mkWindowRepo("x".repeat(10_000));
    const out = await plan([], repo, [fake] as unknown as WorkerAdapter[]);
    expect(out).toContain("context window lints:");
    expect(out).toMatch(/T1: payload ~\d+ tokens exceeds fake:fake-1 window 500/);
  });

  test("absent windows config renders no column and produces no lint", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const scriptPath = join(tickmarkrDir(repo), "fake.json");
    writeFileSync(scriptPath, JSON.stringify({ tasks: {} }));
    withOverlay(repo, `tiers:
  fake:
    vendor: fake
    channel: sub
    models:
      fake-1: mid
routing:
  map:
    chore: { pin: { via: fake, model: fake-1 } }
judge: { adapter: fake, model: fake-1 }
consult: { adapter: fake, model: fake-1 }
`);
    saveGraph(repo, validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
    }));
    writeDoctor(repo, {
      fake: { installed: true, authed: true, models: ["fake-1"], modelAuth: authedModels(["fake-1"]) },
    });
    const fake = new FakeAdapter(scriptPath);
    const adapters = [fake] as unknown as WorkerAdapter[];
    const docOut = await doctor(["--"], repo, adapters);
    expect(docOut).toMatch(/fake-1\s+mid\s+authed/);
    expect(docOut).not.toMatch(/fake-1\s+mid\s+\d+\s+authed/);
    const planOut = await plan([], repo, adapters);
    expect(planOut).not.toContain("context window lints:");
  });

  test("context window lint is advisory — --route-strict does not refuse dispatch", async () => {
    const { repo, fake } = mkWindowRepo("x".repeat(10_000));
    process.env.TICKMARKR_FAKE_SCRIPT = join(tickmarkrDir(repo), "fake.json");
    try {
      const out = await plan([], repo, [fake] as unknown as WorkerAdapter[]);
      expect(out).toContain("context window lints:");
      const result = await run(["--route-strict"], repo);
      expect(result.out).toMatch(/run run-/);
    } finally {
      delete process.env.TICKMARKR_FAKE_SCRIPT;
    }
  });
});

const DOCTOR_STUB = (id: string) =>
  ({ id, vendor: "x", probe: async () => ({ installed: true, authed: true, models: [] }) }) as unknown as WorkerAdapter;
const ADAPTERS5_STUB = ["claude-code", "codex", "cursor-agent", "opencode", "pi"].map(DOCTOR_STUB);

const stripT2Doctor = (out: string) => out.replace(/^    prefer \S+ \(auto\):.*\n/gm, "");

describe("OBS-30 T2 routing provenance and doctor surface", () => {
  const autoChannels: BillingChannel[] = [
    { adapter: "grok", vendor: "xai", model: "grok-4.5", channel: "sub", tier: "mid" },
    { adapter: "cursor-agent", vendor: "cursor", model: "composer-2.5", channel: "sub", tier: "mid" },
    { adapter: "codex", vendor: "openai", model: "gpt-5.6-terra", channel: "sub", tier: "mid" },
  ];
  const cfg: TickmarkrConfig = structuredClone(DEFAULT_CONFIG);
  const mkTask = (over: Record<string, unknown> = {}) =>
    validateGraph({
      version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
      tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 5, acceptance: ["a"], ...over }],
    }).tasks[0];
  const freshAuto: RoutingPreferContext = {
    doctorFresh: true,
    overlayPreferShapes: new Set(),
    autoPrefer: {
      derivedAt: "2026-07-15T12:00:00.000Z",
      implement: ["grok", "cursor-agent"],
    },
  };

  test("autoPrefer dispatch carries auto-modernized and derivedAt date; seed routing does not", () => {
    const auto = route(mkTask({ shape: "implement" }), cfg, autoChannels, undefined, freshAuto);
    expect(auto.provenance).toContain("auto-modernized");
    expect(auto.provenance).toContain("2026-07-15");
    expect(auto.provenance).toMatch(/via prefer \(auto-modernized 2026-07-15\)/);
    const seed = route(mkTask({ shape: "implement" }), cfg, autoChannels);
    expect(seed.provenance).not.toContain("auto-modernized");
    expect(seed.provenance).toContain("via prefer");
  });

  test("non-TTY doctor stdout for a repo with no doctor.json is byte-identical to pre-T2 (golden pins hold)", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    try {
      const out = await doctor(["--"], repo, ADAPTERS5_STUB);
      const preT2 = stripT2Doctor(out);
      expect(preT2).not.toMatch(/prefer \S+ \(auto\):/);
      expect(out).toMatch(/prefer implement \(auto\):/);
      expect(out).toContain("seed was [cursor-agent, codex]");
      // replay on a sibling repo — stripped body is deterministic (pre-T2 surface)
      const repo2 = makeRepo({ "keep.txt": "x" });
      const out2 = stripT2Doctor(await doctor(["--"], repo2, ADAPTERS5_STUB));
      expect(out2).toBe(preT2);
    } finally {
      if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });
});
