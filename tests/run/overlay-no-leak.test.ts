// HARD-06 anti-leak tripwire — nothing propagates today; this oracle reddens if a future "fix"
// copies the gitignored overlay into merged history. Red-capability proven in Task 2 Drill 3
// (38-DIAGNOSIS.md).

import { describe, expect, test } from "vitest";
import { runDaemon } from "../../src/run/daemon.js";
import { shOk } from "../../src/run/git.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

describe("HARD-06 overlay anti-leak (D-05 tripwire)", () => {
  test("Oracle 3: the gitignored overlay never enters the integration branch", async () => {
    const { repo, fake } = setupRepo(
      [T("T1", { files: ["**"] })],
      { tasks: { T1: [{ shell: `echo one > t1.txt && ${COMMIT} t1`, result: { ok: true, summary: "t1" } }] } },
      `gates: { test: "true" }\nreview: { complexityThreshold: 99, required: false }\n`,
    );
    const s = await runDaemon(repo, { adapters: [fake], runId: "run-noleak" });
    expect(s.done).toEqual(["T1"]);

    const patch = await shOk(`git log -p ${s.branch}`, repo);
    expect(patch).not.toContain(".tickmarkr/config.yaml");

    const tree = await shOk(`git ls-tree -r --name-only ${s.branch}`, repo);
    expect(tree).not.toContain(".tickmarkr/");
  });
});
