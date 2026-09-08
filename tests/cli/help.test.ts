import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";
import { expect, test, vi } from "vitest";
import { COMMANDS, dispatch, USAGE } from "../../src/cli/index.js";
import { COMMAND_HELP, PROFILE_HELP, commandHelp } from "../../src/cli/help.js";
import { evalCommand } from "../../src/cli/commands/eval.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import * as registry from "../../src/adapters/registry.js";
import * as fixtures from "../../src/eval/fixtures.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const put = (root: string, path: string, bytes: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
};
const snapshot = (root: string): Record<string, Buffer> => Object.fromEntries(
  readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [path.slice(root.length + 1), readFileSync(path)];
    }),
);

const DRAFT = `<!-- tickmarkr:spec -->
# Export reports

## Requirements
- REQ-01: Export reports as JSON

## Assumptions
- Existing authorization rules apply

## Traceability
| Requirement | Tasks |
| --- | --- |
| REQ-01 | T1 |

## T1: Export reports [REQ-01]
- goal: Export reports as JSON
- shape: implement
- files: src/reports.ts
- acceptance:
  - command: npm test
`;

// Capture options from the actual registered modules, including hand-parsed comparisons/calls.
// No copied command/flag allowlist: new registration, parser option or profile branch participates.
function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}
const source = (path: string) => ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
const nameOf = (name: ts.PropertyName) => ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText();
function registeredSources(): Map<string, ts.SourceFile> {
  const index = source(join(ROOT, "src/cli/index.ts"));
  const imports = new Map<string, string>();
  const result = new Map<string, ts.SourceFile>();
  walk(index, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) imports.set(binding.name.text, node.moduleSpecifier.text);
      }
    }
    if (ts.isVariableDeclaration(node) && node.name.getText() === "COMMANDS" && node.initializer) {
      const object = ts.isSatisfiesExpression(node.initializer) ? node.initializer.expression : node.initializer;
      expect(ts.isObjectLiteralExpression(object)).toBe(true);
      if (!ts.isObjectLiteralExpression(object)) throw new Error("unrecognized command registry");
      for (const property of object.properties) {
        if (!ts.isShorthandPropertyAssignment(property) && !ts.isPropertyAssignment(property)) throw new Error("unrecognized command registration");
        const binding = ts.isShorthandPropertyAssignment(property) ? property.name.text : property.initializer.getText();
        const path = imports.get(binding);
        expect(path, binding).toBeDefined();
        result.set(nameOf(property.name), source(resolve(ROOT, "src/cli", path!.replace(/\.js$/, ".ts"))));
      }
    }
  });
  expect([...result.keys()].sort()).toEqual(Object.keys(COMMANDS).sort());
  return result;
}
function parserOf(file: ts.Node) {
  const flags = new Set<string>();
  const options: Record<string, { type: "string" | "boolean"; multiple?: boolean; short?: string }> = {};
  let nodeParser = false;
  walk(file, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === "parseArgs" && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
      nodeParser = true;
      const optionNode = node.arguments[0].properties.find((p) => ts.isPropertyAssignment(p) && nameOf(p.name) === "options");
      if (optionNode && ts.isPropertyAssignment(optionNode) && ts.isObjectLiteralExpression(optionNode.initializer)) {
        for (const p of optionNode.initializer.properties) {
          if (!ts.isPropertyAssignment(p) || !ts.isObjectLiteralExpression(p.initializer)) throw new Error("unrecognized parser option");
          const values = Object.fromEntries(p.initializer.properties.map((value) => {
            if (!ts.isPropertyAssignment(value)) throw new Error("unrecognized parser option value");
            return [nameOf(value.name), ts.isStringLiteral(value.initializer) ? value.initializer.text : value.initializer.getText()];
          }));
          const key = nameOf(p.name);
          flags.add(`--${key}`);
          if (values.short) flags.add(`-${values.short}`);
          options[key] = { type: values.type as "string" | "boolean", ...(values.multiple === "true" ? { multiple: true } : {}), ...(values.short ? { short: values.short } : {}) };
        }
      }
    }
  });
  if (!nodeParser) walk(file, (node) => {
    if (!ts.isStringLiteral(node) || !/^--[a-z][a-z-]*$/.test(node.text)) return;
    const parent = node.parent;
    if (ts.isBinaryExpression(parent) || (ts.isCallExpression(parent) && /(?:\.includes|optionValue|optionOf|percentageOf)$/.test(parent.expression.getText()))) flags.add(node.text);
  });
  flags.delete("--help");
  return { flags: [...flags].sort(), options, nodeParser };
}
const documentedFlags = (text: string) => [...new Set([...text.matchAll(/--[a-z][a-z-]*\b/g)].map((match) => match[0]))].sort();
const optionFlags = (help: { options: Record<string, string> }) => documentedFlags(Object.keys(help.options).join(" "));

