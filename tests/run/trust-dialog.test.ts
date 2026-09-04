import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeCode, CLAUDE_TRUST_DIALOG } from "../../src/adapters/claude-code.js";
import { codex, CODEX_TRUST_DIALOG } from "../../src/adapters/codex.js";
import { cursorAgent, CURSOR_TRUST_DIALOG } from "../../src/adapters/cursor-agent.js";
import { grok } from "../../src/adapters/grok.js";
import { kimi, KIMI_TRUST_DIALOG } from "../../src/adapters/kimi.js";
import { opencode } from "../../src/adapters/opencode.js";
import { pi } from "../../src/adapters/pi.js";
import type { CliEntry } from "../../src/adapters/catalog.js";
import { allAdapters, getAdapter } from "../../src/adapters/registry.js";
import {
  CLAUDE_TRUST_PANE, CODEX_TRUST_PANE, CURSOR_TRUST_PANE, KIMI_MCP_TRUST_PANE, KIMI_TRUST_PANE,
  matchesTrustDialog, RECORDED_TRUST_PANES, TRUST_DIALOG_BLANK_MESSAGE, TRUST_DIALOG_UNRECORDED_MESSAGE,
  type TrustDialog, type WorkerAdapter,
} from "../../src/adapters/types.js";
import { SubprocessDriver } from "../../src/drivers/subprocess.js";
import type { ExecutorDriver } from "../../src/drivers/types.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

// v1.22 T5 / OBS-19: fingerprint-matched trust dialog gets one Enter; anything else pages.

// v1.89 T1 / OBS-414 round 3: the recorded panes moved into src — they stopped being test fixtures
// when the schema started requiring a fingerprint to be bytes one of them contains. Imported, never
// re-transcribed: a second copy is how a "capture" quietly becomes prose.

// The capture that must be REFUSED: opencode 1.17.15's tool-permission modal, recorded by the round
// that declared it as opencode's trust dialog and named a security defect by the review that killed
// it (.planning/RULING-v189-T1-reauthor.md:11). Enter here selects the highlighted "Allow once" and
// approves an arbitrary tool call — it is not a workspace-trust prompt. Run 305 then declared its
// THIRD line, "enter confirm", which its own refusal list did not name: hence a schema that must be
// positively satisfied rather than a list that must be dodged.
const OPENCODE_PERMISSION_CAPTURE = "Permission required\nAllow once\nenter confirm";

// Every recorded capture, beside the adapter that renders it and the source file that must carry
// the declaration. A test-only fingerprint cannot satisfy the source check.
const RECORDED_CAPTURES = [
  { id: "claude-code", file: "claude-code.ts", dialog: CLAUDE_TRUST_DIALOG, panes: [CLAUDE_TRUST_PANE] },
  { id: "codex", file: "codex.ts", dialog: CODEX_TRUST_DIALOG, panes: [CODEX_TRUST_PANE] },
  { id: "cursor-agent", file: "cursor-agent.ts", dialog: CURSOR_TRUST_DIALOG, panes: [CURSOR_TRUST_PANE] },
  { id: "kimi", file: "kimi.ts", dialog: KIMI_TRUST_DIALOG, panes: [KIMI_TRUST_PANE, KIMI_MCP_TRUST_PANE] },
] as const;

const NO_DIALOG_ADAPTERS = [
  { id: "opencode", file: "opencode.ts", adapter: opencode },
  { id: "pi", file: "pi.ts", adapter: pi },
  { id: "grok", file: "grok.ts", adapter: grok },
] as const;

// Resolved from this file, never the working directory — the recorded kimi capture above contains a
// worktree path, and a cwd-rooted read in the same test would blur which of the two is being read.
const adapterSource = (file: string) => readFileSync(join(import.meta.dirname, "..", "..", "src", "adapters", file), "utf8");

