import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  createConsultDossierPanel,
  foldConsultVerdicts,
  translatePromptContent,
  type ConsultDossierData,
} from "../../src/tui/views/consult-dossier.js";
import type { JournalEvent } from "../../src/run/journal.js";

const ts = "2026-07-22T08:00:00.000Z";

const event = (e: Partial<JournalEvent> & { event: string; taskId?: string }): JournalEvent => ({
  ts,
  data: {},
  ...e,
} as JournalEvent);

const dispatch = (taskId: string, adapter: string, model: string, attempt = 0): JournalEvent =>
  event({ event: "task-dispatch", taskId, data: { attempt, assignment: { adapter, model, channel: "sub", tier: "cheap" } } });

const verdict = (
  taskId: string,
  action: string,
  data: Record<string, unknown> = {},
): JournalEvent => event({ event: "consult-verdict", taskId, data: { action, ...data } });

const strip = (s: string) => s.replace(/\x1b\[[\d;]*m/g, "");

/** Run fn with stdout forced to a styled TTY (brand tokens emit SGR only when isTTY && !NO_COLOR). */
const withTty = <T>(fn: () => T): T => {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const noColor = process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  delete process.env.NO_COLOR;
  try {
    return fn();
  } finally {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (noColor !== undefined) process.env.NO_COLOR = noColor;
  }
};

describe("consult dossier viewer", () => {
  test("selecting a task with recorded consult verdicts lists each verdict's action and reason in dispatch order", () => {
    const events: JournalEvent[] = [
      dispatch("T1", "fake", "model-a", 0),
      verdict("T1", "retry", { reason: "stale fixture, rerun lint" }),
      verdict("T2", "human", { reason: "not my task" }),
      dispatch("T1", "fake", "model-b", 1),
      verdict("T1", "reroute", { reason: "adapter CLI blocked", guidance: "pick another adapter" }),
    ];
    const verdicts = foldConsultVerdicts(events, "T1");
    expect(verdicts.map((v) => v.action)).toEqual(["retry", "reroute"]);

    const panel = createConsultDossierPanel();
    panel.select({ taskId: "T1", verdicts });
    const lines = panel.render().map(strip);
    const retryIdx = lines.findIndex((l) => l.includes("retry"));
    const rerouteIdx = lines.findIndex((l) => l.includes("reroute"));
    expect(retryIdx).toBeGreaterThanOrEqual(0);
    expect(rerouteIdx).toBeGreaterThan(retryIdx);
    expect(lines[retryIdx]).toContain("stale fixture, rerun lint");
    expect(lines[rerouteIdx]).toContain("adapter CLI blocked");
    // the other task's verdict never appears
    expect(lines.some((l) => l.includes("not my task"))).toBe(false);
  });

  test("opening the dossier for a selected verdict shows the persisted prompt content", () => {
    const prompt = [
      "TICKMARKR-CONSULT",
      "You are a senior engineering consult for the tickmarkr orchestrator.",
      "",
      "## Task: T1 — trigger: gate-fail",
    ].join("\n");
    const data: ConsultDossierData = {
      taskId: "T1",
      verdicts: [{ action: "retry", reason: "rerun lint", prompt }],
    };
    const panel = createConsultDossierPanel(data);

    // collapsed: the prompt content is not shown
    expect(panel.render().map(strip).some((l) => l.includes("senior engineering consult"))).toBe(false);

    panel.key("enter");
    const opened = panel.render().map(strip);
    expect(opened.some((l) => l.includes("persisted prompt"))).toBe(true);
    expect(opened.some((l) => l.includes("senior engineering consult"))).toBe(true);
    expect(opened.some((l) => l.includes("trigger: gate-fail"))).toBe(true);

    // toggling again collapses it back to the one-liner
    panel.key("enter");
    expect(panel.render().map(strip).some((l) => l.includes("senior engineering consult"))).toBe(false);
  });

  test("a task with no consult verdicts renders an explanation instead of an empty panel", () => {
    const panel = createConsultDossierPanel();
    panel.select({ taskId: "T9", verdicts: [] });
    const lines = panel.render().map(strip);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("no consult verdicts recorded for T9"))).toBe(true);
  });

  test("the panel renders from injected fixture data with no filesystem access inside the render path", () => {
    const data: ConsultDossierData = {
      taskId: "T1",
      verdicts: [
        { action: "retry", reason: "first", prompt: "persisted prompt body" },
        { action: "human", reason: "second" },
      ],
    };
    const panel = createConsultDossierPanel(data);
    panel.key("enter");
    const lines = panel.render().map(strip);
    expect(lines.some((l) => l.includes("retry"))).toBe(true);
    expect(lines.some((l) => l.includes("persisted prompt body"))).toBe(true);
    // the module itself never imports the filesystem
    const source = readFileSync("src/tui/views/consult-dossier.ts", "utf8");
    expect(source).not.toContain('from "node:fs"');
    expect(source).not.toContain('from "node:fs/promises"');
    expect(source).not.toContain('require("node:fs")');
    expect(source).not.toContain("import * as fs");
  });

  test("the persisted prompt content renders through a line-oriented translator into bold or dim headings, a dim blockquote bar prefix, and guidance's newline-separated steps as a bullet list", () => {
    withTty(() => {
      const out = translatePromptContent([
        "# Top heading",
        "",
        "## Deeper heading",
        "> quoted dossier context",
        "plain prose line",
      ].join("\n"));
      // H1 is bold, deeper headings are dim
      expect(out[0]).toBe("\x1b[1mTop heading\x1b[0m");
      expect(out[2]).toBe("\x1b[2mDeeper heading\x1b[0m");
      // blockquote renders through a dim bar prefix
      expect(out[3]).toBe("\x1b[2m│ quoted dossier context\x1b[0m");
      // everything else passes through plain
      expect(out[4]).toBe("plain prose line");
    });

    // guidance's newline-separated steps render as a bullet list inside the expanded dossier
    const panel = createConsultDossierPanel({
      taskId: "T1",
      verdicts: [{
        action: "retry",
        reason: "rerun lint",
        prompt: "prompt body",
        guidance: "rebase onto attempt 1's commit\nrerun lint locally before redispatching",
      }],
    });
    panel.key("enter");
    const lines = panel.render().map(strip);
    expect(lines.some((l) => l.includes("• rebase onto attempt 1's commit"))).toBe(true);
    expect(lines.some((l) => l.includes("• rerun lint locally before redispatching"))).toBe(true);
  });

  test("expanding the same verdict's dossier a second time without changing the selection reuses the first render's cached lines rather than re-parsing the content", () => {
    let parses = 0;
    const translate = (content: string): string[] => {
      parses++;
      return translatePromptContent(content);
    };
    const data: ConsultDossierData = {
      taskId: "T1",
      verdicts: [{ action: "retry", reason: "rerun lint", prompt: "cached prompt body" }],
    };
    const panel = createConsultDossierPanel(data, { translate });

    panel.key("enter"); // expand
    expect(panel.render().map(strip).some((l) => l.includes("cached prompt body"))).toBe(true);
    expect(parses).toBe(1);
    panel.render(); // repaints never re-parse
    expect(parses).toBe(1);

    panel.key("enter"); // collapse
    panel.key("enter"); // expand the same verdict again, selection unchanged
    const reopened = panel.render().map(strip);
    expect(reopened.some((l) => l.includes("cached prompt body"))).toBe(true);
    expect(parses).toBe(1); // cached lines reused — no re-parse

    // a selection change invalidates the cache: the next expand parses again
    panel.select(data);
    panel.key("enter");
    panel.render();
    expect(parses).toBe(2);
  });
});
