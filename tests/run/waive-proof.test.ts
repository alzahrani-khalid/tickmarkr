// Row 418 (D-2187 add.84, add.100): the seatless review infra park's proof reader, every T9 cell.
import { describe, expect, it } from "vitest";
import { waiveProof } from "../../src/run/waive-proof.js";

type Row = { event: string; taskId: string; data: Record<string, unknown> };
const SUBJECT = "subj-tok-1";
const ALL = ["build", "test", "lint", "evidence", "scope", "acceptance", "review"];
const receipt = (id = "inv-1") => ({ invocationId: id, subject: { gate: "test" }, termination: { kind: "exit", code: 0 } });
const row = (gate: string, data: Record<string, unknown> = {}, attempt = 2, commit = SUBJECT): Row =>
  ({ event: "gate-result", taskId: "T1", data: { gate, pass: true, commit, attempt, ...data } });
const fullTest = (data: Record<string, unknown> = {}, attempt = 2, commit = SUBJECT) =>
  row("test", { evidenceReceipt: receipt(), ...data }, attempt, commit);
const others = (attempt = 2, commit = SUBJECT, except: string[] = []) =>
  ["build", "lint", "evidence", "scope", "acceptance"].filter((g) => !except.includes(g)).map((g) => row(g, {}, attempt, commit));
const review = (attempt = 2, commit = SUBJECT): Row =>
  ({ event: "gate-result", taskId: "T1", data: { gate: "review", skipped: true, infra: true, noVerdict: true, commit, attempt } });
const park: Row = { event: "task-human", taskId: "T1", data: { kind: "infra" } };
const journal = (...rows: Row[]) => [{ event: "task-dispatch", taskId: "T1", data: {} }, ...rows, park];

