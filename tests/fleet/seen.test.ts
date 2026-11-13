// When each CLI first listed each model: the record a probe keeps inside doctor.json.
import { describe, expect, test } from "vitest";
import { withFirstSeen } from "../../src/fleet/seen.js";
import { health } from "./world.js";

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
