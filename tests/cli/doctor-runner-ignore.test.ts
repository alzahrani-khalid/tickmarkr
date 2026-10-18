import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { basename, dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { applyRunnerIgnore, doctor, packageManagerFinding, realParse, runnerIgnoreFinding, selfShadowFinding } from "../../src/cli/commands/doctor.js";
import { makeTestTempDir } from "../helpers/tmprepo.js";

// Q122s (TRIAL T-OBS-3): a repo-wide-collecting runner scans .tickmarkr/ worktrees —
// SentioQ run-1's baseline/tip red. Doctor names the exact remedy line.
// Q130s (TRIAL T-OBS-6): the remedy MUST be <rootDir>-anchored — the unanchored shape
// self-matches inside provisioned worktrees and fails every gate battery closed
// (SentioQ run 2: 10 dispatches, 0 merges, one defect).
function repo(files: Record<string, string>): string {
  const dir = makeTestTempDir("tickmarkr-doctor-");
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

// Titling law: oracle-named test stays TOP-LEVEL (anchored -t equality on the full name).
test("the SentioQ shape: jest with **/ testMatch and no ignore → warn naming the anchored config line", () => {
  const dir = repo({
    "package.json": JSON.stringify({ scripts: { test: "jest" } }),
    "jest.config.js": `module.exports = { testMatch: ["**/__tests__/**/*.test.(ts|tsx)"] };`,
  });
  const f = runnerIgnoreFinding(dir);
  expect(f?.verdict).toBe("warn");
  expect(f?.detail).toContain('add "<rootDir>/\\\\.tickmarkr/" to testPathIgnorePatterns in jest.config.js');
});

// Titling law: oracle-named test stays TOP-LEVEL (anchored -t equality on the full name).
test("the SentioQ run-2 shape: jest with an UNANCHORED .tickmarkr ignore → warn, self-matches inside worktrees", () => {
  const dir = repo({
    "package.json": JSON.stringify({ scripts: { test: "jest" } }),
    "jest.config.js": `module.exports = { testPathIgnorePatterns: ["/node_modules/", "/.tickmarkr/"] };`,
  });
  const f = runnerIgnoreFinding(dir);
  expect(f?.verdict).toBe("warn");
  expect(f?.detail).toContain("not <rootDir>-anchored");
  expect(f?.detail).toContain('"<rootDir>/\\\\.tickmarkr/"');
});

// Queue row 197 (D-2102 add.1; the claim is add.30's): the row passes only when the config's own ignore
// list literally carries the canonical session-worktree entry beside the state dir's, and never claims to
// prove what the runner collects; every other case warns naming the entry and the file. The case table:
// the amended criterion's own cases (c), the non-canonical and unanchored forms the review chains
// executed (r), the configs doctor cannot read (each a warn), and the canonical pass cases (p). Each warn
// row is then repaired by doctor --fix-only (the evaluated config equals the original with exactly the one
// ignore list changed or added, and the row passes) or refused (manual, file byte-identical, still warns).
// case-table:begin
type Write = { path: string; equals: unknown };
type Fix = "none" | "manual" | Write | Write[];
type RunnerKind = "jest" | "jest-json" | "jest-ts" | "vitest" | "vitest-ts";
type Row = [id: string, runner: RunnerKind, config: string, verdict: "pass" | "warn", says: string, fix: Fix, beside?: Record<string, string>];
const JS = String.raw`"<rootDir>/\\.tickmarkr/"`; // config source text
const JW = String.raw`"<rootDir>/\\.claude/worktrees/"`;
const VS = `".tickmarkr/**"`;
const VW = `".claude/worktrees/**"`;
const S = String.raw`<rootDir>/\.tickmarkr/`; // the values those strings hold
const W = String.raw`<rootDir>/\.claude/worktrees/`;
const vS = ".tickmarkr/**";
const vW = ".claude/worktrees/**";
// Vitest 3.2.7's configDefaults.exclude, which a test.exclude doctor adds keeps ahead of the two entries.
const VDEF = ["**/node_modules/**", "**/dist/**", "**/cypress/**", "**/.{idea,git,cache,output,temp}/**",
  "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*"];
const jestCfg = (body: string): string => `module.exports = { ${body} };`;
const vitestCfg = (test: string): string => `export default { test: { ${test} } };`;
const MISS = "does not carry";
const UNV = "doctor could not read";
const ANCH = "is not <rootDir>-anchored";
const OK = "does not prove what";
const IGNORE = "testPathIgnorePatterns";
const EXCLUDE = "test.exclude";
const RUNNER_TABLE: Row[] = [
  // the amended criterion's own cases (D-2102 add.30): the row passes only on the literal canonical entry
  ["c1 jest repo-wide, state ignore only", "jest", jestCfg(`testMatch: ["**/__tests__/**/*.test.ts"], testPathIgnorePatterns: ["/node_modules/", ${JS}]`), "warn",
    String.raw`add "<rootDir>/\\.claude/worktrees/" to testPathIgnorePatterns in jest.config.js`, { path: IGNORE, equals: ["/node_modules/", S, W] }],
  ["c2 vitest default include, state exclude only", "vitest", vitestCfg(`exclude: [${VS}]`), "warn",
    `add ".claude/worktrees/**" to test.exclude in vitest.config.mjs`, { path: EXCLUDE, equals: [vS, vW] }],
  ["c3 vitest rooted include, no exclude: fix-only adds test.exclude keeping Vitest's defaults", "vitest", vitestCfg(`include: ["tests/**/*.test.ts"]`), "warn",
    `test.exclude in vitest.config.mjs ${MISS}`, { path: EXCLUDE, equals: [...VDEF, vS, vW] }],
  ["c4 vitest rooted include beside the state exclude", "vitest", vitestCfg(`include: ["tests/**/*.test.ts"], exclude: [${VS}]`), "warn", MISS, { path: EXCLUDE, equals: [vS, vW] }],
  ["c5 jest unanchored session entry", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, "/.claude/worktrees/"]`), "warn",
    "jest ignore for .claude/worktrees/ is not <rootDir>-anchored", { path: IGNORE, equals: [S, W] }],
  ["c6 vitest config doctor cannot read", "vitest", vitestCfg(`exclude: [${VS}, ${VW}], deps: { inline: [/lodash/] }`), "warn",
    `doctor could not read vitest.config.mjs (a / outside strings and comments (a regex literal or a division)); add ".claude/worktrees/**" to test.exclude`, "manual"],
  ["c7 jest config doctor cannot read", "jest", `const base = require("./jest.base.js");\nmodule.exports = { ...base, testPathIgnorePatterns: [${JS}, ${JW}] };`, "warn", String.raw`doctor could not read jest.config.js (it runs code doctor does not read); add "<rootDir>/\\.claude/worktrees/" to testPathIgnorePatterns`, "manual"],
  ["c8 jest canonical entries present", "jest", jestCfg(`testMatch: ["**/__tests__/**/*.test.ts"], testPathIgnorePatterns: [${JS}, ${JW}]`), "pass",
    String.raw`testPathIgnorePatterns in jest.config.js carries "<rootDir>/\\.claude/worktrees/"`, "none"],
  ["c9 vitest canonical entries present", "vitest", vitestCfg(`exclude: [${VS}, ${VW}]`), "pass", `test.exclude in vitest.config.mjs carries ".claude/worktrees/**"`, "none"],
  ["c10 jest no ignore property: fix-only writes the whole property", "jest", jestCfg(`testMatch: ["**/__tests__/**/*.test.ts"]`), "warn", MISS,
    { path: IGNORE, equals: ["/node_modules/", S, W] }],
  ["c11 vitest empty export: fix-only adds a test object holding the exclude", "vitest", `export default {};`, "warn", MISS, { path: "test", equals: { exclude: [...VDEF, vS, vW] } }],
  ["c12 vitest defineConfig({}): fix-only adds a test object holding the exclude", "vitest", `import { defineConfig } from "vitest/config";\nexport default defineConfig({});`, "warn", MISS,
    { path: "test", equals: { exclude: [...VDEF, vS, vW] } }],
  ["c13 vitest empty test object: fix-only adds test.exclude", "vitest", vitestCfg(``), "warn", MISS, { path: EXCLUDE, equals: [...VDEF, vS, vW] }],
  ["c14 jest JSON without the property: fix-only adds the quoted property in the file's layout", "jest-json", `{\n  "testMatch": ["**/*.test.ts"]\n}\n`, "warn", MISS,
    { path: IGNORE, equals: ["/node_modules/", S, W] }],
  ["c15 jest empty JSON object: fix-only adds the quoted property", "jest-json", `{}`, "warn", MISS, { path: IGNORE, equals: ["/node_modules/", S, W] }],
  // review round 1: the writer touches the runner's own ignore array only
  ["r1 jest cacheDirectory under .tickmarkr", "jest", jestCfg(`cacheDirectory: "<rootDir>/.tickmarkr/jest-cache", testMatch: ["**/*.test.ts"], testPathIgnorePatterns: ["/node_modules/", ${JS}]`), "warn", MISS,
    { path: IGNORE, equals: ["/node_modules/", S, W] }],
  ["r2 vitest cacheDir under .tickmarkr", "vitest", `export default { cacheDir: ".tickmarkr/vite-cache", test: { exclude: [${VS}] } };`, "warn", MISS, { path: EXCLUDE, equals: [vS, vW] }],
  ["r3 jest coverage ignore holding the state entry first", "jest", jestCfg(`coveragePathIgnorePatterns: [${JS}], testPathIgnorePatterns: [${JS}]`), "warn", MISS, { path: IGNORE, equals: [S, W] }],
  // review round 2: expressions are never split; coverage never counts
  ["r4 jest state literal + suffix", "jest", jestCfg(`testPathIgnorePatterns: [${JS} + "generated/"]`), "warn", UNV, "manual"],
  ["r5 jest state literal + slash", "jest", jestCfg(String.raw`testPathIgnorePatterns: ["<rootDir>/\\.tickmarkr" + "/"]`), "warn", UNV, "manual"],
  ["r6 vitest exclude from join()", "vitest", `import { join } from "node:path";\nexport default { test: { exclude: [join(".tickmarkr", "**")] } };`, "warn", UNV, "manual"],
  ["r7 jest session ignore only in coverage", "jest", jestCfg(`coveragePathIgnorePatterns: [${JW}], testPathIgnorePatterns: [${JS}]`), "warn", MISS, { path: IGNORE, equals: [S, W] }],
  ["r8 vitest session exclude only in coverage", "vitest", vitestCfg(`exclude: [${VS}], coverage: { exclude: [${VW}] }`), "warn", MISS, { path: EXCLUDE, equals: [vS, vW] }],
  ["r9 vitest coverage.include beside the default include", "vitest", vitestCfg(`exclude: [${VS}], coverage: { include: ["src/*.ts"] }`), "warn", MISS, { path: EXCLUDE, equals: [vS, vW] }],
  // review round 3
  ["r14 jest partial session ignore beside the state one", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, "<rootDir>/\\.claude/worktrees/generated/"]`), "warn", MISS,
    { path: IGNORE, equals: [S, W, String.raw`<rootDir>/\.claude/worktrees/generated/`] }],
  ["r15 jest partial session ignore alone", "jest", jestCfg(String.raw`testPathIgnorePatterns: ["<rootDir>/\\.claude/worktrees/generated/"]`), "warn", MISS,
    { path: IGNORE, equals: [S, W, String.raw`<rootDir>/\.claude/worktrees/generated/`] }],
  ["r16 vitest partial session exclude beside the state one", "vitest", vitestCfg(`exclude: [${VS}, ".claude/worktrees/**/generated/**"]`), "warn", MISS,
    { path: EXCLUDE, equals: [vS, vW, ".claude/worktrees/**/generated/**"] }],
  ["r17 vitest partial session exclude alone", "vitest", vitestCfg(`exclude: [".claude/worktrees/**/generated/**"]`), "warn", MISS,
    { path: EXCLUDE, equals: [vS, vW, ".claude/worktrees/**/generated/**"] }],
  ["r18 jest anchored state alternative beside an unanchored session one", "jest", jestCfg(String.raw`testPathIgnorePatterns: ["<rootDir>/\\.tickmarkr/|/\\.claude/worktrees/"]`), "warn",
    "holds regex syntax doctor does not read); add", "manual"],
  ["r18b jest unanchored state alternative beside an anchored session one", "jest", jestCfg(String.raw`testPathIgnorePatterns: ["/\\.tickmarkr/|<rootDir>/\\.claude/worktrees/"]`), "warn",
    "holds regex syntax doctor does not read); add", "manual"],
  // review round 4
  ["r19 jest projects, only project 2 lacks the session ignore", "jest",
    jestCfg(`projects: [{ displayName: "a", testMatch: ["<rootDir>/**/*.test.ts"], testPathIgnorePatterns: [${JS}, ${JW}] }, { displayName: "b", testMatch: ["<rootDir>/**/*.test.ts"], testPathIgnorePatterns: [${JS}] }]`),
    "warn", `(it declares projects, each with its own ignore list); add`, "manual"],
  ["r20 vitest projects, only project 2 lacks the session exclude", "vitest",
    vitestCfg(`projects: [{ test: { name: "a", include: ["**/*.test.ts"], exclude: [${VS}, ${VW}] } }, { test: { name: "b", include: ["**/*.test.ts"], exclude: [${VS}] } }]`),
    "warn", `(it declares projects, each with its own ignore list); add`, "manual"],
  ["r27 jest unanchored /\\.claude/ beside the state ignore", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, "/\\.claude/"]`), "warn", ANCH, "manual"],
  ["r28 jest unanchored /\\.claude/ beside both anchored ignores", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "/\\.claude/"]`), "warn", ANCH, "manual"],
  // review round 5
  ["r29 jest anchored extension-partial session ignore", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, "<rootDir>/\\.claude/worktrees/.*\\.(js|ts|tsx)$"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["r30 vitest extension-partial session exclude", "vitest", vitestCfg(`exclude: [${VS}, ".claude/worktrees/**/*.{js,ts,tsx}"]`), "warn", MISS,
    { path: EXCLUDE, equals: [vS, vW, ".claude/worktrees/**/*.{js,ts,tsx}"] }],
  ["r33 jest session-matching .jsx regex beside both anchored ignores", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "/\\.claude/worktrees/.*\\.jsx$"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["r34 jest session-matching .jsx regex beside the state ignore", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, "/\\.claude/worktrees/.*\\.jsx$"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  // review round 6
  ["r35 jest name-limited session ignore", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, "<rootDir>/\\.claude/worktrees/[a-z][^/]*/"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["r36 vitest name-limited session exclude", "vitest", vitestCfg(`exclude: [${VS}, ".claude/worktrees/[a-z]*"]`), "warn", MISS, { path: EXCLUDE, equals: [vS, vW, ".claude/worktrees/[a-z]*"] }],
  ["r39 vitest an unused object beside the exported config reads (add.35 allows plain consts)", "vitest", `const unused = { test: { include: ["tests/**/*.test.ts"] } };\nexport default { test: { exclude: [${VS}] } };`, "warn",
    MISS, { path: EXCLUDE, equals: [vS, vW] }],
  ["r42 jest numeric-name session regex beside both anchored ignores", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "/\\.claude/worktrees/\\d+/.*\\.jsx$"]`), "warn", `(testPathIgnorePatterns holds an escape doctor does not read); add`, "manual"],
  ["r43 jest numeric-name session regex beside the state ignore", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, "/\\.claude/worktrees/\\d+/.*\\.jsx$"]`), "warn", `(testPathIgnorePatterns holds an escape doctor does not read); add`, "manual"],
  // non-canonical exclusion forms: none is the literal entry, so each warns and fix-only adds it beside them
  ["r44 jest whole .claude ignore", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, "<rootDir>/\\.claude/"]`), "warn", MISS, { path: IGNORE, equals: [S, W, String.raw`<rootDir>/\.claude/`] }],
  ["r45 jest both anchored alternatives in one regex", "jest", jestCfg(String.raw`testPathIgnorePatterns: ["<rootDir>/\\.tickmarkr/|<rootDir>/\\.claude/worktrees/"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["r46 vitest **-led excludes", "vitest", vitestCfg(`exclude: ["**/.tickmarkr/**", "**/.claude/worktrees/**"]`), "warn", MISS, { path: EXCLUDE, equals: [vS, vW, "**/.tickmarkr/**", "**/.claude/worktrees/**"] }],
  ["r47 vitest whole .claude exclude", "vitest", vitestCfg(`exclude: [${VS}, ".claude/**"]`), "warn", MISS, { path: EXCLUDE, equals: [vS, vW, ".claude/**"] }],
  ["r48 jest plain-dot anchored ignores", "jest", jestCfg(`testPathIgnorePatterns: ["<rootDir>/.tickmarkr/", "<rootDir>/.claude/worktrees/"]`), "warn", MISS,
    { path: IGNORE, equals: [S, W, "<rootDir>/.tickmarkr/", "<rootDir>/.claude/worktrees/"] }],
  ["r49 jest anchored full run-worktree path", "jest", jestCfg(`testPathIgnorePatterns: ["<rootDir>/.tickmarkr/worktrees.noindex/", ${JW}]`), "warn", "may scan .tickmarkr/ run worktrees (duplicate",
    { path: IGNORE, equals: [S, "<rootDir>/.tickmarkr/worktrees.noindex/", W] }],
  ["r53 jest object spread", "jest", `const base = require("./jest.base.js");\nmodule.exports = { ...base, testPathIgnorePatterns: [${JS}, ${JW}] };`, "warn", UNV, "manual"],
  ["r54 jest testMatch from a variable", "jest", `const patterns = require("./patterns.js");\nmodule.exports = { testMatch: patterns, testPathIgnorePatterns: [${JS}, ${JW}] };`, "warn", UNV, "manual"],
  ["r55 jest export built by a call", "jest", `const nextJest = require("next/jest");\nmodule.exports = nextJest({ dir: "./" })({ testPathIgnorePatterns: [${JS}, ${JW}] });`, "warn", UNV, "manual"],
  ["r56 vitest mergeConfig", "vitest", `import { defineConfig, mergeConfig } from "vitest/config";\nimport viteConfig from "./vite.config";\nexport default mergeConfig(viteConfig, defineConfig({ test: { exclude: [${VS}, ${VW}] } }));`,
    "warn", "(it runs code doctor does not read); add", "manual"],
  ["r57 vitest exclude spreading an imported list", "vitest", `import { shared } from "./shared";\nexport default { test: { exclude: [...shared, ${VS}, ${VW}] } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["r58 vitest project naming another config", "vitest", vitestCfg(`exclude: [${VS}, ${VW}], projects: ["packages/*"]`), "warn", `(it declares projects, each with its own ignore list); add`, "manual"],
  ["r59 jest project naming another config", "jest", jestCfg(`projects: ["<rootDir>/packages/*"], testPathIgnorePatterns: [${JS}, ${JW}]`), "warn", `(it declares projects, each with its own ignore list); add`, "manual"],
  ["r60 vitest extends:true project inherits the root excludes", "vitest", vitestCfg(`exclude: [${VS}, ${VW}], projects: [{ extends: true, test: { name: "unit", include: ["**/*.test.ts"] } }]`), "warn", `(it declares projects, each with its own ignore list); add`, "manual"],
  ["r61 vitest project without extends falls back to the defaults", "vitest", vitestCfg(`exclude: [${VS}, ${VW}], projects: [{ test: { name: "unit", include: ["**/*.test.ts"] } }]`), "warn",
    `(it declares projects, each with its own ignore list); add`, "manual"],
  ["r64 vitest configDefaults.exclude spread", "vitest", `import { configDefaults } from "vitest/config";\nexport default { test: { exclude: [...configDefaults.exclude, ${VS}] } };`, "warn", MISS, { path: EXCLUDE, equals: ["**/node_modules/**", vS, vW] }],
  ["r70 jest rooted testMatch beside the SentioQ run-2 poison", "jest", jestCfg(`testMatch: ["<rootDir>/tests/**/*.test.ts"], testPathIgnorePatterns: ["/node_modules/", "/.tickmarkr/"]`), "warn",
    "jest ignore for .tickmarkr/ is not <rootDir>-anchored", { path: IGNORE, equals: ["/node_modules/", S, W] }],
  ["r72 jest exported binding mutated after its literal", "jest", `const config = { testPathIgnorePatterns: [${JS}, ${JW}] };\nconfig.testPathIgnorePatterns.push("/.claude/");\nmodule.exports = config;`, "warn",
    UNV, "manual"],
  ["r73 jest export assembled in parts", "jest", `module.exports = { testPathIgnorePatterns: [${JS}, ${JW}] };\nmodule.exports.testMatch = ["**/*.test.ts"];`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["r74 jest ignore set twice", "jest", jestCfg(`testPathIgnorePatterns: [${JS}], testPathIgnorePatterns: [${JS}, ${JW}]`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["r75 jest JSON config, state ignore only", "jest-json", `{"testMatch": ["**/*.test.ts"], "testPathIgnorePatterns": [${JS}]}`, "warn", MISS, { path: IGNORE, equals: [S, W] }],
  ["r77 vitest exclude only under coverage", "vitest", vitestCfg(`coverage: { exclude: ["dist/"] }`), "warn", MISS, { path: EXCLUDE, equals: [...VDEF, vS, vW] }],
  ["r78 jest ignore from a variable", "jest", `const ignore = ["/node_modules/"];\nmodule.exports = { testMatch: ["**/*.test.ts"], testPathIgnorePatterns: ignore };`, "warn", UNV, "manual"],
  ["r80 jest canonical ignores inside a block comment", "jest", `module.exports = {\n  testMatch: ["**/*.test.ts"],\n  /*\n  testPathIgnorePatterns: [${JS}, ${JW}],\n  */\n};`, "warn",
    MISS, { path: IGNORE, equals: ["/node_modules/", S, W] }],
  ["r81 jest canonical ignores inside a trailing block comment", "jest", jestCfg(`testMatch: ["**/*.test.ts"], /* testPathIgnorePatterns: [${JS}, ${JW}] */`), "warn", MISS, { path: IGNORE, equals: ["/node_modules/", S, W] }],
  // configs doctor cannot read, each a warn with fix-only manual: an export, test or project that is not one
  // object literal or wrapper call, and a config that declares projects (each carries its own list)
  ["s4 vitest export of a rooted config && a state-only one", "vitest", `export default { test: { include: ["tests/**/*.test.ts"] } } && { test: { exclude: [${VS}] } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["s5 vitest test of a rooted object && a state-only one", "vitest", `export default { test: { include: ["tests/**/*.test.ts"] } && { exclude: [${VS}] } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["s6 vitest project of a rooted object && a state-only one", "vitest", vitestCfg(`projects: [{ test: { include: ["tests/**/*.test.ts"] } } && { test: { exclude: [${VS}] } }]`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["s7 jest export of a canonical config && a state-only one", "jest", `module.exports = { testPathIgnorePatterns: [${JS}, ${JW}] } && { testPathIgnorePatterns: [${JS}] };`, "warn", UNV, "manual"],
  ["s12 vitest conditional export", "vitest", `export default process.env.CI ? { test: { exclude: [${VS}, ${VW}] } } : { test: {} };`, "warn", UNV, "manual"],
  ["s13 vitest export with a trailing operator", "vitest", `export default { test: { exclude: [${VS}, ${VW}] } } || {};`, "warn", UNV, "manual"],
  ["s14 vitest wrapper call with a second argument", "vitest", `export default defineConfig({ test: { exclude: [${VS}, ${VW}] } }, {});`, "warn", UNV, "manual"],
  ["s17 vitest project spread", "vitest", `import { shared } from "./shared";\nexport default { test: { projects: [...shared] } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["s18 jest project wrapped in a call", "jest", jestCfg(`projects: [withDefaults({ testPathIgnorePatterns: [${JS}, ${JW}] })]`), "warn", "(it runs code doctor does not read); add", "manual"],
  // D-2102 add.22 (a): doctor reads only a simple static file — imports, type-only declarations and exactly
  // one export of a supported literal, optionally through one binding; module, exports and that binding occur
  // nowhere else. The verify review's executed shapes first (t1, t2).
  ["t1 jest export mutated through a module.exports alias", "jest", `module.exports = { testPathIgnorePatterns: [${JS}, ${JW}] };\nconst config = module.exports;\nconfig.testPathIgnorePatterns = [${JS}];`, "warn", UNV, "manual"],
  ["t2 jest export mutated through bracket access", "jest", `module.exports = { testPathIgnorePatterns: [${JS}, ${JW}] };\nmodule["exports"].testPathIgnorePatterns = [${JS}];`, "warn", UNV, "manual"],
  ["t3 jest export mutated through the exports alias", "jest", `module.exports = { testPathIgnorePatterns: [${JS}, ${JW}] };\nexports.testPathIgnorePatterns = [${JS}];`, "warn", UNV, "manual"],
  ["t4 jest Object.assign onto the export", "jest", `module.exports = { testPathIgnorePatterns: [${JS}, ${JW}] };\nObject.assign(module.exports, { testPathIgnorePatterns: [${JS}] });`, "warn", UNV, "manual"],
  ["t5 jest exported binding read by bracket access", "jest", `const config = { testPathIgnorePatterns: [${JS}, ${JW}] };\nconfig["testPathIgnorePatterns"] = [${JS}];\nmodule.exports = config;`, "warn", UNV, "manual"],
  ["t6 jest exported let binding reassigned", "jest", `let config = { testPathIgnorePatterns: [${JS}, ${JW}] };\nconfig = { testPathIgnorePatterns: [${JS}] };\nmodule.exports = config;`, "warn", UNV, "manual"],
  ["t7 jest conditional mutation after the export", "jest", `module.exports = { testPathIgnorePatterns: [${JS}, ${JW}] };\nif (process.env.CI) module.exports.testPathIgnorePatterns = [${JS}];`, "warn", UNV, "manual"],
  ["t8 jest require beside the export", "jest", `const path = require("node:path");\nmodule.exports = { testPathIgnorePatterns: [${JS}, ${JW}] };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["t9 vitest a call statement beside the export", "vitest", `export default { test: { exclude: [${VS}, ${VW}] } };\nconsole.log("loaded");`, "warn", UNV, "manual"],
  ["t10 vitest a function declaration beside the export", "vitest", `function extra() { return 1; }\nexport default { test: { exclude: [${VS}, ${VW}] } };`, "warn", UNV, "manual"],
  ["t11 vitest a named export beside the default one", "vitest", `export const shared = { exclude: [${VS}] };\nexport default { test: { exclude: [${VS}, ${VW}] } };`, "warn", UNV, "manual"],
  ["t12 vitest two exports", "vitest", `export default { test: { exclude: [${VS}, ${VW}] } };\nmodule.exports = { test: { exclude: [${VS}] } };`, "warn", UNV, "manual"],
  ["t13 vitest an export continued on the next line", "vitest", `export default { test: { exclude: [${VS}, ${VW}] } }\n  && { test: { exclude: [${VS}] } };`, "warn", UNV, "manual"],
  ["t14 vitest exported binding mutated by a spread copy", "vitest", `const config = { test: { exclude: [${VS}, ${VW}] } };\nexport default { ...config, test: { exclude: [${VS}] } };`, "warn", UNV, "manual"],
  ["t15 vitest module read inside the exported literal", "vitest", vitestCfg(`exclude: [${VS}, ${VW}], setupFiles: [module.id]`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["t16 jest exported binding read inside its own literal", "jest", `const config = { testPathIgnorePatterns: [${JS}, ${JW}], self: () => config };\nmodule.exports = config;`, "warn", "(it runs code doctor does not read); add", "manual"],
  // D-2102 add.22 (b): a project file or a second config the runner reads beside this one (the review's
  // vitest.projects.* and vitest.workspace.* shapes, every extension) leaves the config unreadable.
  ...["ts", "mts", "cts", "js", "mjs", "cjs", "json"].flatMap((ext): Row[] => ["projects", "workspace"].map((stem): Row => [
    `u vitest.${stem}.${ext} beside a rooted config`, "vitest", vitestCfg(`include: ["tests/**/*.test.ts"]`), "warn", `(vitest.${stem}.${ext} declares projects beside it); add`, "manual",
    { [`vitest.${stem}.${ext}`]: ext === "json" ? `[{ "test": { "exclude": [${VS}] } }]` : `export default [{ test: { exclude: [${VS}] } }];` }])),
  ["u two vitest configs", "vitest", vitestCfg(`exclude: [${VS}, ${VW}]`), "warn", `(vitest.config.mts and vitest.config.mjs both configure vitest); add`, "manual",
    { "vitest.config.mts": vitestCfg(`exclude: [${VS}]`) }],
  ["u two jest config files", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}]`), "warn", `(jest.config.ts and jest.config.js both configure jest); add`, "manual",
    { "jest.config.ts": `export default { testPathIgnorePatterns: [${JS}] };` }],
  ["u a jest config file beside the package.json jest block", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}]`), "warn",
    `(jest.config.js and the package.json jest block both configure jest); add`, "manual", { "package.json": JSON.stringify({ scripts: { test: "jest" }, jest: { testMatch: ["**/*.test.ts"] } }) }],
  // a rooted jest testMatch is not the entry either: fix-only adds it, or the whole property where none exists
  ["w1 jest <rootDir>-rooted testMatch", "jest", jestCfg(`testMatch: ["<rootDir>/src/**/*.test.ts", "<rootDir>/tests/**/*.test.ts"], testPathIgnorePatterns: ["/node_modules/"]`), "warn",
    MISS, { path: IGNORE, equals: [S, W, "/node_modules/"] }],
  ["w2 jest plain rooted testMatch without an ignore array", "jest", jestCfg(`testMatch: ["src/**/*.test.ts"]`), "warn", MISS, { path: IGNORE, equals: ["/node_modules/", S, W] }],
  // D-2102 add.25 (c′): settings keys that would hide the list leave the config unreadable — an escaped
  // spelling of a setting or of another key, an unsupported escape, a member without a plain key, one setting
  // twice. The r4 verify review's escaped-key shapes first (y3-y5).
  ["y3 jest escaped key overriding the canonical ignores", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}], "\x74estPathIgnorePatterns": [${JS}]`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["y4 vitest escaped test key overriding the canonical test", "vitest", String.raw`export default { test: { exclude: [${VS}, ${VW}] }, "\x74est": { exclude: [${VS}] } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["y5 jest JSON escaped key overriding the canonical ignores", "jest-json", String.raw`{"testPathIgnorePatterns": [${JS}, ${JW}], "\u0074estPathIgnorePatterns": [${JS}]}`, "warn", "has a member that is not a plain key and value); add", "manual"],
  ["z12 jest computed key", "jest", jestCfg(`["testPathIgnorePatterns"]: [${JS}, ${JW}]`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["z13 jest identifier key written with a unicode escape", "jest", jestCfg(String.raw`\u0074estPathIgnorePatterns: [${JS}, ${JW}]`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["z17 vitest test key and its quoted twin", "vitest", `export default { test: { exclude: [${VS}, ${VW}] }, "test": { exclude: [${VS}] } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["z20 vitest method member in the test object", "vitest", vitestCfg(`include: ["tests/**/*.test.ts"], setup() { return 1; }`), "warn", UNV, "manual"],
  ["z22 jest escaped key duplicating another key", "jest", jestCfg(String.raw`displayName: "unit", "display\u004eame": "e2e", testPathIgnorePatterns: [${JS}, ${JW}]`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["z23 jest settings key with an unsupported escape", "jest", jestCfg(String.raw`"te\qst": 1, testPathIgnorePatterns: [${JS}, ${JW}]`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["z24 jest settings key with an octal escape", "jest", jestCfg(String.raw`"\164estMatch": ["**/*.test.ts"], testPathIgnorePatterns: [${JS}, ${JW}]`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["z25 vitest escaped exclude key in the test object", "vitest", vitestCfg(String.raw`exclude: [${VS}, ${VW}], "\u{65}xclude": [${VS}]`), "warn", "(it runs code doctor does not read); add", "manual"],
  // D-2102 add.28: string values are decoded strictly before any check; a jest regex may keep only \. \/ \-
  // and \\ outside a class, a glob or path no backslash. The r5 verify review's regex shapes first (e7, e8).
  ["e7 jest regex \\x escape beside both canonical ignores", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "/\\.cl\\x61ude/"]`), "warn", `(testPathIgnorePatterns holds an escape doctor does not read); add`, "manual"],
  ["e8 jest regex \\u escape beside both canonical ignores", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "/\\.cl\\u0061ude/"]`), "warn", `(testPathIgnorePatterns holds an escape doctor does not read); add`, "manual"],
  ["e9 jest string \\x escape decoding to an unanchored .claude ignore", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "/\\.cl\x61ude/"]`), "warn", "jest ignore for .claude/worktrees/ is not <rootDir>-anchored", "manual"],
  ["e10 jest string \\u escape decoding to an unanchored .claude ignore", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "/\\.cl\u0061ude/"]`), "warn", "jest ignore for .claude/worktrees/ is not <rootDir>-anchored", "manual"],
  ["e11 jest regex escape inside a character class", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "/[\\.]claude/"]`), "warn", `(testPathIgnorePatterns holds an escape doctor does not read); add`, "manual"],
  ["e15 jest string with an unsupported escape", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "\q"]`), "warn", `(testPathIgnorePatterns holds an escape doctor does not read); add`, "manual"],
  ["e16 jest JSON escaped slashes", "jest-json", String.raw`{"testPathIgnorePatterns": ["<rootDir>\/\\.tickmarkr\/", ${JW}]}`, "warn", `(testPathIgnorePatterns holds an escape doctor does not read); add`, "manual"],
  ["p31 vitest canonical excludes spelled with escapes", "vitest", vitestCfg(String.raw`exclude: ["\x2etickmarkr/**", "\u002eclaude/worktrees/**"]`), "pass", OK, "none"],
  ["p32 jest canonical session ignore spelled with an escape", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, "<rootDir>/\\\x2eclaude/worktrees/"]`), "pass", OK, "none"],
  // D-2102 add.29: nothing is read unless the file parses cleanly — no "/" outside strings and comments, every
  // string, comment and bracket closed, EOF never a close — and fix-only certifies only the effective array.
  // The r6 verify review's executed shapes first (g1-g7).
  ["g1 vitest rooted test, a /{/ regex, then an overriding repo-wide test", "vitest", `export default { test: { include: ["tests/**/*.test.ts"] }, define: { x: /{/ }, test: { include: ["**/*.test.ts"] } };`, "warn", `(a / outside strings and comments (a regex literal or a division)); add`, "manual"],
  ["g2 vitest canonical excludes, a /{/ regex, then an overriding state-only exclude", "vitest", vitestCfg(`exclude: [${VS}, ${VW}], deps: { inline: [/{/] }, exclude: [${VS}]`), "warn", `(a / outside strings and comments (a regex literal or a division)); add`, "manual"],
  ["g3 vitest rooted test, resolve.alias find /{/, then an overriding repo-wide test", "vitest",
    `export default { test: { include: ["tests/**/*.test.ts"] }, resolve: { alias: [{ find: /{/, replacement: "x" }] }, test: { include: ["**/*.test.ts"] } };`, "warn", `(a / outside strings and comments (a regex literal or a division)); add`, "manual"],
  ["g4 jest canonical ignores, a /{/ regex, then an overriding state-only ignore", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}], globals: { x: /{/ }, testPathIgnorePatterns: [${JS}]`), "warn", `(a / outside strings and comments (a regex literal or a division)); add`, "manual"],
  ["g5 vitest rooted include, a /\\(/ regex in server.deps.inline, then a repo-wide includeSource", "vitest",
    vitestCfg(String.raw`include: ["tests/**/*.test.ts"], server: { deps: { inline: [/\(/] } }, includeSource: ["**/*.ts"], exclude: [${VS}]`), "warn", `(a / outside strings and comments (a regex literal or a division)); add`, "manual"],
  ["g6 vitest rooted include, a /\\(/ regex, then a state-only project", "vitest",
    vitestCfg(String.raw`include: ["tests/**/*.test.ts"], server: { deps: { inline: [/\(/] } }, projects: [{ test: { exclude: [${VS}] } }]`), "warn", `(a / outside strings and comments (a regex literal or a division)); add`, "manual"],
  ["g7 vitest state-only exclude, a /\\(/ regex, then another state-only exclude", "vitest",
    vitestCfg(String.raw`exclude: [${VS}], server: { deps: { inline: [/\(/] } }, exclude: [${VS}]`), "warn", `(a / outside strings and comments (a regex literal or a division)); add`, "manual"],
  ["g8 vitest a regex literal in a nested value", "vitest", vitestCfg(`include: ["tests/**/*.test.ts"], server: { deps: { inline: [/lodash/] } }`), "warn", `(a / outside strings and comments (a regex literal or a division)); add`, "manual"],
  ["g9 vitest a division", "vitest", vitestCfg(`include: ["tests/**/*.test.ts"], testTimeout: 60000 / 2`), "warn", `(a / outside strings and comments (a regex literal or a division)); add`, "manual"],
  ["g10 vitest unbalanced at the end of the file", "vitest", `export default { test: { include: ["tests/**/*.test.ts"] }`, "warn", `(an unclosed bracket); add`, "manual"],
  ["g11 vitest an extra closer", "vitest", `export default { test: { include: ["tests/**/*.test.ts"] } } };`, "warn", `(an unmatched closing bracket); add`, "manual"],
  ["g12 vitest a trailing statement after the export", "vitest", `export default { test: { include: ["tests/**/*.test.ts"] } };\nvoid 0;`, "warn", UNV, "manual"],
  ["g13 vitest an unclosed string", "vitest", `export default { test: { include: ["tests/**/*.test.ts] } };`, "warn", `(an unclosed string); add`, "manual"],
  ["g14 vitest an unclosed block comment", "vitest", `export default { test: { include: ["tests/**/*.test.ts"] } }; /* note`, "warn", `(an unclosed comment); add`, "manual"],
  ["g15 vitest a template literal with a substitution", "vitest", "export default { test: { include: [`${'tests'}/**/*.test.ts`] } };", "warn", `(a template literal with a substitution); add`, "manual"],
  ["g16 vitest a state-only exclude set twice", "vitest", vitestCfg(`exclude: [${VS}], exclude: [${VS}]`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["g17 jest an unclosed bracket in a nested value", "jest", `module.exports = { testPathIgnorePatterns: [${JS}, ${JW}], globals: { x: [1, 2 } };`, "warn", `(an unmatched closing bracket); add`, "manual"],
  // D-2102 add.32: a jest ignore entry other than the canonical ones is judged only when it is literal — any
  // class, group, alternation, quantifier, anchor or escape beyond "\." leaves the config unread, and fix-only
  // never certifies while one stays. The r9 review's shapes first (q1-q4), then its invalid JSON (q5, q6).
  ["q1 jest a character class spelling .claude beside both canonical ignores", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}, "/[.]c[lL]aude/"]`), "warn",
    `(testPathIgnorePatterns entry "/[.]c[lL]aude/" holds regex syntax doctor does not read); add`, "manual"],
  ["q2 jest an alternation spelling .claude beside both canonical ignores", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}, "/[.]cl(a|au)ude/"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["q3 jest an alternation spelling .claude beside the state ignore: fix-only never certifies", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, "/[.]cl(a|au)ude/"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["q4 jest classes spelling .claude/worktrees beside the state ignore", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, "/[.]c[lL]aude/workt[rR]ees/"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["q5 jest JSON with a trailing comma beside both canonical ignores", "jest-json", `{"testPathIgnorePatterns": [${JS}, ${JW}],}`, "warn", "doctor could not read jest.config.json (invalid JSON); add", "manual"],
  ["q6 jest JSON with a single-quoted key", "jest-json", `{'testPathIgnorePatterns': [${JS}, ${JW}]}`, "warn", "(invalid JSON); add", "manual"],
  ["q7 jest a negated character class", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}, "/[^x]claude/"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["q8 jest a quantifier", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "/\\.cla+ude/"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["q9 jest an anchored regex holding a class", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, "<rootDir>/[.]claude/worktrees/"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["q10 jest an end anchor on a blind entry", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "\\.d\\.ts$"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["q11 jest JSON with a comment", "jest-json", `{\n  // run and session worktrees\n  "testPathIgnorePatterns": [${JS}, ${JW}]\n}`, "warn", "(invalid JSON); add", "manual"],
  ["q12 jest JSON with the ignore key twice", "jest-json", `{"testPathIgnorePatterns": [${JS}, ${JW}], "testPathIgnorePatterns": [${JS}]}`, "warn", "(testPathIgnorePatterns is set twice); add", "manual"],
  ["q13 jest a literal unanchored .claude entry still warns as unanchored", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "/\\.claude/"]`), "warn", "jest ignore for .claude/worktrees/ is not <rootDir>-anchored", "manual"],
  // D-2102 add.33: a jest ignore entry is judged only inside a whitelist — ANCHORED (<rootDir>, then plain path
  // characters or "\.", no ".." segment) or LITERAL (plain path characters or "\.", no bare dot) — and then by
  // executing it as jest reads it against a probe suite inside each worktree root and in the main checkout:
  // it self-matches when it drops the first and not the second. The r10 review's wildcard shapes first (k1-k4).
  ["k1 jest a bare-dot wildcard spelling .claude beside both canonical ignores", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "/\\.cl.ude/"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["k2 jest a bare-dot wildcard spelling .tickmarkr beside both canonical ignores", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "/\\.tickm.rkr/"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["k3 jest bare dots alone beside both canonical ignores", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}, "/......./"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["k4 jest a bare-dot wildcard beside the state ignore: fix-only never certifies", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, "/\\.cl.ude/"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["k5 jest a partial literal that matches inside the session worktree", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}, "laude/"]`), "warn", "jest ignore for .claude/worktrees/ is not <rootDir>-anchored", "manual"],
  ["k6 jest a partial literal of worktrees that matches inside it", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}, "orktrees/"]`), "warn", "jest ignore for .claude/worktrees/ is not <rootDir>-anchored", "manual"],
  ["k7 jest a partial literal of .tickmarkr that matches inside a run worktree", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "\\.tickm"]`), "warn", "jest ignore for .tickmarkr/ is not <rootDir>-anchored", "manual"],
  ["k8 jest a slash-bounded partial literal matching neither worktree path", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}, "/laude/", "/orktrees/"]`), "pass", OK, "none"],
  ["k9 jest a slash-bounded partial literal of .tickmarkr matching no worktree path", "jest", jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "/\\.tickm/"]`), "pass", OK, "none"],
  ["k10 jest an anchored entry climbing out of <rootDir>", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}, "<rootDir>/../"]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["k11 jest an anchored entry with a bare dot (Next.js)", "jest", jestCfg(`testPathIgnorePatterns: ["<rootDir>/.next/", ${JS}, ${JW}]`), "pass", OK, "none"],
  ["k12 jest a literal with a bare dot", "jest", jestCfg(`testPathIgnorePatterns: ["/node_modules/.cache/", ${JS}, ${JW}]`), "warn", "holds regex syntax doctor does not read); add", "manual"],
  ["k13 jest rootDir set below the config", "jest", jestCfg(`rootDir: "src", testPathIgnorePatterns: [${JS}, ${JW}]`), "warn",
    `(rootDir "src" re-roots <rootDir> away from jest.config.js's own directory); add`, "manual"],
  ["k14 jest rootDir computed", "jest", jestCfg(`rootDir: __dirname, testPathIgnorePatterns: [${JS}, ${JW}]`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["k15 jest rootDir at the config's own directory", "jest", jestCfg(`rootDir: ".", testPathIgnorePatterns: [${JS}, ${JW}]`), "pass", OK, "none"],
  ["k16 jest rootDir spelled <rootDir>", "jest", jestCfg(`rootDir: "<rootDir>", testPathIgnorePatterns: [${JS}, ${JW}]`), "pass", OK, "none"],
  ["k17 jest a literal naming an existing session worktree", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}, "/feature-x/"]`), "warn", "jest ignore for .claude/worktrees/ is not <rootDir>-anchored", "manual",
    { ".claude/worktrees/feature-x/keep.txt": "" }],
  ["k18 jest a literal naming an existing run worktree", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}, "run-0001"]`), "warn", "jest ignore for .tickmarkr/ is not <rootDir>-anchored", "manual",
    { ".tickmarkr/worktrees.noindex/run-0001/keep.txt": "" }],
  ["k19 jest the same literal with no such worktree yet (the queue row 208 residual)", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}, "/feature-x/"]`), "pass", OK, "none"],
  // D-2102 add.34: a defineConfig or defineProject call reads as an identity wrapper only when a static import (or
  // a const require) of the runner's own module binds it — vitest "vitest/config", "vitest" or "vite", jest "jest";
  // any other callee leaves the config unread, at every level. The r11 review's shapes first (d1-d5).
  ["d1 vitest a custom defineConfig around both canonical excludes", "vitest", `import { defineConfig } from "./config-helpers";\nexport default defineConfig({ test: { exclude: [${VS}, ${VW}] } });`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["d2 vitest a custom defineConfig around the state exclude: fix-only stays manual", "vitest", `import { defineConfig } from "./config-helpers";\nexport default defineConfig({ test: { exclude: [${VS}] } });`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["d3 vitest a custom defineProject", "vitest", `import { defineProject } from "./config-helpers";\nexport default defineProject({ test: { exclude: [${VS}] } });`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["d4 vitest a custom defineConfig wrapping the test object", "vitest",
    `import { defineConfig as vitestConfig } from "vitest/config";\nimport { defineConfig } from "./config-helpers";\nexport default vitestConfig({ test: defineConfig({ exclude: [${VS}] }) });`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["d5 jest a custom defineConfig", "jest", `import { defineConfig } from "./jest-helpers";\nexport default defineConfig({ testPathIgnorePatterns: [${JS}] });`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["d6 vitest the genuine vitest/config defineConfig around the state exclude", "vitest", `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { exclude: [${VS}] } });`, "warn", MISS,
    { path: EXCLUDE, equals: [vS, vW] }],
  ["d7 vitest the genuine vite defineConfig", "vitest", `import { defineConfig } from "vite";\nexport default defineConfig({ test: { exclude: [${VS}, ${VW}] } });`, "pass", OK, "none"],
  ["d8 vitest the genuine vitest defineConfig", "vitest", `import { defineConfig } from "vitest";\nexport default defineConfig({ test: { exclude: [${VS}, ${VW}] } });`, "pass", OK, "none"],
  ["d9 jest the genuine jest defineConfig", "jest", `import { defineConfig } from "jest";\nexport default defineConfig({ testPathIgnorePatterns: [${JS}, ${JW}] });`, "pass", OK, "none"],
  ["d10 vitest a renamed genuine import", "vitest", `import { defineConfig as vitestConfig } from "vitest/config";\nexport default vitestConfig({ test: { exclude: [${VS}, ${VW}] } });`, "pass", OK, "none"],
  ["d11 vitest an unresolved global defineConfig with no import", "vitest", `export default defineConfig({ test: { exclude: [${VS}, ${VW}] } });`, "warn", `(the call defineConfig(…) is not an identity wrapper imported from the runner); add`, "manual"],
  ["d12 jest the genuine jest defineConfig by const require, state ignore only", "jest", `const { defineConfig } = require("jest");\nmodule.exports = defineConfig({ testPathIgnorePatterns: [${JS}] });`, "warn", MISS,
    { path: IGNORE, equals: [S, W] }],
  ["d13 jest a renamed genuine jest require", "jest", `const { defineConfig: jestConfig } = require("jest");\nmodule.exports = jestConfig({ testPathIgnorePatterns: [${JS}, ${JW}] });`, "pass", OK, "none"],
  // D-2102 add.34: a LITERAL entry is also probed along its own tail past an existing worktree
  ["d14 jest a literal reaching a folder below an existing session worktree", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}, "worktrees/feature-x/test/"]`), "warn",
    "jest ignore for .claude/worktrees/ is not <rootDir>-anchored", "manual", { ".claude/worktrees/feature-x/keep.txt": "" }],
  ["d15 jest the same literal with no such worktree yet (the queue row 208 residual)", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}, "worktrees/feature-x/test/"]`), "pass", OK, "none"],
  // D-2102 add.35, a whitelist: the top level holds only imports in the strict grammar, one runner require, plain
  // consts and one export of an object (or an identity wrapper around one); no file binds require, module or
  // exports, or any name twice; every evaluated value compiles; each path object holds only plain, once-only
  // keys. The r12 review's eight shapes first (x1-x8), then siblings and the object-literal forms.
  ["x1 vitest a custom require shadowing the runner's, canonical excludes", "vitest", `import { require } from "./helpers";\nconst { defineConfig } = require("vitest/config");\nexport default defineConfig({ test: { exclude: [${VS}, ${VW}] } });`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["x2 vitest a custom require shadowing the runner's, state exclude: fix-only stays manual", "vitest", `import { require } from "./helpers";\nconst { defineConfig } = require("vitest/config");\nexport default defineConfig({ test: { exclude: [${VS}] } });`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["x3 jest a custom require shadowing jest's, canonical ignores", "jest", `import { require } from "./helpers";\nconst { defineConfig } = require("jest");\nmodule.exports = defineConfig({ testPathIgnorePatterns: [${JS}, ${JW}] });`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["x4 jest a custom require shadowing jest's, state ignore: fix-only stays manual", "jest", `import { require } from "./helpers";\nconst { defineConfig } = require("jest");\nmodule.exports = defineConfig({ testPathIgnorePatterns: [${JS}] });`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["x5 jest an empty testMatch value beside both canonical ignores", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}], testMatch: `), "warn", "(invalid syntax); add", "manual"],
  ["x6 jest an empty testMatch value beside the state ignore: fix-only stays manual", "jest", jestCfg(`testPathIgnorePatterns: [${JS}], testMatch: `), "warn", "(invalid syntax); add", "manual"],
  ["x7 vitest an empty include value beside both canonical excludes", "vitest", vitestCfg(`exclude: [${VS}, ${VW}], include: `), "warn", "(invalid syntax); add", "manual"],
  ["x8 vitest an empty include value beside the state exclude: fix-only stays manual", "vitest", vitestCfg(`exclude: [${VS}], include: `), "warn", "(invalid syntax); add", "manual"],
  ["x9 vitest a default-imported require", "vitest", `import require from "./require";\nexport default { test: { exclude: [${VS}, ${VW}] } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["x10 jest a const require of its own", "jest", `const require = (m) => m;\nmodule.exports = { testPathIgnorePatterns: [${JS}, ${JW}] };`, "warn", "(the config binds its own require); add", "manual"],
  ["x11 vitest a namespace import named module", "vitest", `import * as module from "./module";\nexport default { test: { exclude: [${VS}, ${VW}] } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["x12 jest a missing value after a comma", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}], , `), "warn", "(invalid syntax); add", "manual"],
  ["x13 vitest a dangling operator after the exclude", "vitest", vitestCfg(`exclude: [${VS}, ${VW}] + `), "warn", "(invalid syntax); add", "manual"],
  ["x14 vitest as const inside a value (TypeScript-only syntax, the queue row 208 residual)", "vitest", vitestCfg(`exclude: [${VS}, ${VW}] as const`), "warn", "(invalid syntax); add", "manual"],
  ["x15 jest jest.config.ts form: import type, a typed const, the export of it", "jest-ts", `import type { Config } from "jest";\nconst config: Config = {\n  testPathIgnorePatterns: [${JS}, ${JW}],\n};\nexport default config;`, "pass", OK, "none"],
  ["x16 jest the ignore key twice, canonical first and state-only last", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}], testPathIgnorePatterns: [${JS}]`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["x17 jest a plain quoted ignore key", "jest", jestCfg(`"testPathIgnorePatterns": [${JS}, ${JW}]`), "pass", OK, "none"],
  ["x18 vitest a computed test key", "vitest", `export default { [${"`test`"}]: { exclude: [${VS}] } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["x19 vitest a computed exclude key", "vitest", vitestCfg(`["exclude"]: [${VS}, ${VW}]`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["x20 jest __proto__ in the config", "jest", jestCfg(`__proto__: { testPathIgnorePatterns: [${JS}] }, testPathIgnorePatterns: [${JS}, ${JW}]`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["x21 jest a shorthand ignore property", "jest", `const testPathIgnorePatterns = [${JS}, ${JW}];\nmodule.exports = { testPathIgnorePatterns };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["x22 jest a getter for the ignore list", "jest", `module.exports = { get testPathIgnorePatterns() { return [${JS}]; } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["x23 jest a method beside the canonical ignores", "jest", jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}], setup() { return 1; }`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["x24 jest a spread after the list", "jest", `const other = { testPathIgnorePatterns: [${JS}] };\nmodule.exports = { testPathIgnorePatterns: [${JS}, ${JW}], ...other };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["x25 vitest a trailing reassignment of the exclude", "vitest", `const config = { test: { exclude: [${VS}, ${VW}] } };\nconfig.test.exclude = [${VS}];\nexport default config;`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["x26 jest exports.default", "jest", `exports.default = { testPathIgnorePatterns: [${JS}, ${JW}] };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["x27 vitest export { config as default }", "vitest", `const config = { test: { exclude: [${VS}, ${VW}] } };\nexport { config as default };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["x28 vitest Object.assign as the export", "vitest", `export default Object.assign({}, { test: { exclude: [${VS}, ${VW}] } });`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["x29 jest a plain const beside the export reads", "jest", `const shared = ["/node_modules/"];\nmodule.exports = { testPathIgnorePatterns: [${JS}, ${JW}] };`, "pass", OK, "none"],
  ["x30 jest a const naming the export's binding", "jest", `const config = { testPathIgnorePatterns: [${JS}, ${JW}] };\nconst copy = config;\nmodule.exports = config;`, "pass", OK, "none"],
  ["x31 jest the runner required twice", "jest", `const { defineConfig } = require("jest");\nconst { defineConfig: again } = require("jest");\nmodule.exports = defineConfig({ testPathIgnorePatterns: [${JS}, ${JW}] });`, "warn",
    "(the config requires the runner's module more than once); add", "manual"],
  ["x32 jest a let beside the export", "jest", `let counter = 1;\nmodule.exports = { testPathIgnorePatterns: [${JS}, ${JW}] };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["x33 vitest an import outside the strict grammar", "vitest", `import data from "./data.json" with { type: "json" };\nexport default { test: { exclude: [${VS}, ${VW}] } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["x34 vitest a wrapper name imported twice", "vitest", `import { defineConfig } from "vitest/config";\nimport { defineConfig as defineConfig } from "vite";\nexport default defineConfig({ test: { exclude: [${VS}, ${VW}] } });`, "warn",
    "(the config binds defineConfig more than once); add", "manual"],
  // D-2102 add.37 (operator first-hand, add.38): the exported config is PURE DATA — literals, arrays and plain
  // objects of them at every level, process.env reads and earlier pure-data consts — and the file parses with a
  // real parser in a child process; anything that runs code reads unverifiable. The r13b review's shapes first.
  ["m1 vitest an eval mutating the exported exclude", "vitest", `const config = { test: { exclude: [${VS}, ${VW}] } };\nconst change = eval("config.test.exclude.pop()");\nexport default config;`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["m2 vitest a unicode-escaped binding mutating the exclude", "vitest", String.raw`const config = { test: { exclude: [${VS}, ${VW}] } };
const change = conf\u0069g.test.exclude.pop();
export default config;`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["m3 jest an eval mutating the exported ignore list", "jest", `module.exports = { testPathIgnorePatterns: [${JS}, ${JW}] };\nconst change = eval("module.exports.testPathIgnorePatterns.pop()");`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["m4 jest a unicode-escaped module mutating the ignore list", "jest", String.raw`module.exports = { testPathIgnorePatterns: [${JS}, ${JW}] };
const change = m\u006fdule["exports"].testPathIgnorePatterns.pop();`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["m5 vitest a malformed import before a state-only config: fix-only stays manual", "vitest", `import {, defineConfig} from "vitest/config";\nexport default { test: { exclude: [${VS}] } };`, "warn", "(invalid syntax); add", "manual"],
  ["m6 vitest a malformed type declaration before a state-only config: fix-only stays manual", "vitest-ts", `type Note = ;\nexport default { test: { exclude: [${VS}] } };`, "warn", "(invalid syntax); add", "manual"],
  ["m7 vitest a plugin call", "vitest", `import { defineConfig } from "vitest/config";\nexport default defineConfig({ plugins: [react()], test: { exclude: [${VS}, ${VW}] } });`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["m8 vitest a defineConfig arrow", "vitest", `import { defineConfig } from "vitest/config";\nexport default defineConfig(() => ({ test: { exclude: [${VS}, ${VW}] } }));`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["m9 vitest this off the path", "vitest", vitestCfg(`exclude: [${VS}, ${VW}], env: { self: this }`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["m10 vitest arguments off the path", "vitest", vitestCfg(`exclude: [${VS}, ${VW}], env: { args: arguments }`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["m11 vitest a tagged template off the path", "vitest", "export default { test: { exclude: [" + VS + ", " + VW + "], env: { tag: String.raw`x` } } };", "warn", "(it runs code doctor does not read); add", "manual"],
  ["m12 vitest a template substitution off the path", "vitest", "export default { test: { exclude: [" + VS + ", " + VW + "], env: { home: `${'h'}` } } };", "warn", "(a template literal with a substitution); add", "manual"],
  ["m13 vitest new off the path", "vitest", vitestCfg(`exclude: [${VS}, ${VW}], env: { at: new Date() }`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["m14 vitest a getter off the path", "vitest", vitestCfg(`exclude: [${VS}, ${VW}], env: { get at() { return 1; } }`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["m15 vitest a ternary on the environment", "vitest", vitestCfg(`exclude: process.env.CI ? [${VS}, ${VW}] : [${VS}]`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["m16 vitest a plain process.env read off the path", "vitest", vitestCfg(`exclude: [${VS}, ${VW}], env: { mode: process.env.MODE }`), "pass", OK, "none"],
  ["m17 jest pure data with an earlier const and a negative number", "jest", `const shared = ["/node_modules/"];\nmodule.exports = { testPathIgnorePatterns: [${JS}], bail: -1, extra: shared };`, "warn", MISS,
    { path: IGNORE, equals: [S, W] }],
  ["m18 vitest a nested coverage map holding an escaped key reads", "vitest", vitestCfg(String.raw`exclude: [${VS}, ${VW}], coverage: { "re\u0070orter": ["text"] }`), "pass", OK, "none"],
  // D-2102 add.37 follow-up: the one spread pure data admits — `...<configDefaults>.exclude` as an element of
  // test.exclude, from a configDefaults named-imported from "vitest/config" or "vitest" (renamed is fine).
  ["sp1 vitest a renamed configDefaults import spread beside both canonical excludes", "vitest", `import { configDefaults as defaults } from "vitest";\nexport default { test: { exclude: [...defaults.exclude, ${VS}, ${VW}] } };`, "pass", OK, "none"],
  ["sp2 vitest a spread of a local const", "vitest", `const mine = { exclude: [${VS}] };\nexport default { test: { exclude: [...mine.exclude, ${VS}, ${VW}] } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["sp3 vitest configDefaults imported from another module", "vitest", `import { configDefaults } from "./defaults";\nexport default { test: { exclude: [...configDefaults.exclude, ${VS}, ${VW}] } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["sp4 vitest the configDefaults spread outside test.exclude", "vitest", `import { configDefaults } from "vitest/config";\nexport default { test: { exclude: [${VS}, ${VW}], coverage: { exclude: [...configDefaults.exclude] } } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["sp5 vitest a spread of configDefaults.include into test.exclude", "vitest", `import { configDefaults } from "vitest/config";\nexport default { test: { exclude: [...configDefaults.include, ${VS}, ${VW}] } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["sp6 vitest configDefaults from vite (not Vitest's data)", "vitest", `import { configDefaults } from "vite";\nexport default { test: { exclude: [...configDefaults.exclude, ${VS}, ${VW}] } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  // TypeScript configs (D-2102 add.37 follow-up): read as written when this Node has stripTypeScriptTypes,
  // unverifiable when it does not — the table follows the running Node for every .ts row
  ["ts1 vitest a TypeScript config with a type-only import and a satisfies export", "vitest-ts", `import { defineConfig } from "vitest/config";\nimport type { UserConfig } from "vitest/config";\nexport default defineConfig({ test: { exclude: [${VS}, ${VW}] } }) satisfies UserConfig;`, "pass", OK, "none"],
  ["ts2 vitest a TypeScript config, state exclude only, repaired", "vitest-ts", vitestCfg(`exclude: [${VS}]`), "warn", MISS, { path: EXCLUDE, equals: [vS, vW] }],
  // D-2102 add.39: a TypeScript config is scanned only on its type-erased text, so a type declaration can no longer
  // hide the code after it; the r14 review's nine interface shapes first, then a type alias, an enum, and the
  // genuine jest.config.ts form still reading
  ["i1 vitest an interface hiding a pop of the exclude", "vitest-ts", `const config = { test: { exclude: [${VS}, ${VW}] } };\ninterface Note {} config.test.exclude.pop()\nexport default config;`, "warn", UNV, "manual"],
  ["i2 vitest an exported interface hiding a reassigned exclude", "vitest-ts", `const config = { test: { exclude: [${VS}, ${VW}] } };\nexport interface Note {} config.test.exclude = [${VS}]\nexport default config;`, "warn", UNV, "manual"],
  ["i3 vitest a declared interface hiding a pop of the exclude", "vitest-ts", `const config = { test: { exclude: [${VS}, ${VW}] } };\ndeclare interface Note {} config.test.exclude.pop()\nexport default config;`, "warn", UNV, "manual"],
  ["i4 jest an interface hiding a reassigned ignore list", "jest-ts", `const config = { testPathIgnorePatterns: [${JS}, ${JW}] };\ninterface Note {} config.testPathIgnorePatterns = [${JS}]\nexport default config;`, "warn", UNV, "manual"],
  ["i5 jest an exported interface hiding a pop of the ignore list", "jest-ts", `const config = { testPathIgnorePatterns: [${JS}, ${JW}] };\nexport interface Note {} config.testPathIgnorePatterns.pop()\nexport default config;`, "warn", UNV, "manual"],
  ["i6 jest a declared interface hiding a reassigned ignore list", "jest-ts", `const config = { testPathIgnorePatterns: [${JS}, ${JW}] };\ndeclare interface Note {} config.testPathIgnorePatterns = [${JS}]\nexport default config;`, "warn", UNV, "manual"],
  ["i7 vitest the state-only twin of an interface hiding a pop: fix-only stays manual", "vitest-ts", `const config = { test: { exclude: [${VS}] } };\ninterface Note {} config.test.exclude.pop()\nexport default config;`, "warn", UNV, "manual"],
  ["i8 jest the state-only twin of an exported interface hiding a reassignment: fix-only stays manual", "jest-ts", `const config = { testPathIgnorePatterns: [${JS}] };\nexport interface Note {} config.testPathIgnorePatterns = [${JS}]\nexport default config;`, "warn", UNV, "manual"],
  ["i9 vitest the state-only twin of a declared interface hiding a reassignment: fix-only stays manual", "vitest-ts", `const config = { test: { exclude: [${VS}] } };\ndeclare interface Note {} config.test.exclude = [${VS}]\nexport default config;`, "warn", UNV, "manual"],
  ["i10 vitest a type alias followed by code", "vitest-ts", `const config = { test: { exclude: [${VS}, ${VW}] } };\ntype T = {}\nconfig.test.exclude.pop();\nexport default config;`, "warn", UNV, "manual"],
  ["i11 vitest an enum (no plain type erasure)", "vitest-ts", `enum Mode { A }\nexport default { test: { exclude: [${VS}, ${VW}] } };`, "warn", "(invalid syntax); add", "manual"],
  ["i12 jest the genuine jest.config.ts: import type, a typed const and satisfies", "jest-ts", `import type { Config } from "jest";\nconst config: Config = { testPathIgnorePatterns: [${JS}, ${JW}] } satisfies Config;\nexport default config;`, "pass", OK, "none"],
  // a line comment ends at every line terminator (D-2102 add.31): the r8 review's CR, U+2028 and U+2029 shapes
  // show a second, replacing export, which leaves the config unreadable
  ...([["CR", "\r"], ["U+2028", "\u2028"], ["U+2029", "\u2029"]] as const).map(([name, end]): Row => [`l ${name} ends a line comment before a replacing export`, "jest",
    `module.exports = { testPathIgnorePatterns: [${JS}, ${JW}] }; // replaced below${end}module.exports = { testPathIgnorePatterns: [${JS}] };`, "warn",
    "(the config exports more than once); add", "manual"]),
  // (c′) the keys of nested value maps are data, never read: these pass
  ["p25 jest transform and moduleNameMapper regex keys beside both canonical ignores", "jest",
    jestCfg(String.raw`transform: { "^.+\\.tsx?$": "ts-jest" }, moduleNameMapper: { "^@/(.*)$": "<rootDir>/src/$1", "\\.(css|less)$": "identity-obj-proxy" }, testPathIgnorePatterns: [${JS}, ${JW}]`), "pass", OK, "none"],
  ["p26 jest JSON transform regex key beside both canonical ignores", "jest-json", String.raw`{"transform": {"^.+\\.[jt]sx?$": "babel-jest"}, "testPathIgnorePatterns": [${JS}, ${JW}]}`, "pass", OK, "none"],
  ["n2 vitest a key repeated in a nested coverage object (each key once at every level)", "vitest", vitestCfg(String.raw`include: ["tests/**/*.test.ts"], exclude: [${VS}, ${VW}], coverage: { "re\u0070orter": ["text"], reporter: ["html"] }`), "warn", "(it runs code doctor does not read); add", "manual"],
  ["n3 vitest a spread and a shorthand in a nested coverage object", "vitest", `import { base, reporter } from "./coverage";\nexport default { test: { include: ["tests/**/*.test.ts"], exclude: [${VS}, ${VW}], coverage: { ...base, reporter } } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["n4 vitest an import from a module other than the runner's", "vitest", `import { browser } from "./tools";\nexport default { test: { exclude: [${VS}, ${VW}] } };`, "warn", "(it runs code doctor does not read); add", "manual"],
  ["p24 vitest rooted include under plain quoted keys", "vitest", `export default { "test": { "exclude": [${VS}, ${VW}] } };`, "pass", OK, "none"],
  // canonical pass cases
  ["p1 jest literal ignores blind to both directories beside both anchored ones", "jest",
    jestCfg(String.raw`testPathIgnorePatterns: ["/node_modules/", "/fixtures/", "/__mocks__/", "\\.stories\\.tsx", ${JS}, ${JW}]`), "pass", OK, "none"],
  ["p2 jest classic testRegex beside both anchored ignores", "jest", jestCfg(String.raw`testRegex: "(/__tests__/.*|(\\.|/)(test|spec))\\.[jt]sx?$", testPathIgnorePatterns: [${JS}, ${JW}]`), "pass", OK, "none"],
  ["p3 jest negated fixtures testMatch beside both anchored ignores", "jest", jestCfg(`testMatch: ["**/*.test.ts", "!**/fixtures/**"], testPathIgnorePatterns: [${JS}, ${JW}]`), "pass", OK, "none"],
  ["p8 vitest configDefaults.exclude spread beside both canonical excludes", "vitest", `import { configDefaults } from "vitest/config";\nexport default { test: { exclude: [...configDefaults.exclude, ${VS}, ${VW}] } };`,
    "pass", OK, "none"],
  ["p9 jest JSON config with both anchored ignores", "jest-json", `{"testPathIgnorePatterns": ["/node_modules/", ${JS}, ${JW}]}`, "pass", OK, "none"],
  ["p13 vitest defineConfig with a trailing comment", "vitest",
    `import { defineConfig } from "vitest/config";\nexport default defineConfig({\n  test: {\n    exclude: [${VS}, ${VW}], // run and session worktrees\n  },\n});`, "pass", OK, "none"],
  ["p14 jest exported binding with comment lines", "jest",
    `/** @type {import('jest').Config} */\nconst config = {\n  // keep run and session worktrees out of the suite\n  testPathIgnorePatterns: [${JS}, ${JW}],\n};\nmodule.exports = config;`, "pass", OK, "none"],
  ["p15 jest an extra anchored ignore beside both canonical ones", "jest", jestCfg(String.raw`testMatch: ["**/*.test.ts"], testPathIgnorePatterns: [${JS}, ${JW}, "<rootDir>/\\.claude/worktrees/keep/"]`), "pass", OK, "none"],
  ["p17 vitest root at the checkout itself", "vitest", `export default { root: ".", test: { dir: "./", exclude: [${VS}, ${VW}] } };`, "pass", OK, "none"],
  ["p18 jest rootDir at the checkout itself", "jest", jestCfg(`rootDir: "<rootDir>", testPathIgnorePatterns: [${JS}, ${JW}]`), "pass", OK, "none"],
  ["p20 vitest export typed as const", "vitest-ts", `export default { test: { exclude: [${VS}, ${VW}] } } as const;`, "pass", OK, "none"],
  ["p22 jest typed binding beside type-only imports and declarations", "jest-ts",
    `import type { Config } from "jest";\ntype Extra = { note: string };\ninterface Unused { a: Extra }\nconst config: Config = {\n  testPathIgnorePatterns: [${JS}, ${JW}],\n};\nexport default config;`, "pass", OK, "none"],
  ["p16 vitest canonical excludes with trailing element comments", "vitest", vitestCfg(`exclude: [\n    ${VS}, // run worktrees\n    ${VW} // session worktrees\n  ]`), "pass", OK, "none"],
];
const RUNNER_FILES: Record<RunnerKind, { scripts: Record<string, string>; file: string }> = {
  jest: { scripts: { test: "jest" }, file: "jest.config.js" },
  "jest-json": { scripts: { test: "jest" }, file: "jest.config.json" },
  "jest-ts": { scripts: { test: "jest" }, file: "jest.config.ts" },
  vitest: { scripts: { test: "vitest run" }, file: "vitest.config.mjs" },
  "vitest-ts": { scripts: { test: "vitest run" }, file: "vitest.config.ts" },
};
/** A table config's value: JSON parsed, or the module evaluated with its imports stubbed. */
const evaluate = (text: string, json: boolean): Record<string, unknown> => (json ? JSON.parse(text) : new Function("module", "require", "defineConfig", "defineProject", "configDefaults",
  `${text.replace(/^(?:import .*|const \{ defineConfig \} = require\(.*)$/gm, "").replace("export default", "module.exports =")}\nreturn module.exports;`)({ exports: {} }, () => ({}), (c: unknown) => c, (c: unknown) => c, { exclude: ["**/node_modules/**"] }));
/** The value with the array at a dotted path replaced. */
const replaced = (value: Record<string, unknown>, path: string, equals: unknown): Record<string, unknown> => {
  const copy = structuredClone(value);
  const keys = path.split(".");
  const parent = keys.slice(0, -1).reduce<Record<string, unknown>>((o, k) => o[k] as Record<string, unknown>, copy);
  parent[keys[keys.length - 1]] = equals;
  return copy;
};
// case-table:end
// Whether this Node strips TypeScript types (22.13 and later); the .ts rows follow it.
const STRIPS = typeof (nodeModule as { stripTypeScriptTypes?: unknown }).stripTypeScriptTypes === "function";

// Titling law: oracle-named test stays TOP-LEVEL (anchored -t equality on the full name).
test("the runner-ignore row passes naming the file only when a repository-wide Jest or Vitest config's own ignore list literally carries the canonical session-worktree entry, warns naming that entry and the file for a state-only ignore, a rooted Vitest include, an unanchored session entry and a config doctor cannot read, and doctor fix-only writes the entry, or the whole ignore property where none exists, so the row then passes, so a row that passes without the literal entry or a repair that refuses a config with no ignore property fails", async () => {
  expect(new Set(RUNNER_TABLE.map(([id]) => id)).size).toBe(RUNNER_TABLE.length);
  for (const [id, kind, config, verdict, says, fix, beside] of RUNNER_TABLE) {
    const { scripts, file } = RUNNER_FILES[kind];
    const dir = repo({ "package.json": JSON.stringify({ scripts }), [file]: config, ...beside });
    if (!STRIPS && file.endsWith(".ts")) {
      // Below Node 22.13 a TypeScript config reads unverifiable: a warn, and fix-only leaves it byte-identical.
      expect(runnerIgnoreFinding(dir)?.verdict, id).toBe("warn");
      expect(await doctor(["--fix-only"], dir), id).toContain("repair result: manual");
      expect(readFileSync(join(dir, file), "utf8"), id).toBe(config);
      continue;
    }
    const before = runnerIgnoreFinding(dir);
    expect(before?.verdict, id).toBe(verdict);
    expect(before?.detail, id).toContain(says);
    const out = await doctor(["--fix-only"], dir);
    const written = readFileSync(join(dir, file), "utf8");
    if (typeof fix === "string") {
      expect(out, id).toContain(`repair result: ${fix} — `);
      expect(written, id).toBe(config);
      expect(runnerIgnoreFinding(dir)?.verdict, id).toBe(verdict);
    } else {
      expect(out, id).toContain("repair result: wrote");
      expect(out, id).toContain("repair verification: pass");
      expect(runnerIgnoreFinding(dir)?.verdict, id).toBe("pass");
      const writes = Array.isArray(fix) ? fix : [fix];
      expect(evaluate(written, kind === "jest-json"), id).toEqual(writes.reduce((value, w) => replaced(value, w.path, w.equals), evaluate(config, kind === "jest-json")));
    }
  }
  // A config the file system will not let doctor read (D-2102 add.31) is a warn naming the file and the entry,
  // never a throw, and fix-only leaves it alone: a mode-000 file and a directory named like the config.
  const locked = repo({ "package.json": JSON.stringify({ scripts: { test: "jest" } }), "jest.config.js": jestCfg(`testPathIgnorePatterns: [${JS}]`) });
  chmodSync(join(locked, "jest.config.js"), 0o000);
  try {
    const f = runnerIgnoreFinding(locked);
    expect(f?.verdict).toBe("warn");
    expect(f?.detail).toContain(String.raw`doctor could not read jest.config.js (EACCES); add "<rootDir>/\\.claude/worktrees/" to testPathIgnorePatterns`);
    const out = await doctor(["--fix-only"], locked);
    expect(out).toContain("repair result: manual — doctor could not read jest.config.js (EACCES)");
  } finally {
    chmodSync(join(locked, "jest.config.js"), 0o644);
  }
  const folder = repo({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
  mkdirSync(join(folder, "vitest.config.ts"));
  const f = runnerIgnoreFinding(folder);
  expect(f?.verdict).toBe("warn");
  expect(f?.detail).toContain('doctor could not read vitest.config.ts (EISDIR); add ".claude/worktrees/**" to test.exclude');
  expect(await doctor(["--fix-only"], folder)).toContain("repair result: manual — doctor could not read vitest.config.ts (EISDIR)");
  // D-2102 add.33: a literal straddling the checkout's own directory name into .claude self-matches, judged by
  // executing it against the real (realpath) root the temp checkout sits in.
  const straddle = repo({ "package.json": JSON.stringify({ scripts: { test: "jest" } }) });
  writeFileSync(join(straddle, "jest.config.js"), jestCfg(String.raw`testPathIgnorePatterns: [${JS}, ${JW}, "${basename(realpathSync(straddle))}/\\.claude"]`));
  const sf = runnerIgnoreFinding(straddle);
  expect(sf?.verdict).toBe("warn");
  expect(sf?.detail).toContain("jest ignore for .claude/worktrees/ is not <rootDir>-anchored");
  expect(await doctor(["--fix-only"], straddle)).toContain("repair result: manual");
  // D-2102 add.37: on a Node without stripTypeScriptTypes (below 22.13) a TypeScript config reads unverifiable and
  // never throws; the seam stands in for that Node, while a JavaScript config parses the same either way.
  const noStrip = { why: "this Node has no stripTypeScriptTypes to read a TypeScript config" };
  const vitestSource = vitestCfg(`exclude: [${VS}, ${VW}]`);
  expect(realParse(vitestSource, "vitest.config.ts", { strip: "absent" })).toEqual(noStrip);
  expect(realParse(jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}]`), "jest.config.js", { strip: "absent" })).toHaveProperty("text");
  expect(realParse(vitestSource, "vitest.config.ts")).toEqual(STRIPS ? { text: vitestSource } : noStrip);
  // D-2102 add.39: the parse child takes the source on stdin and writes no file, so a missing, file-shaped or
  // unwritable TMPDIR changes nothing; a child that does not answer in time reads unverifiable, never a throw.
  expect(realParse(jestCfg(`testPathIgnorePatterns: [${JS}, ${JW}]`), "jest.config.js", { timeoutMs: 1 })).toEqual({ why: "doctor could not check jest.config.js's syntax" });
  const scratchTmp = repo({ "a-file": "x" });
  const lockedTmp = join(scratchTmp, "locked");
  mkdirSync(lockedTmp);
  chmodSync(lockedTmp, 0o500);
  const previous = process.env.TMPDIR;
  try {
    for (const [name, tmp] of [["missing", join(scratchTmp, "missing")], ["a file", join(scratchTmp, "a-file")], ["unwritable", lockedTmp]] as const) {
      process.env.TMPDIR = tmp;
      const pass = repo({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "vitest.config.mjs": vitestCfg(`exclude: [${VS}, ${VW}], env: { tmpdir: ${JSON.stringify(name)} }`) });
      expect(runnerIgnoreFinding(pass)?.verdict, name).toBe("pass");
      const fix = repo({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "vitest.config.mjs": vitestCfg(`exclude: [${VS}], env: { tmpdir: ${JSON.stringify(name)} }`) });
      expect(await doctor(["--fix-only"], fix), name).toContain("repair verification: pass");
    }
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    chmodSync(lockedTmp, 0o700);
  }
}, 36_000); // the table runs in about 12 s (each readable config parsed once in a child process); about 3x that

describe("doctor test-runner ignore check (Q122s + Q130s anchor probe)", () => {

  test("jest with the <rootDir>-anchored ignore (escaped dot) → pass", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": `module.exports = { testPathIgnorePatterns: ["/node_modules/", "<rootDir>/\\\\.tickmarkr/", "<rootDir>/\\\\.claude/worktrees/"] };`,
    });
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("jest unanchored worktrees.noindex ignore → warn, same self-match class", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": `module.exports = { testPathIgnorePatterns: ["/worktrees.noindex/"] };`,
    });
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("warn");
  });

  test("vitest exclude mentioning .tickmarkr → pass (root-relative globs cannot self-match)", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "vitest.config.mjs": `export default { test: { include: ["**/*.test.ts"], exclude: [".tickmarkr/**", ".claude/worktrees/**"] } };`,
    });
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("vitest whose glob strings form /* and */ pairs (the Intl-Dossier shape) still warns — comment stripping must not eat globs", () => {
    // Regression: 1.90.1's in-line comment-strip regex matched `/*` inside '**/*.d.ts'
    // and deleted through the next `*/`, erasing the repo-wide include evidence and
    // FALSE-PASSING the config as "rooted".
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "turbo run test" } }),
      "vitest.config.mjs": [
        `export default {`,
        `  test: {`,
        `    coverage: { exclude: ['node_modules/', '**/*.d.ts', '**/*.spec.ts', '**/tests/**'] },`,
        `    include: ['**/*.{test,spec}.{js,ts,tsx}'],`,
        `    exclude: ['node_modules', 'dist', '.turbo'],`,
        `  },`,
        `};`,
      ].join("\n"),
    });
    const f = runnerIgnoreFinding(dir);
    expect(f?.verdict).toBe("warn");
    expect(f?.detail).toContain('add ".tickmarkr/**" to test.exclude');
  });

  test("jest anchored ignore with prose comments mentioning .tickmarkr → pass, comments stripped", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": [
        `// /.tickmarkr/ — tickmarkr provisions run worktrees INSIDE the repo`,
        `// (.tickmarkr/worktrees.noindex/): keep them out of the suite`,
        `module.exports = { testPathIgnorePatterns: ["<rootDir>/\\\\.tickmarkr/", "<rootDir>/\\\\.claude/worktrees/"] };`,
      ].join("\n"),
    });
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("jest ignore that is commented OUT → warn, not a false pass", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": [
        `module.exports = { testMatch: ["**/__tests__/**/*.test.ts"] };`,
        `// testPathIgnorePatterns: ["<rootDir>/\\\\.tickmarkr/"]`,
      ].join("\n"),
    });
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("warn");
  });

  // D-2102 add.30: a rooted include is not the literal entry, so it warns like any other missing entry.
  test("vitest with rooted includes (this repo's own shape) → warn naming the canonical exclude", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "vitest.config.mjs": `export default { test: { include: ["tests/**/*.test.ts"] } };`,
    });
    const f = runnerIgnoreFinding(dir);
    expect(f?.verdict).toBe("warn");
    expect(f?.detail).toContain('add ".tickmarkr/**" to test.exclude in vitest.config.mjs');
  });

  test("vitest with NO config file → defaults are repo-wide → warn with root-anchored remedy", () => {
    const dir = repo({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
    const f = runnerIgnoreFinding(dir);
    expect(f?.verdict).toBe("warn");
    expect(f?.detail).toContain('add ".tickmarkr/**" to test.exclude');
  });

  test("no recognized runner → no row", () => {
    const dir = repo({ "package.json": JSON.stringify({ scripts: { test: "sh check.sh" } }) });
    expect(runnerIgnoreFinding(dir)).toBeUndefined();
  });
});

// Q134s: doctor --fix — the WRITE half. Every write is verified by re-running the
// finding; a write that does not turn the row green is reverted (never a half-fix).
describe("doctor --fix runner-ignore writer (Q134s)", () => {

  test("vitest, the Intl-Dossier shape: two exclude arrays (coverage + test) → wrote into test.exclude only, finding passes", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "turbo run test" } }),
      "vitest.config.mjs": [
        `import { defineConfig } from 'vitest/config';`,
        `export default defineConfig({`,
        `  test: {`,
        `    coverage: { exclude: ['node_modules/', 'dist/'] },`,
        `    include: ['**/*.{test,spec}.ts'],`,
        `    exclude: ['node_modules', 'dist', '.turbo'],`,
        `  },`,
        `});`,
      ].join("\n"),
    });
    const r = applyRunnerIgnore(dir);
    expect(r.action).toBe("wrote");
    const text = readFileSync(join(dir, "vitest.config.mjs"), "utf8");
    expect(text).toContain(`    coverage: { exclude: ['node_modules/', 'dist/'] },`);
    expect(text).toContain(`    exclude: [".tickmarkr/**", ".claude/worktrees/**", 'node_modules', 'dist', '.turbo'],`);
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("jest, the SentioQ run-2 poison shape: unanchored entry → wrote, anchored in place", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": `module.exports = { testPathIgnorePatterns: ["/node_modules/", "/.tickmarkr/"] };`,
    });
    const r = applyRunnerIgnore(dir);
    expect(r.action).toBe("wrote");
    const text = readFileSync(join(dir, "jest.config.js"), "utf8");
    expect(text).toContain('"<rootDir>/\\\\.tickmarkr/"');
    expect(text).not.toContain('"/.tickmarkr/"');
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("jest with an ignore array lacking tickmarkr → anchored entry prepended", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": `module.exports = { testMatch: ["**/__tests__/**/*.test.ts"], testPathIgnorePatterns: ["/node_modules/"] };`,
    });
    expect(applyRunnerIgnore(dir).action).toBe("wrote");
    expect(readFileSync(join(dir, "jest.config.js"), "utf8")).toContain(`testPathIgnorePatterns: ["<rootDir>/\\\\.tickmarkr/", "<rootDir>/\\\\.claude/worktrees/", "/node_modules/"]`);
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("jest testMatch-only config (no ignore array) → property added preserving /node_modules/", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": `module.exports = { testMatch: ["**/__tests__/**/*.test.ts"] };`,
    });
    expect(applyRunnerIgnore(dir).action).toBe("wrote");
    const text = readFileSync(join(dir, "jest.config.js"), "utf8");
    expect(text).toContain('"/node_modules/"');
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });

  test("jest config only in the package.json block → manual, package.json untouched", () => {
    const pkg = JSON.stringify({ scripts: { test: "jest" }, jest: { testMatch: ["**/*.test.ts"] } });
    const dir = repo({ "package.json": pkg });
    const r = applyRunnerIgnore(dir);
    expect(r.action).toBe("manual");
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(pkg);
  });

  test("already green → none, file untouched (idempotent)", () => {
    const cfg = `module.exports = { testPathIgnorePatterns: ["<rootDir>/\\\\.tickmarkr/", "<rootDir>/\\\\.claude/worktrees/"] };`;
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "jest.config.js": cfg,
    });
    expect(applyRunnerIgnore(dir).action).toBe("none");
    expect(readFileSync(join(dir, "jest.config.js"), "utf8")).toBe(cfg);
  });

  // D-2102 add.31: a vitest config with no exclude array gets one that keeps Vitest's own defaults.
  test("vitest config with no exclude array → test.exclude added keeping Vitest's defaults, finding passes", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "vitest.config.mjs": `export default { test: { include: ["**/*.test.ts"] } };`,
    });
    expect(applyRunnerIgnore(dir).action).toBe("wrote");
    expect(readFileSync(join(dir, "vitest.config.mjs"), "utf8")).toContain(`exclude: ["**/node_modules/**", "**/dist/**", "**/cypress/**"`);
    expect(runnerIgnoreFinding(dir)?.verdict).toBe("pass");
  });
});