// A stub carrying everything the registry needs to BUILD an adapter and nothing else, so the only
// variable across these constructions is the trust declaration under test.
function nativeEntry(id: string, trustDialog: unknown): CliEntry {
  const adapter = { ...kimi, id, trustDialog } as unknown as WorkerAdapter;
  return { id, binary: id, identity: ".+", vendor: kimi.vendor, drive: { adapter } };
}

// Production construction: the same call `tickmarkr run` makes, with the catalog it is handed.
const buildThroughRegistry = (id: string, trustDialog: unknown): WorkerAdapter =>
  getAdapter(id, allAdapters({ cliEntries: [nativeEntry(id, trustDialog)] }));

// The same declaration through the OTHER production path — the operator's YAML drive contract.
const buildThroughOperatorYaml = (fingerprint: string): WorkerAdapter => getAdapter("yaml-trust-fixture", allAdapters({
  operatorYaml: `
clis:
  - id: yaml-trust-fixture
    binary: yaml-trust-fixture
    identity: ".+"
    vendor: fixture-vendor
    drive:
      headless: "yaml-trust-fixture run --model {model} --prompt-file {promptFile}"
      interactive: null
      trustDialog:
        fingerprint: ${JSON.stringify(fingerprint)}
        key: "Enter"
`,
}));

function fakeScriptPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-trust-"));
  const script = join(dir, "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {} }));
  return script;
}

async function runTrustPane(
  paneText: string,
  trustDialog: TrustDialog | undefined,
  opts: { unblockOnKey: boolean },
): Promise<{ keys: string[]; keyedSlots: string[]; notified: string[]; human: string[] }> {
  const { repo, fake } = setupRepo(
    [T("T1")],
    {
      tasks: {
        T1: [{ shell: opts.unblockOnKey ? "true" : "sleep 30", result: { ok: true, summary: "done after trust" } }],
      },
      // after auto-answer the trailer is enough for worker-result; gates may still fail evidence —
      // consult parks human so the run ends cleanly without burning retries.
      consult: { action: "human", notes: "operator must unblock" },
    },
    `taskTimeoutMinutes: ${opts.unblockOnKey ? 0.2 : 0.05}\n`,
  );
  if (trustDialog) (fake as { trustDialog?: TrustDialog }).trustDialog = trustDialog;

  let phase: "dialog" | "working" = "dialog";
  let nonce = "";
  const keys: string[] = [];
  const keyedSlots: string[] = [];
  const notified: string[] = [];
  const inner = new SubprocessDriver();

  const driver: ExecutorDriver = {
    id: "trust-scripted",
    interactive: true,
    slot: async (cwd, name) => ({ id: "p1", name, cwd }),
    run: async (_s, cmd) => {
      // v1.62 T1: the delivered line is a nonce-free script invocation — the trailer lives in the script
      const p = /^bash '(.+)'$/.exec(cmd)?.[1];
      const m = p ? /TICKMARKR_RESULT_([0-9a-z]+)/i.exec(readFileSync(p, "utf8")) : null;
      if (m) nonce = m[1];
    },
    waitOutput: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return phase === "working";
    },
    waitAgentStatus: async () => true,
    read: async () => {
      if (phase === "dialog") return paneText;
      return `working\nTICKMARKR_RESULT_${nonce} {"ok":true,"summary":"done after trust","deviations":[]}\n`;
    },
    status: async () => (phase === "dialog" ? "blocked" : "working"),
    sendKey: async (s, key) => {
      keys.push(key);
      keyedSlots.push(s.name);
      if (opts.unblockOnKey) phase = "working";
    },
    notify: async (msg) => { notified.push(msg); },
    close: async () => {},
    worktree: inner.worktree.bind(inner),
  };

  const summary = await runDaemon(repo, { adapters: [fake], runId: "run-trust-pane", driver });
  return { keys, keyedSlots, notified, human: summary.human };
}

