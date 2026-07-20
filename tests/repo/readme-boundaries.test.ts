import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const REPO = join(import.meta.dirname, "../..");
const NARRATIVE =
  readFileSync(join(REPO, "README.md"), "utf8") +
  "\n" +
  readFileSync(join(REPO, "CONTRIBUTING.md"), "utf8");

const readmeFleetSection = (): string => {
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  const start = readme.indexOf("## Choosing your fleet");
  const end = readme.indexOf("\n## ", start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return readme.slice(start, end);
};

const fleetAdvancedPath = join(REPO, "FLEET.md");

const fleetAdvancedReadmeLinkPattern = (): RegExp => {
  const repo = (
    JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { repository: { url: string } }
  ).repository.url
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\[FLEET\\.md\\]\\(${escaped}/blob/main/FLEET\\.md\\)`);
};

describe("T6 readme and contributing narrative boundaries", () => {
  test("the readme or contributing file states that minor versions may break before the next major version with every break documented in the changelog", () => {
    expect(NARRATIVE).toMatch(/minor versions may break/i);
    expect(NARRATIVE).toMatch(/major version|pre-2\.0|before the next major/i);
    expect(NARRATIVE).toMatch(/CHANGELOG\.md/i);
    expect(NARRATIVE).toMatch(/documented in|noted in|every.*break/i);
  });

  test("the readme or contributing file explains the public repository is a squashed export of private development", () => {
    expect(NARRATIVE).toMatch(/squashed export/i);
    expect(NARRATIVE).toMatch(/private development/i);
  });

  test("the readme or contributing file states accepted contributions are credited through co-authored-by", () => {
    expect(NARRATIVE).toMatch(/Co-authored-by:/i);
    expect(NARRATIVE).toMatch(/accepted.*contribut|contribution credit|your pull request is accepted/i);
  });

  test("the readme or contributing file states support is best effort for the latest version only", () => {
    expect(NARRATIVE).toMatch(/best effort/i);
    expect(NARRATIVE).toMatch(/latest version only/i);
  });
});

describe("T5 fleet documentation split", () => {
  test("the README's fleet section fits within a short workflow summary and links to the advanced reference document for routing-mode and steering detail", () => {
    const section = readmeFleetSection();
    expect(section.length).toBeLessThan(2200);
    expect(section).toMatch(fleetAdvancedReadmeLinkPattern());
    expect(section).toMatch(/routing-mode/i);
    expect(section).toMatch(/steering/i);
    expect(section).toMatch(/tickmarkr doctor/);
    expect(section).toMatch(/tickmarkr fleet/);
    expect(section).toMatch(/tickmarkr plan/);
    expect(section).toMatch(/tickmarkr run/);
  });

  test("the advanced reference document exists and every source file or command it cites exists in the tree", () => {
    expect(existsSync(fleetAdvancedPath)).toBe(true);
    const doc = readFileSync(fleetAdvancedPath, "utf8");
    const srcPaths = [...doc.matchAll(/`(src\/[^`]+)`/g)].map((m) => m[1]);
    for (const rel of srcPaths) {
      expect(existsSync(join(REPO, rel)), rel).toBe(true);
    }
    const commands = [...doc.matchAll(/`tickmarkr ([a-z-]+)/g)].map((m) => m[1]);
    for (const cmd of new Set(commands)) {
      expect(existsSync(join(REPO, "src/cli/commands", `${cmd}.ts`)), cmd).toBe(true);
    }
    expect(readFileSync(join(REPO, "README.md"), "utf8")).toMatch(fleetAdvancedReadmeLinkPattern());
  });

  test("the advanced reference document states the quality flag is a routing-mode alias with no independent floor-raising effect", () => {
    const doc = readFileSync(fleetAdvancedPath, "utf8");
    expect(doc).toMatch(/routing-mode alias/i);
    expect(doc).toMatch(/no independent floor-raising effect/i);
    expect(doc).toMatch(/--quality/);
  });
});

describe("T7 routing precedence documentation", () => {
  test("the routing precedence documentation states floors filter channel eligibility before preference ordering applies", () => {
    const doc = readFileSync(fleetAdvancedPath, "utf8");
    expect(doc).toMatch(/floors filter channel eligibility before preference ordering applies/i);
    expect(doc).toMatch(/pin > floors > prefer > marginal-cost auto/i);
  });
});
