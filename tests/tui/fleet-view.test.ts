import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createFleetView, foldChannelHealth, type FleetViewData } from "../../src/tui/views/fleet-view.js";

// Every fixture in this file is built inline in memory — no tmpdir, no repo, no files. That is
// the point: the view's render path consumes injected data only.
function fixture(): FleetViewData {
  return {
    doctorAgeMs: 12 * 60_000,
    adapters: [
      {
        adapter: "claude-code",
        models: [
          { model: "fable", tier: "frontier", channel: "sub" },
          { model: "sonnet", tier: "mid", channel: "sub" },
        ],
      },
      {
        adapter: "pi",
        models: [{ model: "zai/glm-5.2", tier: "mid", channel: "sub" }],
      },
    ],
    health: {
      "claude-code": {
        installed: true,
        authed: true,
        version: "2.1.205",
        models: ["fable", "sonnet"],
        modelAuth: {
          fable: { authed: true, probedAt: "2026-07-21T10:00:00.000Z" },
          sonnet: { authed: false, reason: "probe timed out after 60000ms", probedAt: "2026-07-21T10:01:00.000Z" },
        },
      },
      pi: {
        installed: true,
        authed: true,
        version: "0.80.3",
        models: ["zai/glm-5.2"],
        modelAuth: {
          "zai/glm-5.2": { authed: true, probedAt: "2026-07-21T09:00:00.000Z" },
        },
      },
    },
    denyAdapters: [],
    denyModels: ["pi:zai/glm-5.2"],
    notes: {
      denyModels: {
        "pi:zai/glm-5.2": "OBS-57: hangs at finish without a trailer — remove after no-trailer demotion ships",
      },
    },
    telemetry: [
      {
        taskId: "t1", shape: "implement", adapter: "pi", model: "zai/glm-5.2", channel: "sub",
        attempts: 1, outcome: "done", durationMs: 120_000, runId: "run-20260720-101112",
      },
      {
        taskId: "t2", shape: "implement", adapter: "pi", model: "zai/glm-5.2", channel: "sub",
        attempts: 2, outcome: "failed", durationMs: 240_000, overrun: true, gateFails: 1, runId: "run-20260721-101112",
      },
      {
        taskId: "t3", shape: "tests", adapter: "claude-code", model: "sonnet", channel: "sub",
        attempts: 1, outcome: "done", durationMs: 60_000, runId: "run-20260721-101112",
      },
    ],
  };
}

const VIEW_SRC = () => readFileSync(new URL("../../src/tui/views/fleet-view.ts", import.meta.url), "utf8");
const PROPS = { cols: 80, rows: 40 };

