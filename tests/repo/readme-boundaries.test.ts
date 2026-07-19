import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const REPO = join(import.meta.dirname, "../..");
const NARRATIVE =
  readFileSync(join(REPO, "README.md"), "utf8") +
  "\n" +
  readFileSync(join(REPO, "CONTRIBUTING.md"), "utf8");

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