// Q140s(b) / D-OBS-10: the repo's package manager must resolve where gates spawn.
describe("doctor package-manager preflight", () => {
  test("detected pnpm missing from the environment → FAIL naming the fix", () => {
    const dir = repo({ "package.json": JSON.stringify({ packageManager: "pnpm@10.0.0" }), "pnpm-lock.yaml": "" });
    const f = packageManagerFinding(dir, () => false);
    expect(f?.verdict).toBe("fail");
    expect(f?.detail).toContain("pnpm");
    expect(f?.detail).toContain("corepack enable");
  });

  test("resolvable manager → pass naming it", () => {
    const dir = repo({ "package.json": JSON.stringify({ scripts: { test: "jest" } }) });
    const f = packageManagerFinding(dir, () => true);
    expect(f?.verdict).toBe("pass");
    expect(f?.detail).toContain("npm");
  });

  test("no package.json → no row", () => {
    const dir = repo({ "readme.md": "x" });
    expect(packageManagerFinding(dir, () => true)).toBeUndefined();
  });
});

// Q142s: tickmarkr guarded every binary except its own. The check covers BOTH
// declared bin names — the first sweep of the exhibit machine missed `tkr`.
describe("doctor self-shadow check (Q142s)", () => {
  const resolver = (hits: Record<string, string[]>) => (bin: string) => ({ resolved: hits[bin]?.[0], all: hits[bin] ?? [] });

  test("stale second root → FAIL naming path and version, running version stated", () => {
    const f = selfShadowFinding(
      "1.90.3", "/tmp",
      resolver({ tickmarkr: ["/opt/homebrew/bin/tickmarkr", "/Users/x/.local/bin/tickmarkr"] }),
      (p) => p.includes(".local") ? "1.85.0" : "1.90.3",
    );
    expect(f?.verdict).toBe("fail");
    expect(f?.detail).toContain("/Users/x/.local/bin/tickmarkr → 1.85.0");
    expect(f?.detail).toContain("running 1.90.3");
  });

  test("stale tkr alias alone is enough to FAIL — both bin names are swept", () => {
    const f = selfShadowFinding(
      "1.90.3", "/tmp",
      resolver({ tickmarkr: ["/opt/homebrew/bin/tickmarkr"], tkr: ["/Users/x/.local/bin/tkr"] }),
      (p) => p.endsWith("/tkr") ? "1.85.0" : "1.90.3",
    );
    expect(f?.verdict).toBe("fail");
    expect(f?.detail).toContain("/Users/x/.local/bin/tkr → 1.85.0");
  });

  test("single root, both names current → pass", () => {
    const f = selfShadowFinding(
      "1.90.3", "/tmp",
      resolver({ tickmarkr: ["/opt/homebrew/bin/tickmarkr"], tkr: ["/opt/homebrew/bin/tkr"] }),
      () => "1.90.3",
    );
    expect(f?.verdict).toBe("pass");
  });

  test("no install on PATH (repo checkout) → no row", () => {
    expect(selfShadowFinding("1.90.3", "/tmp", resolver({}), () => undefined)).toBeUndefined();
  });

  test("unversionable binary reads as stale (?), never as silently current", () => {
    const f = selfShadowFinding(
      "1.90.3", "/tmp",
      resolver({ tickmarkr: ["/opt/homebrew/bin/tickmarkr", "/broken/tickmarkr"] }),
      (p) => p.startsWith("/broken") ? undefined : "1.90.3",
    );
    expect(f?.verdict).toBe("fail");
    expect(f?.detail).toContain("/broken/tickmarkr → ?");
  });
});
