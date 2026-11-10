// Queue row 392 R6 laws 3 and 6 (D-2187 add.11, add.17 (4), add.21 (3)): behind a confirmed proxy every
// claude-code model is recorded under its true vendor, and an override the Claude CLI does not use never
// carries anthropic models. Every cell runs the real doctor against the fake proxy on 127.0.0.1, then reads
// doctor.json back through discovery and the review gate's picker. The stated-identity turn is the only
// injected seam; the Claude session store is real, under a temporary HOME.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { confirmedClaudeProxy, containDoctorReport, containLines, containReport, type CredentialWithheld, credentialWithheldLine, type GatewayRecord, type GatewaySeam, gatewayNotes, servesFamily } from "../../src/adapters/cliproxy.js";
import { discoverChannels, PREFERENCE_ROLES, readDoctor, writeDoctor } from "../../src/adapters/registry.js";
import { type AuthHealth, type BillingChannel, channelKey, channelsFromConfig, type WorkerAdapter } from "../../src/adapters/types.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { loadConfig, type TickmarkrConfig } from "../../src/config/config.js";
import { pickReviewer } from "../../src/gates/review.js";
import { observedIdentity } from "../../src/route/preference.js";
import { type FakeCliproxy, modelList, refusedUrl, startFakeCliproxy } from "../helpers/fake-cliproxy.js";
import { makeRepo } from "../helpers/tmprepo.js";

const proxies: FakeCliproxy[] = [];
const dirs: string[] = [];
const now = () => new Date("2026-11-08T12:00:00.000Z");
const LISTED = ["claude-opus-5-5", "claude-fable-5-1", "gemini-3-pro", "gpt-6.1-sol", "grok-5"];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "vendor-truth-"));
  dirs.push(d);
  return d;
};
const fake = async (ids = LISTED, status = 200) => {
  const p = await startFakeCliproxy(status === 200 ? modelList(ids) : { status, body: "no" });
  proxies.push(p);
  return p;
};
const fixture = (id: string, vendor: string) => ({
  id, vendor,
  probe: async () => ({ installed: true, authed: true, models: [] }),
  channels: (c: TickmarkrConfig) => channelsFromConfig(id, c),
  headlessCommand: () => "printf OK",
}) as unknown as WorkerAdapter;
const ADAPTERS = [fixture("claude-code", "anthropic"), fixture("codex", "openai"), fixture("gemini-fixture", "google")];

// The QPSS shape: alias fable with a configured override vendor anthropic, beside an exact claude id and an
// unclassified alias; a direct openai and a direct google reviewer.
const OVERLAY = (extra = "") => `tiers:
  claude-code:
    vendor: anthropic
    channel: sub
    models:
      fable: frontier
      opus: frontier
      sonnet: null
      haiku: null
      claude-opus-5-5: frontier
    modelOverrides:
      fable:
        vendor: anthropic
  codex:
    vendor: openai
    channel: sub
    models:
      gpt-6.1-sol: frontier
  gemini-fixture:
    vendor: google
    channel: sub
    models:
      gemini-3-pro: frontier
${extra}`;

let globalDir: string;
let home: string;
beforeEach(() => {
  globalDir = tmp();
  home = tmp();
  vi.stubEnv("HOME", home); // the Claude session store and settings file live under a temporary HOME
  vi.stubEnv("XDG_CONFIG_HOME", tmp());
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const p of proxies.splice(0)) await p.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const repoWith = (yaml: string) => {
  const repo = makeRepo({ "keep.txt": "x" });
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
  return repo;
};
/** The stated-identity turn doctor asks, answering from a table and recording every model it was asked for. */
const turnFrom = (answers: Record<string, string>) => {
  const asked: string[] = [];
  const turn = (_cwd: string, model: string) => {
    asked.push(model);
    return answers[model];
  };
  return Object.assign(turn, { asked });
};
const runDoctor = (repo: string, gateway: GatewaySeam) =>
  doctor(["--"], repo, ADAPTERS, { banner: false, globalDir, gateway: { now, ...gateway } });
const raw = (repo: string) => JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8")) as Record<string, unknown> & { gateway?: GatewayRecord };
const identityOf = (repo: string, model: string) => (raw(repo)["claude-code"] as AuthHealth).modelAuth?.[model]?.identity;
/** Every role's pool as run start reads it: doctor.json through discovery, the Claude CLI's gateway host given
 *  ("" reads as no gateway at all). */
const pools = (repo: string, health: Record<string, AuthHealth> = readDoctor(repo)!, gateway = "127.0.0.1") => {
  const cfg = loadConfig(repo, { globalDir });
  return Object.fromEntries(PREFERENCE_ROLES.map((role) => [role, discoverChannels(cfg, ADAPTERS, health, role, gateway)])) as Record<string, BillingChannel[]>;
};
const vendors = (channels: BillingChannel[]) => Object.fromEntries(channels.map((c) => [channelKey(c), c.vendor]));
const linesWith = (out: string, needle: string) => out.split("\n").filter((l) => l.includes(needle));
const withoutGateway = (repo: string) => {
  const { gateway: _, ...health } = readDoctor(repo) as Record<string, unknown>;
  return health as Record<string, AuthHealth>;
};
const plantStore = (repo: string, records: unknown[]) => {
  const real = realpathSync(repo);
  const dir = join(home, ".claude", "projects", real.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), records.map((r) => JSON.stringify({ type: "assistant", cwd: real, ...r as object })).join("\n"));
};

