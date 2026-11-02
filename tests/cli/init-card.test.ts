import { expect, test } from "vitest";
import type { AuthHealth } from "../../src/adapters/types.js";
import { readinessCard } from "../../src/cli/commands/init-card.js";

const MORE = "more: tickmarkr doctor prints the full capability matrix, model notes and host checks";
const BLOCKING =
  "BLOCKING security warning: codex sandbox escape — stop Codex seats and inspect shared git metadata before dispatch";
const CANNOT_COMMIT =
  "action: codex worker cannot commit in its worktree — use an eligible non-Codex worker";

const h = (over: Partial<AuthHealth> = {}): AuthHealth => ({ installed: true, authed: true, models: [], ...over });

const card = (over: Partial<Parameters<typeof readinessCard>[0]> = {}) => readinessCard({
  adapters: [], health: {}, trust: {}, roles: [], checks: [], ...over,
});

test("the ready row and its counts use adapterHealthy over the given adapters only, so an extra cached health record, an installed kimi without auth or an escaped codex never counts as ready, and an escaped codex without a note shows the blocking warning", () => {
  const rows = card({
    adapters: [{ id: "claude-code" }, { id: "kimi" }, { id: "codex" }],
    health: {
      "claude-code": h({ authed: false }),
      kimi: h({ authed: false, version: "1.5" }),
      codex: h({ codexCommit: "escape" }),
      "cached-extra": h({ version: "9.9.9" }),
    },
  });

  expect(rows).toEqual([
    "ready: claude-code (1 of 3 installed agent CLIs)",
    "not ready: kimi — 1.5",
    `not ready: codex — installed (${BLOCKING})`,
    MORE,
  ]);
});

test("the headline reads the registered-none, installed-none, none-passing and some-passing wordings exactly, each from the adapter list and recorded installed flags", () => {
  expect(card({ health: { "claude-code": h() } })[0]).toBe(
    "not ready: no supported agent CLI is registered — configure an adapter, then run tickmarkr doctor",
  );

  expect(card({
    adapters: [{ id: "pi" }, { id: "grok" }],
    health: { "claude-code": h(), pi: h({ installed: false }), grok: h({ installed: false }) },
  })[0]).toBe("not ready: no supported agent CLI is installed — install one of: pi, grok");

  expect(card({
    adapters: [{ id: "kimi" }, { id: "codex" }, { id: "pi" }],
    health: {
      ghost: h(),
      kimi: h({ authed: false }),
      codex: h({ codexCommit: "escape", note: "already noted" }),
      pi: h({ installed: false }),
    },
  })[0]).toBe("not ready: none of the 2 installed agent CLIs passes the capability check");

  expect(card({
    adapters: [{ id: "pi" }, { id: "kimi" }, { id: "claude-code" }],
    health: { "claude-code": h({ authed: false }), pi: h(), kimi: h({ installed: false }) },
  })[0]).toBe("ready: pi, claude-code (2 of 2 installed agent CLIs)");
});

test("a not-installed adapter with a recorded note gets an unavailable action and one without a note gets none, and a protected codex gets the cannot-commit action while still counting as ready", () => {
  const rows = card({
    adapters: [{ id: "codex" }, { id: "cursor-agent" }, { id: "grok" }, { id: "opencode" }, { id: "qwen" }],
    health: {
      codex: h({ version: "0.144.6", codexCommit: "protected" }),
      "cursor-agent": h({ installed: false, note: "not on PATH" }),
      grok: h({ installed: false }),
      qwen: h({ installed: false, note: "" }),
    },
  });

  expect(rows).toEqual([
    "ready: codex (1 of 1 installed agent CLIs)",
    "action: cursor-agent unavailable — not on PATH",
    CANNOT_COMMIT,
    MORE,
  ]);
});

