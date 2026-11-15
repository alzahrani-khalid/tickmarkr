// When each CLI first listed each model: the record a probe keeps inside doctor.json.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readDoctor, readModelsFirstSeen, writeDoctor } from "../../src/adapters/registry.js";
import type { AuthHealth } from "../../src/adapters/types.js";
import { withFirstSeen } from "../../src/fleet/seen.js";
import { health } from "./world.js";

// Queue row 461; D-2187 add.256: the contract's T8 case table (K1-K5, A1-A5, W1-W3).
const AT = new Date("2026-11-14T00:00:00Z");
const NOW_ISO = AT.toISOString();
const CARBON = "google/gemini-4-carbon";
const h = (models: string[]): AuthHealth => ({ installed: true, authed: true, models });
const dated = (fs: Record<string, Record<string, string>>) =>
  Object.entries(fs).flatMap(([a, m]) => Object.entries(m).filter(([, at]) => at).map(([id, at]) => [a, id, at]));

describe("new models", () => {
  test("an adapter's first record is a baseline that dates nothing; a later probe dates only what it had not listed", () => {
    const first = withFirstSeen(null, health(), new Date("2026-11-06T00:00:00Z"));
    expect(new Set(Object.values(first).flatMap((m) => Object.values(m)))).toEqual(new Set([""]));
    const later = withFirstSeen(first, health([], { omp: ["google/gemini-4-carbon"] }), new Date("2026-11-10T00:00:00Z"));
    expect(Object.entries(later).flatMap(([a, m]) => Object.entries(m).filter(([, at]) => at).map(([id, at]) => [a, id, at])))
      .toEqual([["omp", "google/gemini-4-carbon", "2026-11-10T00:00:00.000Z"]]);
    // a CLI installed later starts with its own baseline; a scoped probe keeps the adapters it did not touch
    const added = withFirstSeen(first, { newcli: { installed: true, authed: true, models: ["m1"] } }, new Date("2026-11-11T00:00:00Z"));
    expect(added.newcli).toEqual({ m1: "" });
    expect(added.omp).toEqual(first.omp);
  });
});