test("a configured claude model behind the confirmed proxy keeps vendor anthropic its tier and its routability", async () => {
  const repo = repoWith(OVERLAY());
  const proxy = await fake();
  // claude-opus-5-5 recorded as itself; the aliases stay silent (identity not recorded)
  const turn = turnFrom({ "claude-opus-5-5": "claude-opus-5-5" });
  await runDoctor(repo, { env: { ANTHROPIC_BASE_URL: proxy.url }, identityTurn: turn });
  expect(raw(repo).gateway?.listing.status).toBe("succeeded");
  expect(identityOf(repo, "claude-opus-5-5")).toBe("claude-opus-5-5");

  const behind = pools(repo);
  // "before": the same verdicts read directly, with no gateway at all
  const direct = pools(repo, withoutGateway(repo), "");
  for (const role of PREFERENCE_ROLES) {
    const seat = behind[role].find((c) => channelKey(c) === "claude-code:claude-opus-5-5");
    expect(seat, role).toMatchObject({ vendor: "anthropic", tier: "frontier", identity: "claude-opus-5-5" });
    expect(seat, role).toEqual(direct[role].find((c) => channelKey(c) === "claude-code:claude-opus-5-5"));
    // routable in every role exactly as before
    expect(behind[role].map(channelKey), role).toContain("claude-code:claude-opus-5-5");
  }

  // identity NOT recorded: the classified id's own family, never unknown or provisional
  const silent = repoWith(OVERLAY());
  await runDoctor(silent, { env: { ANTHROPIC_BASE_URL: proxy.url }, identityTurn: turnFrom({}) });
  expect(identityOf(silent, "claude-opus-5-5")).toBeUndefined();
  const silentPools = pools(silent);
  const silentDirect = pools(silent, withoutGateway(silent), "");
  for (const role of PREFERENCE_ROLES) {
    const seat = silentPools[role].find((c) => channelKey(c) === "claude-code:claude-opus-5-5");
    expect(seat, role).toEqual({ adapter: "claude-code", model: "claude-opus-5-5", vendor: "anthropic", channel: "sub", tier: "frontier" });
    expect(seat, role).toEqual(silentDirect[role].find((c) => channelKey(c) === "claude-code:claude-opus-5-5"));
  }
  // the review gate still seats it for an openai author
  const author = { adapter: "codex", model: "gpt-6.1-sol", channel: "sub" as const, tier: "frontier" as const };
  const review = silentPools.review.filter((c) => c.adapter !== "gemini-fixture");
  expect(pickReviewer(author, review)).toMatchObject({ adapter: "claude-code", vendor: "anthropic" });
}, 60_000);

