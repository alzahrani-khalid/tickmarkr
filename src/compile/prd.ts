import { existsSync, readFileSync } from "node:fs";
import { type RunGraph, validateGraph } from "../graph/schema.js";
import { CompileError, inferShape, sha256 } from "./common.js";

const HEAD_RE = /^## (T\d+):\s*(.+)$/;
const FIELD_RE = /^- (\w+):\s*(.*)$/;
const NESTED_RE = /^\s+- (.+)$/;

export function compilePrd(file: string): RunGraph {
  if (!existsSync(file)) throw new CompileError(`no such PRD file: ${file}`);
  const content = readFileSync(file, "utf8");

  interface Draft { id: string; title: string; fields: Record<string, string>; acceptance: string[]; inAcceptance: boolean }
  const drafts: Draft[] = [];
  for (const line of content.split("\n")) {
    const h = line.match(HEAD_RE);
    if (h) {
      drafts.push({ id: h[1], title: h[2].trim(), fields: {}, acceptance: [], inAcceptance: false });
      continue;
    }
    const d = drafts.at(-1);
    if (!d) continue;
    const f = line.match(FIELD_RE);
    if (f) {
      d.inAcceptance = f[1].toLowerCase() === "acceptance";
      if (!d.inAcceptance) d.fields[f[1].toLowerCase()] = f[2].trim();
      continue;
    }
    const n = line.match(NESTED_RE);
    if (n && d.inAcceptance) d.acceptance.push(n[1].trim());
    else if (line.trim() && !line.startsWith(" ")) d.inAcceptance = false;
  }
  if (!drafts.length) {
    throw new CompileError(`${file} has no task sections. Expected "## T1: Title" headings with field bullets (goal/shape/deps/files/acceptance).`);
  }

  const missing = drafts.filter((d) => !d.acceptance.length).map((d) => d.id);
  if (missing.length) {
    throw new CompileError(
      `acceptance criteria are required on every task. Missing on: ${missing.join(", ")}.\n` +
        `Add to each section in ${file}:\n- acceptance:\n  - <observable outcome>`,
    );
  }

  const csv = (v?: string) => (v && v.toLowerCase() !== "none" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
  const tasks = drafts.map((d) => {
    const pin = d.fields.pin?.split(/\s+/);
    return {
      id: d.id,
      title: d.title,
      goal: d.fields.goal ?? d.title,
      shape: (d.fields.shape as never) ?? inferShape(d.title),
      complexity: d.fields.complexity ? Number(d.fields.complexity) : 5,
      deps: csv(d.fields.deps),
      files: csv(d.fields.files),
      context: csv(d.fields.context),
      acceptance: d.acceptance,
      ...(d.fields.humangate === "true" ? { humanGate: true } : {}),
      ...(pin && pin.length === 2 ? { routingHints: { pin: { via: pin[0], model: pin[1] } } } : {}),
    };
  });

  return validateGraph({
    version: 1,
    spec: { source: "prd", paths: [file], hash: sha256(content) },
    tasks,
  });
}
