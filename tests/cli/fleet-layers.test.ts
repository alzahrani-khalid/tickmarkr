// v2.6.6 L (T10, D-925/D-926): production Fleet writes each membership edit to the overlay that holds
// it — the repository overlay when it declares or masks the routing.allow/flat-deny family (worker
// leaves follow their own holder), else the user overlay — through ONE reviewed w/y destination.
// Harness: production assembleFleetEditor → the actual Ink editor fed raw key bytes → w → y →
// production commit and atomic writer; temp HOME/XDG/global-dir and real temp git repos; cached fake
// doctor health and injected adapters (no probe, model or network). Frame and state barriers only —
// elapsed time never decides a row; the 600000ms ceilings are cleanup bounds.
import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";
import * as registry from "../../src/adapters/registry.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { channelsFromConfig, type WorkerAdapter } from "../../src/adapters/types.js";
import { assembleFleetEditor, type FleetIO } from "../../src/cli/commands/fleet.js";
import { loadConfigWithMode, type TickmarkrConfig } from "../../src/config/config.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { disallowedBy } from "../../src/route/preference.js";
import type { FleetEditorResult, FleetEditorState, FleetOverlayReview } from "../../src/tui/ink/fleet-app.js";
import { makeRepo } from "../helpers/tmprepo.js";

const CEILING = 600_000;
const FUTURE_LOADS = "the save changes future config loads only — a tickmarkr run already in progress keeps the config it loaded";

const K = { down: "\x1b[B", enter: "\r", escape: "\x1b", space: " ", tab: "\t", ctrlC: "\x03" } as const;
// the reach picker: in · out workers · out all seats
const REACH = { in: K.space + K.enter, workers: K.space + K.down + K.enter, all: K.space + K.down + K.down + K.enter } as const;

const TIERS = [
  "tiers:",
  "  fake:",
  "    vendor: fake",
  "    channel: sub",
  "    models:",
  "      A: mid",
  "      B: mid",
  "  codex:",
  "    vendor: openai",
  "    channel: sub",
  "    models:",
  "      gpt-6-sol: frontier",
  "      gpt-6-luna: mid",
  "",
].join("\n");

// fake:C classified too, so a fixture's extra fake:C is a discovered, routable channel the allow form names
const TIERS_WITH_C = TIERS.replace("      B: mid\n", "      B: mid\n      C: mid\n");

let homeBefore: string | undefined;
beforeEach(() => {
  homeBefore = process.env.HOME;
  // temp HOME and XDG: nothing here can read or write the operator's real user layer
  vi.stubEnv("HOME", mkdtempSync(join(tmpdir(), "tkr-layers-home-")));
  vi.stubEnv("XDG_CONFIG_HOME", mkdtempSync(join(tmpdir(), "tkr-layers-xdg-")));
  vi.stubEnv("FORCE_COLOR", "0");
});
afterEach(() => {
  vi.unstubAllEnvs();
  expect(process.env.HOME).toBe(homeBefore);
});

type Fixture = {
  repo: string;
  globalDir: string;
  userPath: string;
  repoPath: string;
  user: string;
  repoBytes: string;
  adapters: WorkerAdapter[];
  health: ReturnType<typeof registry.readDoctor> & object;
};

// a git repo with the given user and repo overlay bytes and a fresh cached doctor: every listed model
// is served and authed unless `unprobed`, `identities` records a floating alias's resolved id
function fixture(opts: {
  user: string;
  repo: string;
  extra?: Record<string, string[]>;
  unprobed?: Record<string, string[]>;
  identities?: Record<string, Record<string, string>>;
}): Fixture {
  const repo = makeRepo({ "keep.txt": "x", ".tickmarkr/config.yaml": opts.repo });
  // the user layer lives under the temp HOME, so the browser shows it as ~/…
  const globalDir = mkdtempSync(join(process.env.HOME ?? tmpdir(), "tkr-layers-user-"));
  const userPath = join(globalDir, "config.yaml");
  writeFileSync(userPath, opts.user);
  const repoPath = join(repo, ".tickmarkr", "config.yaml");
  const { cfg } = loadConfigWithMode(repo, { globalDir });
  const script = join(repo, "fake.json");
  writeFileSync(script, JSON.stringify({ tasks: {} }));
  const ids = ["fake", "codex"];
  const adapters = ids.map((id) => Object.assign(Object.create(new FakeAdapter(script)) as WorkerAdapter, {
    id,
    vendor: id === "codex" ? "openai" : "fake",
    channels: (candidate: TickmarkrConfig) => channelsFromConfig(id, candidate),
    probe: async () => {
      throw new Error("fleet-layers forbids a live probe");
    },
  }));
  const at = "2026-10-02T00:00:00.000Z";
  const health = Object.fromEntries(ids.map((id) => {
    const tiered = Object.keys(cfg.tiers[id]?.models ?? {}).filter((m) => ["A", "B", "gpt-6-sol", "gpt-6-luna"].includes(m));
    const served = [...tiered, ...(opts.extra?.[id] ?? [])];
    const unprobed = opts.unprobed?.[id] ?? [];
    return [id, {
      installed: true,
      authed: true,
      version: "cached",
      models: [...served, ...unprobed],
      modelsDetectedAt: at,
      modelAuth: Object.fromEntries(served.map((m) => [m, {
        authed: true, probedAt: at, ...(opts.identities?.[id]?.[m] ? { identity: opts.identities[id][m] } : {}),
      }])),
    }];
  }));
  registry.writeDoctor(repo, health);
  const when = new Date(Date.now() - 5 * 60_000);
  utimesSync(join(tickmarkrDir(repo), "doctor.json"), when, when);
  return { repo, globalDir, userPath, repoPath, user: opts.user, repoBytes: opts.repo, adapters, health: registry.readDoctor(repo)! };
}

type TestInput = PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void; ref: () => TestInput; unref: () => TestInput };