test("behind a confirmed proxy a remapped alias records its served family over the override and doctor prints the alias line", async () => {
  const proxy = await fake();
  const env = { ANTHROPIC_BASE_URL: proxy.url };
  const ALIAS = "ALIAS: claude-code:fable is served as gemini-3-pro (google) by gateway 127.0.0.1 — recorded vendor google, not the configured anthropic";

  // QPSS: the proxy maps fable to a gemini- id; the exact id is served as itself; opus stays silent
  const qpss = repoWith(OVERLAY());
  const turn = turnFrom({ fable: "gemini-3-pro", "claude-opus-5-5": "claude-opus-5-5" });
  const out = await runDoctor(qpss, { env, identityTurn: turn });
  expect([...turn.asked].sort()).toEqual(["claude-opus-5-5", "fable", "opus"]); // every configured claude-code model
  expect(identityOf(qpss, "fable")).toBe("gemini-3-pro");
  expect(linesWith(out, "ALIAS:")).toEqual([`  ! ${ALIAS}`]);
  const qpssPools = pools(qpss);
  for (const role of PREFERENCE_ROLES) {
    expect(vendors(qpssPools[role].filter((c) => c.adapter === "claude-code")), role).toEqual({
      "claude-code:fable": "google", // the identity's family beats the configured override
      "claude-code:opus": "unknown", // unrecorded identity: the base reading behind a gateway
      "claude-code:claude-opus-5-5": "anthropic",
    });
  }
  // A review of a google-recorded fable author never seats a google reviewer. (Whether an anthropic reviewer
  // is seated is the seat resolver's provider axis, which reads the model name and is unchanged here, Q2 held.)
  const author = { adapter: "claude-code", model: "fable", channel: "sub" as const, tier: "frontier" as const };
  const reviewer = pickReviewer(author, qpssPools.review);
  expect(reviewer).not.toBeNull();
  expect(reviewer?.vendor).not.toBe("google");
  expect(pickReviewer(author, qpssPools.review.filter((c) => c.adapter !== "codex"))?.vendor ?? null).not.toBe("google");

  // Store record first: the CLI recorded fable as the requested model and the proxy's gemini- id as served.
  const stored = repoWith(OVERLAY());
  plantStore(stored, [{ timestamp: "2026-11-08T11:00:00.000Z", requestedModel: "fable", message: { model: "gemini-3-pro" } }]);
  const storedTurn = turnFrom({ fable: "claude-fable-5-1" });
  const storedOut = await runDoctor(stored, { env, identityTurn: storedTurn });
  expect(storedTurn.asked).not.toContain("fable");
  expect(identityOf(stored, "fable")).toBe("gemini-3-pro");
  expect(linesWith(storedOut, "ALIAS:")).toEqual([`  ! ${ALIAS}`]);

  // Controls, closed: the alias served as a claude-fable- id, the exact id as itself, an unrecorded and an
  // unclassified identity — anthropic or the base reading, and no ALIAS line.
  const cells: { cell: string; answers: Record<string, string>; identity?: string; fable: string }[] = [
    { cell: "served as a claude-fable- id", answers: { fable: "claude-fable-5-1" }, identity: "claude-fable-5-1", fable: "anthropic" },
    { cell: "identity unrecorded", answers: {}, fable: "anthropic" },
    { cell: "identity unclassified", answers: { fable: "mystery-model-1" }, fable: "anthropic" },
  ];
  for (const c of cells) {
    const repo = repoWith(OVERLAY());
    const cellOut = await runDoctor(repo, { env, identityTurn: turnFrom({ ...c.answers, "claude-opus-5-5": "claude-opus-5-5" }) });
    expect(identityOf(repo, "fable"), c.cell).toBe(c.identity);
    expect(linesWith(cellOut, "ALIAS:"), c.cell).toEqual([]);
    expect(vendors(pools(repo).worker)["claude-code:fable"], c.cell).toBe(c.fable);
    expect(vendors(pools(repo).worker)["claude-code:claude-opus-5-5"], c.cell).toBe("anthropic");
  }

  // The same caches with a failed listing, or with no gateway record: the base override-first vendor and the
  // alias-only identity — the turn is never asked, the exact id is never resolved, no ALIAS line.
  const failed = await fake(LISTED, 404);
  for (const [cell, seam] of [["failed listing", { env: { ANTHROPIC_BASE_URL: failed.url } }], ["no gateway", { env: {} }]] as const) {
    const repo = repoWith(OVERLAY());
    const never = turnFrom({ fable: "gemini-3-pro", "claude-opus-5-5": "claude-opus-5-5" });
    const baseOut = await runDoctor(repo, { ...seam, identityTurn: never });
    expect(never.asked, cell).toEqual([]);
    expect(identityOf(repo, "fable"), cell).toBeUndefined();
    expect(identityOf(repo, "claude-opus-5-5"), cell).toBeUndefined();
    expect(linesWith(baseOut, "ALIAS:"), cell).toEqual([]);
    expect(vendors(pools(repo).worker), cell).toMatchObject({ "claude-code:fable": "anthropic", "claude-code:claude-opus-5-5": "unknown" });
  }
}, 120_000);

const OVERRIDE_LINE = (claudeHost: string) =>
  `gateway override 127.0.0.1 differs from the Claude CLI endpoint ${claudeHost} — anthropic models are not used through it`;

test("a gateway override that differs from the claude endpoint is never used for anthropic models and doctor says why in one line", async () => {
  const proxy = await fake();
  const elsewhere = await refusedUrl(); // the Claude CLI's own gateway: never requested
  const cells: { cell: string; env: Record<string, string>; claudeHost: string }[] = [
    { cell: "the Claude CLI on another gateway", env: { ANTHROPIC_BASE_URL: elsewhere }, claudeHost: "127.0.0.1" },
    { cell: "the Claude CLI on Anthropic's own endpoint", env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, claudeHost: "api.anthropic.com" },
    { cell: "the Claude CLI with no base URL", env: {}, claudeHost: "api.anthropic.com" },
  ];
  for (const c of cells) {
    const repo = repoWith(OVERLAY(`cliproxy:\n  baseUrl: ${proxy.url}\n`));
    const turn = turnFrom({ fable: "gemini-3-pro", "claude-opus-5-5": "claude-opus-5-5" });
    const out = await runDoctor(repo, { env: c.env, identityTurn: turn });
    const record = raw(repo).gateway!;
    expect(record, c.cell).toMatchObject({ source: "config", listing: { status: "succeeded" }, anthropicUnusable: { claudeHost: c.claudeHost } });
    expect(linesWith(out, "gateway override"), c.cell).toEqual([`  ! ${OVERRIDE_LINE(c.claudeHost)}`]);
    // anthropic ids are not served through it; the other families are
    expect(servesFamily(record, "anthropic"), c.cell).toBe(false);
    for (const family of ["google", "openai", "xai"] as const) expect(servesFamily(record, family), c.cell).toBe(true);
    // the claude-code models are not behind it: no widened identity, no vendor truth, no ALIAS line
    expect(confirmedClaudeProxy(record), c.cell).toBeUndefined();
    expect(turn.asked, c.cell).toEqual([]);
    expect(identityOf(repo, "fable"), c.cell).toBeUndefined();
    expect(linesWith(out, "ALIAS:"), c.cell).toEqual([]);
    expect(pools(repo), c.cell).toEqual(pools(repo, withoutGateway(repo)));
  }
}, 60_000);