// Leaf title is the complete acceptance criterion, verbatim.
test("The production dispatcher answers --help and -h for every registered command and nested profile operation before invoking its handler. Seeded config, lock, scope destination and eval fixture bytes and available fake-adapter call counters remain unchanged for help, while normal confirmed actions reach their handlers. Literal --help after -- is data, and eval’s prior strict unknown-option refusal becomes usable help without claiming historical seeding. A zero counter achieved by hiding CLIs or a help route that actuates unlock/profile reset fails.", async () => {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-help-"));
  const xdg = process.env.XDG_CONFIG_HOME;
  try {
    put(repo, ".tickmarkr/config.yaml", "routing:\n  map:\n    spec:\n      pin: { via: fake, model: fake-1 }\n");
    put(repo, ".tickmarkr/graph.lock", "seeded malformed lock\n");
    put(repo, ".tickmarkr/profile-since", "operator-cursor\n");
    put(repo, ".tickmarkr/profile-discounts", "");
    put(repo, "xdg/tickmarkr/config.yaml", "{}\n");
    put(repo, "feature.intent.md", "# Export reports\n\n## Blocking questions\n1. Which format?\n\n## Answers\n1. JSON\n");
    put(repo, "feature.spec.md", "operator-authored spec\n");
    put(repo, "--help/sample/start/README.md", "fixture start\n");
    put(repo, "--help/sample/solution/README.md", "fixture solution\n");
    put(repo, "fake.json", JSON.stringify({ tasks: {}, judge: { spec: DRAFT } }));
    const fake = new FakeAdapter(join(repo, "fake.json"));
    const probe = vi.spyOn(fake, "probe");
    const headless = vi.spyOn(fake, "headlessCommand");
    // Available, installed/authed adapter; the positive scope action below calls this same instance.
    vi.spyOn(registry, "allAdapters").mockReturnValue([fake]);
    registry.writeDoctor(repo, { fake: await fake.probe() });
    probe.mockClear();
    const seed = vi.spyOn(fixtures, "seedFixture");
    const handlers = Object.keys(COMMANDS).map((name) => vi.spyOn(COMMANDS, name as keyof typeof COMMANDS));
    // Resolve production handlers' default directory against this synthetic fixture only.
    vi.spyOn(process, "cwd").mockReturnValue(repo);
    process.env.XDG_CONFIG_HOME = join(repo, "xdg");
    const before = snapshot(repo);
    const operations = [...Object.keys(COMMANDS).map((name) => [name]), ...Object.keys(PROFILE_HELP).map((op) => ["profile", op])];
    for (const [command, ...args] of operations) {
      for (const flag of ["--help", "-h"]) {
        for (const argv of [[...args, flag], [flag, ...args], [...args, "--unknown-option", flag]]) {
          const result = await dispatch(command, argv);
          expect(result.code, `${command} ${argv.join(" ")}`).toBe(0);
          expect(result.out).toContain(`usage: tickmarkr ${command}${args.length ? ` ${args[0]}` : ""}`);
          expect(result.out).toContain("Options:");
        }
      }
    }
    for (const flag of ["--help", "-h"]) {
      for (const [command, args] of [
        ["unlock", ["--garbage", "--yes"]], ["unlock", ["run-example", "--yes"]],
        ["scope", ["feature.intent.md", "--yes", "--force"]], ["eval", ["./--help"]],
        ["profile", ["reset"]], ["profile", ["discount", "run-example", "--weight", "0", "--reason", "incident"]],
        ["doctor", ["--fix-only"]], ["ui", ["--setup", "run-example"]],
      ] as const) {
        expect((await dispatch(command, [...args, flag])).code).toBe(0);
      }
    }
    expect(snapshot(repo)).toEqual(before);
    handlers.forEach((handler) => expect(handler).not.toHaveBeenCalled());
    expect(probe).not.toHaveBeenCalled();
    expect(headless).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();

    // The old eval parser refused help BEFORE discovery/seeding; it did not seed historically.
    await expect(evalCommand(["--help"], repo)).rejects.toThrow(/Unknown option/);
    expect(seed).not.toHaveBeenCalled();
    const literal = await dispatch("eval", ["--", "--help"]);
    expect(literal.code).toBe(0);
    expect(literal.out).toContain("seeded sample");
    expect(seed).toHaveBeenCalledOnce();
    expect(snapshot(repo)).toEqual(before);
    expect((await dispatch("eval", ["--invented"])).code).toBe(1);

    const unlocked = await dispatch("unlock", ["--garbage", "--yes"]);
    expect(unlocked).toEqual({ out: "removed garbage lock (unparseable payload)", code: 0 });
    expect(existsSync(join(repo, ".tickmarkr/graph.lock"))).toBe(false);
    expect((await dispatch("profile", ["reset"])).out).toContain("profile reset");
    expect(readFileSync(join(repo, ".tickmarkr/profile-since"), "utf8")).toBe("\n");
    const scoped = await dispatch("scope", ["feature.intent.md", "--yes", "--force"]);
    expect(scoped.code, scoped.out).toBe(0);
    expect(scoped.out).toContain("1 LLM call");
    expect(probe).toHaveBeenCalledOnce();
    expect(headless).toHaveBeenCalledOnce();
    expect(headless.mock.calls[0]![1]).toBe("fake-1");
    expect(readFileSync(join(repo, "feature.spec.md"), "utf8")).toBe(DRAFT);
    expect(COMMANDS.unlock).toHaveBeenCalledOnce();
    expect(COMMANDS.profile).toHaveBeenCalledOnce();
    expect(COMMANDS.scope).toHaveBeenCalledOnce();
  } finally {
    vi.restoreAllMocks();
    if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = xdg;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Command help describes every flag accepted by each production parser and the delivered examples, with a drift test grounded in the registered command set. In particular verify files/author/baseline/record/no-review/no-acceptance, ui delivered views/setup, unlock garbage/yes, doctor fix-only, scope preview/yes and report --md stdout are actionable. A parser-supported flag omitted from its help, an invented option or an example launching deferred view 2, 3 or 6 fails.", async () => {
  const registered = registeredSources();
  expect(Object.keys(COMMAND_HELP).sort()).toEqual([...registered.keys()].sort());
  for (const [command, file] of registered) {
    const help = COMMAND_HELP[command as keyof typeof COMMAND_HELP];
    const parser = parserOf(file);
    expect(optionFlags(help), `${command} parser/help drift`).toEqual(parser.flags);
    const result = await dispatch(command, ["--help"]);
    expect(result).toEqual({ out: commandHelp(command), code: 0 });
    expect(USAGE).toMatch(new RegExp(`^  ${command}(?: |$)`, "m"));
    expect(result.out).toContain("--help, -h");
    for (const [flag, description] of Object.entries(help.options)) {
      expect(description.length).toBeGreaterThan(15);
      expect(result.out).toContain(`${flag}  ${description}`);
    }
    for (const example of help.examples) {
      expect(result.out).toContain(`tickmarkr ${example}`);
      const argv = [...example.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
      expect(argv.shift()).toBe(command);
      const redirect = argv.indexOf(">");
      if (redirect >= 0) argv.splice(redirect);
      const separator = argv.indexOf("--");
      const flags = documentedFlags((separator < 0 ? argv : argv.slice(0, separator)).join(" "));
      expect(flags.filter((flag) => !parser.flags.includes(flag)), example).toEqual([]);
      if (parser.nodeParser) expect(() => parseArgs({ args: argv, options: parser.options, allowPositionals: true })).not.toThrow();
      if (command === "ui") {
        const view = argv.indexOf("--view");
        if (view >= 0) expect(["home", "run", "evidence"]).toContain(argv[view + 1]);
        expect(example).not.toMatch(/--view (?:2|3|6|fleet|plan|health)\b/);
      }
    }
  }
  const profileOperations: string[] = [];
  walk(registered.get("profile")!, (node) => {
    if (ts.isBinaryExpression(node) && node.left.getText() === "argv[0]" && ts.isStringLiteral(node.right) && !node.right.text.startsWith("-")) profileOperations.push(node.right.text);
    if (ts.isFunctionDeclaration(node) && node.name?.text === "parseDiscountArgs") {
      expect(optionFlags(PROFILE_HELP.discount)).toEqual(parserOf(node).flags);
    }
  });
  expect(Object.keys(PROFILE_HELP).sort()).toEqual(profileOperations.sort());
  for (const operation of profileOperations) {
    const result = await dispatch("profile", [operation, "-h"]);
    expect(result.out).toContain(PROFILE_HELP[operation]!.description);
    expect(result.out).toContain(`usage: tickmarkr profile ${operation}`);
  }
  const verify = commandHelp("verify");
  expect(verify).toContain("repeat for multiple globs");
  expect(verify).toContain("baseline JSON");
  expect(verify).toContain("Append verification results");
  expect(verify).toContain("independent reviewer");
  expect(verify).toContain("deterministic gates remain mandatory");
  expect(commandHelp("ui")).toContain("1 Home, 4 Run, 5 Evidence");
  expect(commandHelp("ui")).toContain("ui --setup run-example");
  expect(commandHelp("doctor")).toContain("skip model probes and catalog refresh");
  expect(commandHelp("scope")).toContain("no probes, model calls or writes");
  expect(commandHelp("unlock")).toContain("all holder and race checks still apply");
  expect(commandHelp("report")).toContain("does not create a Markdown file");
  expect(commandHelp("report")).toContain("report run-example --md > feature.record.md");
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-help-report-"));
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(repo);
  try {
    put(repo, ".tickmarkr/config.yaml", "{}\n");
    put(repo, ".tickmarkr/runs/run-example/journal.jsonl", JSON.stringify({
      ts: "2026-09-05T00:00:00.000Z", event: "run-start", data: { baseRef: "main" },
    }) + "\n");
    const before = snapshot(repo);
    const markdown = await dispatch("report", ["run-example", "--md"]);
    expect(markdown.code, markdown.out).toBe(0);
    expect(markdown.out).toMatch(/^# tickmarkr engagement\n/);
    expect(markdown.out).toContain("**runId:** run-example");
    expect(snapshot(repo)).toEqual(before);
  } finally {
    cwd.mockRestore();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the end-of-options marker preserves data and legacy help scans cannot reinterpret it", async () => {
  const handler = vi.fn(async (argv: string[]) => JSON.stringify(argv));
  const argv = ["--", "--help", "-h"];
  expect(await dispatch("custom", argv, { custom: handler })).toEqual({ out: JSON.stringify(argv), code: 0 });
  expect(handler).toHaveBeenCalledWith(argv);
  for (const command of ["status", "verify"]) {
    for (const literal of ["--help", "-h"]) {
      const result = await dispatch(command, ["--", literal]);
      expect(result.code).toBe(1);
      expect(result.out).toContain(`literal argument "${literal}" after --`);
      expect(result.out).not.toContain("usage:");
    }
  }
  for (const alias of ["version", "--version", "-v"]) {
    expect(await dispatch(alias, ["--help"])).toEqual({ out: commandHelp("version"), code: 0 });
  }
  expect((await dispatch("toString", ["--help"])).code).toBe(1);
  expect((await dispatch("custom", ["--help"], { custom: handler })).out).toContain("usage: tickmarkr custom");
  expect(handler).toHaveBeenCalledOnce();
});