// one decoded key per input event (Ink treats a multi-character write as a paste); frames are counted
// so every act waits on the frame its key produced — a frame barrier, never a sleep
function makeIO() {
  const input = new PassThrough() as TestInput;
  input.isTTY = true;
  input.setRawMode = () => {};
  input.ref = () => input;
  input.unref = () => input;
  const frames: string[] = [];
  const output = {
    isTTY: true,
    columns: 160,
    rows: 60,
    write: (chunk: string) => {
      if (chunk && chunk !== "\x1b[?25l" && chunk !== "\x1b[?25h") frames.push(chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
      return true;
    },
    on: () => {},
    off: () => {},
    removeListener: () => {},
  };
  const io: FleetIO = { input, output, debug: true };
  return { input, frames, io };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function session(fx: Fixture) {
  const { input, frames, io } = makeIO();
  const assembled = await assembleFleetEditor(fx.repo, fx.adapters, io, { globalDir: fx.globalDir });
  if ("unavailable" in assembled) throw new Error(assembled.unavailable);
  let review: FleetOverlayReview | undefined;
  let staged: FleetEditorState | undefined;
  const reviewOverlay = assembled.props.reviewOverlay;
  assembled.props.reviewOverlay = (state) => {
    staged = structuredClone(state);
    review = reviewOverlay(state);
    return review;
  };
  const { runFleetInkEditor } = await import("../../src/tui/ink/fleet-app.js");
  const done = runFleetInkEditor(assembled.props);
  const until = async (seen: () => boolean, what: string) => {
    for (let turns = 0; !seen(); turns++) {
      if (turns > 20_000) throw new Error(`frame barrier: never saw ${what} — last frame:\n${frames.at(-1)}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  const last = () => frames.at(-1) ?? "";
  const key = async (bytes: string) => {
    for (const part of bytes.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? []) {
      const count = frames.length;
      input.write(part);
      await until(() => frames.length > count, `a frame after ${JSON.stringify(part)}`);
      await tick();
    }
  };
  await until(() => frames.length > 0, "the first frame");
  const s = {
    fx,
    frames,
    last,
    key,
    get review() {
      return review;
    },
    get staged() {
      return staged;
    },
    commit: assembled.commit,
    async select(model: string) {
      await key(`/${model}`);
      await key(K.enter);
    },
    async clearFilter() {
      await key(K.escape);
    },
    async rail(adapter: string) {
      const at = assembled.props.modelGroups.findIndex((group) => group.adapter === adapter);
      await key(K.tab);
      for (let n = 0; n < 3 + at; n++) await key(K.down);
    },
    async w() {
      await key("w");
      return review;
    },
    // y on a diff ends the session; its result is the editor's, and commit is the production actuator
    async y(): Promise<{ result: FleetEditorResult; outcome: string }> {
      input.write("y");
      const result = await done;
      return { result, outcome: assembled.commit(result) };
    },
    // a key that renders nothing new (no frame to wait on): written, then scheduler turns drained
    async press(bytes: string) {
      input.write(bytes);
      for (let n = 0; n < 5; n++) await tick();
    },
    async quit() {
      input.write(K.ctrlC);
      const result = await done;
      return assembled.commit(result);
    },
    async end(bytes: string) {
      input.write(bytes);
      const result = await done;
      return assembled.commit(result);
    },
  };
  return s;
}

const read = (path: string) => readFileSync(path, "utf8");
const cfgOf = (fx: Fixture, layers: { userOverlayText?: string; repoOverlayText?: string } = {}) =>
  loadConfigWithMode(fx.repo, { globalDir: fx.globalDir, ...layers }).cfg;
const pools = (fx: Fixture, cfg = cfgOf(fx)) => Object.fromEntries(Object.entries(registry.rolePools(cfg, fx.adapters, fx.health))
  .map(([role, channels]) => [role, channels.map((c) => `${c.adapter}:${c.model}`).sort()]));
const noTemp = (fx: Fixture) => [fx.userPath, fx.repoPath]
  .every((path) => !readdirSync(dirname(path)).some((name) => name.startsWith("config.yaml") && name !== "config.yaml"));
// w → a diff review naming `path`; y → the production commit lands exactly the reviewed bytes there and the
// other overlay keeps its fixture bytes
type Session = Awaited<ReturnType<typeof session>>;
const diffAt = async (s: Session, path: string) => {
  const review = await s.w();
  if (review?.kind !== "diff") throw new Error(`expected a diff, got ${JSON.stringify(review)}`);
  expect(review.path).toBe(path);
  return review;
};
const published = async (s: Session, review: Awaited<ReturnType<typeof diffAt>>) => {
  expect((await s.y()).outcome).toBe(`fleet: wrote ${review.path}`);
  expect(read(review.path)).toBe(review.after);
  const [other, bytes] = review.path === s.fx.repoPath ? [s.fx.userPath, s.fx.user] : [s.fx.repoPath, s.fx.repoBytes];
  expect(read(other)).toBe(bytes);
};
const saved = async (s: Session, path: string) => published(s, await diffAt(s, path));

// D-936: the frozen 4497942f writer's bytes for the SAME repository input and edit (C1 row "named pair"
// below), captured as a literal by rendering the production write through that build's writer. Its
// whole-document re-serialization collapses each untouched flow list's two-space note gap (`[codex]  # c`
// → `[codex] # c`); L must equal it, or restore the original bytes, per region — reviewed AND published.
const NAMED_PAIR_REPO = [
  "# repository fleet policy",
  "routing:",
  "  allow:",
  "    adapters: [codex]  # whole adapter admitted",
  "    models:",
  "      - fake:B  # repository restriction",
  "  deny:",
  "    workers:",
  "      adapters: [codex]  # c",
  "",
].join("\n");
const FROZEN_4497942F_NAMED_PAIR = "# repository fleet policy\nrouting:\n  allow:\n    adapters: [codex] # whole adapter admitted\n    models:\n      - fake:A\n  deny:\n    workers:\n      adapters: [codex] # c\n";
// the same oracle on a user-destination save (C1 row "user family"): today's destination, no new churn
const USER_FAMILY = `${TIERS}routing:\n  allow:\n    models: [fake:B, codex:gpt-6-sol, codex:gpt-6-luna]  # user restriction\n`;
// whole fleet in: the allow block goes away (the frozen writer leaves `routing: {}`)
const FROZEN_4497942F_USER_FAMILY = `${TIERS}routing: {}\n`;
const restoreRegions = (frozen: string, original: string) => original.split("\n")
  .filter((line) => /\]  #/.test(line))
  .reduce((bytes, line) => bytes.replace(line.replace("]  #", "] #"), line), frozen);

describe("v2.6.6 L Fleet membership edits reach their effective overlay", () => {
  test("production Fleet writes effective allow and deny edits for two channels to the displayed holding overlay preserving untouched YAML versus a shadowed user save", async () => {
    // C1 closed case table: each member once, no cross-products.

    // named pair (repo): fake:A admitted — allow.models gains a member — and fake:B out · all seats; the
    // untouched flow lists keep their two-space notes where the frozen writer collapsed them
    {
      const fx = fixture({ user: TIERS, repo: NAMED_PAIR_REPO });
      const s = await session(fx);
      await s.select("fake/A");
      await s.key(REACH.in);
      await s.clearFilter();
      await s.select("fake/B");
      await s.key(REACH.all);
      // the review names the displayed holding overlay, the tracked-file and future-load notes
      const review = await diffAt(s, fx.repoPath);
      expect(s.last()).toContain(`review · ${fx.repoPath}`);
      expect(review.notes?.[0]).toContain(`destination: the repository overlay ${fx.repoPath}`);
      expect(review.notes?.[0]).toContain("Fleet never stages or commits it");
      expect(review.notes).toContain(FUTURE_LOADS);
      const { outcome } = await s.y();
      expect(outcome).toBe(`fleet: wrote ${fx.repoPath}`);
      const published = read(fx.repoPath);
      expect(published).toBe(review.after); // reviewed AND published
      expect(published).toContain("      adapters: [codex]  # c\n");
      expect(FROZEN_4497942F_NAMED_PAIR).toContain("      adapters: [codex] # c\n");
      expect(published).toBe(restoreRegions(FROZEN_4497942F_NAMED_PAIR, NAMED_PAIR_REPO));
      expect(read(fx.userPath)).toBe(fx.user);
      expect(noTemp(fx)).toBe(true);
      const after = pools(fx);
      expect(after.worker).toEqual(["fake:A"]); // codex workers stay denied by the untouched list
      expect(after.judge).toEqual(["codex:gpt-6-luna", "codex:gpt-6-sol", "fake:A"]);
      // versus a shadowed user save: the same bytes in the USER layer leave this repository unchanged
      const shadowed = cfgOf(fx, { userOverlayText: `${TIERS}${published}`, repoOverlayText: NAMED_PAIR_REPO }).routing;
      expect(disallowedBy({ adapter: "fake", model: "A" }, shadowed, "judge")).not.toBeNull();
      expect(disallowedBy({ adapter: "fake", model: "B" }, shadowed, "judge")).toBeNull();
    }

    // every flat DENY_SCOPES leaf (repo): the rail clears codex from deny.adapters, the row clears fake:B
    // from deny.models — row and rail each edit only their own entry; both lists are tombstoned so the
    // user layer can never re-exclude behind them
    {
      const repo = "routing:\n  deny:\n    adapters: [codex]  # repo adapter deny\n    models:\n      - fake:B  # repo model deny\n";
      const fx = fixture({ user: `${TIERS}routing:\n  deny:\n    models: [fake:A]\n`, repo });
      const s = await session(fx);
      await s.select("fake/B");
      await s.key(REACH.in);
      await s.clearFilter();
      await s.rail("codex");
      await s.key(REACH.in);
      expect(s.last()).toContain("cleared codex from routing.deny.adapters");
      await saved(s, fx.repoPath);
      expect(parse(read(fx.repoPath)).routing.deny).toEqual({ adapters: null, models: null });
      for (const role of ["worker", "judge", "review", "consult"]) {
        expect(pools(fx)[role], role).toEqual(["codex:gpt-6-luna", "codex:gpt-6-sol", "fake:A", "fake:B"]);
      }
    }

    // worker leaves held by the repo (missing ≠ held: [] declares both): the rail sets codex and the row
    // sets fake:A out · workers; every non-worker pool keeps its members
    {
      const repo = "routing:\n  deny:\n    workers:\n      adapters: []  # owning rail\n      models: []\n";
      const fx = fixture({ user: TIERS, repo });
      const before = pools(fx);
      const s = await session(fx);
      await s.select("fake/A");
      await s.key(REACH.workers);
      await s.clearFilter();
      await s.rail("codex");
      await s.key(REACH.workers);
      await saved(s, fx.repoPath);
      const after = pools(fx);
      expect(after.worker).toEqual(["fake:B"]);
      for (const role of ["judge", "review", "consult"]) expect(after[role], role).toEqual(before[role]);
    }

    // D-926 worker set: the repository masks deny.workers.adapters with null and its allow leaves
    // codex:gpt-6-luna out, so a direct out · workers on the partial rail is refused by name; two presses
    // (out · all, then move to workers) stage it, and neither the review nor the bytes carry the
    // intermediate flat routing.deny.adapters entry
    {
      const repo = "routing:\n  allow:\n    models:\n      - codex:gpt-6-sol\n      - fake:A\n      - fake:B\n  deny:\n    workers:\n      adapters: null\n";
      const fx = fixture({ user: TIERS, repo });
      const before = pools(fx);
      const s = await session(fx);
      await s.rail("codex");
      await s.key(REACH.workers);
      expect(s.last()).toContain("codex stays out-all (partial: not every channel)"); // the direct-refusal witness
      await s.key(REACH.all);
      expect(s.last()).toContain("added codex to routing.deny.adapters");
      await s.key(REACH.workers);
      expect(s.last()).toContain("moved codex to routing.deny.workers.adapters");
      const review = await diffAt(s, fx.repoPath);
      expect(s.staged?.denyAdapters).toEqual([]);
      expect(s.staged?.denyWorkersAdapters).toEqual(["codex"]);
      expect(review.after).not.toMatch(/^ {4}adapters:/m);
      await published(s, review);
      const cfg = cfgOf(fx);
      expect(cfg.routing.deny?.adapters).toBeUndefined();
      expect(cfg.routing.deny?.workers?.adapters).toEqual(["codex"]);
      const after = pools(fx);
      expect(after.worker).toEqual(["fake:A", "fake:B"]);
      for (const role of ["judge", "review", "consult"]) expect(after[role], role).toEqual(before[role]);
      expect(read(fx.userPath)).toBe(fx.user);
    }

    // worker lift while another all-seat reason remains: the rail lifts the repo's workers entry; the
    // allow exclusion of codex:gpt-6-luna is named as what still keeps it out
    {
      const repo = "routing:\n  allow:\n    models: [codex:gpt-6-sol, fake:A, fake:B]\n  deny:\n    workers:\n      adapters: [codex]  # c\n";
      const fx = fixture({ user: TIERS, repo });
      const before = pools(fx);
      const s = await session(fx);
      await s.rail("codex");
      await s.key(REACH.in);
      expect(s.last()).toContain("cleared codex from routing.deny.workers.adapters — still out:");
      expect(s.last()).toContain("routing.allow");
      await saved(s, fx.repoPath);
      expect(read(fx.repoPath)).toContain("    models: [codex:gpt-6-sol, fake:A, fake:B]\n"); // untouched flow list
      const after = pools(fx);
      expect(after.worker).toEqual(["codex:gpt-6-sol", "fake:A", "fake:B"]);
      for (const role of ["judge", "review", "consult"]) expect(after[role], role).toEqual(before[role]);
    }

    // user family (the repository holds no family leaf): the save stays a user save, the repo bytes are
    // exact, and the user bytes equal the frozen writer's for the same input and edit
    {
      const repo = "concurrency: 2  # a project execution preference\n";
      const fx = fixture({ user: USER_FAMILY, repo });
      const s = await session(fx);
      await s.select("fake/A");
      const userLine = USER_FAMILY.split("\n").indexOf("  allow:") + 1;
      expect(s.last()).toContain(`held: routing.allow @ ~/${fx.userPath.split("/").slice(-2).join("/")}:${userLine}`);
      await s.key(REACH.in);
      const review = await diffAt(s, fx.userPath);
      expect(review.notes).toEqual([FUTURE_LOADS]);
      await published(s, review);
      expect(read(fx.userPath)).toBe(restoreRegions(FROZEN_4497942F_USER_FAMILY, fx.user));
      expect(pools(fx).worker).toEqual(["codex:gpt-6-luna", "codex:gpt-6-sol", "fake:A", "fake:B"]);
    }

    // bare repository `allow: {}` (no leaf declared or masked): the user's allow exclusion of fake:A is
    // displayed and saved in the user overlay, which the merge keeps effective under the empty map
    {
      const repo = "routing:\n  allow: {}  # no leaf\n";
      const user = `${TIERS}routing:\n  allow:\n    models: [fake:B, codex:gpt-6-sol]\n`;
      const fx = fixture({ user, repo });
      const s = await session(fx);
      await s.select("fake/A");
      expect(s.last()).toContain(`held: routing.allow @ ~/${fx.userPath.split("/").slice(-2).join("/")}:${user.split("\n").indexOf("  allow:") + 1}`);
      await s.key(REACH.in);
      await saved(s, fx.userPath);
      expect(pools(fx).worker).toEqual(["codex:gpt-6-sol", "fake:A", "fake:B"]);
    }

    // bare `allow: {}` when the edit admits every channel: the user form would be dropped and the empty
    // map alone would fail-close this repository, so the save goes to the repository, which masks it
    {
      const repo = "routing:\n  allow: {}\n";
      const fx = fixture({ user: USER_FAMILY, repo });
      const s = await session(fx);
      await s.select("fake/A");
      await s.key(REACH.in);
      await saved(s, fx.repoPath);
      for (const role of ["worker", "judge", "review", "consult"]) {
        expect(pools(fx)[role], role).toEqual(["codex:gpt-6-luna", "codex:gpt-6-sol", "fake:A", "fake:B"]);
      }
    }

    // bare `allow: {}` with an uncovered user allow member U: admitting fake:A excludes nothing discovered,
    // yet the retained fake:U keeps the user allow form, so the empty map never fail-closes — a user save
    // with exact repository bytes
    {
      const repo = "routing:\n  allow: {}\n";
      const fx = fixture({ user: `${TIERS}routing:\n  allow:\n    adapters: [codex]\n    models: [fake:B, fake:U]  # U awaits a probe\n`, repo });
      const s = await session(fx);
      await s.select("fake/A");
      await s.key(REACH.in);
      await saved(s, fx.userPath);
      expect(read(fx.userPath)).toContain("    models: [fake:U]  # U awaits a probe\n");
      for (const role of ["worker", "judge", "review", "consult"]) {
        expect(pools(fx)[role], role).toEqual(["codex:gpt-6-luna", "codex:gpt-6-sol", "fake:A", "fake:B"]);
      }
    }

    // bare `allow: {}` beneath an inherited fully admitted fleet: fake:A out · all seats stages a flat deny,
    // which the regenerated user allow form carries — the user form stays, so the save is a user save and
    // the repository bytes are exact
    {
      const repo = "routing:\n  allow: {}\n";
      const fx = fixture({ user: `${TIERS}routing:\n  allow:\n    adapters: [fake, codex]\n`, repo });
      const s = await session(fx);
      await s.select("fake/A");
      await s.key(REACH.all);
      await saved(s, fx.userPath);
      for (const role of ["worker", "judge", "review", "consult"]) {
        expect(pools(fx)[role], role).toEqual(["codex:gpt-6-luna", "codex:gpt-6-sol", "fake:B"]);
      }
    }

    // mixed inheritance: the user declares allow, the repository declares deny.models: [] — the family's
    // one destination is the repository, and its allow form admits fake:A over the user's restriction
    {
      const fx = fixture({ user: USER_FAMILY, repo: "routing:\n  deny:\n    models: []\n" });
      const s = await session(fx);
      await s.select("fake/A");
      await s.key(REACH.in);
      await saved(s, fx.repoPath);
      expect(pools(fx).worker).toEqual(["codex:gpt-6-luna", "codex:gpt-6-sol", "fake:A", "fake:B"]);
    }

    // null mask: the repository's `allow: null` holds the family; fake:A out · all seats lands there
    {
      const fx = fixture({ user: USER_FAMILY, repo: "routing:\n  allow: null\n" });
      const s = await session(fx);
      await s.select("fake/A");
      await s.key(REACH.all);
      await saved(s, fx.repoPath);
      expect(pools(fx).judge).toEqual(["codex:gpt-6-luna", "codex:gpt-6-sol", "fake:B"]);
    }

    // prefix mask: the repository's `deny: null` masks the whole flat-deny family; the user's own deny
    // stays masked and fake:A out · all seats lands in the repository
    {
      const fx = fixture({ user: `${TIERS}routing:\n  deny:\n    models: [fake:B]\n`, repo: "routing:\n  deny: null  # masks the user's deny lists\n" });
      const s = await session(fx);
      await s.select("fake/A");
      await s.key(REACH.all);
      await saved(s, fx.repoPath);
      expect(pools(fx).judge).toEqual(["codex:gpt-6-luna", "codex:gpt-6-sol", "fake:B"]);
    }

    // prefix mask under a worker leaf: the repository's `deny: null` is materialized into its deny
    // leaves, each still masked, so the user's all-seat deny of fake:B never comes back — every
    // nonworker pool keeps fake:B while fake:A leaves the worker pool alone
    {
      const fx = fixture({ user: `${TIERS}routing:\n  deny:\n    models: [fake:B]\n`, repo: "routing:\n  deny: null\n" });
      const before = pools(fx);
      const s = await session(fx);
      await s.select("fake/A");
      await s.key(REACH.workers);
      await saved(s, fx.repoPath);
      expect(parse(read(fx.repoPath)).routing.deny).toEqual({ adapters: null, models: null, workers: { adapters: null, models: ["fake:A"] } });
      const after = pools(fx);
      expect(after.worker).toEqual(["codex:gpt-6-luna", "codex:gpt-6-sol", "fake:B"]);
      for (const role of ["judge", "review", "consult"]) expect(after[role], role).toEqual(before[role]);
    }

    // A/B lower-allow resurrection: admitting fake:A puts the whole fleet in; the repository masks the
    // user's allow [fake:A] with null instead of deleting its own and resurrecting the user restriction
    {
      const repo = "routing:\n  allow:\n    adapters: [codex]\n    models: [fake:B]  # repository restriction\n";
      const fx = fixture({ user: `${TIERS}routing:\n  allow:\n    models: [fake:A]\n`, repo });
      const s = await session(fx);
      await s.select("fake/A");
      await s.key(REACH.in);
      await saved(s, fx.repoPath);
      expect(read(fx.repoPath)).toMatch(/^ {2}allow: null/m);
      expect(pools(fx).judge).toEqual(["codex:gpt-6-luna", "codex:gpt-6-sol", "fake:A", "fake:B"]);
    }

    // A/B leaf resurrection: the user admits the whole fake adapter, the repository declares only
    // allow.models; fake:A out · all seats empties the generated adapters leaf, which masks the user's
    // with null instead of inheriting it — fake:A leaves every pool
    {
      const fx = fixture({ user: `${TIERS}routing:\n  allow:\n    adapters: [fake]\n`, repo: "routing:\n  allow:\n    models: [codex:gpt-6-sol]\n" });
      const s = await session(fx);
      await s.select("fake/A");
      await s.key(REACH.all);
      await saved(s, fx.repoPath);
      expect(parse(read(fx.repoPath)).routing.allow).toEqual({ models: ["codex:gpt-6-sol", "fake:B"], adapters: null });
      for (const role of ["worker", "judge", "review", "consult"]) expect(pools(fx)[role], role).toEqual(["codex:gpt-6-sol", "fake:B"]);
    }

    // an uncovered authored allow entry U (a channel this probe never served) keeps its line and comment
    // while the regenerated form admits fake:A beside fake:B
    {
      const repo = "routing:\n  allow:\n    adapters: [codex]\n    models:\n      - fake:B\n      - fake:U  # uncovered authored identity\n";
      const fx = fixture({ user: `${TIERS}routing:\n  allow:\n    models: [fake:A]\n`, repo });
      const s = await session(fx);
      await s.select("fake/A");
      await s.key(REACH.in);
      await saved(s, fx.repoPath);
      expect(read(fx.repoPath)).toContain("      - fake:U  # uncovered authored identity\n");
      expect(pools(fx).worker).toEqual(["codex:gpt-6-luna", "codex:gpt-6-sol", "fake:A", "fake:B"]);
    }

    // D-973 witness: discovered fake:A/B/C, the repository's allow.models aliases a block sequence holding
    // fake:B and the uncovered fake:U; admitting A keeps U admitted, and the anchored list stays as authored
    {
      const repo = "shared: &list\n  - fake:B\n  - fake:U  # U awaits a probe\nrouting:\n  allow:\n    models: *list\n";
      const fx = fixture({ user: TIERS_WITH_C, repo, extra: { fake: ["C"] } });
      const s = await session(fx);
      await s.select("fake/A");
      await s.key(REACH.in);
      await saved(s, fx.repoPath);
      expect(read(fx.repoPath).startsWith("shared: &list\n  - fake:B\n  - fake:U  # U awaits a probe\n")).toBe(true);
      expect([...(cfgOf(fx).routing.allow?.models ?? [])].sort()).toEqual(["fake:A", "fake:B", "fake:U"]);
      for (const role of ["worker", "judge", "review", "consult"]) expect(pools(fx)[role], role).toEqual(["fake:A", "fake:B"]);
    }

    // per-leaf inheritance with an uncovered member: the repository declares only allow.adapters, so the
    // user's allow.models stays effective here — its unserved codex:U admission survives the repository's
    // regenerated form while fake:A leaves every seat
    {
      const fx = fixture({ user: `${TIERS}routing:\n  allow:\n    models: [codex:gpt-6-sol, codex:U]\n`, repo: "routing:\n  allow:\n    adapters: [fake]\n" });
      expect(cfgOf(fx).routing.allow?.models).toEqual(["codex:gpt-6-sol", "codex:U"]);
      const s = await session(fx);
      await s.select("fake/A");
      await s.key(REACH.all);
      await saved(s, fx.repoPath);
      const { allow } = cfgOf(fx).routing;
      expect(allow?.models).toEqual(expect.arrayContaining(["codex:U", "codex:gpt-6-sol", "fake:B"]));
      expect(allow?.models).toHaveLength(3);
      expect(allow?.adapters ?? []).toEqual([]);
      for (const role of ["worker", "judge", "review", "consult"]) expect(pools(fx)[role], role).toEqual(["codex:gpt-6-sol", "fake:B"]);
    }

    // rail out · all over a retained uncovered member, in either allow leaf: the classified fake:U has no
    // probe verdict, so the allow form cannot see it — its authored entry stays, and the staged
    // deny.adapters [fake] stays beside it as the exclusion that covers it, so U never reaches a pool
    // once it is probed
    for (const { leaf, repo, kept } of [
      { leaf: "models", repo: "routing:\n  allow:\n    adapters: [codex]\n    models: [fake:A, fake:U]  # U awaits a probe\n", kept: ["fake:U"] },
      { leaf: "adapters", repo: "routing:\n  allow:\n    adapters: [codex, U]  # U awaits a probe\n    models: [fake:A]\n", kept: ["U", "codex"] },
    ] as const) {
      const user = TIERS.replace("      B: mid\n", "      B: mid\n      U: mid\n");
      const fx = fixture({ user, repo, unprobed: { fake: ["U"] } });
      const s = await session(fx);
      await s.rail("fake");
      await s.key(REACH.all);
      expect(s.last()).toContain("added fake to routing.deny.adapters");
      await saved(s, fx.repoPath);
      const { routing } = cfgOf(fx);
      expect(routing.allow?.[leaf], leaf).toEqual(kept);
      expect(routing.deny?.adapters, leaf).toEqual(["fake"]);
      // production discovery with U's injected probe verdict: fake:U stays out of every pool
      const probed = structuredClone(fx.health);
      probed.fake.modelAuth = { ...probed.fake.modelAuth, U: { authed: true, probedAt: "2026-10-02T00:00:00.000Z" } };
      const after = Object.fromEntries(Object.entries(registry.rolePools(cfgOf(fx), fx.adapters, probed))
        .map(([role, channels]) => [role, channels.map((c) => `${c.adapter}:${c.model}`).sort()]));
      for (const role of ["worker", "judge", "review", "consult"]) {
        expect(after[role], `${leaf} ${role}`).toEqual(["codex:gpt-6-luna", "codex:gpt-6-sol"]);
      }
      expect(disallowedBy({ adapter: "fake", model: "U" }, routing, "worker"), leaf).not.toBeNull();
    }
  }, CEILING);

  test("production Fleet reads an aliased or anchored allow list as the loader does and keeps its uncovered admission while every other consumer of a shared anchor keeps its value, and refuses a merge-key path", async () => {
    // D-973: one table, each member once. Discovered fake:A/B/C and codex; the repository's allow admits
    // fake:B and the uncovered fake:U through the row's YAML shape; the production review admits fake:A
    // (and drops it from deny.models where the row denies it), then the production commit publishes.
    // D-987: Fleet writes through no `<<` merge key — a merge row (removal rows stage fake:A out of every
    // seat instead) is refused, naming the path, the merge shape and the remedy; nothing is published.
    const rows: Array<{ member: string; repo: string; consumers: Record<string, unknown>; deny?: string[]; removeA?: true; refused?: true }> = [
      { member: "direct control", repo: "routing:\n  allow:\n    models: [fake:B, fake:U]\n", consumers: {} },
      {
        member: "leaf alias to a block sequence",
        repo: "shared: &list\n  - fake:B\n  - fake:U\nrouting:\n  allow:\n    models: *list\nmirror: *list\n",
        consumers: { shared: ["fake:B", "fake:U"], mirror: ["fake:B", "fake:U"] },
      },
      {
        member: "leaf alias to a flow sequence",
        repo: "shared: &list [fake:B, fake:U]\nrouting:\n  allow:\n    models: *list\n",
        consumers: { shared: ["fake:B", "fake:U"] },
      },
      {
        member: "alias on the allow parent",
        repo: "shared: &allow\n  models: [fake:B, fake:U]\nrouting:\n  allow: *allow\n",
        consumers: { shared: { models: ["fake:B", "fake:U"] } },
      },
      {
        member: "alias on the routing grandparent",
        repo: "shared: &routing\n  allow:\n    models: [fake:B, fake:U]\nrouting: *routing\n",
        consumers: { shared: { allow: { models: ["fake:B", "fake:U"] } } },
      },
      {
        member: "anchor on the edited leaf with a second consumer",
        repo: "routing:\n  allow:\n    models: &list [fake:B, fake:U]\nmirror: *list\n",
        consumers: { mirror: ["fake:B", "fake:U"] },
      },
      {
        member: "anchor on the edited parent with a second consumer",
        repo: "routing:\n  allow: &allow\n    models: [fake:B, fake:U]\nmirror: *allow\n",
        consumers: { mirror: { models: ["fake:B", "fake:U"] } },
      },
      {
        // fake:A is denied through the alias beside the independent fake:C reason, which stays
        member: "aliased deny.models stale row",
        repo: "shared: &denied [fake:A, fake:C]\nrouting:\n  allow:\n    models: [fake:B, fake:U]\n  deny:\n    models: *denied\n",
        consumers: { shared: ["fake:A", "fake:C"] },
        deny: ["fake:C"],
      },
      {
        member: "%YAML 1.1 merge",
        repo: "%YAML 1.1\n---\nshared: &base\n  models: [fake:B, fake:U]\nrouting:\n  allow:\n    <<: *base\n",
        consumers: { shared: { models: ["fake:B", "fake:U"] } },
        refused: true,
      },
      {
        // the merge source supplies allow.adapters [fake]; a `<<` beside an edit would keep admitting fake:A
        member: "%YAML 1.1 merge removal",
        repo: "%YAML 1.1\n---\nshared: &base\n  adapters: [fake]\nrouting:\n  allow:\n    <<: *base\nmirror:\n  <<: *base\n",
        consumers: { shared: { adapters: ["fake"] }, mirror: { adapters: ["fake"] } },
        removeA: true,
        refused: true,
      },
      {
        // OOB-2: the merged allow map is anchored and deny.workers consumes it — an edit there would drop
        // the workers deny and admit B/C as workers
        member: "%YAML 1.1 anchored merge shared by deny.workers",
        repo: "%YAML 1.1\n---\nshared: &base\n  adapters: [fake]\nrouting:\n  allow: &seat\n    <<: *base\n  deny:\n    workers: *seat\n",
        consumers: { shared: { adapters: ["fake"] } },
        removeA: true,
        refused: true,
      },
    ];
    for (const { member, repo, consumers, deny, removeA, refused } of rows) {
      const fx = fixture({ user: TIERS_WITH_C, repo, extra: { fake: ["C"] } });
      const before = cfgOf(fx).routing;
      if (removeA) expect(before.allow?.adapters, member).toEqual(["fake"]);
      else expect([...(before.allow?.models ?? [])].sort(), member).toEqual(["fake:B", "fake:U"]);
      const assembled = await assembleFleetEditor(fx.repo, fx.adapters, makeIO().io, { globalDir: fx.globalDir });
      if ("unavailable" in assembled) throw new Error(assembled.unavailable);
      const { props, commit } = assembled;
      const admitA = (list: string[] | undefined) => (list ?? []).filter((entry) => entry !== "fake:A");
      const review = props.reviewOverlay({
        denyAdapters: props.initialDenyAdapters ?? [],
        denyModels: removeA ? [...(props.initialDenyModels ?? []), "fake:A"] : admitA(props.initialDenyModels),
        denyWorkersAdapters: props.initialDenyWorkersAdapters ?? [],
        denyWorkersModels: props.initialDenyWorkersModels ?? [],
        allowOut: removeA ? props.initialAllowOut ?? [] : admitA(props.initialAllowOut),
        classifications: [],
        selectedMode: props.initialMode,
        map: props.initialMap,
        steering: props.initialSteering,
      });
      if (refused) {
        expect(review, member).toEqual({
          kind: "refused",
          reason: "routing.allow takes keys through the YAML merge key `<<: *base` in routing.allow — Fleet does not write through merge keys; inline the merged keys there by hand, then save again",
        });
        expect(read(fx.repoPath), member).toBe(repo);
        expect(read(fx.userPath), member).toBe(fx.user);
        expect(noTemp(fx), member).toBe(true);
        expect(cfgOf(fx).routing, member).toEqual(before);
        continue;
      }
      if (review.kind !== "diff") throw new Error(`${member}: expected a diff, got ${JSON.stringify(review)}`);
      expect(review.path, member).toBe(fx.repoPath);
      expect(commit({ kind: "write", review }), member).toBe(`fleet: wrote ${fx.repoPath}`);
      const published = read(fx.repoPath);
      expect(published, member).toBe(review.after); // reviewed bytes are the published bytes
      expect(read(fx.userPath), member).toBe(fx.user);
      const { allow, deny: denied } = cfgOf(fx).routing;
      expect(allow?.adapters ?? [], member).toEqual([]);
      expect([...(allow?.models ?? [])].sort(), member).toEqual(["fake:A", "fake:B", "fake:U"]);
      expect(denied?.models ?? [], member).toEqual(deny ?? []);
      const written = parse(published) as Record<string, unknown>;
      for (const [key, value] of Object.entries(consumers)) expect(written[key], `${member} ${key}`).toEqual(value);
    }
  }, CEILING);

  test("production Fleet admitting a channel through allow.models keeps an unchanged anchored allow.adapters list and its alias byte-identical, reviewed and published", async () => {
    // T10 owed review F2: the untouched `&whole [codex]` is not rewritten, so `mirror: *whole` keeps its bytes
    const repo = "routing:\n  allow:\n    adapters: &whole [codex]\n    models: [fake:B]\nmirror: *whole\n";
    const fx = fixture({ user: TIERS_WITH_C, repo, extra: { fake: ["C"] } });
    const s = await session(fx);
    await s.select("fake/A");
    await s.key(REACH.in);
    const review = await diffAt(s, fx.repoPath);
    expect(review.after).toBe("routing:\n  allow:\n    adapters: &whole [codex]\n    models: [fake:A, fake:B]\nmirror: *whole\n");
    await published(s, review);
    expect(pools(fx).worker).toContain("fake:A");
  }, CEILING);

  test("production Fleet preserves both overlays on cancel or stale or mixed destination confirmation versus committing the reviewed single overlay", async () => {
    // C2 closed case table: each member once, no cross-products. One repository-destination edit
    // (fake:A admitted over the repository's allow) is reviewed, then the member decides its fate.
    const repo = "routing:\n  allow:\n    adapters: [codex]\n    models: [fake:B]  # repository restriction\n";
    const reviewed = async (fx: Fixture) => {
      const s = await session(fx);
      await s.select("fake/A");
      await s.key(REACH.in);
      const review = await diffAt(s, fx.repoPath);
      expect(s.last()).toContain(`review · ${fx.repoPath}`);
      return { s, review };
    };

    // cancel: n discards; both overlays keep their bytes and no temp publication exists
    {
      const fx = fixture({ user: TIERS, repo });
      const { s } = await reviewed(fx);
      expect(await s.end("n")).toBe("fleet: discarded overlay changes");
      expect(read(fx.userPath)).toBe(fx.user);
      expect(read(fx.repoPath)).toBe(repo);
      expect(noTemp(fx)).toBe(true);
    }

    // confirmed: y commits exactly the reviewed bytes to the one reviewed overlay
    {
      const fx = fixture({ user: TIERS, repo });
      const { s, review } = await reviewed(fx);
      expect((await s.y()).outcome).toBe(`fleet: wrote ${fx.repoPath}`);
      expect(read(fx.repoPath)).toBe(review.after);
      expect(read(fx.userPath)).toBe(fx.user);
      expect(noTemp(fx)).toBe(true);
      expect(pools(fx).worker).toEqual(["codex:gpt-6-luna", "codex:gpt-6-sol", "fake:A", "fake:B"]);
    }

    // stale destination, other layer, holding movement: each overlay is moved after the review; y and
    // the production commit both refuse before any temp file exists, never retargeting, and both
    // post-injection overlays keep their bytes
    const injections: Array<{ member: string; inject: (fx: Fixture) => void; refusal: string }> = [
      {
        member: "stale destination",
        inject: (fx) => writeFileSync(fx.repoPath, `${repo}# foreign edit after review\n`),
        refusal: "stale preview — the repository overlay",
      },
      {
        member: "other layer",
        inject: (fx) => writeFileSync(fx.userPath, `${TIERS}# foreign edit after review\n`),
        refusal: "stale preview — the user overlay",
      },
      {
        member: "holding movement",
        inject: (fx) => writeFileSync(fx.repoPath, "# the family moved away after review\n"),
        refusal: "stale preview — the repository overlay",
      },
    ];
    for (const { member, inject, refusal } of injections) {
      const fx = fixture({ user: TIERS, repo });
      const { s, review } = await reviewed(fx);
      inject(fx);
      const user = read(fx.userPath);
      const repoNow = read(fx.repoPath);
      await s.key("y");
      expect(s.last(), member).toContain(refusal);
      expect(s.commit({ kind: "write", review }), member).toMatch(new RegExp(`^fleet: nothing written — ${refusal}`));
      expect(await s.quit(), member).toBe("fleet: quit without writing");
      expect(read(fx.userPath), member).toBe(user);
      expect(read(fx.repoPath), member).toBe(repoNow);
      expect(noTemp(fx), member).toBe(true);
    }

    // mixed: the repository membership edit plus a user-only effort edit — w refuses before any write and
    // names the edits, both paths and the separate sessions; y has nothing to confirm
    {
      const fx = fixture({ user: TIERS, repo });
      const s = await session(fx);
      await s.select("fake/A");
      await s.key(REACH.in);
      await s.clearFilter();
      await s.select("codex/gpt-6-sol");
      await s.key("e");
      await s.key("w");
      const review = s.review;
      if (review?.kind !== "refused") throw new Error(`expected a refusal, got ${JSON.stringify(review)}`);
      expect(review.reason).toContain(`routing.allow/routing.deny membership → ${fx.repoPath}`);
      expect(review.reason).toContain(`model efforts → ${fx.userPath}`);
      expect(review.reason).toContain("separate sessions");
      expect(s.last()).toContain("w refused — mixed destinations");
      await s.press("y"); // no review is open: nothing to confirm, nothing written
      expect(await s.quit()).toBe("fleet: quit without writing");
      expect(read(fx.userPath)).toBe(fx.user);
      expect(read(fx.repoPath)).toBe(repo);
      expect(noTemp(fx)).toBe(true);
    }
  }, CEILING);

  test("production Fleet names t for an unclassified row then admits its staged classification in the same session versus restoring the old allow exclusion", async () => {
    // C3 closed case table: each member once, no cross-products. The repository's allow form (the
    // pre-D926 shape) leaves every unclassified model out; doctor reports the real codex:gpt-6.1-sol.
    const repo = "routing:\n  allow:\n    models:\n      - codex:gpt-6-sol\n      - fake:A\n      - fake:B\n";
    const sol = { adapter: "codex", model: "gpt-6.1-sol" };
    // the browser row, never the search line above it that echoes the same filter text
    const rowLine = (frame: string, model: string) => frame.split("\n").findLast((line) => line.includes(`/${model}`)) ?? "";

    // admitted, newly classified, real codex:gpt-6.1-sol: t classifies, Space admits in the same
    // session, the row reads in before w, and tier + admission land together in the repository
    {
      const fx = fixture({ user: TIERS, repo, extra: { codex: ["gpt-6.1-sol"] } });
      const s = await session(fx);
      await s.select("codex/gpt-6.1-sol");
      expect(s.last()).toContain("unclassified — Space/Enter classifies (t too)"); // the unclassified row names t
      await s.key("t");
      await s.key(K.down + K.down + K.enter); // frontier
      await s.key("cached benchmark");
      await s.key(K.enter);
      expect(rowLine(s.last(), "gpt-6.1-sol")).toMatch(/frontier\s+out allow/);
      // the row names the overlay path:line holding the scope that excludes it — the file w writes
      expect(s.last()).toContain("routing.allow (not admitted) — held: routing.allow @ .tickmarkr/config.yaml:2");
      await s.key(REACH.in);
      expect(rowLine(s.last(), "gpt-6.1-sol")).toMatch(/frontier\s+in\s/); // preview-in, before w
      expect(s.last()).toContain("space: cleared codex:gpt-6.1-sol from routing.allow");
      expect(s.last()).not.toContain("space: cleared codex:gpt-6.1-sol from routing.allow — still out");
      expect(s.staged).toBeUndefined();
      const review = await diffAt(s, fx.repoPath);
      expect(s.staged?.seededAllowOut).toEqual([{ adapter: "codex", model: "gpt-6.1-sol", displayModel: "gpt-6.1-sol", entry: "codex:gpt-6.1-sol" }]);
      await published(s, review);
      const written = parse(read(fx.repoPath));
      expect(written.tiers.codex.models["gpt-6.1-sol"]).toBe("frontier");
      expect(written.routing.allow.models).toContain("codex:gpt-6.1-sol");
      // versus restoring the old allow exclusion: every seat admits it, beside the sibling it kept
      expect(disallowedBy(sol, cfgOf(fx).routing, "review")).toBeNull();
      for (const role of ["worker", "judge", "review", "consult"]) {
        expect(pools(fx)[role], role).toEqual(expect.arrayContaining(["codex:gpt-6.1-sol", "codex:gpt-6-sol", "fake:A", "fake:B"]));
      }
    }

    // the shared session steps: classify a model (tier index 0 cheap · 1 mid · 2 frontier), optionally admit
    const classify = async (s: Awaited<ReturnType<typeof session>>, row: string, tier = 1) => {
      await s.select(row);
      await s.key("t");
      for (let n = 0; n < tier; n++) await s.key(K.down);
      await s.key(K.enter);
      await s.key("cached benchmark");
      await s.key(K.enter);
    };

    // lone tier: classified, never admitted — the tier stays in the user layer, the repository bytes are
    // exact, and the allow exclusion still holds (a classification is no admission)
    {
      const fx = fixture({ user: TIERS, repo, extra: { codex: ["gpt-6.1-sol"] } });
      const s = await session(fx);
      await classify(s, "codex/gpt-6.1-sol", 2);
      await saved(s, fx.userPath);
      expect(parse(read(fx.userPath)).tiers.codex.models["gpt-6.1-sol"]).toBe("frontier");
      expect(disallowedBy(sol, cfgOf(fx).routing, "review")).not.toBeNull();
      for (const role of ["worker", "judge", "review", "consult"]) expect(pools(fx)[role], role).not.toContain("codex:gpt-6.1-sol");
    }

    // unrelated tier: a second classification never hitchhikes on another model's admission — its tier is
    // user-bound, so the batch is refused by name and both overlays keep their bytes
    {
      const fx = fixture({ user: TIERS, repo, extra: { codex: ["gpt-6.1-sol", "gpt-6.2-nova"] } });
      const s = await session(fx);
      await classify(s, "codex/gpt-6.1-sol", 2);
      await s.key(REACH.in);
      await s.clearFilter();
      await classify(s, "codex/gpt-6.2-nova", 1);
      await s.key("w");
      const review = s.review;
      if (review?.kind !== "refused") throw new Error(`expected a refusal, got ${JSON.stringify(review)}`);
      expect(review.reason).toContain(`routing.allow/routing.deny membership, tiers.codex.models.gpt-6.1-sol → ${fx.repoPath}`);
      expect(review.reason).toContain(`tiers.codex.models.gpt-6.2-nova → ${fx.userPath}`);
      expect(await s.quit()).toBe("fleet: quit without writing");
      expect(read(fx.userPath)).toBe(fx.user);
      expect(read(fx.repoPath)).toBe(repo);
    }

    // shared exclusion: the repository's allow names only codex, so fake is out whole; Space clears C's
    // own seed, yet the adapter entry still excludes it — no admission, so the lone tier is a user save
    // and the repository keeps its bytes (and the exclusion)
    {
      const adapterOnly = "routing:\n  allow:\n    adapters: [codex]  # repository restriction\n";
      const fx = fixture({ user: TIERS, repo: adapterOnly, extra: { fake: ["C"] } });
      const s = await session(fx);
      await classify(s, "fake/C", 1);
      expect(rowLine(s.last(), "C")).toMatch(/mid\s+out allow/);
      await s.key(REACH.in);
      expect(rowLine(s.last(), "C")).toMatch(/mid\s+out allow/);
      await saved(s, fx.userPath);
      const written = parse(read(fx.userPath));
      expect(written.tiers.fake.models.C).toBe("mid");
      expect(written.routing).toBeUndefined();
      expect(disallowedBy({ adapter: "fake", model: "C" }, cfgOf(fx).routing, "judge")).not.toBeNull();
      for (const role of ["worker", "judge", "review", "consult"]) expect(pools(fx)[role], role).not.toContain("fake:C");
    }

    // undo: admitted, then out · all seats — no admission remains, the row reads out, and the review
    // refuses the now-separate tier (user) and membership (repository) edits; nothing is written
    {
      const fx = fixture({ user: TIERS, repo, extra: { codex: ["gpt-6.1-sol"] } });
      const s = await session(fx);
      await classify(s, "codex/gpt-6.1-sol", 2);
      await s.key(REACH.in);
      await s.key(REACH.all);
      expect(rowLine(s.last(), "gpt-6.1-sol")).toMatch(/out all/);
      await s.key("w");
      const review = s.review;
      if (review?.kind !== "refused") throw new Error(`expected a refusal, got ${JSON.stringify(review)}`);
      expect(review.reason).toContain(`tiers.codex.models.gpt-6.1-sol → ${fx.userPath}`);
      expect(await s.quit()).toBe("fleet: quit without writing");
      expect(read(fx.userPath)).toBe(fx.user);
      expect(read(fx.repoPath)).toBe(repo);
      expect(disallowedBy(sol, cfgOf(fx).routing, "review")).not.toBeNull();
    }

    // user family: the allow form lives in the user layer only — tier and admission both land there and
    // the repository stays byte-identical
    {
      const userFamily = `${TIERS}routing:\n  allow:\n    models: [codex:gpt-6-sol, fake:A, fake:B]\n`;
      const fx = fixture({ user: userFamily, repo: "# the repository declares no fleet family\n", extra: { codex: ["gpt-6.1-sol"] } });
      const s = await session(fx);
      await classify(s, "codex/gpt-6.1-sol", 2);
      await s.key(REACH.in);
      await saved(s, fx.userPath);
      const written = parse(read(fx.userPath));
      expect(written.tiers.codex.models["gpt-6.1-sol"]).toBe("frontier");
      expect(written.routing.allow.models).toContain("codex:gpt-6.1-sol");
      expect(pools(fx).review).toEqual(expect.arrayContaining(["codex:gpt-6.1-sol", "codex:gpt-6-sol", "fake:A", "fake:B"]));
    }

    // recorded identity: doctor resolved fake:C to recorded-C; the seed carries Ink's own ownAllow
    // spelling (fake:C), never a guessed canonical id, and the admission reaches every pool
    {
      const fx = fixture({ user: TIERS, repo, extra: { fake: ["C"] }, identities: { fake: { C: "recorded-C" } } });
      const s = await session(fx);
      await classify(s, "fake/C", 1);
      await s.key(REACH.in);
      const review = await diffAt(s, fx.repoPath);
      expect(s.staged?.seededAllowOut).toEqual([{ adapter: "fake", model: "C", displayModel: "C", identity: "recorded-C", entry: "fake:C" }]);
      await published(s, review);
      // A, B and C are every fake channel now, so the regenerated form admits the whole adapter
      expect(parse(read(fx.repoPath)).routing.allow).toEqual({ adapters: ["fake"], models: ["codex:gpt-6-sol"] });
      expect(disallowedBy({ adapter: "fake", model: "C", identity: "recorded-C" }, cfgOf(fx).routing, "judge")).toBeNull();
      expect(pools(fx).worker).toEqual(expect.arrayContaining(["fake:A", "fake:B", "fake:C"]));
    }

    // collapsed variant (T10 owed review F1, fallback D-1016): doctor serves only fake:C-high, shown as the row C
    // that classifies C-high; its display name names no channel, so it is not seeded for same-session admission —
    // the row never reads in, the save is the lone tier, and production serves what it served before
    {
      const fx = fixture({ user: TIERS, repo, extra: { fake: ["C-high"] } });
      const before = pools(fx);
      const s = await session(fx);
      await classify(s, "fake/C", 1);
      expect(rowLine(s.last(), "C")).toMatch(/mid\s+out allow/);
      await s.key(REACH.in);
      expect(rowLine(s.last(), "C")).toMatch(/mid\s+out allow/);
      expect(rowLine(s.last(), "C")).not.toMatch(/mid\s+in\s/);
      const review = await diffAt(s, fx.userPath);
      expect(s.staged?.seededAllowOut).toEqual([]);
      await published(s, review);
      const written = parse(read(fx.userPath));
      expect(written.tiers.fake.models["C-high"]).toBe("mid");
      expect(written.routing).toBeUndefined();
      expect(read(fx.repoPath)).toBe(repo);
      expect(disallowedBy({ adapter: "fake", model: "C-high" }, cfgOf(fx).routing, "judge")).not.toBeNull();
      expect(pools(fx)).toEqual(before);
    }

    // classified over its own deny: fake:C is out by the allow form AND its own deny.models entry; t still
    // seeds its allow entry, so two owning lifts (deny, then allow) admit it and tier + admission land
    // together in the repository
    {
      const denied = `${repo}  deny:\n    models: [fake:C]\n`;
      const fx = fixture({ user: TIERS, repo: denied, extra: { fake: ["C"] } });
      const s = await session(fx);
      await classify(s, "fake/C", 1);
      await s.key(REACH.in);
      expect(s.last()).toContain("space: cleared fake:C from routing.deny.models — still out:");
      await s.key(REACH.in);
      expect(s.last()).toContain("space: cleared fake:C from routing.allow");
      expect(rowLine(s.last(), "C")).toMatch(/mid\s+in\s/);
      const review = await diffAt(s, fx.repoPath);
      expect(s.staged?.seededAllowOut).toEqual([{ adapter: "fake", model: "C", displayModel: "C", entry: "fake:C" }]);
      await published(s, review);
      expect(parse(read(fx.repoPath)).tiers.fake.models.C).toBe("mid");
      expect(disallowedBy({ adapter: "fake", model: "C" }, cfgOf(fx).routing, "judge")).toBeNull();
      for (const role of ["worker", "judge", "review", "consult"]) expect(pools(fx)[role], role).toContain("fake:C");
    }

    // classified over its own deny, no allow restriction: t seeds nothing (the allow form admits it), and
    // Space → in lifts the repository's deny of fake:C — that lift is its own admission, so tier and
    // admission land together in the repository instead of a mixed refusal
    {
      const denyOnly = "routing:\n  deny:\n    models: [fake:C]  # repository deny\n";
      const fx = fixture({ user: TIERS, repo: denyOnly, extra: { fake: ["C"] } });
      const s = await session(fx);
      await classify(s, "fake/C", 1);
      await s.key(REACH.in);
      expect(s.last()).toContain("space: cleared fake:C from routing.deny.models");
      expect(rowLine(s.last(), "C")).toMatch(/mid\s+in\s/);
      const review = await diffAt(s, fx.repoPath);
      expect(s.staged?.seededAllowOut).toEqual([]);
      await published(s, review);
      expect(parse(read(fx.repoPath)).tiers.fake.models.C).toBe("mid");
      expect(disallowedBy({ adapter: "fake", model: "C" }, cfgOf(fx).routing, "judge")).toBeNull();
      for (const role of ["worker", "judge", "review", "consult"]) expect(pools(fx)[role], role).toContain("fake:C");
    }

    // preview-in, unprobed-unroutable: an unprobed model is admitted (membership) and reads in before w,
    // yet no pool routes it until a probe verdict exists, and the save names that step
    {
      const fx = fixture({ user: TIERS, repo, unprobed: { codex: ["gpt-6.1-sol"] } });
      const s = await session(fx);
      await classify(s, "codex/gpt-6.1-sol", 2);
      await s.key(REACH.in);
      expect(rowLine(s.last(), "gpt-6.1-sol")).toMatch(/frontier\s+in\s/);
      await diffAt(s, fx.repoPath);
      const { outcome } = await s.y();
      expect(outcome).toContain(`fleet: wrote ${fx.repoPath}`);
      expect(outcome).toContain("no probe verdict yet (codex:gpt-6.1-sol)");
      expect(disallowedBy(sol, cfgOf(fx).routing, "review")).toBeNull();
      for (const role of ["worker", "judge", "review", "consult"]) expect(pools(fx)[role], role).not.toContain("codex:gpt-6.1-sol");
    }
  }, CEILING);
});