test("trust gives a run-once action for action-required and a check-failed action for a failed check and nothing for trusted or seeded, and role actions list judge before consult even when consult comes first in the input", () => {
  const rows = card({
    adapters: [{ id: "codex" }, { id: "claude-code" }, { id: "kimi" }, { id: "pi" }, { id: "grok" }],
    health: {
      codex: h({ codexCommit: "allowed" }),
      "claude-code": h(),
      kimi: h(),
      pi: h(),
      grok: h({ installed: false }),
    },
    trust: {
      codex: { status: "action-required", command: "codex login" },
      "claude-code": { status: "trusted" },
      kimi: { status: "check-failed", error: "permission denied" },
      pi: { status: "seeded" },
      grok: { status: "action-required", command: "grok trust" },
    },
    roles: [
      { role: "consult", adapter: "grok", model: "k2" },
      { role: "judge", adapter: "judge-cli", model: "opus" },
      { role: "consult", adapter: "claude-code", model: "sonnet" },
    ],
  });

  expect(rows).toEqual([
    "ready: codex, claude-code, kimi, pi (4 of 4 installed agent CLIs)",
    "action: codex trust — run once: codex login",
    "action: kimi trust — check failed: permission denied; run tickmarkr doctor",
    "action: judge runs on judge-cli:opus, which is not installed — that gate fails closed until you install it or remap judge",
    "action: consult runs on grok:k2, which is not installed — that gate fails closed until you install it or remap consult",
    MORE,
  ]);
});

test("checks render in the declared key order whatever their input order, and the more row is always last", () => {
  const checks = [
    { key: "package-manager" as const, detail: "pm" },
    { key: "folders" as const, detail: "fo" },
    { key: "visibility" as const, detail: "vi" },
    { key: "consult-model" as const, detail: "cm" },
    { key: "judge-model" as const, detail: "jm" },
    { key: "workers" as const, detail: "wk" },
  ];
  const rows = card({
    adapters: [{ id: "claude-code" }],
    health: { "claude-code": h() },
    trust: { "claude-code": { status: "action-required", command: "claude /trust" } },
    roles: [
      { role: "consult", adapter: "missing", model: "m" },
      { role: "judge", adapter: "also-missing", model: "j" },
    ],
    checks,
  });

  expect(rows.slice(-7)).toEqual([
    "action: workers — wk",
    "action: judge-model — jm",
    "action: consult-model — cm",
    "action: visibility — vi",
    "action: folders — fo",
    "action: package-manager — pm",
    MORE,
  ]);
  expect(rows.at(-1)).toBe(MORE);
  expect(rows.filter((row) => row.startsWith("more:"))).toEqual([MORE]);
  expect(rows.indexOf("action: judge runs on also-missing:j, which is not installed — that gate fails closed until you install it or remap judge"))
    .toBeLessThan(rows.indexOf("action: workers — wk"));
  expect(rows.indexOf("action: consult runs on missing:m, which is not installed — that gate fails closed until you install it or remap consult"))
    .toBeLessThan(rows.indexOf("action: workers — wk"));

  expect(card()).toEqual([
    "not ready: no supported agent CLI is registered — configure an adapter, then run tickmarkr doctor",
    MORE,
  ]);
  const reversed = card({
    checks: [{ key: "folders", detail: "later" }, { key: "workers", detail: "sooner" }],
  });
  expect(reversed.at(-1)).toBe(MORE);
  expect(reversed.slice(-3)).toEqual(["action: workers — sooner", "action: folders — later", MORE]);
});

