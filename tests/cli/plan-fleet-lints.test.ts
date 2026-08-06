import { describe, expect, test } from "vitest";
import { writeDoctor } from "../../src/adapters/registry.js";
import { plan } from "../../src/cli/commands/plan.js";
import { saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";
import { authedModels, makeRepo } from "../helpers/tmprepo.js";

// The pair text is byte-pinned by tests/fixtures/brand-surfaces/plan-lints.txt (a fixture this task does not
// own), so the two lints are separated by their own texts and repairs rather than by rewording that one.
const ZERO_CHANNEL_LINT = "review: review.required is set but no channel can route — the fleet is empty; install or authenticate an adapter";
const CROSS_VENDOR_PAIR_LINT = "review: no cross-vendor reviewer pair in fleet — set review.required: false to waive";

const NO_CHANNELS_DOCTOR = {
  "claude-code": { installed: false, authed: false, models: [] },
  codex: { installed: false, authed: false, models: [] },
  "cursor-agent": { installed: false, authed: false, models: [] },
  opencode: { installed: false, authed: false, models: [] },
  pi: { installed: false, authed: false, models: [] },
};

const SINGLE_VENDOR_DOCTOR = {
  ...NO_CHANNELS_DOCTOR,
  "claude-code": {
    installed: true,
    authed: true,
    models: [],
    modelAuth: authedModels(["fable", "opus", "sonnet", "haiku"]),
  },
};

function repoWithDoctor(health: Parameters<typeof writeDoctor>[1]): string {
  const repo = makeRepo({ "keep.txt": "x\n" });
  saveGraph(repo, validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["p"], hash: "h" },
    tasks: [{ id: "T1", title: "t", goal: "g", shape: "chore", complexity: 2, acceptance: ["a"] }],
  }));
  writeDoctor(repo, health);
  return repo;
}

describe("plan review fleet lints", () => {
  test("test: with review.required and zero discovered channels, plan lints that no channel can route instead of staying silent", async () => {
    const out = await plan([], repoWithDoctor(NO_CHANNELS_DOCTOR));

    expect(out).toContain(ZERO_CHANNEL_LINT);
    expect(out).not.toContain(CROSS_VENDOR_PAIR_LINT);
  });

  test("test: with review.required and a non-empty single-vendor fleet, the cross-vendor pair lint still fires and the zero-channel lint does not", async () => {
    const out = await plan([], repoWithDoctor(SINGLE_VENDOR_DOCTOR));

    expect(out).toContain(CROSS_VENDOR_PAIR_LINT);
    expect(out).not.toContain(ZERO_CHANNEL_LINT);
  });

  test("test: the zero-channel lint and the pair lint are distinct texts, each naming its own repair", async () => {
    const zeroChannelOut = await plan([], repoWithDoctor(NO_CHANNELS_DOCTOR));
    const singleVendorOut = await plan([], repoWithDoctor(SINGLE_VENDOR_DOCTOR));

    expect(ZERO_CHANNEL_LINT).not.toBe(CROSS_VENDOR_PAIR_LINT);
    // an empty fleet is repaired by making ANY channel routable — never by naming a vendor pair it cannot have
    expect(zeroChannelOut).toContain(ZERO_CHANNEL_LINT);
    expect(ZERO_CHANNEL_LINT).toContain("install or authenticate an adapter");
    expect(zeroChannelOut).not.toContain("cross-vendor reviewer pair");
    // a single-vendor fleet is repaired at the vendor dimension, or waived — never by installing anything
    expect(singleVendorOut).toContain(CROSS_VENDOR_PAIR_LINT);
    expect(CROSS_VENDOR_PAIR_LINT).toContain("set review.required: false to waive");
    expect(singleVendorOut).not.toContain("install or authenticate an adapter");
  });
});
