import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { allAdapters } from "../../adapters/registry.js";
import type { WorkerAdapter } from "../../adapters/types.js";
import { repoOverlayPath } from "../../config/config.js";
import type { ExecutorDriver } from "../../drivers/types.js";
import { compile } from "./compile.js";
import { plan, type PlanTaskRow } from "./plan.js";
import { scope } from "./scope.js";

// Closed rule: lowercase; every run outside [a-z0-9] folds to one hyphen; edge hyphens trimmed. Over 48
// characters, cut before the last hyphen at or before index 48 (never keeping it), else at 48.
export function startSlug(sentence: string): string {
  const slug = sentence.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length <= 48) return slug || "start";
  const j = slug.lastIndexOf("-", 48);
  return j > 0 ? slug.slice(0, j) : slug.slice(0, 48);
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// One sentence → intent → scope (draft) → compile → plan, composed from the exported commands; the
// card is built from plan's per-task callback, never from its printed text. start never runs the graph.
export async function start(
  argv: string[],
  cwd = process.cwd(),
  adapters: WorkerAdapter[] = allAdapters(),
  harnessFrom: string | undefined = process.argv[1],
  driver?: ExecutorDriver,
): Promise<string> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { yes: { type: "boolean" }, force: { type: "boolean" } },
    allowPositionals: true,
  });
  const sentence = positionals.join(" ").trim();
  if (!sentence) throw new Error(`usage: tickmarkr start "<what you want built>" [--yes] [--force]`);
  if (!existsSync(repoOverlayPath(cwd))) throw new Error("start: no .tickmarkr/config.yaml here — run tickmarkr init first");
  const slug = startSlug(sentence);
  const intentRel = `specs/${slug}.intent.md`;
  const specRel = `specs/${slug}.spec.md`;
  const intentPath = join(cwd, intentRel);
  if (!values.force) {
    for (const rel of [intentRel, specRel]) {
      if (existsSync(join(cwd, rel))) throw new Error(`start: ${rel} already exists — pass --force to overwrite it`);
    }
  }

  const created = !existsSync(intentPath);
  mkdirSync(join(cwd, "specs"), { recursive: true });
  writeFileSync(intentPath, `# ${sentence}\n\n${sentence}\n`);
  try {
    await scope([intentRel, ...(values.yes ? ["--yes"] : []), ...(values.force ? ["--force"] : [])], cwd, adapters, driver);
  } catch (error) {
    if (created) rmSync(intentPath, { force: true });
    throw error;
  }
  await compile([specRel], cwd, harnessFrom);
  const rows: PlanTaskRow[] = [];
  await plan([], cwd, adapters, harnessFrom, { onTask: (row) => rows.push(row) });

  const blocked = rows.filter((row) => !row.worker).length;
  return [
    `tickmarkr start — ${sentence}`,
    `drafted ${specRel} · ${count(rows.length, "task")} · compiled`,
    "",
    ...rows.flatMap((row, i) => [
      `  ${i + 1}. ${row.title}`,
      row.worker
        ? `     builds: ${row.worker.adapter}:${row.worker.model} · reviews: ${row.review} · ${count(row.acceptance, "acceptance check")}`
        : `     not routable yet: ${row.blocked}`,
    ]),
    "",
    blocked ? `not ready — ${count(blocked, "task")} cannot route yet; tickmarkr plan says why` : "next: tickmarkr run",
    `change it first: edit ${specRel}, then tickmarkr compile ${specRel} && tickmarkr plan`,
    "full routing detail: tickmarkr plan",
  ].join("\n");
}
