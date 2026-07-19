import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { tickmarkrDir, saveGraph } from "../../src/graph/graph.js";
import { validateGraph } from "../../src/graph/schema.js";

export const COMMIT = "git add -A && git commit --no-gpg-sign -m";
export const authedModels = (models: Iterable<string>) => Object.fromEntries([...models].map((model) => [model, { authed: true, probedAt: "2026-07-16T00:00:00.000Z" }]));

export const T = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: id, goal: id, shape: "implement", complexity: 3, acceptance: ["done"], ...over,
});

// one fixture for every daemon suite: graph + config overlay + scripted fake adapter
export function setupRepo(tasks: unknown[], script: object, extraCfg = ""): { repo: string; fake: FakeAdapter; scriptPath: string } {
  const repo = makeRepo({ "base.txt": "base\n" });
  saveGraph(repo, validateGraph({ version: 1, spec: { source: "prd", paths: ["p"], hash: "h" }, tasks }));
  // fake adapter is judge+reviewer+consult too
  writeFileSync(
    join(tickmarkrDir(repo), "config.yaml"),
    `judge: { adapter: fake, model: fake-1 }\nconsult: { adapter: fake, model: fake-1 }\n${extraCfg}`,
  );
  const sdir = mkdtempSync(join(tmpdir(), "tickmarkr-script-"));
  const scriptPath = join(sdir, "s.json");
  writeFileSync(scriptPath, JSON.stringify({ judge: { pass: true, criteria: [{ criterion: "c1", met: true, reason: "ok" }] }, review: { approve: true, issues: [] }, ...script }));
  return { repo, fake: new FakeAdapter(scriptPath), scriptPath };
}

export function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-repo-"));
  const git = (c: string) => execSync(`git ${c}`, { cwd: dir, encoding: "utf8" });
  git("init -b main");
  git("config user.email tickmarkr@test.local");
  git("config user.name tickmarkr-test");
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  git("add -A");
  git('commit -m init --no-gpg-sign');
  return dir;
}