test("test: under the subprocess driver the journal carries driver-capability-absent once per run for narrator and once for sendKey when a trust-dialog adapter is dispatched and never under a driver that implements them while the worker-launch row carries surface and hostPlatform when the driver describes the slot and every worker-dead and worker-dead-held row names the read source it judged from whereas a daemon that journals the absence per slice or omits the source fails", async () => {
  const run = async (runId: string, complete: boolean) => {
    const { repo, fake } = setupRepo([T("T1")], { tasks: { T1: [{
      shell: `echo ok > ok.txt && ${COMMIT} ok`, result: { ok: true, summary: "ok" },
    }] } });
    (fake as { trustDialog?: TrustDialog }).trustDialog = CURSOR_TRUST_DIALOG;
    const inner = new SubprocessDriver();
    const driver: ExecutorDriver = {
      id: "placement-spy", interactive: false, readSource: "captured-screen",
      slot: inner.slot.bind(inner), run: inner.run.bind(inner), waitOutput: inner.waitOutput.bind(inner),
      waitAgentStatus: inner.waitAgentStatus.bind(inner), status: inner.status.bind(inner),
      read: inner.read.bind(inner), notify: inner.notify.bind(inner), close: inner.close.bind(inner),
      worktree: inner.worktree.bind(inner),
      describe: () => ({ surface: "visible", hostPlatform: "darwin" }),
      ...(complete ? {
        sendKey: async () => {},
        narrator: async (cwd: string) => inner.slot(cwd, `watch-${runId}`),
      } : {}),
    };
    await runDaemon(repo, { adapters: [fake], runId, driver });
    return Journal.open(repo, runId).read();
  };

  const absent = await run("run-capability-absent", false);
  expect(absent.filter((e) => e.event === "driver-capability-absent").map((e) => e.data.capability).sort())
    .toEqual(["narrator", "sendKey"]);
  expect(absent.find((e) => e.event === "worker-launch")?.data)
    .toMatchObject({ surface: "visible", hostPlatform: "darwin" });
  const complete = await run("run-capability-complete", true);
  expect(complete.filter((e) => e.event === "driver-capability-absent")).toEqual([]);

  const { repo, fake } = setupRepo([T("T1", { timeoutMinutes: 0.01 })], {
    tasks: { T1: [{ shell: "sleep 30", result: { ok: true } }] },
  });
  const inner = new SubprocessDriver();
  const driver: ExecutorDriver = {
    id: "source-spy", interactive: true, readSource: "captured-screen",
    slot: inner.slot.bind(inner), run: inner.run.bind(inner), waitOutput: inner.waitOutput.bind(inner),
    waitAgentStatus: inner.waitAgentStatus.bind(inner), status: async () => { throw new Error("status unavailable"); },
    read: inner.read.bind(inner), notify: inner.notify.bind(inner), close: inner.close.bind(inner),
    worktree: inner.worktree.bind(inner),
  };
  await runDaemon(repo, { adapters: [fake], runId: "run-read-source", driver });
  const liveness = Journal.open(repo, "run-read-source").read()
    .filter((e) => e.event === "worker-dead" || e.event === "worker-dead-held");
  expect(liveness.length).toBeGreaterThan(0);
  expect(liveness.every((row) => row.data.source === "captured-screen")).toBe(true);
}, 60_000);

