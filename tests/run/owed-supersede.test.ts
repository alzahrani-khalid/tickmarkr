// Queue row 339 / D-2181 D5: the current owed-check fold over owed-check-superseded rows. The valid closure is
// produced once through `verify --supersede` (fake adapter, zero tokens); every other cell edits rows or proofs.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { approve } from "../../src/cli/commands/approve.js";
import { verify, verifyStateDir } from "../../src/cli/commands/verify.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { modelProvider } from "../../src/route/preference.js";
import { foldOwedChecks, Journal, type JournalEvent, type OwedCheck, type OwedProofMemo, owedSubject, supersedeContainment } from "../../src/run/journal.js";
import { authedModels, makeRepo, makeTestTempDir, T } from "../helpers/tmprepo.js";

const RUN = "run-owed-supersede";
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  delete process.env.TICKMARKR_FAKE_SCRIPT;
  vi.restoreAllMocks();
});

async function supersededReview(gate = "review", gates = "") {
  const repo = makeRepo({ "src/a.ts": "a\n" });
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks: [T("T1", { files: ["src/a.ts"] })] }));
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), `judge: { adapter: fake, model: fake-1 }\n${gates}`);
  writeDoctor(repo, { fake: { installed: true, authed: true, models: [], modelAuth: authedModels(["fake-1", "fake-2"]) } });
  const script = join(makeTestTempDir("owed-supersede-script-"), "script.json");
  writeFileSync(script, JSON.stringify({ tasks: {}, review: { approve: true, issues: [] } }));
  process.env.TICKMARKR_FAKE_SCRIPT = script;
  vi.spyOn(console, "error").mockImplementation(() => {});
  git(repo, "branch", `tickmarkr/${RUN}`, "main");
  git(repo, "checkout", "-q", "-b", `tickmarkr/${RUN}--T1`);
  writeFileSync(join(repo, "src/a.ts"), "a\nfeature\n");
  git(repo, "commit", "-q", "--no-gpg-sign", "-am", "feature");
  const owedHead = git(repo, "rev-parse", "HEAD");
  const base = git(repo, "rev-parse", "main");
  git(repo, "checkout", "-q", "main");
  const journal = Journal.create(repo, RUN);
  copyFileSync(join(repo, ".tickmarkr", "graph.json"), join(journal.dir, "graph.json"));
  journal.append("run-start", undefined, { baseRef: "main" });
  journal.append("task-dispatch", "T1", { attempt: 0, assignment: { adapter: "fake", model: "fake-1", channel: "sub", tier: "frontier" } });
  journal.append("gate-result", "T1", { gate, pass: false, details: "red", commit: owedSubject(repo, base, owedHead) });
  journal.append("task-human", "T1", { kind: "gate-fail", reason: "operator decision" });
  await approve([RUN, "T1", "--waive", "--by", "operator", "--reason", "D-2181"], repo);
  journal.append("run-end", undefined, { done: ["T1"], failed: [], human: [], blocked: [], pending: [] });
  const obligation = journal.read().find((row) => row.event === "task-approved")!.data.obligation as OwedCheck;
  git(repo, "checkout", "-q", "--detach", owedHead);
  writeFileSync(join(repo, "src/a.ts"), "a\nfeature fixed\n");
  git(repo, "commit", "-q", "--no-gpg-sign", "-am", "fix");
  const fixHead = git(repo, "rev-parse", "HEAD");
  const result = await verify(["--record", RUN, "--task", "T1", "--base", "main", "--supersede", obligation.id, "--author", "human", "--no-acceptance"], repo);
  expect(result.code, result.out).toBe(0);
  const events = journal.read();
  const row = events.find((e) => e.event === "owed-check-superseded")!;
  return { repo, journal, obligation, fixHead, events, row };
}

