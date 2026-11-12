import { afterEach, expect, test, vi } from "vitest";
import { SubprocessDriver } from "../../../src/drivers/subprocess.js";
import type { NotificationPost } from "../../../src/drivers/types.js";
import { runDaemon } from "../../../src/run/daemon.js";
import { Journal } from "../../../src/run/journal.js";
import * as locks from "../../../src/run/lock.js";
import { setupRepo, T } from "../../helpers/tmprepo.js";

afterEach(() => vi.restoreAllMocks());

async function schedulerCrash(postFailure?: Error, notifyFailure?: Error) {
  const { repo, fake } = setupRepo([T("T1", { humanGate: true })], { tasks: {} });
  const runId = "run-fatal-post";
  const cause = new Error("scheduler cause");
  const original = new Error("scheduler crashed", { cause });
  // This is the scheduler's final close boundary, after run-start and before its run-end append.
  vi.spyOn(locks, "acquireApprovalSerialization").mockRejectedValue(original);
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const post = vi.fn((value: NotificationPost) => {
    if (value.kind !== "run-end") return;
    if (postFailure) throw postFailure;
  });
  const notify = vi.fn(async (message: string) => {
    if (message.includes("run crashed") && notifyFailure) throw notifyFailure;
  });
  const driver = new SubprocessDriver();
  driver.postSync = post;
  driver.notify = notify;

  const caught = await runDaemon(repo, { adapters: [fake], driver, runId, approvalWindowMs: 0 })
    .then(() => new Error("runDaemon unexpectedly succeeded"), (error: unknown) => error);
  const lines = stderr.mock.calls.map((args) => args.map(String).join(" "));
  const postKinds = post.mock.calls.map(([value]) => value.kind);
  const posts = post.mock.calls.map(([value]) => value).filter((value) => value.kind === "run-end");
  const notices = notify.mock.calls.map(([message]) => message);
  const events = Journal.open(repo, runId).read();
  vi.restoreAllMocks();
  return { original, cause, caught, lines, postKinds, posts, notices, events };
}

test("a parked task's earlier post does not mask the scheduler crash or its run-end post", async () => {
  for (const failure of [undefined, new Error("run-end transport exploded")]) {
    const result = await schedulerCrash(failure);
    expect(result.caught).toBe(result.original);
    expect(result.postKinds).toEqual(["park", "run-end"]);
    expect(result.posts).toHaveLength(1);
    expect(result.lines).toEqual(failure
      ? [`tickmarkr: run-end post failed: ${failure.message} — original error: ${result.original.message}`]
      : []);
  }
});

test("test: a scheduler crash whose run end post throws reaches the caller as the same error object with one stderr line naming the post failure and the notify still called", async () => {
  const failure = new Error("post transport exploded");
  const { original, cause, caught, lines, posts, notices, events } = await schedulerCrash(failure);

  expect(caught).toBe(original);
  expect((caught as Error).message).toBe(original.message);
  expect((caught as Error).stack).toBe(original.stack);
  expect((caught as Error).cause).toBe(cause);
  expect(lines).toEqual([`tickmarkr: run-end post failed: ${failure.message} — original error: ${original.message}`]);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ kind: "run-end", text: expect.stringContaining("run ended") });
  expect(notices.filter((message) => message.includes("run crashed"))).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ event: "run-end", data: { fatal: true, phase: "scheduler", error: original.message } });
});

test("test: a crash with a healthy post prints no extra line and a crash whose post and notify both throw still reaches the caller unchanged", async () => {
  const healthy = await schedulerCrash();
  expect(healthy.caught).toBe(healthy.original);
  expect(healthy.posts).toHaveLength(1);
  expect(healthy.notices.filter((message) => message.includes("run crashed"))).toHaveLength(1);
  expect(healthy.lines).toEqual([]);

  const failure = new Error("post transport exploded");
  const bothFail = await schedulerCrash(failure, new Error("notify transport exploded"));
  expect(bothFail.caught).toBe(bothFail.original);
  expect((bothFail.caught as Error).stack).toBe(bothFail.original.stack);
  expect((bothFail.caught as Error).cause).toBe(bothFail.cause);
  expect(bothFail.posts).toHaveLength(1);
  expect(bothFail.notices.filter((message) => message.includes("run crashed"))).toHaveLength(1);
  expect(bothFail.lines).toEqual([`tickmarkr: run-end post failed: ${failure.message} — original error: ${bothFail.original.message}`]);
});