test("a gateway override equal to the claude endpoint serves every family", async () => {
  const proxy = await fake();
  // equal after API-root normalisation: trailing slash, a final /v1, the scheme's case
  for (const override of [`${proxy.url}/v1/`, `${proxy.url}/`, proxy.url.replace("http://", "HTTP://")]) {
    const repo = repoWith(OVERLAY(`cliproxy:\n  baseUrl: ${override}\n`));
    const turn = turnFrom({ fable: "gemini-3-pro", "claude-opus-5-5": "claude-opus-5-5" });
    const out = await runDoctor(repo, { env: { ANTHROPIC_BASE_URL: proxy.url }, identityTurn: turn });
    const record = raw(repo).gateway!;
    expect(record, override).toMatchObject({ source: "config", listing: { status: "succeeded" } });
    expect(record.anthropicUnusable, override).toBeUndefined();
    expect(linesWith(out, "gateway override"), override).toEqual([]);
    for (const family of ["anthropic", "google", "openai", "xai"] as const) expect(servesFamily(record, family), override).toBe(true);
    // the Claude CLI goes through it, so the proxy is confirmed for claude-code and vendor truth applies
    expect(confirmedClaudeProxy(record), override).toEqual(record);
    expect([...turn.asked].sort(), override).toEqual(["claude-opus-5-5", "fable", "opus"]);
    expect(linesWith(out, "ALIAS:"), override).toEqual([
      "  ! ALIAS: claude-code:fable is served as gemini-3-pro (google) by gateway 127.0.0.1 — recorded vendor google, not the configured anthropic",
    ]);
    expect(vendors(pools(repo).review), override).toMatchObject({ "claude-code:fable": "google", "claude-code:claude-opus-5-5": "anthropic" });
  }
}, 60_000);