describe("trust-dialog declarations", () => {
  test("a pane showing the claude workspace-trust dialog matches its adapter's declared fingerprint and is answered with its declared key", async () => {
    const dialog = claudeCode.trustDialog;
    // v1.89 T1: the declaration is a union now — a no-dialog value has no key to press.
    expect(dialog.kind).not.toBe("none");
    if (dialog.kind === "none") return;
    expect(matchesTrustDialog(CLAUDE_TRUST_PANE, dialog)).toBe(true);

    const { keys, notified } = await runTrustPane(CLAUDE_TRUST_PANE, dialog, { unblockOnKey: true });
    expect(keys).toEqual([dialog.key]);
    expect(notified.filter((m) => /blocked on a prompt|looks idle/.test(m))).toHaveLength(0);
  }, 30_000);

  test("a pane showing the codex trust dialog matches its adapter's declared fingerprint and is answered with its declared key", async () => {
    const dialog = codex.trustDialog;
    // v1.89 T1: the declaration is a union now — a no-dialog value has no key to press.
    expect(dialog.kind).not.toBe("none");
    if (dialog.kind === "none") return;
    expect(matchesTrustDialog(CODEX_TRUST_PANE, dialog)).toBe(true);

    const { keys, notified } = await runTrustPane(CODEX_TRUST_PANE, dialog, { unblockOnKey: true });
    expect(keys).toEqual([dialog.key]);
    expect(notified.filter((m) => /blocked on a prompt|looks idle/.test(m))).toHaveLength(0);
  }, 30_000);

  test("a blocked pane matching no declared fingerprint is never auto-answered and still surfaces through the existing operator-paging path", async () => {
    const { keys, notified, human } = await runTrustPane(
      "Approve running: rm -rf / ?\n[y/N]",
      CURSOR_TRUST_DIALOG,
      { unblockOnKey: false },
    );
    expect(keys).toEqual([]);
    expect(notified.filter((m) => /blocked on a prompt/.test(m))).toHaveLength(1);
    expect(human).toEqual(["T1"]);
  }, 30_000);

  test("the existing cursor declaration and the once-per-slot answer semantics are unchanged", async () => {
    expect(cursorAgent.trustDialog).toBe(CURSOR_TRUST_DIALOG);
    expect(CURSOR_TRUST_DIALOG).toEqual({ fingerprint: "Workspace Trust Required", key: "Enter" });

    // Keep showing the same matched dialog after Enter. The daemon may page when it remains
    // blocked, but the per-slot latch must prevent a second automatic keypress.
    const { keys, keyedSlots } = await runTrustPane(CURSOR_TRUST_PANE, CURSOR_TRUST_DIALOG, { unblockOnKey: false });
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key === "Enter")).toBe(true);
    expect(new Set(keyedSlots).size).toBe(keyedSlots.length);
  }, 30_000);

  test("each declared fingerprint is specific enough to match only its own trust dialog and never routine agent output", () => {
    const declared = [
      { name: "claude", dialog: claudeCode.trustDialog, pane: CLAUDE_TRUST_PANE },
      { name: "codex", dialog: codex.trustDialog, pane: CODEX_TRUST_PANE },
      { name: "cursor", dialog: cursorAgent.trustDialog, pane: CURSOR_TRUST_PANE },
      // v1.89 T1: kimi's capture joins the closed set — its pane says "Trust this folder?" too, so
      // the cursor glyph in its fingerprint is what keeps the two from answering each other's dialog.
      { name: "kimi", dialog: kimi.trustDialog, pane: KIMI_TRUST_PANE },
    ];
    const routineOutput = [
      "I reviewed workspace trust handling and the tests pass.",
      "Do you trust this implementation? The agent is still working.",
      'TICKMARKR_RESULT_nonce {"ok":true,"summary":"trust dialog support","deviations":[]}',
    ];

    for (const entry of declared) {
      expect(entry.dialog.kind, `${entry.name} declaration`).not.toBe("none");
      if (entry.dialog.kind === "none") continue;
      expect(matchesTrustDialog(entry.pane, entry.dialog), `${entry.name} own dialog`).toBe(true);
      for (const other of declared.filter((candidate) => candidate !== entry)) {
        expect(matchesTrustDialog(other.pane, entry.dialog), `${entry.name} must not match ${other.name}`).toBe(false);
      }
      for (const output of routineOutput) {
        expect(matchesTrustDialog(output, entry.dialog), `${entry.name} routine output`).toBe(false);
      }
    }
  });

  test("auto-answer remains declaration-gated so no dialog outside the declared set is ever answered", async () => {
    // This is byte-for-byte a real declared Claude pane, but the dispatched adapter carries its own
    // shipped declaration (v1.89 T1: the fake's honest {kind:"none"}). Runtime must consult only
    // that adapter, never a process-global fingerprint set.
    const { keys, notified, human } = await runTrustPane(CLAUDE_TRUST_PANE, undefined, { unblockOnKey: false });
    expect(keys).toEqual([]);
    expect(notified.filter((m) => /blocked on a prompt/.test(m))).toHaveLength(1);
    expect(human).toEqual(["T1"]);
  }, 30_000);
});

