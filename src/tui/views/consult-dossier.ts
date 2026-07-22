// T2 (v1.68): consult dossier viewer — the Runs cockpit's detail panel.
// Lists every consult verdict recorded for the selected task (action + reason, dispatch order)
// and expands one verdict's persisted prompt content on request. Pure render over INJECTED data:
// this module never touches the filesystem — the caller folds journal events and loads the
// consults/ artifacts, then hands both in. The prompt-content translator is a hand-written
// line-oriented pass over a known narrow subset (headings, blockquotes, bullets, fenced blocks),
// never a markdown-AST dependency. Rendered prompt lines are cached per verdict and invalidated
// only on selection change — never re-parsed on repaint (opencode's opentui regression lesson).
// Read-only by construction: there is no edit or delete path for a dossier or a verdict.
import { GLYPHS, bold, dim, warn } from "../../brand.js";
import type { ConsultVerdict } from "../../run/consult.js";
import type { JournalEvent } from "../../run/journal.js";

/** Placeholder marker surfaced in the Runs detail panel until T2 fills the viewer. */
export const DOSSIER_PLACEHOLDER = "consult dossier viewer — stub, filled by T2";

/** Placeholder renderer — returns one dim line. */
export function renderDossierPlaceholder(): string {
  return `  ${DOSSIER_PLACEHOLDER}`;
}

export type ConsultAction = ConsultVerdict["action"];

/** One recorded consult verdict, with its persisted prompt content injected by the caller. */
export interface DossierVerdict {
  action: ConsultAction;
  reason?: string;
  notes?: string;
  guidance?: string;
  /** Persisted prompt content (the consults/<task>-<n>.md artifact), loaded by the caller. */
  prompt?: string;
}

/** Everything the dossier panel renders — loaded by the caller, never by the render path. */
export interface ConsultDossierData {
  taskId: string;
  /** Verdicts in dispatch order (journal order). */
  verdicts: DossierVerdict[];
}

export interface ConsultDossierPanel {
  /** Change the selected task. Any selection change invalidates every cached prompt render. */
  select(data: ConsultDossierData | undefined): void;
  /** "up"/"down" move the verdict cursor; "enter" toggles the selected verdict's dossier. */
  key(name: string): void;
  /** Render the panel body lines (chrome/divider lines are the host view's job). */
  render(): string[];
  /** Index of the expanded verdict, or null when collapsed. */
  readonly expandedIndex: number | null;
}

const ACTIONS: readonly string[] = ["retry", "reroute", "decompose", "human"];

/** Fold one task's consult-verdict journal events into dossier verdicts, in dispatch order.
 *  Pure function over injected events. opts.prompts carries the persisted prompt contents in
 *  the same dispatch order (the caller reads the consults/ artifacts); a verdict whose artifact
 *  was not loaded simply has no prompt. Malformed events are skipped, never fatal. */
export function foldConsultVerdicts(
  events: JournalEvent[],
  taskId: string,
  opts: { prompts?: string[] } = {},
): DossierVerdict[] {
  const verdicts: DossierVerdict[] = [];
  for (const e of events) {
    if (e.taskId !== taskId || e.event !== "consult-verdict") continue;
    const d = e.data;
    if (typeof d.action !== "string" || !ACTIONS.includes(d.action)) continue;
    verdicts.push({
      action: d.action as ConsultAction,
      ...(typeof d.reason === "string" ? { reason: d.reason } : {}),
      ...(typeof d.notes === "string" ? { notes: d.notes } : {}),
      ...(typeof d.guidance === "string" ? { guidance: d.guidance } : {}),
    });
  }
  if (opts.prompts) {
    for (const [i, prompt] of opts.prompts.entries()) {
      if (verdicts[i]) verdicts[i]!.prompt = prompt;
    }
  }
  return verdicts;
}

// ── prompt-content translator ────────────────────────────────────────────────
// Hand-written, line-oriented, pure. Known subset only: ATX headings (# = bold, deeper = dim),
// `> ` blockquotes (dim `│ ` bar prefix), `- `/`* ` bullets (• marker), ``` fenced blocks
// (dim, indented), everything else passes through plain. No markdown-AST dependency.

