import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compileNative } from "../../src/compile/native.js";
import { compilePrd } from "../../src/compile/prd.js";
import { compileSpecKit } from "../../src/compile/speckit.js";

// Queue row 130 (one class with rows 127-129): a spec line is split at "\n" only, and its rest is read as [^\r\n], so a
// U+2028/U+2029 inside a line never drops, merges or retypes the item it belongs to.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const write = (name: string, body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-spec-lt-"));
  writeFileSync(join(dir, name), body);
  return join(dir, name);
};
const native = (item: string, head: string) => write("s.native.md", [
  "<!-- tickmarkr:spec -->", "# probe", "", `## T1: probe${head}title`, `- goal: probe${head}goal`, "- shape: implement", "- deps: none",
  "- files: src/a.ts, tests/a.test.ts", "- acceptance:", "  - test: first criterion", `  - test: second${item}criterion`, "",
].join("\n"));

test.each([
  ["N1 U+2028", LS],
  ["N1' U+2029", PS],
  ["N1'' control: a plain space", " "],
])("%s inside a native acceptance item keeps it its own typed criterion", (_name, sep) => {
  expect(compileNative(native(sep, " ")).tasks[0]!.acceptance)
    .toEqual([{ oracle: "test", test: "first criterion" }, { oracle: "test", test: `second${sep}criterion` }]);
});

test("N2 U+2028 inside a native task heading and goal compiles them whole", () => {
  const [task] = compileNative(native(" ", LS)).tasks;
  expect(task!.title).toBe(`probe${LS}title`);
  expect(task!.goal).toBe(`probe${LS}goal`);
});

test("PRD1 a PRD acceptance item holding U+2028 is kept, never dropped", () => {
  const file = write("s.prd.md", ["# probe", "", "## T1: probe", "- files: src/**", "- acceptance:", "  - first criterion", `  - second${LS}criterion`, ""].join("\n"));
  expect(compilePrd(file).tasks[0]!.acceptance).toEqual(["first criterion", `second${LS}criterion`]);
});

const specKit = (title: string, item: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-sk-lt-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tasks.md"), ["# Tasks", "", `- [ ] T001 Create${title}structure in src/`, "  - acceptance: first criterion",
    `  - acceptance: second${item}criterion`, "  - files: src/**", ""].join("\n"));
  return dir;
};

test("S1 a Spec Kit sub-bullet holding U+2028 is kept, never dropped", () => {
  expect(compileSpecKit(specKit(" ", LS)).tasks[0]!.acceptance).toEqual(["first criterion", `second${LS}criterion`]);
});

test("S2 a Spec Kit task line holding U+2028 compiles its title whole", () => {
  expect(compileSpecKit(specKit(LS, " ")).tasks[0]!.title).toBe(`Create${LS}structure in src/`);
});
