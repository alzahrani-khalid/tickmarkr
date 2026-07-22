import { beforeEach, describe, expect, test, vi } from "vitest";
import type { BillingChannel } from "../../src/adapters/types.js";
import { candidateRow, costSignal, shapeCandidates } from "../../src/cli/commands/fleet-picker.js";
import { DEFAULT_CONFIG, INTEGRITY_FLOOR_SHAPES, type TickmarkrConfig } from "../../src/config/config.js";
import { SHAPES } from "../../src/graph/schema.js";
import { createRoutingView, routingPreviewTask } from "../../src/tui/views/routing-view.js";

// Delegation oracle (judge criterion): wrap the shared picker glue in a call-through spy so the
// tests can assert the inspector ranks through it rather than reimplementing candidate ordering.
vi.mock("../../src/cli/commands/fleet-picker.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/cli/commands/fleet-picker.js")>();
  return { ...mod, shapeCandidates: vi.fn(mod.shapeCandidates) };
});

// Same live-channel fixture as tests/route/candidates.test.ts: subs across all three tiers plus
// one api channel, so both cost economics and a below-floor row show up in the ranking.
const CH: BillingChannel[] = [
  { adapter: "claude-code", vendor: "anthropic", model: "fable", channel: "sub", tier: "frontier" },
  { adapter: "claude-code", vendor: "anthropic", model: "sonnet", channel: "sub", tier: "mid" },
  { adapter: "codex", vendor: "openai", model: "gpt-5.6-terra", channel: "sub", tier: "mid" },
  { adapter: "cursor-agent", vendor: "cursor", model: "composer-2.5", channel: "sub", tier: "mid" },
  { adapter: "opencode", vendor: "mixed", model: "moonshotai/kimi-k2", channel: "api", tier: "cheap" },
];

const cfg: TickmarkrConfig = structuredClone(DEFAULT_CONFIG);
const data = { cfg, channels: CH };
const FRAME = { cols: 80, rows: 24 };

// grid rows render as "❯ <shape…" (selected) or "  <shape…" — the two-char prefix is the cursor
const gridRow = (lines: string[], shape: string) => lines.find((l) => l.slice(2).startsWith(shape));

beforeEach(() => vi.clearAllMocks());

describe("routing view — the policy grid (v1.66 T4)", () => {
  test("the grid renders every shape with its floor pin and prefer chain", () => {
    const view = createRoutingView({ data });
    const lines = view.render(FRAME);
    for (const shape of SHAPES) expect(gridRow(lines, shape), shape).toBeDefined();

    const plan = gridRow(lines, "plan")!;
    expect(plan).toContain("frontier"); // floor
    expect(plan).toContain("claude-code:fable"); // map pin

    const implement = gridRow(lines, "implement")!;
    expect(implement).toContain("mid");
    expect(implement).toContain("cursor-agent, codex"); // prefer chain, config order

    const tests = gridRow(lines, "tests")!;
    expect(tests).toContain("cheap");
    expect(tests).toContain("opencode");

    // unset cells render an explicit placeholder, never a silent blank
    expect(gridRow(lines, "docs")).toContain("—");
  });

  test("integrity-set shapes carry the never-below-frontier marker", () => {
    const view = createRoutingView({ data });
    const lines = view.render(FRAME);
    for (const shape of INTEGRITY_FLOOR_SHAPES) {
      expect(gridRow(lines, shape), shape).toContain("*");
    }
    const rest = SHAPES.filter((s) => !(INTEGRITY_FLOOR_SHAPES as readonly string[]).includes(s));
    for (const shape of rest) {
      expect(gridRow(lines, shape), shape).not.toContain("*");
    }
    expect(lines.some((l) => l.includes("never below frontier"))).toBe(true);
  });

  test("the candidate inspector rows for a shape match the existing picker ranking for the same inputs", () => {
    const view = createRoutingView({ data });
    view.openInspector("ui");
    const expected = shapeCandidates(routingPreviewTask("ui"), cfg, CH).map((c) => candidateRow(c, cfg.pricing));
    expect(expected.length).toBeGreaterThan(0);
    // exact ordered equality against the shared picker ranking for the identical inputs
    expect(view.inspectorRows()).toEqual(expected);
    const lines = view.render(FRAME);
    for (const row of expected) expect(lines.some((l) => l.includes(row)), row).toBe(true);
  });

  test("the inspector shows each candidate's cost signal and provenance line", () => {
    const view = createRoutingView({ data });
    view.openInspector("ui");
    const text = view.render(FRAME).join("\n");
    const ranked = shapeCandidates(routingPreviewTask("ui"), cfg, CH);
    expect(ranked.length).toBeGreaterThan(0);
    for (const c of ranked) {
      expect(text).toContain(costSignal(c.assignment, cfg.pricing));
      expect(text).toContain(c.why); // route provenance, verbatim
    }
    // both channel economics surface: api channels render a per-task estimate, subs never fake dollars
    expect(text).toContain("api ~$");
    expect(text).toContain("sub flat-rate quota");
  });

  test("the grid header names the active routing mode", () => {
    const staff = createRoutingView({ data: { ...data, mode: "staff-led" } });
    expect(staff.render(FRAME).some((l) => l.includes("mode: staff-led"))).toBe(true);
    // absent a mode declaration the header names the risk-based default
    const dflt = createRoutingView({ data });
    expect(dflt.render(FRAME).some((l) => l.includes("mode: risk-based"))).toBe(true);
  });

  test("the inspector delegates candidate ordering to the shared picker ranking", () => {
    const view = createRoutingView({ data });
    view.openInspector("migration");
    expect(shapeCandidates).toHaveBeenCalledTimes(1);
    const call = vi.mocked(shapeCandidates).mock.calls[0]!;
    expect(call[0]).toEqual(routingPreviewTask("migration")); // same task inputs the picker ranks
    expect(call[1]).toBe(cfg);
    expect(call[2]).toBe(CH);
  });

  test("moving the grid cursor changes the shape the inspector opens for", () => {
    const view = createRoutingView({ data });
    expect(view.selectedShape).toBe("plan");
    view.moveCursor(1);
    expect(view.selectedShape).toBe("spec");
    view.openInspector();
    expect(view.render(FRAME).some((l) => l.includes("candidates: spec"))).toBe(true);
    view.closeInspector();
    expect(view.inspectorRows()).toBeNull();
  });
});