// v1.89 T1 / OBS-414: the declaration is required, and required-but-honest — a verbatim capture or
// an explicit no-dialog value with a reason. Both prior rounds of this task are pinned here as
// negatives: prose that matches no pane, and a tool-permission prompt that matches too much.
//
// These four sit at FILE TOP LEVEL and carry the criterion as their whole title on purpose: the
// acceptance oracle anchors its filter (`^…$`, gates/acceptance.ts:109) against the runner-visible
// full name, which is every enclosing describe title space-joined with the test title. Wrapped in a
// describe, or prefixed, the name filter matches zero tests and the oracle fails closed — which is
// exactly what it did to round 3. Do not nest them.

test("every adapter the registry can build carries a trust declaration that is either a captured dialog with a fingerprint and key or an explicit no-dialog value with a reason, enumerated from the registry's own adapter list so a transcribed name set cannot stay green when a later adapter omits the field", () => {
  // The enumeration IS the registry's list — nothing here transcribes adapter names, so an
  // adapter added tomorrow is checked by this test on the day it is added.
  const adapters = allAdapters({ fakeScriptPath: fakeScriptPath() });
  expect(adapters.map((adapter) => adapter.id)).toContain("fake");
  expect(adapters.length).toBeGreaterThanOrEqual(8);

  for (const adapter of adapters) {
    const declaration = adapter.trustDialog;
    if (declaration.kind === "none") {
      expect(declaration.reason.trim().length, adapter.id).toBeGreaterThan(0);
    } else {
      expect(declaration.fingerprint.trim().length, adapter.id).toBeGreaterThan(0);
      expect(declaration.key.length, adapter.id).toBeGreaterThan(0);
      // A capture is only a capture if it names the gate it claims to answer AND is bytes some
      // recorded pane actually contains — the corpus, not the word, is the evidence.
      expect(declaration.fingerprint, adapter.id).toMatch(/trust/i);
      expect(RECORDED_TRUST_PANES.some((pane) => pane.includes(declaration.fingerprint)), adapter.id).toBe(true);
    }
  }

  // And the enumeration is load-bearing rather than decorative: a LATER adapter that omits the
  // field cannot reach this list at all, so this test cannot stay green while one exists.
  expect(() => allAdapters({ cliEntries: [nativeEntry("late-adapter", undefined)] }))
    .toThrow(/trust declaration/i);
});

test("the trust-dialog schema used by production registry construction rejects fingerprints \"\" and \" \" with the trust-dialog operator message and accepts the recorded kimi capture, constructing all three through the registry path so a length-only schema or test-local validator cannot pass", () => {
  // `z.string().min(1)` admits " ": the rejection must come from the schema production uses, on
  // the path production builds adapters with — not from an assertion written beside the test.
  for (const blank of ["", " "]) {
    expect(() => buildThroughRegistry("blank-fixture", { fingerprint: blank, key: "Enter" }), JSON.stringify(blank))
      .toThrow(TRUST_DIALOG_BLANK_MESSAGE);
    // The operator's own YAML layer reaches the identical schema through the drive contract.
    expect(() => buildThroughOperatorYaml(blank), `yaml ${JSON.stringify(blank)}`)
      .toThrow(TRUST_DIALOG_BLANK_MESSAGE);
  }

  const built = buildThroughRegistry("kimi-fixture", KIMI_TRUST_DIALOG);
  expect(built.trustDialog).toEqual(KIMI_TRUST_DIALOG);
  expect(matchesTrustDialog(KIMI_TRUST_PANE, built.trustDialog)).toBe(true);
  expect(buildThroughOperatorYaml(KIMI_TRUST_DIALOG.fingerprint).trustDialog).toEqual(KIMI_TRUST_DIALOG);
});

