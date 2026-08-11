import { describe, expect, test } from "vitest";
import { assertWriteScope } from "../../src/compile/common.js";
import { dispositionOffenders } from "../../src/gates/scope.js";
import { filesGlob, literalParens } from "../../src/graph/files-glob.js";

// Q120s (TRIAL T-OBS-4, SentioQ run-1): Expo Router / Next.js name group directories
// `(app)` and dynamic routes `[id]`. Bare parens compile to a regex capture group that
// can never match the literal path — T3 burned 3 dispatches on a scope red unwinnable
// by construction. filesGlob is the ONE files[] matcher; these are its contracts.
// Titling law: oracle-named tests are TOP-LEVEL — the acceptance -t filter anchors ^title$
// against the runner-visible full name, so a describe prefix makes the oracle unmatchable
// (the T53 zero-match class; this very slice's first verify run reproduced it).
const SENTIOQ_T3_PATH = "app/(app)/connections/[id]/prep/[scenario].tsx";
test("the exact SentioQ T3 shape: literal pattern matches its own path", () => {
  expect(filesGlob(SENTIOQ_T3_PATH)(SENTIOQ_T3_PATH)).toBe(true);
});

describe("filesGlob — files[] semantics (Q120s)", () => {
  const path = "app/(app)/connections/[id]/prep/[scenario].tsx";

  test("starred pattern crosses a paren group dir — the shape that was unwinnable", () => {
    expect(filesGlob("app/(app)/connections/*/prep/*.tsx")(path)).toBe(true);
    expect(filesGlob("app/(app)/**")("app/(app)/x/y.ts")).toBe(true);
  });

  test("bracket dirs still match both readings; wildcards and out-of-scope stay correct", () => {
    expect(filesGlob("app/[id]/*.tsx")("app/[id]/x.tsx")).toBe(true);
    expect(filesGlob("src/*.ts")("src/a.ts")).toBe(true);
    expect(filesGlob("app/(app)/**")("app/(marketing)/x.ts")).toBe(false);
  });

  test("already-escaped parens are not double-escaped", () => {
    expect(literalParens("a/\\(x\\)/b")).toBe("a/\\(x\\)/b");
  });

  test("scope allowDeviations honor paren paths (dispositionOffenders)", () => {
    const { hard, allowed } = dispositionOffenders(
      ["app/(app)/extra.tsx", "src/stray.ts"],
      ["app/(app)/**"],
    );
    expect(allowed).toEqual(["app/(app)/extra.tsx"]);
    expect(hard).toEqual(["src/stray.ts"]);
  });

  test("compile-side write scope agrees (assertWriteScope accepts a paren-dir write)", () => {
    expect(() =>
      assertWriteScope("spec", "T1", ["app/(app)/connections/*/prep/*.tsx"], [
        { path, directive: "modify", bare: false },
      ]),
    ).not.toThrow();
  });
});