describe("waiveProof (row 418)", () => {
  it("an executed full test that passed on the parked subject with every other enabled gate passed proves the candidate while a disabled acceptance is not owed", () => {
    expect(waiveProof(journal(...others(), fullTest(), review()), "T1", ALL)).toEqual({ ok: true, subject: SUBJECT, attempt: 2 });
    // a disabled acceptance: no acceptance row at all, and it is not owed
    const noAcceptance = ALL.filter((g) => g !== "acceptance");
    expect(waiveProof(journal(...others(2, SUBJECT, ["acceptance"]), fullTest(), review()), "T1", noAcceptance))
      .toEqual({ ok: true, subject: SUBJECT, attempt: 2 });
    // a later passed selected screen does not undo an executed full green
    expect(waiveProof(journal(...others(), fullTest(), row("test", { selectedTests: ["a.test.ts"], evidenceReceipt: receipt("inv-2") }), review()), "T1", ALL).ok).toBe(true);
    // a non-infra park is never proof
    const gateFail = [...journal(...others(), fullTest(), review()).slice(0, -1), { event: "task-human", taskId: "T1", data: { kind: "gate-fail" } }];
    expect(waiveProof(gateFail, "T1", ALL)).toMatchObject({ ok: false, missing: "park" });
  });

  it("a skipped green with no command a green with no receipt and a listing only receipt each refuse the proof", () => {
    const skippedGreen = row("test", { skipped: true, details: "no test command configured" });
    expect(waiveProof(journal(...others(), skippedGreen, review()), "T1", ALL)).toMatchObject({ ok: false, missing: "test" });
    const noReceipt = row("test");
    expect(waiveProof(journal(...others(), noReceipt, review()), "T1", ALL)).toMatchObject({ ok: false, missing: "test" });
    const listingOnly = row("test", { evidenceReceipts: [receipt("inv-1-listing")] });
    expect(waiveProof(journal(...others(), listingOnly, review()), "T1", ALL)).toMatchObject({ ok: false, missing: "test" });
  });

  it("a green followed by a same subject red and a prior attempt green before a current owed test each refuse the proof", () => {
    const red = row("test", { pass: false, evidenceReceipt: receipt("inv-2") });
    expect(waiveProof(journal(...others(), fullTest(), red, review()), "T1", ALL)).toMatchObject({ ok: false, missing: "test" });
    // a prior attempt's executed green on the SAME subject token (the repair landed no commit)
    const priorGreen = fullTest({}, 1);
    expect(waiveProof(journal(priorGreen, ...others(), review()), "T1", ALL)).toMatchObject({ ok: false, missing: "test" });
    // …then the parked attempt's test recorded owed (journaled skipped + infra, no pass)
    const owed: Row = { event: "gate-result", taskId: "T1", data: { gate: "test", skipped: true, infra: true, commit: SUBJECT, attempt: 2 } };
    expect(waiveProof(journal(priorGreen, ...others(), owed, review()), "T1", ALL)).toMatchObject({ ok: false, missing: "test" });
    // a receipt-bearing pass marked infra, test-owed or gate-owed after the green is no later green
    for (const mark of [{ infra: true }, { testOwed: true }, { gateOwed: "test" }]) {
      const later = fullTest({ ...mark, evidenceReceipt: receipt("inv-2") });
      expect(waiveProof(journal(...others(), fullTest(), later, review()), "T1", ALL)).toMatchObject({ ok: false, missing: "test" });
    }
    // an earlier dispatch's review and green gates never satisfy a new dispatch's park
    const approved = (event: string): Row => ({ event, taskId: "T1", data: {} });
    const stale = [...journal(...others(1), fullTest({}, 1), review(1)), approved("task-approved"), approved("task-dispatch"),
      { event: "gate-result", taskId: "T1", data: { gate: "test", skipped: true, infra: true, testOwed: true, commit: SUBJECT, attempt: 2 } }, park];
    expect(waiveProof(stale, "T1", ALL)).toMatchObject({ ok: false, missing: "review" });
    // and an owed row carrying a pass-shaped legacy field after a green is still red-side
    expect(waiveProof(journal(...others(), fullTest(), row("test", { testOwed: true, skipped: true }), review()), "T1", ALL))
      .toMatchObject({ ok: false, missing: "test" });
  });

  it("a selected screen a red an owed or an absent test an enabled acceptance red or absent and another subject's rows each refuse naming the gate", () => {
    const screen = row("test", { selectedTests: ["a.test.ts"], evidenceReceipt: receipt() });
    expect(waiveProof(journal(...others(), screen, review()), "T1", ALL)).toMatchObject({ ok: false, missing: "test" });
    const red = fullTest({ pass: false });
    expect(waiveProof(journal(...others(), red, review()), "T1", ALL)).toMatchObject({ ok: false, missing: "test" });
    const owed = row("test", { pass: undefined, skipped: true, infra: true, testOwed: true });
    expect(waiveProof(journal(...others(), owed, review()), "T1", ALL)).toMatchObject({ ok: false, missing: "test" });
    expect(waiveProof(journal(...others(), review()), "T1", ALL)).toMatchObject({ ok: false, missing: "test" });
    // acceptance enabled: red, absent, or a skipped pass (a generic satisfied fold) each refuse naming it
    const accRed = row("acceptance", { pass: false });
    expect(waiveProof(journal(...others(2, SUBJECT, ["acceptance"]), accRed, fullTest(), review()), "T1", ALL))
      .toMatchObject({ ok: false, missing: "acceptance" });
    expect(waiveProof(journal(...others(2, SUBJECT, ["acceptance"]), fullTest(), review()), "T1", ALL))
      .toMatchObject({ ok: false, missing: "acceptance" });
    const accSkipped = row("acceptance", { skipped: true });
    expect(waiveProof(journal(...others(2, SUBJECT, ["acceptance"]), accSkipped, fullTest(), review()), "T1", ALL))
      .toMatchObject({ ok: false, missing: "acceptance" });
    // every green row on another subject token: the parked subject has no proof
    expect(waiveProof(journal(...others(2, "other-tok"), fullTest({}, 2, "other-tok"), review()), "T1", ALL))
      .toMatchObject({ ok: false, missing: "test" });
    // a matching raw Git SHA is not the token: only the token joins
    expect(waiveProof(journal(...others(2, "other-tok"), fullTest({ head: SUBJECT }, 2, "other-tok"), review()), "T1", ALL))
      .toMatchObject({ ok: false });
  });
});