test("the current owed fold memoises only immutable supersede ancestry revalidates closure evidence on every fold and keeps superseded provenance separate from discharged history across missing tampered relocated linked and forged neighbor evidence", async () => {
  const { repo, journal, obligation, fixHead, events, row } = await supersededReview();
  const proofPath = join(journal.dir, String(row.data.artifactPath));
  const proof = readFileSync(proofPath);
  const closed = { id: obligation.id, head: fixHead, artifactPath: String(row.data.artifactPath), artifactSha256: String(row.data.artifactSha256) };
  const closedFold = { known: true, debt: 0, outstanding: [], discharged: [], acceptedRisk: [obligation], superseded: [closed], unknown: [] };
  expect(foldOwedChecks(events, repo)).toEqual(closedFold);
  // The human sentinel fixer is accepted from the hash-bound facts, never re-resolved against the waive's declared table.
  expect(obligation.declared.map((seat) => seat.key)).not.toContain("human:human");

  // Legacy shapes: no supersede row, no owed checks — no invented closure and no superseded property.
  const withoutClosure = events.filter((e) => e !== row);
  expect(foldOwedChecks(withoutClosure, repo)).toEqual({ known: true, debt: 1, outstanding: [obligation], acceptedRisk: [obligation], discharged: [], unknown: [] });
  expect(foldOwedChecks([], repo)).toEqual({ known: true, debt: 0, outstanding: [], acceptedRisk: [], discharged: [], unknown: [] });

  // The memo caches exactly the immutable ancestry tuple of a completed proof.
  const memo: OwedProofMemo = new Set();
  expect(foldOwedChecks(events, repo, memo)).toEqual(closedFold);
  expect([...memo]).toEqual([JSON.stringify(["supersede", obligation.base, obligation.head, obligation.base, fixHead])]);
  // A cold proof over an unreadable owed head is unknown and never memoised; the warm memo answers without ancestry git.
  const object = join(repo, ".git", "objects", obligation.head.slice(0, 2), obligation.head.slice(2));
  expect(existsSync(object)).toBe(true);
  renameSync(object, `${object}.hidden`);
  try {
    const coldMemo: OwedProofMemo = new Set();
    for (const cold of [foldOwedChecks(events, repo), foldOwedChecks(events, repo, coldMemo)]) {
      expect(cold).toMatchObject({ known: false, debt: "unknown", outstanding: [{ id: obligation.id }], discharged: [] });
      expect(cold).not.toHaveProperty("superseded");
      expect(cold.unknown[0]!.reason).toMatch(/^supersede range does not contain the obligation: unreadable history/);
    }
    expect(coldMemo.size).toBe(0);
    expect(foldOwedChecks(events, repo, memo)).toEqual(closedFold);
  } finally {
    renameSync(`${object}.hidden`, object);
  }

  // Evidence is re-read on EVERY fold, warm memo included: missing and tampered proofs read unknown by name.
  const unknown = (rows: readonly JournalEvent[], reason: string | RegExp) => {
    for (const fold of [foldOwedChecks(rows, repo, memo), foldOwedChecks(rows, repo)]) {
      expect(fold).toMatchObject({ known: false, debt: "unknown", outstanding: [{ id: obligation.id }], discharged: [] });
      expect(fold).not.toHaveProperty("superseded");
      expect(fold.unknown.at(-1)!.reason).toMatch(reason);
    }
  };
  rmSync(proofPath);
  unknown(events, /^artifact unavailable$/);
  const altered = Buffer.from(proof);
  altered[0] ^= 1;
  writeFileSync(proofPath, altered);
  unknown(events, /^artifact hash mismatch$/);
  writeFileSync(proofPath, proof);

  // Forged row claims, each refused against the obligation and the hash-bound artifact.
  const replace = (data: Record<string, unknown>, over: Partial<JournalEvent> = {}): JournalEvent[] =>
    events.map((e) => e === row ? { ...row, ...over, data: { ...row.data, ...data } } : e);
  unknown(replace({ ids: ["ffffffffffffffff"] }), /^discharge names no recorded obligation$/);
  unknown(replace({}, { taskId: "T2" }), /^discharge names another task$/);
  unknown(replace({ gates: ["test"] }), /^supersede does not bind the obligation's one check and gate$/);
  unknown(replace({ mapping: "exact" }), /^supersede does not bind the obligation's one check and gate$/);
  unknown(replace({ criteria: "0".repeat(64) }), /^discharge proved other criteria$/);
  unknown(replace({ head: obligation.base }), /^supersede range does not contain the obligation: the owed head .* is not an ancestor of/);
  unknown(replace({ head: obligation.head }), /^artifact measured another range$/);
  unknown(replace({ fixAuthors: undefined }), /^malformed fixing-author facts$/);
  unknown(replace({ fixAuthors: [{ key: "human", vendor: "human" }] }), /^malformed fixing-author facts$/);
  unknown(replace({ fixAuthors: [{ key: "fake:fake-3", vendor: "fake-a" }] }), /^artifact verified another fixing author$/);
  unknown(replace({ reviewer: { key: "fake:fake-9", vendor: "fake-b" } }), /^unresolved reviewer$/);
  // Only completed ancestry proofs are memoised (the owed head itself contains the owed range; its artifact was the
  // refusal), never the refused tuple whose head precedes the owed head.
  const tuple = (head: string) => JSON.stringify(["supersede", obligation.base, obligation.head, obligation.base, head]);
  expect([...memo].sort()).toEqual([tuple(fixHead), tuple(obligation.head)].sort());

  // Self-consistent forged proofs (row and artifact agree, hash fresh) still answer to the obligation and both author sets.
  const artifact = JSON.parse(proof.toString()) as Record<string, unknown> & { gateRows: Array<Record<string, unknown>> };
  const forge = (over: Record<string, unknown>, rowOver: Record<string, unknown> = {}): JournalEvent[] => {
    const bytes = JSON.stringify({ ...artifact, ...over });
    const digest = sha(bytes);
    mkdirSync(join(journal.dir, "discharges"), { recursive: true });
    writeFileSync(join(journal.dir, "discharges", `${digest}.json`), bytes);
    return replace({ artifactPath: join("discharges", `${digest}.json`), artifactSha256: digest, ...rowOver });
  };
  const reviewRow = artifact.gateRows.find((r) => r.gate === "review")!;
  unknown(forge({ gateRows: [{ ...reviewRow, pass: false }] }), /^artifact holds no passing review row$/);
  unknown(forge({ gateRows: [{ ...reviewRow, meta: { ...(reviewRow.meta as object), skipped: true } }] }), /^artifact holds no passing review row$/);
  unknown(forge({ files: ["src/**"] }), /^artifact gated another file scope$/);
  unknown(forge({ criteria: "0".repeat(64) }), /^artifact measured other criteria$/);
  unknown(forge({ head: obligation.head }), /^artifact measured another range$/);
  const sameAsReviewer = [{ key: "fake:fake-2", vendor: "fake-b" }];
  unknown(forge({ fixAuthors: sameAsReviewer }, { fixAuthors: sameAsReviewer }), /^same-vendor reviewer \(the reviewer matches a fixing author\)$/);
  const sameVendor = [{ key: "fake:other", vendor: "fake-b" }];
  unknown(forge({ fixAuthors: sameVendor }, { fixAuthors: sameVendor }), /^same-vendor reviewer \(the reviewer matches a fixing author\)$/);
  // Well-formed fixing-author facts absent from config, doctor and the declared table are accepted as recorded.
  const undeclared = [{ key: "fake:fake-3", vendor: "fake-a" }];
  const undeclaredRows = forge({ fixAuthors: undeclared }, { fixAuthors: undeclared });
  expect(foldOwedChecks(undeclaredRows, repo, memo)).toMatchObject({ known: true, debt: 0, superseded: [{ id: obligation.id }] });

  // Invalid JSON whose sha256 the row binds exactly: unknown, never a closure.
  const raw = "{ not json";
  writeFileSync(join(journal.dir, "discharges", `${sha(raw)}.json`), raw);
  unknown(replace({ artifactPath: join("discharges", `${sha(raw)}.json`), artifactSha256: sha(raw) }), /^artifact unavailable$/);
  // Malformed original-author proofs: absent, not a channel fact, inconsistent vendors, a vendor never declared.
  unknown(replace({ authorChannels: undefined }), /^unresolved author channel$/);
  unknown(replace({ authorChannels: [{ key: "fake:fake-1" }] }), /^unresolved author channel$/);
  unknown(replace({ authorChannels: [{ key: "fake:fake-1", vendor: "fake-a" }, { key: "fake:fake-1", vendor: "fake-b" }] }),
    /^unresolved author channel \(inconsistent vendor claims\)$/);
  unknown(replace({ authorChannels: [{ key: "fake:fake-1", vendor: "fake-z" }] }), /^unresolved author channel \(no declared channel with that identity and vendor\)$/);

  // Provider-only collisions: a reviewer seat served by openai, and an original author or a fixer whose vendor and key
  // differ but whose served model is openai's. The obligation declares the forged seats; a human fixer is the control.
  const openaiReviewer = { key: "codex:gpt-6", vendor: "openai" };
  const viaGateway = { key: "pi:gpt-6-mini", vendor: "pi" };
  const reviewedBy = artifact.gateRows.map((r) => r.gate === "review"
    ? { ...r, meta: { ...(r.meta as object), reviewer: openaiReviewer.key, vendor: openaiReviewer.vendor, provider: "openai" } } : r);
  const declare = (rows: JournalEvent[], over: Partial<OwedCheck> = {}): JournalEvent[] => rows.map((e) => e.event === "task-approved" && e.data.obligation
    ? { ...e, data: { ...e.data, obligation: { ...(e.data.obligation as OwedCheck), declared: [...obligation.declared, openaiReviewer, viaGateway], ...over } } } : e);
  expect(foldOwedChecks(declare(forge({ gateRows: reviewedBy }, { reviewer: openaiReviewer })), repo, memo))
    .toMatchObject({ known: true, debt: 0, superseded: [{ id: obligation.id }] });
  unknown(declare(forge({ gateRows: reviewedBy, fixAuthors: [viaGateway] }, { reviewer: openaiReviewer, fixAuthors: [viaGateway] })),
    /^same-vendor reviewer \(the reviewer matches a fixing author\)$/);
  unknown(declare(forge({ gateRows: reviewedBy }, { reviewer: openaiReviewer, authorChannels: [viaGateway] }), { authors: [viaGateway.key] }), /^same-vendor reviewer$/);

  // Ancestry overlays (D-2184 add.51): a replace ref or the legacy graft file grafting the owed head under a sibling fix.
  // A self-consistent forged closure from that sibling never closes and its tuple is never memoised, so removing the
  // overlay leaves the warm memo agreeing with a cold fold; an overlay HIDING real ancestry never refuses the genuine one.
  git(repo, "checkout", "-q", "--detach", obligation.base);
  writeFileSync(join(repo, "src/a.ts"), "a\nsibling fix\n");
  git(repo, "commit", "-q", "--no-gpg-sign", "-am", "sibling fix");
  const sib = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "--detach", fixHead);
  const sibRows = forge({ head: sib }, { head: sib });
  const notContained = `the owed head ${obligation.head} is not an ancestor of ${sib}`;
  const graftFile = join(repo, ".git", "info", "grafts");
  const memoBefore = [...memo].sort();
  const overlays: Array<[string, (child: string, parent: string) => void, (child: string) => void]> = [
    ["replace ref", (child, parent) => git(repo, "replace", "--graft", child, parent), (child) => git(repo, "replace", "-d", child)],
    ["graft file", (child, parent) => writeFileSync(graftFile, `${child} ${parent}\n`), () => rmSync(graftFile)],
  ];
  const isAncestor = (a: string, b: string) => spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: repo }).status;
  for (const [name, add, remove] of overlays) {
    add(sib, obligation.head);
    try {
      expect(isAncestor(obligation.head, sib), name).toBe(0); // the control: the overlay is live and git's ancestry says yes
      unknown(sibRows, `supersede range does not contain the obligation: ${notContained}`);
      expect(supersedeContainment(repo, obligation, obligation.base, sib, memo)).toEqual({ ok: false, unreadable: false, reason: notContained });
    } finally {
      remove(sib);
    }
    expect([...memo].sort(), name).toEqual(memoBefore);
    unknown(sibRows, `supersede range does not contain the obligation: ${notContained}`);
    add(fixHead, obligation.base);
    try {
      expect(isAncestor(obligation.head, fixHead), name).toBe(1); // the control: the overlay hides the owed head
      expect(foldOwedChecks(events, repo), name).toEqual(closedFold);
      expect(foldOwedChecks(events, repo, new Set()), name).toEqual(closedFold);
    } finally {
      remove(fixHead);
    }
  }

  // A duplicate valid closure never subtracts twice and keeps the FIRST provenance; ordinary discharge stays distinct.
  const second = undeclaredRows.find((e) => e.event === "owed-check-superseded")!;
  expect(foldOwedChecks([...events, row, second], repo, memo)).toEqual(closedFold);
  // An unknown waiver beside a valid supersede: only the named check closes, and the debt stays unknown.
  const legacy: JournalEvent[] = [
    { ts: "2026-11-07T00:00:00.000Z", event: "task-approved", taskId: "T2", data: { release: "gate-satisfied", gate: "review" } },
    { ts: "2026-11-07T00:00:01.000Z", event: "task-dispatch", taskId: "T2", data: {} },
  ];
  expect(foldOwedChecks([...events, ...legacy], repo, memo)).toMatchObject({ known: false, debt: "unknown", outstanding: [], discharged: [],
    superseded: [closed], unknown: [{ taskId: "T2", reason: "legacy waiver without an owed-check obligation" }] });

  // Temporary verify state deleted, the repository moved, a linked checkout with no local run: the relative proof holds.
  rmSync(verifyStateDir(repo), { recursive: true, force: true });
  expect(foldOwedChecks(events, repo)).toEqual(closedFold);
  const moved = join(makeTestTempDir("owed-supersede-moved-"), "repository");
  renameSync(repo, moved);
  const movedEvents = Journal.open(moved, RUN).read();
  expect(foldOwedChecks(movedEvents, moved)).toEqual(closedFold);
  const linked = join(makeTestTempDir("owed-supersede-linked-"), "checkout");
  git(moved, "worktree", "add", "--detach", linked, "HEAD");
  try {
    expect(existsSync(join(linked, ".tickmarkr"))).toBe(false);
    expect(foldOwedChecks(movedEvents, linked)).toEqual(closedFold);
    // A neighbour run holding a same-named proof never lends it; a local run lacking the proof is unknown.
    const neighbour = Journal.create(linked, "run-neighbour");
    neighbour.append("run-start", undefined, {});
    mkdirSync(join(neighbour.dir, "discharges"), { recursive: true });
    writeFileSync(join(neighbour.dir, String(row.data.artifactPath)), proof);
    expect(foldOwedChecks(movedEvents, linked)).toEqual(closedFold);
    Journal.create(linked, RUN).append("run-start", undefined, {});
    const forged = foldOwedChecks(movedEvents, linked);
    expect(forged).toMatchObject({ known: false, debt: "unknown", unknown: [{ reason: "artifact unavailable" }] });
    expect(forged).not.toHaveProperty("superseded");
  } finally {
    git(moved, "worktree", "remove", "--force", linked);
  }
}, 60_000);