test("behind a confirmed proxy an identity carrying the gateway credential is never written to doctor.json or printed", async () => {
  // Queue row 392 R6 (D-2187 add.11): the credential leaves cliproxy.ts only as request headers. The closed table:
  // the identity's source (the session store, the stated-identity turn) × its spelling of the credential.
  const SECRET = "SYNTHETIC_REVIEW_SECRET";
  const proxy = await fake();
  const spellings = [`gemini-${SECRET}`, `gemini-${SECRET.toLowerCase()}`, `claude-fable-${SECRET}`];
  const stderr = vi.mocked(process.stderr.write);
  const leaked = (repo: string, out: string) =>
    [readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8"), out, ...stderr.mock.calls.map((c) => String(c[0]))]
      .some((text) => text.toLowerCase().includes(SECRET.toLowerCase()));
  for (const credential of [SECRET, undefined]) {
    for (const source of ["store", "turn"] as const) {
      for (const identity of spellings) {
        const cell = `${source} ${identity}${credential ? "" : " (control: no credential)"}`;
        stderr.mockClear();
        const repo = repoWith(OVERLAY());
        if (source === "store") plantStore(repo, [{ timestamp: "2026-11-08T11:00:00.000Z", requestedModel: "fable", message: { model: identity } }]);
        const turn = turnFrom(source === "turn" ? { fable: identity } : {});
        const env = { ANTHROPIC_BASE_URL: proxy.url, ...(credential ? { ANTHROPIC_AUTH_TOKEN: credential } : {}) };
        const out = await runDoctor(repo, { env, identityTurn: turn });
        expect(raw(repo).gateway?.listing.status, cell).toBe("succeeded");
        if (credential) {
          expect(leaked(repo, out), cell).toBe(false);
          expect(identityOf(repo, "fable"), cell).toBeUndefined();
          expect(linesWith(out, "ALIAS:"), cell).toEqual([]);
        } else {
          // control, an instance of what the guard catches: the same identity reaches both sinks without it
          expect(identityOf(repo, "fable"), cell).toBe(identity);
          expect(leaked(repo, out), cell).toBe(true);
        }
      }
    }
  }
  // At the ALIAS sink too: an identity already in the health (an earlier report merged in) is never printed.
  const repo = repoWith(OVERLAY());
  await runDoctor(repo, { env: { ANTHROPIC_BASE_URL: proxy.url }, identityTurn: turnFrom({}) });
  const record = raw(repo).gateway!;
  const health = { "claude-code": { installed: true, authed: true, models: ["fable"], modelAuth: { fable: { authed: true, probedAt: now().toISOString(), identity: `gemini-${SECRET}` } } } };
  const cfg = loadConfig(repo, { globalDir });
  expect(gatewayNotes(record, cfg, health, { env: { ANTHROPIC_BASE_URL: proxy.url, ANTHROPIC_AUTH_TOKEN: SECRET } })).toEqual([]);
  expect(gatewayNotes(record, cfg, health, { env: { ANTHROPIC_BASE_URL: proxy.url } })).toEqual([
    `ALIAS: claude-code:fable is served as gemini-${SECRET} (google) by gateway 127.0.0.1 — recorded vendor google, not the configured anthropic`,
  ]);
}, 180_000);

test("behind a confirmed proxy doctor attributes a store record by its requested model and records that identity's family", async () => {
  // Queue row 392 R6 law 3 (D-2187 add.11): a claude-code model named gemini-3-pro, which the proxy served as
  // gpt-6.1-sol at 10:00; at 11:00 it served fable as gemini-3-pro. Neither answer is taken from the other's record.
  const proxy = await fake();
  const repo = repoWith(OVERLAY().replace("      claude-opus-5-5: frontier\n", "      claude-opus-5-5: frontier\n      gemini-3-pro: frontier\n"));
  plantStore(repo, [
    { timestamp: "2026-11-08T10:00:00.000Z", requestedModel: "gemini-3-pro", message: { model: "gpt-6.1-sol" } },
    { timestamp: "2026-11-08T11:00:00.000Z", requestedModel: "fable", message: { model: "gemini-3-pro" } },
  ]);
  const turn = turnFrom({ "gemini-3-pro": "gemini-3-pro", fable: "claude-fable-5-1", "claude-opus-5-5": "claude-opus-5-5" });
  const out = await runDoctor(repo, { env: { ANTHROPIC_BASE_URL: proxy.url }, identityTurn: turn });
  expect(turn.asked).not.toContain("gemini-3-pro");
  expect(turn.asked).not.toContain("fable");
  expect(identityOf(repo, "gemini-3-pro")).toBe("gpt-6.1-sol");
  expect(identityOf(repo, "fable")).toBe("gemini-3-pro");
  expect(linesWith(out, "ALIAS:").sort()).toEqual([
    "  ! ALIAS: claude-code:fable is served as gemini-3-pro (google) by gateway 127.0.0.1 — recorded vendor google, not the configured anthropic",
    "  ! ALIAS: claude-code:gemini-3-pro is served as gpt-6.1-sol (openai) by gateway 127.0.0.1 — recorded vendor openai",
  ]);
  for (const role of PREFERENCE_ROLES) {
    expect(vendors(pools(repo)[role]), role).toMatchObject({ "claude-code:gemini-3-pro": "openai", "claude-code:fable": "google" });
  }
}, 60_000);

test("behind a confirmed proxy doctor never lets an unattributed store record supersede one attributed to the requested model, and asks the turn when none is attributed", async () => {
  // Queue row 392 R6 law 3 (D-2187 add.11), the reviewer's mixed-record case: a claude-code model named gemini-3-pro
  // was served as gpt-6.1-sol (attributed by requestedModel); a NEWER record with no requestedModel states
  // gemini-3-pro, which fable may have produced. Only the attributed record answers: openai, never google.
  const proxy = await fake();
  const env = { ANTHROPIC_BASE_URL: proxy.url };
  const overlay = OVERLAY().replace("      claude-opus-5-5: frontier\n", "      claude-opus-5-5: frontier\n      gemini-3-pro: frontier\n");
  const unattributed = { timestamp: "2026-11-08T11:00:00.000Z", message: { model: "gemini-3-pro" } };
  const mixed = repoWith(overlay);
  plantStore(mixed, [{ timestamp: "2026-11-08T10:00:00.000Z", requestedModel: "gemini-3-pro", message: { model: "gpt-6.1-sol" } }, unattributed]);
  const turn = turnFrom({ "gemini-3-pro": "gemini-3-pro", "claude-opus-5-5": "claude-opus-5-5" });
  const out = await runDoctor(mixed, { env, identityTurn: turn });
  expect(turn.asked).not.toContain("gemini-3-pro");
  expect(identityOf(mixed, "gemini-3-pro")).toBe("gpt-6.1-sol");
  expect(linesWith(out, "ALIAS: claude-code:gemini-3-pro")).toEqual([
    "  ! ALIAS: claude-code:gemini-3-pro is served as gpt-6.1-sol (openai) by gateway 127.0.0.1 — recorded vendor openai",
  ]);
  for (const role of PREFERENCE_ROLES) expect(vendors(pools(mixed)[role])["claude-code:gemini-3-pro"], role).toBe("openai");

  // No attributed record: attribution cannot be established from the store, so the stated-identity turn answers.
  const silent = repoWith(overlay);
  plantStore(silent, [unattributed]);
  const silentTurn = turnFrom({ "gemini-3-pro": "gpt-6.1-terra", "claude-opus-5-5": "claude-opus-5-5" });
  await runDoctor(silent, { env, identityTurn: silentTurn });
  expect(silentTurn.asked).toContain("gemini-3-pro");
  expect(identityOf(silent, "gemini-3-pro")).toBe("gpt-6.1-terra");
  expect(vendors(pools(silent).review)["claude-code:gemini-3-pro"]).toBe("openai");
}, 60_000);

// ── Credential containment at the doctor.json sink — queue row 392 R6 (D-2187 add.11) ──
// The FINAL merged report is checked, so an entry a scoped doctor retains from the prior report is checked too.
const SINK_SECRET = "SYNTHETIC_REVIEW_SECRET";
const IDENTITY_NOTE = (model: string) =>
  `  ! credential withheld: the recorded identity of claude-code:${model} carries the gateway credential — not written to doctor.json, it reads as unrecorded`;
/** Whether a text carries the credential once percent-decoded, NFKC-normalized and case-folded. */
const carriesSecret = (text: string) => {
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // a stray % elsewhere: the text as is
  }
  return [text, decoded].some((t) => t.normalize("NFKC").toLowerCase().includes(SINK_SECRET.toLowerCase()));
};
const plantDoctor = (repo: string, claude: object) =>
  writeFileSync(join(repo, ".tickmarkr", "doctor.json"), JSON.stringify({ "claude-code": { installed: true, authed: true, models: [], ...claude } }));
