import { readFileSync } from "node:fs";
import { afterAll, expect, test } from "vitest";
import { CODEX_TRUST_DIALOG } from "../../src/adapters/codex.js";
import type { TrustDialog } from "../../src/adapters/types.js";
import { HerdrAppDriver, OWNER_LABEL } from "../../src/drivers/herdr-app.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { FakeHerdrApp, type FakeRule } from "../helpers/fake-herdr-app.js";
import { makeTestTempDir, reapTestTempDirs, setupRepo, T } from "../helpers/tmprepo.js";

// Queue row 340; D-2180 — contract C: the captured Codex folder-trust question keeps its existing once-only Enter, now
// through the REAL HerdrAppDriver over the executable hc fake: the daemon reads the owned terminal's rendered screen
// (`hc read <t> --lines 0`) and keys that same terminal (`hc keys <t> enter`). Frames are verbatim captures.

afterAll(() => reapTestTempDirs());

// codex 0.153.4's trust dialog as a pane read it (tests/fixtures/codex-input-box/trust-dialog.txt, OBS-930 capture).
const CODEX_TRUST = readFileSync(new URL("../fixtures/codex-input-box/trust-dialog.txt", import.meta.url), "utf8");
const CLAUDE_TRUST = JSON.parse(readFileSync(new URL("../fixtures/claude-trust/captures.json", import.meta.url), "utf8")) as { files: Record<string, string> };
// The captured Claude MCP-server modal and the captured `hc keys` answer: an unrelated blocked modal, and a key receipt.
const MCP_MODAL = (JSON.parse(CLAUDE_TRUST.files["not-trust-mcp-dialog/02-read-dialog.json"]!) as { text: string }).text;
const KEYS_OK = CLAUDE_TRUST.files["03-keys-down.json"]!;

async function codexOverApp(runId: string, frame: string) {
  const { repo, fake } = setupRepo([T("T1")], {
    tasks: { T1: [{ shell: "sleep 30", result: { ok: true, summary: "never reached" } }] },
    consult: { action: "human", notes: "operator must unblock" },
  }, "taskTimeoutMinutes: 0.05\n");
  (fake as { trustDialog?: TrustDialog }).trustDialog = CODEX_TRUST_DIALOG;
  const f = new FakeHerdrApp(makeTestTempDir("hcapp-codex-trust-"));
  // Every worker terminal is created live and blocked on `frame`; a key is acknowledged with the captured receipt and
  // changes nothing, so the modal stays painted and a second automatic key would find it again.
  f.update((s) => { s.spawn = { state: "live", reported: true, status: { state: "blocked" }, screen: { text: frame, complete: true, how: "screen" } }; });
  f.rule({ match: ["keys"], output: KEYS_OK } satisfies FakeRule);
  const driver = new HerdrAppDriver({ hcBin: f.hc, appBin: f.app, env: { PATH: process.env.PATH }, runId, pollMs: 50, readinessMs: 1_500, confirmMs: 1_000 });
  await runDaemon(repo, { adapters: [fake], runId, driver });
  const created = f.hcCalls("run").length;
  return { f, created, events: Journal.open(repo, runId).read() };
}

test("captured Codex folder trust is answered once through the owned rendered key path while unrelated blocked modals receive no automatic key", async () => {
  const trust = await codexOverApp("run-app-codex-trust", CODEX_TRUST);
  expect(trust.created).toBeGreaterThan(0);
  const keys = trust.f.hcCalls("keys");
  const addresses = [...new Set(keys.map((k) => k[1]!))];
  // One Enter per owned worker terminal, never a Down, never a second key while the same modal stays painted.
  expect(keys.length).toBeGreaterThan(0);
  expect(keys).toEqual(addresses.map((t) => ["keys", t, "enter", "--json"]));
  // The fake numbers terminals in creation order: t<n> is the n-th `hc run`, whose owner label it was created with.
  const ownerOf = (t: string) => trust.f.hcCalls("run")[Number(t.slice(1)) - 1]!.find((a) => a.startsWith(`${OWNER_LABEL}=`));
  for (const t of addresses) {
    // Its owner is a worker of this run, and the key followed a rendered-screen read of that same terminal.
    expect(ownerOf(t)).toMatch(/^tickmarkr\.owner=tickmarkr:worker:T1:\d+:run-app-codex-trust$/);
    const calls = trust.f.calls().filter((c) => c.tool === "hc" && c.argv[1] === t).map((c) => c.argv);
    const enter = calls.findIndex((a) => a[0] === "keys");
    expect(calls.slice(0, enter).some((a) => a[0] === "read" && a[a.indexOf("--lines") + 1] === "0")).toBe(true);
  }
  const answers = trust.events.filter((e) => e.event === "trust-auto-answer");
  expect(answers).toHaveLength(addresses.length);
  expect(trust.events.filter((e) => e.event === "trust-answer-refused")).toEqual([]);

  // Unrelated blocked modals — the captured MCP-server modal, a tool-permission prompt — get no automatic key at all.
  for (const [i, modal] of [MCP_MODAL, "Approve running: rm -rf / ?\n[y/N]"].entries()) {
    const other = await codexOverApp(`run-app-codex-modal-${i}`, modal);
    expect(other.created, modal).toBeGreaterThan(0);
    expect(other.f.hcCalls("keys"), modal).toEqual([]);
    expect(other.events.filter((e) => e.event === "trust-auto-answer" || e.event === "trust-answer-refused"), modal).toEqual([]);
    expect(other.events.some((e) => e.event === "operator-page"), modal).toBe(true);
  }
}, 180_000);
