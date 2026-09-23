import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "../../src/cli/commands/compile.js";
import { graphPath } from "../../src/graph/graph.js";
import { makeRepo } from "../helpers/tmprepo.js";

const SPEC = `# Routing fixture

## T1: Update widget behavior
- goal: Keep the widget behavior observable.
- shape: implement
- complexity: 3
- files: src/widget.ts
- acceptance:
  - widgetValue remains observable
`;

function repoWithConfig(yaml?: string): string {
  const repo = makeRepo({ "feature.prd.md": SPEC, "src/widget.ts": "export const widgetValue = () => 1;\n" });
  if (yaml !== undefined) {
    mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
    writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
  }
  return repo;
}

const poolCfg = (shape: string, channels: string) =>
  `routing:\n  deny:\n    adapters: [codex]\n  map:\n    ${shape}: { pool: { mode: any, channels: [${channels}] } }\n`;

async function failure(argv: string[], repo: string): Promise<string> {
  try {
    await compile(argv, repo);
    return "compile unexpectedly succeeded";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("compile refuses a fully denied pool (OBS-1086)", () => {
  test("test: compile refuses a spec whose task shape maps to a pool every channel of which the loaded config denies naming the shape the pool and the denying entry, so a refusal first raised at plan fails", async () => {
    const repo = repoWithConfig(poolCfg("implement", "codex:gpt-5.6, codex:gpt-5.5"));
    const msg = await failure(["feature.prd.md"], repo);
    expect(msg).toMatch(/fully denied pool/);
    expect(msg).toMatch(/routing\.map\.implement\.pool codex:gpt-5\.6 > codex:gpt-5\.5 fully disallowed by routing\.deny \(codex\)/);
    expect(existsSync(graphPath(repo))).toBe(false);
  });

  test("test: a pool with one live channel or a fully denied pool for a shape no task uses compiles clean, so a refusal on a partial deny or an unused shape fails", async () => {
    const partial = repoWithConfig(poolCfg("implement", "codex:gpt-5.6, fake:fake-1"));
    await expect(compile(["feature.prd.md"], partial)).resolves.toMatch(/compiled feature\.prd\.md/);
    const unused = repoWithConfig(poolCfg("migration", "codex:gpt-5.6"));
    await expect(compile(["feature.prd.md"], unused)).resolves.toMatch(/compiled feature\.prd\.md/);
  });

  test("test: a dry run reaches the same refusal and a repository with no config file compiles as today, so a compile that needs a config to succeed fails", async () => {
    const dead = repoWithConfig(poolCfg("implement", "codex:gpt-5.6"));
    expect(await failure(["feature.prd.md", "--dry-run"], dead)).toMatch(/routing\.map\.implement\.pool .* fully disallowed by routing\.deny \(codex\)/);
    expect(existsSync(graphPath(dead))).toBe(false);
    const bare = repoWithConfig();
    expect(existsSync(join(bare, ".tickmarkr", "config.yaml"))).toBe(false);
    await expect(compile(["feature.prd.md"], bare)).resolves.toMatch(/compiled feature\.prd\.md/);
  });
});