describe("fleet view — the harness roster", () => {
  test("the roster shows adapters with models tier badges and auth state from the doctor cache", () => {
    const lines = createFleetView(fixture()).render(PROPS);
    const text = lines.join("\n");
    expect(text).toContain("claude-code");
    expect(text).toContain("pi");
    expect(text).toContain("fable");
    expect(text).toContain("sonnet");
    expect(text).toContain("zai/glm-5.2");
    // tier badges ride each model row
    expect(text).toContain("[frontier]");
    expect(text).toContain("[mid]");
    // auth state from the doctor cache, with the cache age on the header
    expect(text).toContain("2.1.205");
    expect(text).toContain("authed");
    expect(text).toContain("unauthed: probe timed out after 60000ms (2026-07-21)");
    expect(text).toContain("doctor cache: 12m old");
  });

  test("a denied channel renders its provenance note beside the denied marker", () => {
    const lines = createFleetView(fixture()).render(PROPS);
    const row = lines.find((l) => l.includes("zai/glm-5.2") && l.includes("denied"));
    expect(row).toBeDefined();
    expect(row!).toContain("✗ denied");
    expect(row!).toContain("OBS-57: hangs at finish without a trailer");
    // beside = after, on the same row
    expect(row!.indexOf("denied")).toBeLessThan(row!.indexOf("OBS-57"));

    // an adapter-level deny reaches every channel under it, carrying the ADAPTER's note: a channel
    // the router can never pick must never read as available on its own row
    const f = fixture();
    f.denyAdapters = ["claude-code"];
    f.notes = { ...f.notes, denyAdapters: { "claude-code": "OBS-12: quota exhausted until reset" } };
    const inherited = createFleetView(f).render(PROPS).find((l) => l.includes("fable"));
    expect(inherited).toBeDefined();
    expect(inherited!).toContain("✗ denied");
    expect(inherited!).toContain("OBS-12: quota exhausted until reset");
  });

  test("the detail panel shows the selected channel's health digest from recent journals", () => {
    const view = createFleetView(fixture());
    // rows: 0 claude-code header, 1 fable, 2 sonnet, 3 pi header, 4 zai/glm-5.2
    for (let i = 0; i < 4; i++) view.key("down");
    expect(view.selectedChannel()).toBe("pi:zai/glm-5.2");
    const text = view.render(PROPS).join("\n");
    expect(text).toContain("── pi:zai/glm-5.2 ──");
    expect(text).toContain("tier mid · sub · authed (probed 2026-07-21) · denied");
    expect(text).toContain(
      "journals: 2 tasks · 3 attempts · 1 done · 1 failed · median 3.0m · 1 gate-fails · 1 overrun · 0 quota failovers",
    );
    expect(text).toContain("last outcome: failed");

    // a channel with no journal rows says so rather than inventing zeroes, and an unauthed reading
    // already carries its probe date — the panel must not print the same day a second time
    const sonnet = createFleetView(fixture());
    sonnet.key("down");
    sonnet.key("down");
    expect(sonnet.selectedChannel()).toBe("claude-code:sonnet");
    const panel = sonnet.render(PROPS).join("\n");
    expect(panel).toContain("unauthed: probe timed out after 60000ms (2026-07-21) · enabled");
    expect(panel).not.toContain("(2026-07-21) (probed");

    // a channel with no journal rows says so rather than inventing a row of zeroes
    sonnet.key("up");
    expect(sonnet.selectedChannel()).toBe("claude-code:fable");
    expect(sonnet.render(PROPS).join("\n")).toContain("journals: no recent telemetry for this channel");
  });

  test("expand and collapse toggles an adapter's model rows", () => {
    const view = createFleetView(fixture());
    expect(view.expanded("claude-code")).toBe(true);
    expect(view.render(PROPS).join("\n")).toContain("fable");

    view.key("left"); // cursor starts on the claude-code header row
    expect(view.expanded("claude-code")).toBe(false);
    const collapsed = view.render(PROPS).join("\n");
    expect(collapsed).toContain("claude-code");
    expect(collapsed).not.toContain("fable");
    expect(collapsed).not.toContain("sonnet");

    view.key("right");
    expect(view.expanded("claude-code")).toBe(true);
    expect(view.render(PROPS).join("\n")).toContain("fable");

    // space toggles the same adapter off again
    view.key("space");
    expect(view.expanded("claude-code")).toBe(false);
    expect(view.render(PROPS).join("\n")).not.toContain("fable");
  });

  test("the view renders from injected fixture data with no filesystem access inside the render path", () => {
    // the fixture is plain in-memory data; rendering it must produce the full roster
    const text = createFleetView(fixture()).render(PROPS).join("\n");
    expect(text).toContain("Fleet view — harness roster");
    expect(text).toContain("zai/glm-5.2");
    // and the module itself can never reach the filesystem: no fs import of any form
    const src = VIEW_SRC();
    expect(src).not.toMatch(/from\s+["'](?:node:)?fs["']/);
    expect(src).not.toMatch(/require\(\s*["'](?:node:)?fs["']\s*\)/);
    expect(src).not.toMatch(/\b(readFileSync|writeFileSync|appendFileSync|existsSync|readdirSync|statSync)\b/);
  });

  test("the health digest derives from journal telemetry rather than any new state file", () => {
    // the fold consumes TelemetryRow-shaped journal rows directly and recomputes deterministically
    const digest = foldChannelHealth(fixture().telemetry);
    expect(foldChannelHealth(fixture().telemetry)).toEqual(digest);
    expect(digest.get("pi:zai/glm-5.2")).toEqual({
      key: "pi:zai/glm-5.2",
      tasks: 2,
      attempts: 3,
      done: 1,
      failed: 1,
      human: 0,
      overruns: 1,
      quotaFailovers: 0,
      gateFails: 1,
      medianDurationMs: 180_000,
      lastOutcome: "failed",
    });
    // the module's only telemetry source is the journal's TelemetryRow type — no state-file reads
    const src = VIEW_SRC();
    expect(src).toMatch(/import\s+type\s*\{[^}]*TelemetryRow[^}]*\}\s*from\s*["'][^"']*journal\.js["']/);
  });
});