test("split the verbatim three-line OpenCode permission capture \"Permission required\\nAllow once\\nenter confirm\" on newlines and submit the full capture and each of its three non-empty lines through the trust-dialog schema used by production registry construction; all four are rejected, the attempted-line count equals the capture's non-empty-line count, and the recorded kimi folder-trust capture is accepted, so a selected-label subset, transcribed capture or reject-all schema cannot pass", () => {
  // Run 305's refusal list named the selected LABELS ("Permission required", "Allow once") and
  // the combined pane, and never tried the third line — so `{fingerprint: "enter confirm"}` built
  // cleanly and matched this very pane. Every line is submitted here, derived by splitting the
  // capture rather than transcribed, so no line can be quietly left out of the check.
  const lines = OPENCODE_PERMISSION_CAPTURE.split("\n").filter((line) => line.trim().length > 0);
  expect(lines).toEqual(["Permission required", "Allow once", "enter confirm"]);

  const attemptedLines: string[] = [];
  for (const [index, line] of lines.entries()) {
    attemptedLines.push(line);
    expect(() => buildThroughRegistry(`permission-line-${index}`, { fingerprint: line, key: "Enter" }), line).toThrow();
    expect(() => buildThroughOperatorYaml(line), `yaml ${line}`).toThrow();
  }
  expect(attemptedLines.length).toBe(lines.length);
  expect(() => buildThroughRegistry("permission-capture", { fingerprint: OPENCODE_PERMISSION_CAPTURE, key: "Enter" }))
    .toThrow();
  expect(() => buildThroughOperatorYaml(OPENCODE_PERMISSION_CAPTURE)).toThrow();

  // Not reject-all: the recorded folder-trust capture builds, on the same path, in the same test.
  expect(buildThroughRegistry("kimi-fixture", KIMI_TRUST_DIALOG).trustDialog).toEqual(KIMI_TRUST_DIALOG);
});