test("a version, note, error or detail holding a newline, a carriage return, a CSI escape, an OSC sequence and a C1 control renders inside one row with no control byte, an empty sanitized version reads installed and an empty sanitized note adds no parentheses", () => {
  const dirty = (lead: string, tail: string) => `${lead}\n\r\u001B[31mMID\u001B]0;osc\u0007\u0085${tail}`;
  const empty = "\u001B[31m\n\r\u001B]0;osc\u0007\u0085";
  const blankNote = "\u001B[0m\n\r \u0085";
  const rows = card({
    adapters: [{ id: "claude-code" }, { id: "kimi" }, { id: "codex" }],
    health: {
      "claude-code": h(),
      kimi: h({ authed: false, version: dirty("ver", "V"), note: blankNote }),
      codex: h({ codexCommit: "escape", version: empty, note: dirty("note", "N") }),
    },
    trust: { "claude-code": { status: "check-failed", error: dirty("err", "E") } },
    checks: [{ key: "workers", detail: dirty("det", "D") }],
  });

  expect(rows).toEqual([
    "ready: claude-code (1 of 3 installed agent CLIs)",
    "not ready: kimi — ver MID V",
    "not ready: codex — installed (note MID N)",
    "action: claude-code trust — check failed: err MID E; run tickmarkr doctor",
    "action: workers — det MID D",
    MORE,
  ]);
  for (const row of rows) expect(row).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
});

test("extra health records outside input.adapters must be ignored, so judge and consult mapped to cached-extra still warn when only that cached record says installed", () => {
  const adapters = [{ id: "claude-code" }];
  const roles = [
    { role: "consult" as const, adapter: "cached-extra", model: "m" },
    { role: "judge" as const, adapter: "cached-extra", model: "m" },
  ];
  const judge = "action: judge runs on cached-extra:m, which is not installed — that gate fails closed until you install it or remap judge";
  const consult = "action: consult runs on cached-extra:m, which is not installed — that gate fails closed until you install it or remap consult";
  const without = card({ adapters, roles });
  const withCache = card({
    adapters,
    roles,
    health: { "cached-extra": { installed: true, authed: true, models: [] } },
  });

  expect(without).toEqual([
    "not ready: no supported agent CLI is installed — install one of: claude-code",
    judge,
    consult,
    MORE,
  ]);
  expect(withCache).toEqual(without);
});

test("role availability follows the installed roster, so cached health for ids outside the adapter list never suppresses a judge or consult warning and never changes any other row", () => {
  const adapters = [{ id: "claude-code" }, { id: "kimi" }, { id: "pi" }];
  const roles = [
    { role: "consult" as const, adapter: "cached-extra", model: "m" },
    { role: "judge" as const, adapter: "ghost", model: "j" },
    { role: "consult" as const, adapter: "other-seat", model: "c" },
    { role: "judge" as const, adapter: "claude-code", model: "opus" },
    { role: "consult" as const, adapter: "kimi", model: "k" },
    { role: "judge" as const, adapter: "pi", model: "p" },
    { role: "consult" as const, adapter: "pi", model: "p2" },
  ];
  const rosterHealth = {
    "claude-code": h(),
    kimi: h({ authed: false }),
    pi: h({ installed: false, note: "absent" }),
  };
  // Closed set: the leaking installed shape, a noted installed row, a noted absent row, and a
  // protected codex record whose id is not on the roster.
  const outside = {
    "cached-extra": h(),
    ghost: h({ note: "cached ghost" }),
    "other-seat": h({ installed: false, note: "not on PATH" }),
    codex: h({ codexCommit: "protected", note: "cached codex" }),
  };
  const without = card({ adapters, health: rosterHealth, roles });
  const withOutside = card({ adapters, health: { ...rosterHealth, ...outside }, roles });

  expect(withOutside).toEqual(without);
  expect(withOutside).toEqual([
    "ready: claude-code (1 of 2 installed agent CLIs)",
    "not ready: kimi — installed",
    "action: pi unavailable — absent",
    "action: judge runs on ghost:j, which is not installed — that gate fails closed until you install it or remap judge",
    "action: judge runs on pi:p, which is not installed — that gate fails closed until you install it or remap judge",
    "action: consult runs on cached-extra:m, which is not installed — that gate fails closed until you install it or remap consult",
    "action: consult runs on other-seat:c, which is not installed — that gate fails closed until you install it or remap consult",
    "action: consult runs on pi:p2, which is not installed — that gate fails closed until you install it or remap consult",
    MORE,
  ]);
});