// Row 339 / D-2181 D5 (D-2184 add.54): a supersede's reviewer is re-resolved on EVERY fold, whatever gate the check
// owes, against the union of the original authors and the recorded fixing authors — from the journal row and the
// hash-bound artifact alike. The closure is produced through `verify --supersede` for an owed SCOPE check; the bounded
// sweep re-owes the same closure as every other non-review gate its artifact passed. Each tampered closure carries a
// refreshed hash, so only the reviewer rule can refuse it; the untampered closure is the control.
test("a supersede closure of every non review owed gate folds unknown when its reviewer is unresolved an original author or a fixing author from the row and the hash bound artifact alike", async () => {
  // Configured build, test and lint commands, so every non-review gate's row really ran and passed.
  const { repo, journal, obligation, events, row } = await supersededReview("scope", "gates:\n  build: \"true\"\n  test: \"true\"\n  lint: \"true\"\n");
  expect(obligation.gate).toBe("scope");
  const artifact = JSON.parse(readFileSync(join(journal.dir, String(row.data.artifactPath)), "utf8")) as Record<string, unknown> & { gateRows: Array<Record<string, unknown>> };
  const passing = (gate: string) => artifact.gateRows.some((r) => r.gate === gate && r.pass === true && (r.meta as { skipped?: unknown } | undefined)?.skipped !== true);
  const gates = ["build", "test", "lint", "evidence", "scope"] as const;
  expect(gates.filter(passing)).toEqual([...gates]); // the sweep's precondition: every non-review gate's row passed
  expect(row.data.reviewer).toEqual({ key: "fake:fake-2", vendor: "fake-b" });
  expect(row.data.authorChannels).toEqual([{ key: "fake:fake-1", vendor: "fake-a" }]);
  expect(row.data.fixAuthors).toEqual([{ key: "human:human", vendor: "human" }]);

  const forge = (rows: readonly JournalEvent[], over: Record<string, unknown>, rowOver: Record<string, unknown>): JournalEvent[] => {
    const bytes = JSON.stringify({ ...artifact, ...over });
    const digest = sha(bytes);
    writeFileSync(join(journal.dir, "discharges", `${digest}.json`), bytes);
    return rows.map((e) => e.event === "owed-check-superseded"
      ? { ...e, data: { ...e.data, artifactPath: join("discharges", `${digest}.json`), artifactSha256: digest, ...rowOver } } : e);
  };
  const reviewedBy = (fact: { key: string; vendor: string }) => artifact.gateRows.map((r) => r.gate === "review"
    ? { ...r, meta: { ...(r.meta as object), reviewer: fact.key, vendor: fact.vendor, provider: modelProvider(fact.key.slice(fact.key.indexOf(":") + 1), fact.vendor) } } : r);
  const original = { key: "fake:fake-1", vendor: "fake-a" };
  const reviewer = row.data.reviewer as { key: string; vendor: string };
  const cells: Array<[string, (rows: readonly JournalEvent[]) => JournalEvent[], RegExp]> = [
    ["fixing author is the reviewer", (rows) => forge(rows, { fixAuthors: [reviewer] }, { fixAuthors: [reviewer] }), /^same-vendor reviewer \(the reviewer matches a fixing author\)$/],
    ["fixing author shares the reviewer's vendor", (rows) => forge(rows, { fixAuthors: [{ key: "fake:other", vendor: reviewer.vendor }] }, { fixAuthors: [{ key: "fake:other", vendor: reviewer.vendor }] }),
      /^same-vendor reviewer \(the reviewer matches a fixing author\)$/],
    ["reviewer is an original author", (rows) => forge(rows, { gateRows: reviewedBy(original) }, { reviewer: original }), /^same-vendor reviewer \(the reviewer is a recorded patch author\)$/],
    ["no reviewer on the row", (rows) => forge(rows, {}, { reviewer: undefined }), /^unresolved reviewer$/],
    ["row reviewer is not the artifact's", (rows) => forge(rows, {}, { reviewer: { key: "fake:fake-9", vendor: reviewer.vendor } }), /^unresolved reviewer$/],
    ["reviewer never declared", (rows) => forge(rows, { gateRows: reviewedBy({ key: "fake:fake-9", vendor: reviewer.vendor }) }, { reviewer: { key: "fake:fake-9", vendor: reviewer.vendor } }),
      /^unresolved reviewer \(no declared channel with that identity and vendor\)$/],
    ["artifact holds no passing review row", (rows) => forge(rows, { gateRows: artifact.gateRows.filter((r) => r.gate !== "review") }, {}), /^artifact holds no passing review row$/],
  ];
  const memo: OwedProofMemo = new Set();
  for (const gate of gates) {
    // The same closure, owed as `gate`: the red gate the park bound, the waive's gate and obligation, the closure's gate.
    const owedAs = events.map((e) => e.event === "task-approved" && e.data.obligation
      ? { ...e, data: { ...e.data, gate, obligation: { ...(e.data.obligation as OwedCheck), gate } } }
      : e.event === "gate-result" && e.data.gate === "scope" ? { ...e, data: { ...e.data, gate } }
      : e.event === "owed-check-superseded" ? { ...e, data: { ...e.data, gates: [gate] } } : e);
    const control = forge(owedAs, {}, {});
    expect(foldOwedChecks(control, repo, memo).unknown, gate).toEqual([]);
    expect(foldOwedChecks(control, repo, memo), gate).toMatchObject({ known: true, debt: 0, discharged: [], superseded: [{ id: obligation.id }] });
    for (const [cell, tamper, reason] of cells) {
      for (const fold of [foldOwedChecks(tamper(owedAs), repo, memo), foldOwedChecks(tamper(owedAs), repo)]) {
        expect(fold, `${gate}: ${cell}`).toMatchObject({ known: false, debt: "unknown", outstanding: [{ id: obligation.id }], discharged: [] });
        expect(fold, `${gate}: ${cell}`).not.toHaveProperty("superseded");
        expect(fold.unknown.at(-1)!.reason, `${gate}: ${cell}`).toMatch(reason);
      }
    }
  }
}, 60_000);
