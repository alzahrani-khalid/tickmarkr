// Queue row 414 (D-2187 add.71; OBS-212): separability compares glob against glob. Every cell of
// the contract's closed case table runs through taskUnitContractErrors, the seam compile calls.
import { describe, expect, test } from "vitest";
import { filesOverlap, separabilityErrors, taskUnitContractErrors } from "../../src/compile/collateral.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

const task = (id: string, files: string[], deps: string[] = []) => ({
  id, files, deps, goal: id, shape: "implement" as const, acceptance: [{ kind: "test" as const, text: `${id} works` }],
});

/** The separability rows compile's task unit contract emits for two tasks. */
const separability = (a: string[], b: string[], ordered = false): string[] =>
  taskUnitContractErrors([task("T1", a), task("T2", b, ordered ? ["T1"] : [])], makeTestTempDir("tkr-sep-"))
    .filter((e) => e.includes("both write"));

describe("separability compares glob against glob (row 414)", () => {
  test("test: two unordered tasks whose brace patterns share a member fail separability naming that member while disjoint brace patterns pass", () => {
    const errs = separability(["src/{a,b}.ts"], ["src/{b,c}.ts"]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("T1 and T2 both write src/b.ts but neither depends on the other");
    expect(errs[0]).not.toContain("src/a.ts");
    expect(errs[0]).not.toContain("src/c.ts");
    // brace-expanding into a substring test would flag these
    expect(separability(["src/{a,b}.ts"], ["src/{c,d}.ts"])).toEqual([]);
    expect(separability(["src/{ab,x}.ts"], ["src/{b,y}.ts"])).toEqual([]);
  });

  test("test: two wildcard patterns whose literal prefixes and suffixes are compatible fail closed while diverging prefixes or suffixes pass", () => {
    const errs = separability(["src/run/*.ts"], ["src/run/d*.ts"]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("T1 and T2 both write src/run/*.ts ∩ src/run/d*.ts but");
    expect(separability(["src/run/*.ts"], ["src/gates/*.ts"])).toEqual([]); // prefixes diverge
    expect(separability(["tests/*.test.ts"], ["tests/*.spec.ts"])).toEqual([]); // suffixes diverge
    // a brace member that is itself a wildcard is compared by the same test
    expect(separability(["src/{run,gates}/*.ts"], ["src/run/d*.ts"])[0]).toContain("src/run/*.ts ∩ src/run/d*.ts");
    // an expansion over the bound fails closed as an overlap of the unexpanded patterns
    expect(filesOverlap(["src/{a..z}{a..z}.ts"], ["lib/{x,y}.ts"])).toEqual(["src/{a..z}{a..z}.ts ∩ lib/{x,y}.ts"]);
  });

  test("test: a literal against a brace pattern reports exactly as before and an ordered pair reports nothing", () => {
    const errs = separability(["src/b.ts"], ["src/{b,c}.ts"]);
    expect(errs).toEqual(separabilityErrors([task("T1", ["src/b.ts"]), task("T2", ["src/{b,c}.ts"])]));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("T1 and T2 both write src/b.ts ⊂ src/{b,c}.ts but");
    expect(separability(["src/{a,b}.ts"], ["src/{b,c}.ts"], true)).toEqual([]);
    expect(separability(["src/run/*.ts"], ["src/run/d*.ts"], true)).toEqual([]);
  });
});