const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const QUOTE_RE = /^>[ \t]?(.*)$/;
const BULLET_RE = /^[-*][ \t]+(.*)$/;
const FENCE_RE = /^\s*```/;

/** Translate persisted prompt content into styled terminal lines. Pure. */
export function translatePromptContent(content: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      out.push(line.trim() ? dim(`    ${line}`) : "");
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      out.push(heading[1]!.length === 1 ? bold(heading[2]!) : dim(heading[2]!));
      continue;
    }
    const quote = QUOTE_RE.exec(line);
    if (quote) {
      out.push(dim(`│ ${quote[1]}`));
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      out.push(`• ${bullet[1]}`);
      continue;
    }
    out.push(line);
  }
  return out;
}

/** A verdict's guidance field is "imperative steps for the worker (newline-separated ok)" —
 *  already list-shaped, so it renders as a bullet list, never a wall of prose. Pure. */
export function renderGuidanceSteps(guidance: string): string[] {
  return guidance
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `• ${s}`);
}

/** The consult dossier panel. Stateful over injected data: a verdict cursor, at most one
 *  expanded dossier, and a per-verdict render cache cleared only when the selection changes. */
export function createConsultDossierPanel(
  initial?: ConsultDossierData,
  opts: { translate?: (content: string) => string[] } = {},
): ConsultDossierPanel {
  const translate = opts.translate ?? translatePromptContent;
  let data = initial;
  let cursor = 0;
  let expanded: number | null = null;
  // Per-verdict cached render of the expanded dossier block — parsed once, reused on every
  // later expand of the same verdict within the same selection; never re-parsed per repaint.
  const cache = new Map<number, string[]>();

  const dossierBlock = (verdict: DossierVerdict, index: number): string[] => {
    const hit = cache.get(index);
    if (hit) return hit;
    const lines: string[] = [];
    lines.push(dim(`── persisted prompt · consult · ${data?.taskId ?? "?"} · verdict ${index + 1} ──`));
    if (verdict.prompt !== undefined) lines.push(...translate(verdict.prompt));
    else lines.push(dim("(no persisted prompt content recorded for this verdict)"));
    lines.push(`action: ${verdict.action}`);
    const steps = verdict.guidance ? renderGuidanceSteps(verdict.guidance) : [];
    if (steps.length > 0) {
      lines.push("guidance:");
      for (const s of steps) lines.push(`  ${s}`);
    }
    cache.set(index, lines);
    return lines;
  };

  return {
    get expandedIndex() {
      return expanded;
    },

    select(next: ConsultDossierData | undefined): void {
      data = next;
      cursor = 0;
      expanded = null;
      cache.clear();
    },

    key(name: string): void {
      if (!data || data.verdicts.length === 0) return;
      if (name === "up") cursor = Math.max(cursor - 1, 0);
      else if (name === "down") cursor = Math.min(cursor + 1, data.verdicts.length - 1);
      else if (name === "enter") expanded = expanded === cursor ? null : cursor;
    },

    render(): string[] {
      if (!data) return [];
      if (data.verdicts.length === 0) {
        return [
          `  no consult verdicts recorded for ${data.taskId} — every attempt finished without needing a consult.`,
        ];
      }
      const lines: string[] = [];
      data.verdicts.forEach((verdict, i) => {
        const pointer = i === cursor ? `${GLYPHS.pointer} ` : "  ";
        // Consult actions are not pass/fail: human → warn (needs the operator), the rest plain.
        const actionWord = verdict.action === "human" ? warn(verdict.action) : verdict.action;
        const reason = verdict.reason ?? verdict.notes;
        const hint = dim(i === expanded ? "[enter: collapse]" : "[enter: expand]");
        lines.push(`  ${pointer}${i + 1}. ${actionWord}${reason ? ` — ${reason}` : ""}  ${hint}`);
        if (i === expanded) {
          for (const l of dossierBlock(verdict, i)) lines.push(`     ${l}`);
        }
      });
      return lines;
    },
  };
}
