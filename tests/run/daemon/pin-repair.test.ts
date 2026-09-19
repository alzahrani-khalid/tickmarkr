// v2.5.6 T5 (OBS-1034): the pin hosts its own review-upheld repair, and a capped repair brief says what it cut.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FakeAdapter } from "../../../src/adapters/fake.js";
import { channelKey, shq } from "../../../src/adapters/types.js";
import { extractPromptNonce } from "../../../src/gates/llm.js";
import { approve } from "../../../src/cli/commands/approve.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal, type JournalEvent } from "../../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../../helpers/tmprepo.js";

/** retry.test.ts's closing responder: every carried fingerprint is echoed back, so a later round is a verdict and never a closure mismatch. */
function closingReview(fake: FakeAdapter, scriptPath: string, disposition: "resolved" | "reraised"): FakeAdapter {
  const headless = fake.headlessCommand.bind(fake);
  fake.headlessCommand = (promptFile, model) => {
    const prompt = readFileSync(promptFile, "utf8");
    if (!prompt.startsWith("TICKMARKR-REVIEW")) return headless(promptFile, model);
    const prior = prompt.match(/## Prior materials this attempt must close\n([\s\S]*?)\n## Diff/)?.[1] ?? "";
    const fingerprints = [...prior.matchAll(/^Fingerprint: (.+)$/gm)].map((match) => match[1]);
    const { review } = JSON.parse(readFileSync(scriptPath, "utf8")) as { review: object };
    return `printf '%s\\n' ${shq(JSON.stringify({
      ...review, nonce: extractPromptNonce(prompt), resolved: [], reraised: [], [disposition]: fingerprints,
    }))}`;
  };
  return fake;
}

const BIG = "x".repeat(60).concat("\n").repeat(40); // 2 440 raw diff bytes when deleted; ~0 reviewable-logic bytes

/** A task whose worker deletes a big tracked file (raw diff far over the brief cap, logic diff tiny) and whose reviewer rejects with material findings. */
const upheldRun = async (runId: string, pin: boolean) => {
  const { repo, fake, scriptPath } = setupRepo(
    [T("T1", { complexity: 8, files: ["big.txt", "t1.txt"], acceptance: [{ oracle: "command", command: "true" }],
      ...(pin ? { routingHints: { pin: { via: "fake", model: "fake-1" } } } : {}) })],
    {
      review: { approve: false, findings: [{ note: "`t1.txt` line 1 says one where the spec wants two", severity: "material" }] },
      consult: { action: "human", notes: "must never fire" },
      tasks: { T1: [
        { shell: `git rm -q big.txt && echo one > t1.txt && ${COMMIT} v1`, result: { ok: true, summary: "v1" } },
        { shell: `echo one-again > t1.txt && ${COMMIT} v2`, result: { ok: true, summary: "v2" } },
        { shell: `echo two > t1.txt && ${COMMIT} v3`, result: { ok: true, summary: "v3" } },
      ] },
    },
    "gates: { diffCap: 1200 }\n",
  );
  writeFileSync(join(repo, "big.txt"), BIG);
  const { execSync } = await import("node:child_process");
  execSync("git add big.txt && git commit --no-gpg-sign -qm big", { cwd: repo });
  const first = await runDaemon(repo, { adapters: [closingReview(fake, scriptPath, "reraised")], runId });
  expect(first.human).toEqual(["T1"]);
  const parked = Journal.open(repo, runId).read();
  expect(parked.find((e) => e.event === "task-human")?.data.kind).toBe("gate-fail");
  const rounds = parked.filter((e) => e.event === "task-dispatch").length;
  await approve([runId, "T1", "--uphold", "--by", "operator"], repo);
  const script = JSON.parse(readFileSync(scriptPath, "utf8")) as Record<string, unknown>;
  writeFileSync(scriptPath, JSON.stringify({ ...script, review: { approve: true, issues: [] } }));
  const resumed = await runDaemon(repo, { adapters: [closingReview(new FakeAdapter(scriptPath), scriptPath, "resolved")], runId, resume: true });
  const all = Journal.open(repo, runId).read();
  const idx = all.map((e) => e.event).lastIndexOf("run-resume");
  const post = all.slice(idx + 1);
  const dispatch = post.find((e) => e.event === "task-dispatch" && e.taskId === "T1")!;
  expect(dispatch).toBeDefined();
  const prompts = join(Journal.open(repo, runId).dir, "prompts");
  const prompt = readFileSync(join(prompts, `T1-a${dispatch.data.attempt}.md`), "utf8");
  return { repo, resumed, parked, post, rounds, dispatch, prompt, all };
};

const of = (evs: JournalEvent[], event: string) => evs.filter((e) => e.event === event && e.taskId === "T1");

describe("v2.5.6 T5 — the pin hosts its own repair", () => {
  test("test: a pinned task upheld after its own attempt re-dispatches the review-fix repair on the pinned seat, a capped repair brief journals the dropped files on the repair-dispatch row and the worker prompt states that the diff is partial naming the cut, and an unpinned task keeps excluding its tried seats, so a pin excluded from its own repair or a capped brief that hides its cut from the row or the worker fails", async () => {
    // ---- pinned: every prior attempt sat on the pin, and the funded fix lands on it too ------------
    const pinned = await upheldRun("run-pin-repair", true);
    for (const d of of(pinned.parked, "task-dispatch")) expect(channelKey(d.data.assignment as { adapter: string; model: string })).toBe("fake:fake-1");
    expect(channelKey(pinned.dispatch.data.assignment as { adapter: string; model: string })).toBe("fake:fake-1");
    expect(pinned.dispatch.data.retryMode).toBe("repair");
    expect(pinned.prompt).toMatch(/UPHELD/);
    // the brief was capped: the row names the files the cap dropped, and the worker is told the diff is partial
    const repair = of(pinned.post, "repair-dispatch")[0]!;
    expect(repair).toBeDefined();
    expect(repair.data.capped).toBe(true);
    expect(repair.data.droppedFiles).toEqual(expect.arrayContaining(["big.txt"]));
    expect(pinned.prompt).toMatch(/PARTIAL DIFF: the diff above is incomplete; files cut by the cap: .*big\.txt/);
    expect(pinned.resumed.done).toEqual(["T1"]);
    // ---- unpinned: the tried seat stays excluded and the fix goes to the next seat ------------------
    const free = await upheldRun("run-free-repair", false);
    expect(channelKey(free.dispatch.data.assignment as { adapter: string; model: string })).toBe("fake:fake-2");
    expect(free.dispatch.data.excludedChannels).toContain("fake:fake-1");
    expect(free.resumed.done).toEqual(["T1"]);
  }, 300_000);
});