const scopedDoctor = (repo: string, model: string | undefined, env: Record<string, string>) =>
  doctor(model ? ["--model", `claude-code:${model}`] : ["--"], repo, ADAPTERS, { banner: false, globalDir, gateway: { now, env, identityTurn: turnFrom({}) } });
const sinkText = (repo: string, out: string) =>
  [readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8"), out, ...vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0]))];

test("a scoped doctor behind a confirmed proxy never writes the gateway credential from a retained identity or a cached modelIdentities fallback", async () => {
  // The reviewer's two round-2 cases, through the real doctor and the fake proxy: a cached fable modelAuth identity
  // retained by --model claude-code:opus, and a cached modelIdentities.fable fallback kept by --model claude-code:fable.
  const proxy = await fake();
  const verdict = { authed: true, probedAt: now().toISOString() };
  const cases = [
    { cell: "retained modelAuth identity", model: "opus", claude: { modelAuth: { fable: { ...verdict, identity: `gemini-${SINK_SECRET}` }, opus: verdict } } },
    { cell: "cached modelIdentities fallback", model: "fable", claude: { modelAuth: { fable: verdict, opus: verdict }, modelIdentities: { fable: `gemini-${SINK_SECRET}` } } },
  ];
  for (const c of cases) {
    vi.mocked(process.stderr.write).mockClear();
    const repo = repoWith(OVERLAY());
    plantDoctor(repo, c.claude);
    const out = await scopedDoctor(repo, c.model, { ANTHROPIC_BASE_URL: proxy.url, ANTHROPIC_AUTH_TOKEN: SINK_SECRET });
    expect(raw(repo).gateway?.listing.status, c.cell).toBe("succeeded");
    expect(sinkText(repo, out).filter(carriesSecret), c.cell).toEqual([]);
    // the dropped identity reads as unrecorded, so the base vendor reading applies: the configured override
    expect(observedIdentity(readDoctor(repo), "claude-code", "fable"), c.cell).toBeUndefined();
    expect(vendors(pools(repo).review)["claude-code:fable"], c.cell).toBe("anthropic");
    // one typed note, without the value
    expect(linesWith(out, "credential withheld"), c.cell).toEqual([IDENTITY_NOTE("fable")]);
  }
}, 60_000);

test("the gateway credential in any doctor.json entry is dropped at the sink in every spelling and nothing changes without one", async () => {
  // The closed table: the entry carrying it (a modelAuth identity, a modelIdentities fallback, another field of a
  // retained verdict, a key) × its spelling × the scope × the gateway. The spelling and scope axes run through
  // writeDoctor with the sink doctor hands it (every doctor.json write and scoped merge goes through it); the
  // gateway axis runs the real doctor against the fake proxy. With no credential the bytes stay as at the base.
  const verdict = { authed: true, probedAt: now().toISOString() };
  const fullwidth = [...SINK_SECRET].map((ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join("");
  const spellings = [SINK_SECRET, SINK_SECRET.toLowerCase(), SINK_SECRET.replaceAll("_", "%5F"), fullwidth];
  const entries = (s: string) => [
    { entry: "modelAuth identity", claude: { modelAuth: { fable: { ...verdict, identity: `gemini-${s}` } } }, note: IDENTITY_NOTE("fable") },
    { entry: "modelIdentities fallback", claude: { modelIdentities: { fable: `gemini-${s}` } }, note: IDENTITY_NOTE("fable") },
    { entry: "retained verdict field", claude: { modelAuth: { "claude-opus-5-5": { ...verdict, authed: false, reason: `401 for ${s}` } } },
      note: "  ! credential withheld: doctor.json entry claude-code.modelAuth.claude-opus-5-5.reason carries the gateway credential — not written" },
    { entry: "a key", claude: { modelAuth: { [`gemini-${s}`]: verdict } },
      note: "  ! credential withheld: doctor.json entry claude-code.modelAuth.<withheld key> carries the gateway credential — not written" },
  ];
  const fresh = { installed: true, authed: true, models: [], modelAuth: { opus: verdict, fable: verdict } } as AuthHealth;
  for (const spelling of spellings) {
    for (const e of entries(spelling)) {
      for (const scope of ["opus", "fable", undefined]) {
        const cell = `writeDoctor / ${e.entry} / ${spelling} / ${scope ? `--model ${scope}` : "full"}`;
        const repo = repoWith(OVERLAY());
        plantDoctor(repo, e.claude);
        let withheld: CredentialWithheld[] = [];
        writeDoctor(repo, { "claude-code": fresh }, scope ? [{ adapter: "claude-code", model: scope }] : undefined, (report) => {
          const sunk = containReport(report, SINK_SECRET);
          withheld = sunk.withheld;
          return sunk.report;
        });
        expect(carriesSecret(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8")), cell).toBe(false);
        expect(observedIdentity(readDoctor(repo), "claude-code", "fable"), cell).toBeUndefined();
        expect(readDoctor(repo)?.["claude-code"]?.modelAuth?.[scope ?? "opus"], cell).toEqual(verdict); // the clean verdict stays
        // a full write revives nothing, and a selected fable releases its modelAuth history: nothing left to drop
        const carried = scope !== undefined && !(scope === "fable" && e.entry === "modelAuth identity");
        expect(withheld.map((w) => `  ! ${credentialWithheldLine(w)}`), cell).toEqual(carried ? [e.note] : []);
        // control, an instance of what the sink catches: the same write with no credential keeps the planted bytes
        plantDoctor(repo, e.claude);
        writeDoctor(repo, { "claude-code": fresh }, scope ? [{ adapter: "claude-code", model: scope }] : undefined, (report) => containReport(report, undefined).report);
        expect(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8").includes(spelling), cell).toBe(carried);
      }
    }
  }
  // The gateway axis through the real doctor: only a confirmed proxy contains. A failed listing, a differing
  // override and a withheld request target know a credential but confirm no proxy, so without one, or with no
  // gateway at all, the planted modelIdentities fallback stays byte for byte and no note is printed.
  const proxy = await fake();
  const failed = await fake(LISTED, 404);
  const elsewhere = await refusedUrl();
  const override = `cliproxy:\n  baseUrl: ${proxy.url}\n`;
  for (const [cell, env, extra, contained] of [
    ["confirmed proxy", { ANTHROPIC_BASE_URL: proxy.url, ANTHROPIC_AUTH_TOKEN: SINK_SECRET }, "", true],
    ["failed listing", { ANTHROPIC_BASE_URL: failed.url, ANTHROPIC_AUTH_TOKEN: SINK_SECRET }, "", false],
    ["differing override", { ANTHROPIC_BASE_URL: elsewhere, ANTHROPIC_AUTH_TOKEN: SINK_SECRET }, override, false],
    ["withheld request target", { ANTHROPIC_BASE_URL: `${proxy.url}/${SINK_SECRET}`, ANTHROPIC_AUTH_TOKEN: SINK_SECRET }, "", false],
    ["confirmed proxy, no credential", { ANTHROPIC_BASE_URL: proxy.url }, "", false],
    ["no gateway", { ANTHROPIC_AUTH_TOKEN: SINK_SECRET }, "", false],
  ] as const) {
    vi.mocked(process.stderr.write).mockClear();
    const repo = repoWith(OVERLAY(extra));
    plantDoctor(repo, entries(SINK_SECRET)[1].claude);
    const out = await scopedDoctor(repo, "opus", env);
    expect(sinkText(repo, out).filter(carriesSecret).length > 0, cell).toBe(!contained);
    expect(observedIdentity(readDoctor(repo), "claude-code", "fable"), cell).toBe(contained ? undefined : `gemini-${SINK_SECRET}`);
    expect((raw(repo)["claude-code"] as AuthHealth).modelIdentities, cell).toEqual(contained ? {} : { fable: `gemini-${SINK_SECRET}` });
    expect(linesWith(out, "credential withheld"), cell).toEqual(contained ? [IDENTITY_NOTE("fable")] : []);
  }
  // writeDoctor's default sink (verify's write) contains only under the report's own confirmed gateway record.
  const confirmedRecord = { host: "127.0.0.1", baseUrl: proxy.url, source: "env", listing: { status: "succeeded", checkedAt: now().toISOString() }, models: [] };
  const cached = { "claude-code": { installed: true, authed: true, models: [], modelIdentities: { fable: `gemini-${SINK_SECRET}` } } };
  const credentialed = { env: { ANTHROPIC_BASE_URL: proxy.url, ANTHROPIC_AUTH_TOKEN: SINK_SECRET } };
  for (const [cell, gateway] of [
    ["no gateway record", undefined],
    ["a failed listing", { ...confirmedRecord, listing: { status: "failed", failure: "down", reason: "ECONNREFUSED", checkedAt: now().toISOString() } }],
    ["a differing override", { ...confirmedRecord, source: "config", anthropicUnusable: { claudeHost: "api.anthropic.com" } }],
  ] as const) {
    const report = gateway === undefined ? cached : { ...cached, gateway };
    expect(containDoctorReport(report, credentialed), cell).toBe(report);
  }
  // control, an instance of what it catches: the same cache under a confirmed record is contained
  expect(containDoctorReport({ ...cached, gateway: confirmedRecord }, credentialed)).toEqual({
    "claude-code": { installed: true, authed: true, models: [], modelIdentities: {} }, gateway: confirmedRecord,
  });
  // The sinks themselves: no credential, or no hit, is the same report object and the same text — byte-identical.
  const report = { "claude-code": { installed: true, authed: true, models: [], modelIdentities: { fable: "gemini-3-pro" } } };
  expect(containReport(report, undefined).report).toBe(report);
  expect(containReport(report, SINK_SECRET)).toEqual({ report, withheld: [] });
  expect(containReport(report, SINK_SECRET).report).toBe(report);
  expect(containLines("a\nb", SINK_SECRET)).toBe("a\nb");
  expect(containLines(`a\nb ${SINK_SECRET.toLowerCase()}`, SINK_SECRET)).toBe("a\ncredential withheld: 1 doctor line(s) carrying the gateway credential not printed");
}, 120_000);

test("a failed listing with a cached credential-bearing identity leaves doctor.json and every printed line as at the base", async () => {
  // The reviewer's anchored regression (doctor's sink, queue row 392 R6, D-2187 add.11): a failed listing confirms no
  // proxy, so doctor writes and prints exactly what its twin with no credential does — the base, where no sink ran.
  const failed = await fake(LISTED, 404);
  const verdict = { authed: true, probedAt: now().toISOString() };
  const planted = { modelAuth: { fable: { ...verdict, identity: `gemini-${SINK_SECRET}` }, opus: verdict }, modelIdentities: { fable: `gemini-${SINK_SECRET}` } };
  // Timestamps and durations are the clock's, not the sink's.
  const stable = (text: string) => text.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<t>").replace(/\d+(\.\d+)?\s?(ms|s)\b/g, "<d>").replace(/"durationMs": \d+/g, '"durationMs": <d>');
  const runOnce = async (model: string | undefined, credential: boolean) => {
    vi.mocked(process.stderr.write).mockClear();
    const repo = repoWith(OVERLAY());
    plantDoctor(repo, planted);
    const out = await scopedDoctor(repo, model, { ANTHROPIC_BASE_URL: failed.url, ...(credential ? { ANTHROPIC_AUTH_TOKEN: SINK_SECRET } : {}) });
    const [json, ...printed] = sinkText(repo, out);
    return { repo, json, printed: printed.map(stable).join("\n").replaceAll(repo, "<repo>"), out };
  };
  for (const model of ["opus", undefined]) {
    const cell = model ? `--model claude-code:${model}` : "full";
    const withCredential = await runOnce(model, true);
    const twin = await runOnce(model, false);
    expect(raw(withCredential.repo).gateway?.listing.status, cell).toBe("failed");
    expect(stable(withCredential.json), cell).toBe(stable(twin.json));
    expect(withCredential.printed, cell).toBe(twin.printed);
    expect(linesWith(withCredential.out, "credential withheld"), cell).toEqual([]);
    // a scoped run retains the cached identity and fallback byte for byte; a full run drops neither by containment
    if (model) {
      const claude = raw(withCredential.repo)["claude-code"] as AuthHealth;
      expect(claude.modelAuth?.fable, cell).toEqual(planted.modelAuth.fable);
      expect(claude.modelIdentities, cell).toEqual(planted.modelIdentities);
    }
  }
}, 60_000);
