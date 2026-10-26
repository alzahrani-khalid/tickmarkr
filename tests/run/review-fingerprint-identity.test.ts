import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { shq } from "../../src/adapters/types.js";
import { approve } from "../../src/cli/commands/approve.js";
import { extractPromptNonce } from "../../src/gates/llm.js";
import { runDaemon } from "../../src/run/daemon.js";
import {
  GATE_SATISFIED_RELEASE, Journal, carryReviewFindings, observedReviewFingerprints, outstandingReviewFindings,
  reraisedReviewChains, structuredFindings, type JournalEvent, type StructuredFinding,
} from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const TS = "2026-10-25T00:00:00.000Z";
const OLD_NOTE = "src/run/git-trust.ts:10 — shGitOk() drops the command exit status";
const NEW_NOTE = "src/run/git-trust.ts:20 — shGitOk() accepts an untrusted working directory";
const NATURAL = "review:material|src/run/git-trust.ts|shGitOk";
const HASHED = /^review:material\|src\/run\/git-trust\.ts\|shGitOk(?:#[0-9a-f]{12})+$/;
const material = (note: string): StructuredFinding => structuredFindings("review", `- [material] ${note}`)[0]!;
const review = (findings: StructuredFinding[], data: Record<string, unknown> = {}, taskId = "T1"): JournalEvent => ({
  ts: TS, event: "gate-result", taskId, data: { gate: "review", pass: false, findings, ...data },
});
const fold = (events: JournalEvent[]) => outstandingReviewFindings(events, "T1");

test("test: the outstanding review findings fold gives a new material sharing the path and symbol of a chain this task resolved, by its resolved list or by passing, a distinct fingerprint in the existing hash form, so a fold that reuses the resolved fingerprint fails", () => {
  const old = material(OLD_NOTE);
  const moved = material(OLD_NOTE.replace("git-trust.ts", "git-trust-moved.ts"));
  const histories = [
    [review([old])],
    [review([old]), review([{ ...moved, reraisedFrom: old.fingerprint }], { reraised: [old.fingerprint] })],
  ];
  for (const history of histories) {
    const observed = observedReviewFingerprints(fold(history)[0]!);
    expect(observed).toContain(NATURAL);
    for (const closure of [{ resolved: [old.fingerprint] }, { pass: true }]) {
      const closed = [...history, review([], closure)];
      expect(fold(closed)).toEqual([]);
      for (const note of [NEW_NOTE, NEW_NOTE.replace("git-trust.ts", "git-trust-moved.ts")]) {
        if (!observed.includes(material(note).fingerprint)) continue;
        const [fresh] = fold([...closed, review([material(note)])]);
        expect(fresh!.note).toBe(note);
        expect(observed).not.toContain(fresh!.fingerprint);
        expect(fresh!.symbol).toMatch(/^shGitOk#[0-9a-f]{12}$/);
        expect(fresh!.fingerprint).toBe(`review:material|${fresh!.path}|${fresh!.symbol}`);
      }
    }
  }
});

test("test: a new material whose generated hash fingerprint was itself resolved earlier on the task is minted again until its fingerprint is unused, so a single re-hash that lands on a retired generated fingerprint fails", () => {
  const fresh = material(NEW_NOTE);
  const anchor = { ...structuredFindings("review", "- t1.txt:1 — repeated note evidence")[0]!, boundTo: NATURAL };
  const events = [review([material(OLD_NOTE)]), review([], { resolved: [NATURAL] })];
  const retired = new Set([NATURAL]);
  let hashSuffix = "";
  for (let generation = 1; generation <= 4; generation++) {
    events.push(review([fresh, anchor]));
    const [current] = fold(events);
    expect(current!.fingerprint).toMatch(HASHED);
    expect(retired.has(current!.fingerprint)).toBe(false);
    expect(current!.symbol.split("#")).toHaveLength(generation + 1);
    expect(fold(events).filter((row) => row.class === "review:anchored")).toEqual([{ ...anchor, boundTo: current!.fingerprint }]);
    if (generation === 1) hashSuffix = current!.fingerprint.slice(NATURAL.length);
    retired.add(current!.fingerprint);
    events.push(review([], { resolved: [current!.fingerprint] }));
    expect(fold(events)).toEqual([]);
  }
  // The next available generated spelling may instead be owned by an open chain.
  const occupied = {
    ...material("src/run/git-trust.ts:40 — shGitOk() races the writer"),
    symbol: `shGitOk${hashSuffix.repeat(5)}`, fingerprint: `${NATURAL}${hashSuffix.repeat(5)}`,
  };
  const history = [...events, review([occupied]), review([fresh])];
  const open = fold(history);
  expect(open).toHaveLength(2);
  expect(open[0]).toEqual(occupied);
  expect(open[1]!.fingerprint).toBe(`${NATURAL}${hashSuffix.repeat(6)}`);
  const recorded = carryReviewFindings([open[1]!], [{ ...fresh, reraisedFrom: open[1]!.fingerprint }]);
  const carried = fold([...history, review(recorded, { reraised: [open[1]!.fingerprint] })]);
  expect(carried).toHaveLength(2);
  expect(carried[1]!.fingerprint).toBe(open[1]!.fingerprint);
  expect(observedReviewFingerprints(carried[1]!)).toEqual([open[1]!.fingerprint]);
});

test("test: a new finding with its own symbol, one sharing only another task's resolved chain and one sharing only a waived chain keep their natural fingerprints, while an open chain collision is disambiguated as before, so a fold that re-spells an unrelated fingerprint fails", () => {
  const old = material(OLD_NOTE);
  const fresh = material(NEW_NOTE);
  const own = material("src/run/git-trust.ts:30 — assertGitTrust() skips the repository check");
  expect(fold([review([old]), review([own], { resolved: [NATURAL] })])).toEqual([own]);
  expect(fold([
    review([old], {}, "T2"), review([], { resolved: [NATURAL] }, "T2"), review([fresh]),
  ])).toEqual([fresh]);

  const waive = (events: JournalEvent[]): JournalEvent[] => {
    const parked = [...events, { ts: TS, taskId: "T1", event: "task-human", data: { kind: "gate-fail" } }];
    return [...parked, {
      ts: TS, taskId: "T1", event: "task-approved",
      data: { release: GATE_SATISFIED_RELEASE, gate: "review", park: { line: parked.length, ts: TS } },
    }];
  };
  const waived = waive([review([old])]);
  expect(fold(waived)).toEqual([]); // prove this is an effective waive, rather than a refused release
  expect(fold([...waived, review([fresh])])).toEqual([fresh]);
  // A waive adds no retired ids and does not forget ids already resolved on this task.
  const resolvedThenWaived = waive([review([old]), review([own], { resolved: [NATURAL] })]);
  expect(fold(resolvedThenWaived)).toEqual([]);
  expect(fold([...resolvedThenWaived, review([fresh])])[0]!.fingerprint).toMatch(HASHED);

  const collision = fold([review([old]), review([fresh])]);
  expect(collision).toHaveLength(2);
  expect(collision[0]).toEqual(old);
  expect(collision[1]!.fingerprint).toMatch(HASHED);
  expect(fold([review([old]), review([old])])).toEqual([old]);
  const restatement = { ...fresh, reraisedFrom: NATURAL };
  expect(fold([review([old]), review([restatement], { reraised: [NATURAL] })])).toEqual([restatement]);
  const repeated = fold([review([old]), review([fresh]), review([fresh])]);
  expect(repeated).toMatchObject(collision);
  expect(repeated).toHaveLength(2);
});

test("test: a chain re-raised and then resolved by the verdict that raises a new material with the same path and symbol leaves the new chain with zero re-raises in the re-raised chains fold the repair brief reads, so a new chain credited with the resolved chain's re-raises fails", () => {
  const old = material(OLD_NOTE);
  const reraised = { ...old, reraisedFrom: NATURAL };
  const events = [review([old]), review([reraised], { reraised: [NATURAL] }), review([reraised], { reraised: [NATURAL] })];
  expect(reraisedReviewChains(events, "T1")).toEqual([{ finding: reraised, reraises: 2 }]);
  events.push(review([material(NEW_NOTE)], { resolved: [NATURAL], reraised: [] }));
  const chains = reraisedReviewChains(events, "T1");
  expect(chains).toHaveLength(1);
  expect(chains[0]!.finding.fingerprint).toMatch(HASHED);
  expect(chains[0]!.finding.note).toBe(NEW_NOTE);
  expect(observedReviewFingerprints(chains[0]!.finding)).not.toContain(NATURAL);
  expect(chains[0]!.reraises).toBe(0);

  // The review gate carries linked rows without the fold's retired set. Exercise both
  // validated links with the resulting natural spelling and contaminated observed list.
  for (const link of ["reraised", "codeIdentity"]) {
    const codeIdentity = { definition: "shGitOk", defect: "untrusted-working-directory" };
    const freshRow = { ...material(NEW_NOTE), ...(link === "codeIdentity" ? { codeIdentity } : {}) };
    const history = [...events.slice(0, -1), review([freshRow], { resolved: [NATURAL], reraised: [] })];
    const fresh = fold(history)[0]!;
    const restatement = {
      ...material(NEW_NOTE),
      ...(link === "reraised" ? { reraisedFrom: fresh.fingerprint } : { codeIdentity }),
    };
    const recorded = carryReviewFindings([fresh], [restatement]);
    expect(recorded[0]!.fingerprint).toBe(NATURAL);
    expect(observedReviewFingerprints(recorded[0]!)).toContain(NATURAL);
    history.push(review(recorded, { reraised: [fresh.fingerprint] }));
    const [carried] = reraisedReviewChains(history, "T1");
    expect(carried!.finding.fingerprint).toBe(fresh.fingerprint);
    expect(observedReviewFingerprints(carried!.finding)).not.toContain(NATURAL);
    expect(carried!.reraises).toBe(1);
    expect(fold([...history, review([], { resolved: [fresh.fingerprint] })])).toEqual([]);
  }
});

test("anchors in a verdict follow both new and carried chains away from retired spellings and retire with the final fingerprint", () => {
  const fresh = material(NEW_NOTE);
  const anchor = {
    ...structuredFindings("review", "- t1.txt:1 — untrusted working directory accepted here")[0]!, boundTo: NATURAL,
  };
  const loose = structuredFindings("review", "- t1.txt:2 — unrelated open comment")[0]!;
  for (const anchorFirst of [false, true]) {
    // The old chain's bound anchor retires; only anchors from this verdict follow the new row.
    const oldAnchor = { ...structuredFindings("review", "- t1.txt:1 — old command status lost here")[0]!, boundTo: NATURAL };
    const rows = [{ ...fresh, observedFingerprints: [NATURAL] }, anchor];
    const history = [review([material(OLD_NOTE), oldAnchor]), review(anchorFirst ? [...rows].reverse() : rows, { resolved: [NATURAL] })];
    const open = fold(history);
    const parent = open.find((row) => row.class === "review:material")!;
    expect(parent.fingerprint).toMatch(HASHED);
    expect(observedReviewFingerprints(parent)).toEqual([parent.fingerprint]);
    expect(open.filter((row) => row.class === "review:anchored")).toEqual([{ ...anchor, boundTo: parent.fingerprint }]);
    expect(fold([...history, review([], { resolved: [parent.fingerprint] })])).toEqual([]);

    for (const link of ["reraised", "codeIdentity", "unlinked"]) {
      const codeIdentity = { definition: "shGitOk", defect: "untrusted-working-directory" };
      const linkedHistory = link === "codeIdentity"
        ? [history[0]!, review([{ ...fresh, codeIdentity }, anchor], { resolved: [NATURAL] })]
        : history;
      const seeded = fold(linkedHistory).find((row) => row.class === "review:material")!;
      const restatement = {
        ...fresh,
        ...(link === "reraised" ? { reraisedFrom: seeded.fingerprint } : {}),
        ...(link === "codeIdentity" ? { codeIdentity } : {}),
      };
      // The gate knows only the open chain. The fold must also clean aliases when this
      // row takes the new-row/owner-reuse branch instead of a positive-lineage match.
      const recorded = link === "unlinked"
        ? [{ ...restatement, observedFingerprints: [seeded.fingerprint, NATURAL] }]
        : carryReviewFindings([seeded], [restatement]);
      expect(recorded[0]!.fingerprint).toBe(NATURAL);
      const current = [...recorded, anchor, loose];
      const carriedHistory = [...linkedHistory, review(anchorFirst ? [...current].reverse() : current, { reraised: [seeded.fingerprint] })];
      const carried = fold(carriedHistory);
      expect(carried.find((row) => row.class === "review:material")!.fingerprint).toBe(seeded.fingerprint);
      expect(observedReviewFingerprints(carried.find((row) => row.class === "review:material")!)).not.toContain(NATURAL);
      expect(carried.filter((row) => row.class === "review:anchored")).toEqual([
        { ...anchor, boundTo: seeded.fingerprint }, loose,
      ]);
      // This is a failing verdict, so a passing review cannot mask an orphan anchor.
      expect(fold([...carriedHistory, review([], { resolved: [seeded.fingerprint] })])).toEqual([loose]);
    }
  }
});

test("test: the production daemon's next review brief names a new material raised beside the resolution of an earlier chain with the same path and symbol by its distinct fingerprint, and a verdict resolving that fingerprint retires the new chain, so a brief that hands the reviewer the retired fingerprint fails", async () => {
  const attempts = [1, 2, 3, 4, 5].map((n) => ({
    shell: `echo ${n} > t1.txt && ${COMMIT} attempt-${n}`, result: { ok: true, summary: `attempt ${n}` },
  }));
  const { repo, fake } = setupRepo([T("T1", {
    routingHints: { pin: { via: "fake", model: "fake-1" } }, files: ["t1.txt"],
    acceptance: [{ oracle: "command", command: "true" }],
    gates: ["build", "test", "lint", "evidence", "scope", "review"],
  })], { tasks: { T1: attempts } });
  const briefs: string[] = [];
  const ids: string[][] = [];
  const anchorBody = "untrusted working directory accepted here";
  const otherNote = "src/run/git-trust.ts:30 — assertGitTrust() skips the repository check";
  const workerBriefs: string[] = [];
  const invoke = fake.invoke.bind(fake);
  fake.invoke = (task, cwd, adapter, ctx) => {
    workerBriefs.push(readFileSync(ctx.promptFile, "utf8"));
    return invoke(task, cwd, adapter, ctx);
  };
  const headless = fake.headlessCommand.bind(fake);
  fake.headlessCommand = (file, model) => {
    const prompt = readFileSync(file, "utf8");
    if (!prompt.startsWith("TICKMARKR-REVIEW")) return headless(file, model);
    briefs.push(prompt);
    const prior = [...prompt.matchAll(/^Fingerprint: (.+)$/gm)].map((match) => match[1]!);
    ids.push(prior);
    const round = briefs.length;
    const verdict = {
      nonce: extractPromptNonce(prompt), approve: round >= 5,
      resolved: round === 3 ? [] : prior, reraised: round === 3 ? prior : [],
      findings: round < 5 ? [{
        note: round === 1 ? OLD_NOTE : round === 4 ? otherNote : NEW_NOTE, severity: "material",
        ...(round === 3 ? { reraised: prior[0] } : {}),
      }] : [],
      ...(round === 2 || round === 3 ? { comments: [{ path: "t1.txt", line: 1, body: anchorBody, finding: 1 }] } : {}),
    };
    return `printf '%s\\n' ${shq(JSON.stringify(verdict))}`;
  };
  const runId = "run-resolved-fingerprint-identity";
  expect((await runDaemon(repo, { adapters: [fake], runId })).human).toEqual(["T1"]);
  expect(ids).toEqual([[], [NATURAL]]);
  await approve([runId, "T1", "--uphold", "--review-rounds", "3"], repo);
  expect((await runDaemon(repo, { adapters: [fake], runId, resume: true })).done).toEqual(["T1"]);
  expect(briefs).toHaveLength(5);
  expect(ids[2]).toHaveLength(1);
  const freshId = ids[2]![0]!;
  expect(freshId).toMatch(HASHED);
  expect(freshId).not.toBe(NATURAL);
  expect(briefs[2]).toContain(NEW_NOTE);
  expect(briefs[2]).not.toContain(OLD_NOTE);
  expect(ids[3]).toEqual([freshId]);
  expect(briefs[3]).toContain(NEW_NOTE);
  expect(briefs[3]).not.toContain(OLD_NOTE);
  const events = Journal.open(repo, runId).read();
  const verdicts = events.filter((event) => event.event === "gate-result" && event.data.gate === "review");
  expect(verdicts.map((event) => event.data.pass)).toEqual([false, false, false, false, true]);
  const beforeClosure = events.slice(0, events.indexOf(verdicts[3]!));
  const beforeClosureFindings = fold(beforeClosure);
  expect(beforeClosureFindings.filter((finding) => finding.class === "review:material").map((finding) => finding.fingerprint)).toEqual([freshId]);
  expect(beforeClosureFindings.filter((finding) => finding.class === "review:anchored")).toMatchObject([{ note: anchorBody, boundTo: freshId }]);
  for (const verdict of verdicts.slice(1, 3)) {
    // The gate-side binding still names the natural spelling; the fold must repair it.
    expect((verdict.data.findings as StructuredFinding[]).find((finding) => finding.class === "review:anchored")!.boundTo).toBe(NATURAL);
    expect(fold(events.slice(0, events.indexOf(verdict) + 1)).find((finding) => finding.class === "review:anchored")!.boundTo).toBe(freshId);
  }
  expect(reraisedReviewChains(beforeClosure, "T1")[0]!.reraises).toBe(1);
  expect(verdicts[3]!.data.resolved).toEqual([freshId]);
  expect(fold(events.slice(0, events.indexOf(verdicts[3]!) + 1))).toEqual([material(otherNote)]);
  expect(workerBriefs[4]).not.toContain(anchorBody);
  expect(workerBriefs[4]).not.toContain(NEW_NOTE);
  expect(ids[4]).toEqual([material(otherNote).fingerprint]);
  expect(fold(events)).toEqual([]);
}, 90_000);
