import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import type { BillingChannel } from "../../src/adapters/types.js";
import type { ChannelResult } from "../../src/eval/dispatch.js";
import { appendChannelResult, fixtureRevisionHash, readReport } from "../../src/eval/report.js";
import type { Fixture } from "../../src/eval/fixtures.js";

function tempFixture(id: string, contents: { start: Record<string, string>; solution?: Record<string, string> }): Fixture {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-report-"));
  const dir = join(root, id);
  mkdirSync(join(dir, "start"), { recursive: true });
  mkdirSync(join(dir, "solution"), { recursive: true });
  for (const [p, content] of Object.entries(contents.start)) {
    const fp = join(dir, "start", p);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content);
  }
  if (contents.solution) {
    for (const [p, content] of Object.entries(contents.solution)) {
      const fp = join(dir, "solution", p);
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, content);
    }
  }
  return { id, path: dir, startDir: join(dir, "start"), solutionDir: join(dir, "solution") };
}

function channelResult(model: string, channel: "sub" | "api" = "sub", opts: Partial<ChannelResult> = {}): ChannelResult {
  const billingChannel: BillingChannel = {
    adapter: "test-adapter",
    vendor: "test-vendor",
    model,
    channel,
    tier: "frontier",
  };
  return {
    channel: billingChannel,
    channelKey: `test-adapter:${model}`,
    skipped: false,
    ...opts,
  };
}

function tempOutput(): string {
  return join(mkdtempSync(join(tmpdir(), "tickmarkr-report-out-")), "results.jsonl");
}

describe("incremental JSON report", () => {
  test("a result is appended to the output file as soon as its channel finishes, before any remaining channel completes", async () => {
    const fixture = tempFixture("fx", { start: { "a.txt": "a" } });
    const out = tempOutput();

    const firstResult = channelResult("m1");
    const secondResult = channelResult("m2", "api");

    const first = new Promise<ChannelResult>((resolve) => setTimeout(() => resolve(firstResult), 10));
    const second = new Promise<ChannelResult>((resolve) => setTimeout(() => resolve(secondResult), 50));

    appendChannelResult(out, fixture, await first, "2026-07-22T12:00:00.000Z");
    const mid = readFileSync(out, "utf8").trim().split("\n").filter(Boolean);
    expect(mid).toHaveLength(1);

    appendChannelResult(out, fixture, await second, "2026-07-22T12:00:01.000Z");
    const final = readReport(out);
    expect(final).toHaveLength(2);
  });

  test("an interrupted run leaves every already-written result readable and valid on disk", () => {
    const fixture = tempFixture("fx", { start: { "a.txt": "a" } });
    const out = tempOutput();

    appendChannelResult(out, fixture, channelResult("m1"), "2026-07-22T12:00:00.000Z");
    appendChannelResult(out, fixture, channelResult("m2", "api"), "2026-07-22T12:00:01.000Z");
    // Simulate a crash tearing off the third append mid-write.
    writeFileSync(out, '{"incomplete":', { flag: "a" });

    const rows = readReport(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.channel.model).toBe("m1");
    expect(rows[1]?.channel.model).toBe("m2");
    expect(() => JSON.parse(readFileSync(out, "utf8").split("\n")[0]!)).not.toThrow();
    expect(() => JSON.parse(readFileSync(out, "utf8").split("\n")[1]!)).not.toThrow();
  });

  test("each written result names the fixture, the channel, and a content identity for the fixture revision it ran against", () => {
    const fixture = tempFixture("fx", { start: { "a.txt": "hello" }, solution: { "a.txt": "world" } });
    const out = tempOutput();
    const result = channelResult("m1", "sub", {
      worker: { ok: true, summary: "ok", deviations: [], raw: "raw" },
      acceptance: { pass: true, details: "passed" },
    });

    appendChannelResult(out, fixture, result, "2026-07-22T12:00:00.000Z");

    const rows = readReport(out);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.fixture.id).toBe("fx");
    expect(row.fixture.revision).toBe(fixtureRevisionHash(fixture));
    expect(row.channel.adapter).toBe("test-adapter");
    expect(row.channel.model).toBe("m1");
    expect(row.channel.channel).toBe("sub");
    expect(row.channel.channelKey).toBe("test-adapter:m1");
  });

  test("two separate invocations of the same fixture against the same channel produce results distinguishable by their recorded run time", () => {
    const fixture = tempFixture("fx", { start: { "a.txt": "a" } });
    const out = tempOutput();

    appendChannelResult(out, fixture, channelResult("m1"), "2026-07-22T12:00:00.000Z");
    appendChannelResult(out, fixture, channelResult("m1"), "2026-07-22T12:00:05.000Z");

    const rows = readReport(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.runAt).not.toBe(rows[1]!.runAt);
    expect(rows[0]!.runAt).toBe("2026-07-22T12:00:00.000Z");
    expect(rows[1]!.runAt).toBe("2026-07-22T12:00:05.000Z");
  });
});