describe("the first probe after an upgrade (row 461)", () => {
  test("after an upgrade from a record with no first-seen key, a model the prior record listed is the baseline and one it did not list is dated now", () => {
    // A4 + A5: the prior list holds "a", lacks Carbon
    const prior = { omp: h(["a"]) };
    const out = withFirstSeen(null, { omp: h(["a", CARBON]) }, AT, prior);
    expect(out).toEqual({ omp: { a: "", [CARBON]: NOW_ISO } });
    // A5 bait: the prior list must come from the prior record, never from the health being written
    expect(withFirstSeen(null, { omp: h(["a", CARBON]) }, AT, { omp: h(["a", CARBON]) })).toEqual({ omp: { a: "", [CARBON]: "" } });
  });

  test("with no first-seen key an adapter with no prior list of names stays a baseline", () => {
    const probe = { omp: h(["a", CARBON]) };
    const base = { omp: { a: "", [CARBON]: "" } };
    // A1: no doctor.json (null/undefined), or one that does not parse (readDoctorFile gives null)
    for (const none of [null, undefined]) expect(withFirstSeen(null, probe, AT, none)).toEqual(base);
    // A2: the prior record does not name the adapter
    expect(withFirstSeen(null, probe, AT, { other: h(["x"]) })).toEqual(base);
    // A3: models absent, empty, a string, holding a non-string; the entry not a map
    for (const entry of [{ installed: true }, h([]), { models: "a,b" }, { models: ["a", 7] }, "omp", 3, ["a"], null]) {
      expect(withFirstSeen(null, probe, AT, { omp: entry })).toEqual(base);
    }
  });

  test("a first-seen key that is present, even malformed, decides alone: the prior record's list neither dates nor re-dates a model", () => {
    const listed = { omp: h(["a", "b"]) };
    // K1: a recorded model keeps its value, even beside a prior list that lacks it
    const key = { omp: { a: "2026-11-01T00:00:00.000Z", c: "" } };
    expect(withFirstSeen(key, { omp: h(["a", "c"]) }, AT, { ...listed, modelsFirstSeen: key })).toEqual(key);
    // K2: not recorded, not in the prior list → dated now
    expect(withFirstSeen(key, { omp: h(["a", "d"]) }, AT, { ...listed, modelsFirstSeen: key }).omp.d).toBe(NOW_ISO);
    // K3: not recorded but in the prior list → still dated now (the key decides)
    expect(withFirstSeen(key, { omp: h(["b"]) }, AT, { ...listed, modelsFirstSeen: key }).omp.b).toBe(NOW_ISO);
    // K4: a malformed key, with a non-empty prior list lacking the probed model → nothing dated
    for (const bad of ["word", 7, ["x"], null, { omp: "x" }, { omp: [] }, { omp: {} }]) {
      const out = withFirstSeen(bad, { omp: h([CARBON]) }, AT, { ...listed, modelsFirstSeen: bad });
      expect(dated(out)).toEqual([]);
    }
    // K5: a partly malformed record whose other entry survives → dated now, as 2.26.0
    const partial = { omp: { other: 7 } };
    expect(withFirstSeen(partial, { omp: h(["a"]) }, AT, { ...listed, modelsFirstSeen: partial }).omp).toEqual({ other: "", a: NOW_ISO });
  });

  const repoWith = (prior: Record<string, unknown>) => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-seen-upgrade-"));
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    // as 2.25.0 wrote it: the adapters, no first-seen key
    writeFileSync(join(repo, ".tickmarkr", "doctor.json"), JSON.stringify(prior, null, 2) + "\n");
    return repo;
  };

  test("through the doctor writer the first probe after an upgrade dates exactly the unlisted models and the next probe keeps those dates", () => {
    const before = { ...health(), agy: h(["gemini-3-pro"]) };
    const repo = repoWith(before);
    try {
      const probe = { ...health([], { omp: [CARBON], "cursor-agent": [CARBON] }), agy: h(["gemini-3-pro", CARBON]) };
      // W1
      writeDoctor(repo, probe);
      const w1 = readModelsFirstSeen(repo)!;
      const w1Dated = dated(w1);
      expect(w1Dated.map(([a, id]) => [a, id]).sort()).toEqual([["agy", CARBON], ["cursor-agent", CARBON], ["omp", CARBON]]);
      expect(Object.keys(w1).sort()).toEqual(Object.keys(probe).sort());
      expect(readDoctor(repo)).not.toHaveProperty("modelsFirstSeen");
      // W2: the next probe, same lists, keeps W1's dates and dates nothing else
      writeDoctor(repo, probe);
      expect(readModelsFirstSeen(repo)).toEqual(w1);
      expect(readDoctor(repo)).not.toHaveProperty("modelsFirstSeen");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a scoped doctor write over a record with no first-seen key dates only what the scoped adapter's own prior list lacked", () => {
    const before = health();
    const repo = repoWith(before);
    try {
      // W3: only omp is probed; its verdict lists Carbon
      const ompModels = [...before.omp.models!, CARBON];
      const verdict = { omp: { ...before.omp, models: ompModels, modelAuth: { ...before.omp.modelAuth, [CARBON]: { authed: true, probedAt: "2026-11-14T00:00:00Z" } } } };
      writeDoctor(repo, verdict, [{ adapter: "omp", model: CARBON }]);
      const fs = readModelsFirstSeen(repo)!;
      expect(dated(fs)).toEqual([["omp", CARBON, expect.any(String)]]);
      expect(Object.keys(fs).sort()).toEqual(Object.keys(before).sort());
      expect(readDoctor(repo)).not.toHaveProperty("modelsFirstSeen");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