test("production registry construction accepts the recorded kimi folder-trust capture while refusing the permission-pane captures, using exact recorded bytes so reject-all logic and hand-written prose fingerprints both fail", () => {
  const accepted = buildThroughRegistry("kimi-fixture", KIMI_TRUST_DIALOG).trustDialog;
  expect(accepted).toEqual(KIMI_TRUST_DIALOG);
  for (const refused of [OPENCODE_PERMISSION_CAPTURE, ...OPENCODE_PERMISSION_CAPTURE.split("\n")]) {
    expect(() => buildThroughRegistry("permission-fixture", { fingerprint: refused, key: "Enter" }), refused).toThrow();
  }

  // Round 2's defect, submitted the way it actually reopens: as the FINGERPRINT, through both
  // production construction paths — not as pane text against somebody else's capture. Codex's real
  // recorded gate is "Do you trust the contents of this directory?", one word away from the first
  // string below, so the word "trust" cannot separate them and no regex ever will; only the record
  // can. Accepting either would hand the daemon an Enter to press on a tool-permission pane.
  //
  // The last three are round 3's bypass: PREFIXES of recorded lines. "Trust" is a prefix of kimi's
  // and cursor's captured rows and also a substring of a tool-permission pane reading "Trust this
  // command?"; "Trust this folder" is kimi's row with the selection cursor stripped, the exact
  // string OBS-406 measured matching 258 supervisor panes that merely discussed the dialog. A
  // prefix of a capture is not a capture — only an enumerated fingerprint is.
  for (const prose of [
    "Do you trust this command?", "Trust this workspace?", "the workspace trust dialog",
    "Trust", "Trust this folder", "Workspace Trust",
  ]) {
    expect(() => buildThroughRegistry("prose-fixture", { fingerprint: prose, key: "Enter" }), prose)
      .toThrow(TRUST_DIALOG_UNRECORDED_MESSAGE);
    expect(() => buildThroughOperatorYaml(prose), `yaml ${prose}`).toThrow(TRUST_DIALOG_UNRECORDED_MESSAGE);
  }

  // The shipped adapters, built through the registry, are the same objects their modules export —
  // a factory default or construction-site fallback would not be — and every fingerprint is bytes
  // that appear in a recorded pane. Prose ABOUT a dialog is not the dialog: it matches nothing.
  const adapters = allAdapters();
  for (const { id, file, dialog, panes } of RECORDED_CAPTURES) {
    const built = getAdapter(id, adapters);
    expect(built.trustDialog, id).toBe(dialog);
    expect(adapterSource(file).includes(dialog.fingerprint), `${id} capture recorded beside its declaration`).toBe(true);
    expect(RECORDED_TRUST_PANES.some((pane) => pane.includes(dialog.fingerprint)), `${id} fingerprint is recorded bytes`).toBe(true);
    for (const pane of panes) expect(matchesTrustDialog(pane, built.trustDialog), `${id} own pane`).toBe(true);
    expect(matchesTrustDialog(OPENCODE_PERMISSION_CAPTURE, built.trustDialog), `${id} vs permission pane`).toBe(false);
  }
  expect(matchesTrustDialog("discussing the Trust this folder dialog with the operator", KIMI_TRUST_DIALOG)).toBe(false);

  for (const { id, file, adapter } of NO_DIALOG_ADAPTERS) {
    const built = getAdapter(id, adapters);
    expect(built.trustDialog, id).toBe(adapter.trustDialog);
    const declaration = built.trustDialog;
    expect(declaration.kind, id).toBe("none");
    if (declaration.kind !== "none") continue;
    // The reason is recorded in the shipped source beside the construction site, and it is
    // falsifiable: every one names the observation that would replace it with a capture.
    expect(adapterSource(file).includes(declaration.reason), `${id} reason recorded at its declaration`).toBe(true);
    expect(declaration.reason, id).toMatch(/falsified|capture/i);
    // No pane, recorded or otherwise, gets a key from a no-dialog declaration.
    for (const { panes } of RECORDED_CAPTURES) {
      for (const pane of panes) expect(matchesTrustDialog(pane, declaration), `${id} vs recorded pane`).toBe(false);
    }
  }
});

test("the daemon keys the same pane bytes only for the captured declaration, never for a no-dialog one", async () => {
  const noDialog: TrustDialog = { kind: "none", reason: "this adapter renders no workspace-trust prompt" };

  // Same pane bytes, same daemon, only the declaration differs. A presence-only guard would key
  // both; an always-false guard would key neither.
  //
  // SCOPE, so this is not read as more than it is: the dispatched adapter here has no
  // `interactiveSeed`, so this covers the daemon's post-seed trust loop only. A kimi startup pane
  // blocks inside runInteractiveSeed's readiness wait, before this loop is entered — see the note
  // at kimi.ts's `trustDialog`. That path lives in src/run and belongs to T19.
  const captured = await runTrustPane(KIMI_TRUST_PANE, KIMI_TRUST_DIALOG, { unblockOnKey: true });
  expect(captured.keys).toEqual([KIMI_TRUST_DIALOG.key]);
  expect(captured.notified.filter((m) => /blocked on a prompt|looks idle/.test(m))).toHaveLength(0);

  const declined = await runTrustPane(KIMI_TRUST_PANE, noDialog, { unblockOnKey: false });
  expect(declined.keys).toEqual([]);
  expect(declined.notified.filter((m) => /blocked on a prompt/.test(m))).toHaveLength(1);
  expect(declined.human).toEqual(["T1"]);
}, 60_000);
