import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import * as registry from "../../src/adapters/registry.js";
import { init } from "../../src/cli/commands/init.js";
import { specTemplate } from "../../src/compile/native.js";
import { makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// The spec-authoring law only reaches users through the file `tickmarkr init` writes, so read it from a
// freshly initialised repository rather than from specTemplate() — a law asserted only against its own
// source is exactly the divergence these tests exist to catch.
async function initialisedSpec(): Promise<string> {
  vi.spyOn(registry, "allAdapters").mockReturnValue([]);
  const repo = makeRepo({ "keep.txt": "x" });
  await init(["--global-dir", makeTestTempDir("tickmarkr-spec-template-global-")], repo);
  return readFileSync(join(repo, "tickmarkr.spec.md"), "utf8");
}

afterEach(() => vi.restoreAllMocks());

describe("spec template — stub-satisfiability law", () => {
  test("test: the template the init path writes contains the stub-satisfiability test stated as a question an author applies to each criterion, and names the production caller as what distinguishes a real criterion from a satisfiable one", async () => {
    const written = await initialisedSpec();

    // Stated as a question the author asks of every criterion, not as background prose.
    expect(written).toContain("Ask of every criterion:");
    expect(written).toContain("COULD THIS BE SATISFIED BY CODE THAT NOTHING OUTSIDE THE TEST SUITE CALLS?");
    // ...and answered by naming the production caller, which is what a stub lacks.
    expect(written).toContain("PRODUCTION CALLER");
    expect(written).toMatch(/A criterion naming a CAPABILITY is satisfiable by a stub/);
    expect(written).toMatch(/PRODUCTION CALLER\n\s+that must exercise the capability/);
  });

  test("test: the template reaching a freshly initialised repository is the same text, so the law is not documentation that diverges from what is written", async () => {
    expect(await initialisedSpec()).toBe(specTemplate());
  });

  test("test: the new law sits with the existing criterion-quality rules and weakens none of them", async () => {
    const written = await initialisedSpec();
    const section = written.slice(
      written.indexOf("WHAT MAKES A CRITERION REAL:"),
      written.indexOf("ORDERING AND OWNERSHIP:"),
    );

    expect(section).toContain("COULD THIS BE SATISFIED BY CODE THAT NOTHING OUTSIDE THE TEST SUITE CALLS?");
    // The rules that were already there stay there, verbatim.
    for (const rule of [
      "title must match the criterion string verbatim",
      "NO criterion may be satisfiable by an absence, a rename, a source-text grep, or an empty collection",
      '"goal:" is NEVER verification',
      'A source-only obligation (a comment or doc that a change makes false) has no lawful "test:"',
      "A criterion that pins the SHAPE of a fix must also pin the CONDITIONS under which it runs",
      "Enumerating one axis exhaustively is what hides the others",
    ]) {
      expect(section).toContain(rule);
    }
  });
});
