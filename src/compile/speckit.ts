import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type RunGraph, validateGraph } from "../graph/schema.js";
import { CompileError, inferShape, sha256 } from "./common.js";

const TASK_RE = /^- \[( |x)\] (T\d+)\s*(\[P\])?\s*(.+)$/;
const SUB_RE = /^\s+- (\w+):\s*(.+)$/;

interface Draft {
  id: string; title: string; parallel: boolean; done: boolean;
  fields: Record<string, string[]>;
}

export function compileSpecKit(dir: string): RunGraph {
  const path = join(dir, "tasks.md");
  if (!existsSync(path)) {
    throw new CompileError(`no tasks.md in ${dir} — point tickmarkr compile at a Spec Kit feature directory`);
  }
  const content = readFileSync(path, "utf8");

  const drafts: Draft[] = [];
  for (const line of content.split("\n")) {
    const t = line.match(TASK_RE);
    if (t) {
      drafts.push({ id: t[2], title: t[4].trim(), parallel: !!t[3], done: t[1] === "x", fields: {} });
      continue;
    }
    const s = line.match(SUB_RE);
    if (s && drafts.length) {
      const d = drafts[drafts.length - 1];
      (d.fields[s[1].toLowerCase()] ??= []).push(s[2].trim());
    }
  }
  if (!drafts.length) throw new CompileError(`${path} contains no task lines ("- [ ] T001 ...")`);

  const missing = drafts.filter((d) => !d.fields.acceptance?.length).map((d) => d.id);
  if (missing.length) {
    throw new CompileError(
      `acceptance criteria are required on every task (spec rule). Missing on: ${missing.join(", ")}.\n` +
        `Annotate each task in ${path} with an indented sub-bullet:\n  - acceptance: <observable outcome>`,
    );
  }

  // [P] semantics → dependency edges
  let barrier: string | null = null;
  let sinceBarrier: string[] = [];
  const csv = (v?: string[]) => (v ? v.flatMap((x) => x.split(",")).map((s) => s.trim()).filter(Boolean) : []);

  const tasks = drafts.map((d) => {
    const deps = d.parallel
      ? barrier ? [barrier] : []
      : sinceBarrier.length ? [...sinceBarrier] : barrier ? [barrier] : [];
    if (d.parallel) {
      sinceBarrier.push(d.id);
    } else {
      barrier = d.id;
      sinceBarrier = [];
    }
    return {
      id: d.id,
      title: d.title,
      goal: d.fields.goal?.[0] ?? d.title,
      shape: (d.fields.shape?.[0] as never) ?? inferShape(d.title),
      complexity: d.fields.complexity ? Number(d.fields.complexity[0]) : 5,
      deps,
      files: csv(d.fields.files),
      context: csv(d.fields.context),
      acceptance: d.fields.acceptance,
      ...(d.done ? { status: "done" as const } : {}),
    };
  });

  return validateGraph({
    version: 1,
    spec: { source: "speckit", paths: [path], hash: sha256(content) },
    tasks,
  });
}
