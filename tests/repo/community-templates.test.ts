import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, test } from "vitest";

const REPO = join(import.meta.dirname, "../..");
const BUG = join(REPO, ".github/ISSUE_TEMPLATE/bug.yml");
const FEATURE = join(REPO, ".github/ISSUE_TEMPLATE/feature.yml");
const PR = join(REPO, ".github/pull_request_template.md");

type IssueField = {
  type: string;
  id?: string;
  attributes?: { label?: string; description?: string };
  validations?: { required?: boolean };
};

function loadForm(path: string): IssueField[] {
  const doc = parseYaml(readFileSync(path, "utf8")) as { body: IssueField[] };
  return doc.body;
}

function fieldByLabel(body: IssueField[], needle: RegExp): IssueField | undefined {
  return body.find(
    (f) => needle.test(f.attributes?.label ?? "") || needle.test(f.attributes?.description ?? ""),
  );
}

function expectRequiredField(body: IssueField[], needle: RegExp): void {
  const field = fieldByLabel(body, needle);
  expect(field, `missing field matching ${needle}`).toBeDefined();
  expect(field!.validations?.required, field!.attributes?.label).toBe(true);
}

describe("T5 community issue and pull request templates", () => {
  test("the bug issue template requires the tickmarkr version", () => {
    expectRequiredField(loadForm(BUG), /tickmarkr version/i);
  });

  test("the bug issue template requires the doctor output", () => {
    expectRequiredField(loadForm(BUG), /doctor output/i);
  });

  test("the bug issue template requires a journal excerpt", () => {
    expectRequiredField(loadForm(BUG), /journal excerpt/i);
  });

  test("the feature issue template asks which invariant the proposal touches", () => {
    const body = loadForm(FEATURE);
    const field = fieldByLabel(body, /invariant/i);
    expect(field, "invariant field").toBeDefined();
    expect(field!.attributes?.label?.toLowerCase()).toContain("invariant");
  });

  test("the pull request template includes the green bar checklist", () => {
    const md = readFileSync(PR, "utf8");
    expect(md).toMatch(/green bar/i);
    expect(md).toContain("npm run build");
    expect(md).toContain("npm test");
    expect(md).toContain("npm run lint");
    expect(md).toContain("npm run test:coverage");
  });

  test("a first time reporter filling out either issue template cannot submit without providing the version and doctor evidence maintainers need", () => {
    for (const path of [BUG, FEATURE]) {
      const body = loadForm(path);
      expectRequiredField(body, /tickmarkr version/i);
      expectRequiredField(body, /doctor output/i);
    }
  });
});
