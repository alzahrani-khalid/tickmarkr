import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isAsExpression,
  isBindingElement,
  isBlock,
  isCallExpression,
  isConstructorDeclaration,
  isElementAccessExpression,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportDeclaration,
  isMethodDeclaration,
  isNamedImports,
  isNamespaceImport,
  isNonNullExpression,
  isObjectBindingPattern,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isSetAccessorDeclaration,
  isStringLiteral,
  isTypeAssertionExpression,
  isVariableDeclaration,
  NodeFlags,
  ScriptKind,
  ScriptTarget,
  type BindingName,
  type Expression,
  type Node,
  type VariableDeclaration,
} from "typescript";
import { describe, expect, test } from "vitest";

// v1.86 T30: `const describe = d.skip` defeats every grep for skipped tests — one grep hit
// concealed 92 skipped assertions across tests/tui. This lint resolves disable aliases instead
// of grepping for `.skip(`. The grammar is closed and this comment is its exact statement:
//
//   roots      — named or renamed imports of `describe`/`suite` (suite level) and `test`/`it`
//                (test level) from "vitest", plus namespace imports (`import * as v`) projected
//                through those same names.
//   disabling   — the member is literally `skip` or `todo`; `describe.todo` produces the
//   members      identical whole-suite silence one token from `skip`, so both resolve.
//   chainables — suite modifiers `concurrent`/`sequential`/`only`/`shuffle` and test modifiers
//                `concurrent`/`sequential`/`only`/`fails` wrap their callable without enabling
//                or disabling it, so the disable stays STICKY wherever it sits in the chain:
//                `describe.concurrent.skip`, `describe.skip.concurrent` and
//                `describe.shuffle.todo` all resolve, direct or aliased. `each`/`for` resolve
//                through their own call — `describe.skip.each(cases)("name", fn)` is reported
//                at the suite call, and `const s = describe.skip; s.each(cases)(...)` with it.
//   aliases    — `let`/`var`/`const`, comma declarations, alias chains (fixed-point), object
//                destructuring (`const { skip: s } = describe`), TS assertion wrappers
//                (`as`/`satisfies`/non-null/parens) and static element access (`d["skip"]`)
//                all resolve, at either binding level.
//   scope      — bindings resolve LEXICALLY, never by name alone: the module, every function
//                and every block gets its own scope, a nested declaration or a parameter
//                shadows the outer binding (an unresolved shadow resolves to NOTHING, not to
//                the outer alias), and `var` hoists to its function scope.
//   deliberate — a direct `test.skip(...)` / `test.todo(...)` is named in place already and is
//   asymmetry    NOT a finding — and neither is a chain that still names the member at the
//                call site (`test.concurrent.skip(...)`, `test.skip.each(cases)(...)`); a
//                direct `describe.skip` / `describe.todo` IS one, because a silenced suite is
//                invisible where it stands. `skipIf` carries its condition in the call and is
//                out of scope.
//
// What stays open is enumerated member by member in the last test of this file — conditional
// expressions, function-call wrappers, object-parked aliases, reassignments, computed keys and
// array destructuring — never summarised as "dynamic aliases". The chainable-modifier category
// is CLOSED (see chainables above), so it is proven in the chain test, not listed as residual.

const repoRoot = join(import.meta.dirname, "..", "..");

type Level = "describe" | "test";

type Finding = {
  file: string;
  line: number; // 1-based line of the disabled declaration
  level: Level; // the binding level the disable acts at
  alias: string; // the name used at the call site
  via: string; // the alias chain that turned that name into a skip/todo
};

type Binding =
  | { level: Level; skipped: boolean; callable: "collector" | "parameterizer"; via: string }
  | { namespace: true; via: string };

const DISABLING_MEMBERS = new Set(["skip", "todo"]);
// vitest's chainable modifiers (@vitest/runner createChainable([...])) — they wrap the
// callable without enabling or disabling it, so they project through unchanged.
const SUITE_CHAINABLE_MEMBERS = new Set(["concurrent", "sequential", "only", "shuffle"]);
const TEST_CHAINABLE_MEMBERS = new Set(["concurrent", "sequential", "only", "fails"]);
// `each`/`for` are chainables whose result is only callable after their OWN call:
// `describe.skip.each(cases)("name", fn)`. The member projects through like any chainable,
// and the call of that member returns the same binding (resolve's call branch).
const EACH_MEMBERS = new Set(["each", "for"]);

/**
 * One lexical scope of the file under lint. A name present with an `undefined` binding is
 * DECLARED here but not resolved to a vitest root (a parameter, or an alias whose initializer
 * does not resolve) — it still shadows every outer binding of the same name.
 */
type Scope = {
  kind: "source" | "function" | "block";
  parent: Scope | undefined;
  bindings: Map<string, Binding | undefined>;
  declarations: VariableDeclaration[];
};

const isFunctionLikeNode = (node: Node): boolean =>
  isFunctionDeclaration(node)
  || isFunctionExpression(node)
  || isArrowFunction(node)
  || isMethodDeclaration(node)
  || isConstructorDeclaration(node)
  || isGetAccessorDeclaration(node)
  || isSetAccessorDeclaration(node);

/** Every name a binding pattern introduces (identifier, object and array patterns, recursively). */
function patternNames(name: BindingName): string[] {
  if (isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    // array-pattern elisions (`const [, x] = ...`) are OmittedExpressions and bind nothing
    isBindingElement(element) ? patternNames(element.name) : [],
  );
}

/** Root names at each binding level: describe and suite silence suites; test and it silence tests. */
function rootLevel(name: string): Level | undefined {
  if (name === "describe" || name === "suite") return "describe";
  if (name === "test" || name === "it") return "test";
  return undefined;
}

function unwrapExpression(expression: Expression): Expression {
  let current = expression;
  while (
    isParenthesizedExpression(current)
    || isAsExpression(current)
    || isTypeAssertionExpression(current)
    || isNonNullExpression(current)
    || isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function memberName(expression: Expression): string | undefined {
  const current = unwrapExpression(expression);
  if (isPropertyAccessExpression(current)) return current.name.text;
  if (isElementAccessExpression(current) && current.argumentExpression) {
    const argument = unwrapExpression(current.argumentExpression);
    if (isStringLiteral(argument)) return argument.text;
  }
  return undefined;
}

function memberBase(expression: Expression): Expression | undefined {
  const current = unwrapExpression(expression);
  if (isPropertyAccessExpression(current) || isElementAccessExpression(current)) return current.expression;
  return undefined;
}

function declarationPrefix(declaration: VariableDeclaration): string {
  const flags = declaration.parent.flags;
  return flags & NodeFlags.Const ? "const" : flags & NodeFlags.Let ? "let" : "var";
}

function projectMember(base: Binding, property: string, text: string): Binding | undefined {
  if ("namespace" in base) {
    const level = rootLevel(property);
    return level
      ? { level, skipped: false, callable: "collector", via: `${text} — ${base.via}` }
      : undefined;
  }
  if (base.callable !== "collector") return undefined;
  if (DISABLING_MEMBERS.has(property)) {
    return { ...base, skipped: true, via: `${text} — ${base.via}` };
  }
  const chainable = base.level === "describe" ? SUITE_CHAINABLE_MEMBERS : TEST_CHAINABLE_MEMBERS;
  if (chainable.has(property)) {
    // level-preserving projection: the chainable neither enables nor disables, so `skipped`
    // stays sticky and the disabling member is found anywhere in the chain
    return { ...base, via: `${text} — ${base.via}` };
  }
  if (EACH_MEMBERS.has(property)) {
    return { ...base, callable: "parameterizer", via: `${text} — ${base.via}` };
  }
  return undefined;
}

/**
 * Does the callee chain still NAME a disabling member at the call site — `test.skip(...)`,
 * `test.concurrent.skip(...)`, `test.skip.each(cases)(...)`? A disable named where it stands
 * is conspicuous; the deliberate asymmetry exempts it at test level.
 */
function calleeNamesDisablingMember(expression: Expression): boolean {
  let current = unwrapExpression(expression);
  for (;;) {
    if (isCallExpression(current)) {
      current = unwrapExpression(current.expression);
      continue;
    }
    const property = memberName(current);
    if (property && DISABLING_MEMBERS.has(property)) return true;
    const base = property ? memberBase(current) : undefined;
    if (!base) return false;
    current = unwrapExpression(base);
  }
}

/** Lint one test-file source for suites or tests disabled directly or through a skip/todo alias. */
export function lintSource(src: string, file = "<fixture>"): Finding[] {
  const sourceFile = createSourceFile(file, src, ScriptTarget.Latest, true, ScriptKind.TS);
  const findings: Finding[] = [];

  // Lexical scopes. A single file-wide map keyed by name cannot model JavaScript bindings: a
  // nested declaration or a parameter shadows the outer binding, and the shadow — not the
  // outer alias — decides what a call site resolves to. Build the scope tree first: the
  // module, every function and every block gets its own scope, and `var` hoists to its
  // function scope.
  const rootScope: Scope = { kind: "source", parent: undefined, bindings: new Map(), declarations: [] };
  const scopeByNode = new Map<Node, Scope>([[sourceFile, rootScope]]);
  const allScopes: Scope[] = [rootScope];
  const buildScopes = (node: Node, enclosing: Scope): void => {
    let scope = enclosing;
    if (
      isFunctionLikeNode(node)
      || isBlock(node)
      || isForStatement(node)
      || isForInStatement(node)
      || isForOfStatement(node)
    ) {
      scope = {
        kind: isFunctionLikeNode(node) ? "function" : "block",
        parent: enclosing,
        bindings: new Map(),
        declarations: [],
      };
      allScopes.push(scope);
      scopeByNode.set(node, scope);
      if (
        isFunctionDeclaration(node) || isFunctionExpression(node) || isArrowFunction(node)
        || isMethodDeclaration(node) || isConstructorDeclaration(node)
        || isGetAccessorDeclaration(node) || isSetAccessorDeclaration(node)
      ) {
        // parameters shadow outer bindings and never resolve to a vitest root
        for (const parameter of node.parameters) {
          for (const name of patternNames(parameter.name)) scope.bindings.set(name, undefined);
        }
      }
    }
    if (isVariableDeclaration(node)) {
      let target = scope;
      if (!(node.parent.flags & (NodeFlags.Let | NodeFlags.Const))) {
        // `var` hoists out of blocks to the nearest function (or the module) scope
        while (target.kind === "block" && target.parent) target = target.parent;
      }
      target.declarations.push(node);
      for (const name of patternNames(node.name)) {
        if (!target.bindings.has(name)) target.bindings.set(name, undefined);
      }
    }
    forEachChild(node, (child) => buildScopes(child, scope));
  };
  forEachChild(sourceFile, (child) => buildScopes(child, rootScope));

  const scopeAt = (node: Node): Scope => {
    for (let current: Node | undefined = node; current; current = current.parent) {
      const scope = scopeByNode.get(current);
      if (scope) return scope;
    }
    return rootScope;
  };

  const lookup = (name: string, scope: Scope): Binding | undefined => {
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      if (current.bindings.has(name)) return current.bindings.get(name);
    }
    return undefined;
  };

  const resolve = (expression: Expression, scope: Scope): Binding | undefined => {
    const current = unwrapExpression(expression);
    if (isIdentifier(current)) return lookup(current.text, scope);
    if (isCallExpression(current)) {
      // Calling the `.each`/`.for` parameterizer returns the actual suite/test collector.
      // Keeping those two callable states distinct prevents the builder call itself from
      // becoming a false finding and also resolves an alias of the returned callable.
      const base = resolve(current.expression, scope);
      if (!base || "namespace" in base || base.callable !== "parameterizer") return undefined;
      return {
        ...base,
        callable: "collector",
        via: `${current.getText(sourceFile)} — ${base.via}`,
      };
    }
    const property = memberName(current);
    const baseExpression = memberBase(current);
    if (!property || !baseExpression) return undefined;
    const base = resolve(baseExpression, scope);
    if (!base) return undefined;
    return projectMember(base, property, current.getText(sourceFile));
  };

  for (const statement of sourceFile.statements) {
    if (
      !isImportDeclaration(statement)
      || !isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "vitest"
      || !statement.importClause?.namedBindings
    ) continue;
    const imported = statement.importClause.namedBindings;
    if (isNamespaceImport(imported)) {
      rootScope.bindings.set(imported.name.text, {
        namespace: true,
        via: `import * as ${imported.name.text} from "vitest"`,
      });
      continue;
    }
    if (!isNamedImports(imported)) continue;
    for (const specifier of imported.elements) {
      const importedName = (specifier.propertyName ?? specifier.name).text;
      const localName = specifier.name.text;
      const level = rootLevel(importedName);
      if (!level) continue;
      rootScope.bindings.set(localName, {
        level,
        skipped: false,
        callable: "collector",
        via: importedName === localName
          ? `import { ${importedName} } from "vitest"`
          : `import { ${importedName} as ${localName} } from "vitest"`,
      });
    }
  }

  // Resolve every variable declaration against its own lexical scope. Declaration kind, comma
  // layout, semicolon style, namespace qualification and TS assertion wrappers are irrelevant.
  // Repeat to a fixed point so a later declaration can expose an earlier alias chain as well.
  const declarationCount = allScopes.reduce((count, scope) => count + scope.declarations.length, 0);
  for (let pass = 0; pass <= declarationCount; pass++) {
    let changed = false;
    for (const scope of allScopes) {
      for (const declaration of scope.declarations) {
        if (!declaration.initializer) continue;
        const base = resolve(declaration.initializer, scope);
        if (!base) continue;
        const prefix = declarationPrefix(declaration);
        if (isIdentifier(declaration.name)) {
          const via = `${prefix} ${declaration.getText(sourceFile)} — ${base.via}`;
          if (scope.bindings.get(declaration.name.text)?.via === via) continue;
          scope.bindings.set(declaration.name.text, { ...base, via });
          changed = true;
          continue;
        }
        if (!isObjectBindingPattern(declaration.name)) continue;
        for (const element of declaration.name.elements) {
          if (!isIdentifier(element.name)) continue;
          const property = element.propertyName && isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.propertyName && isStringLiteral(element.propertyName)
              ? element.propertyName.text
              : element.name.text;
          const projected = projectMember(
            base,
            property,
            `${declaration.initializer.getText(sourceFile)}.${property}`,
          );
          if (!projected) continue;
          const via = `${prefix} ${declaration.getText(sourceFile)} — ${projected.via}`;
          if (scope.bindings.get(element.name.text)?.via === via) continue;
          scope.bindings.set(element.name.text, { ...projected, via });
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const visitCalls = (node: Node): void => {
    if (isCallExpression(node)) {
      const binding = resolve(node.expression, scopeAt(node));
      if (
        binding
        && !("namespace" in binding)
        && binding.callable === "collector"
        && binding.skipped
      ) {
        // A direct test.skip(...) / test.todo(...) — or a chain that still names the member at
        // the call site, like test.concurrent.skip(...) — is conspicuous and intentionally
        // permitted (the asymmetry the resolver implements). Rebinding the member behind an
        // alias hides the disable at its eventual call site and is therefore a finding — at
        // either level, and for every direct call at suite level, where silence is invisible
        // where it stands.
        const directNamedCall = calleeNamesDisablingMember(node.expression);
        if (binding.level === "describe" || !directNamedCall) {
          const start = node.getStart(sourceFile);
          findings.push({
            file,
            line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
            level: binding.level,
            alias: node.expression.getText(sourceFile),
            via: binding.via,
          });
        }
      }
    }
    forEachChild(node, visitCalls);
  };
  visitCalls(sourceFile);

  return findings.sort((a, b) => a.line - b.line);
}

function walkTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTestFiles(path));
    else if (entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

const lineOf = (source: string, marker: string) =>
  source.split("\n").findIndex((line) => line.includes(marker)) + 1;

describe("skip-alias lint", () => {
  test("test: the lint reports a skipped suite reached through an alias, proven member by member over the closed set of alias forms the resolver implements — a renamed-import const alias, a namespace-import alias, a let alias, a comma-declared alias chain, an object-destructured alias, a TS-assertion-wrapped alias and a static element-access member — each reported with the binding chain that produced it", () => {
    const cases: Array<{ name: string; marker: string; needles: string[]; source: string }> = [
      {
        name: "renamed-import-const-alias",
        marker: "silenced through a renamed-import const alias",
        needles: ["const s = d.skip", "import { describe as d } from \"vitest\""],
        source: `import { describe as d, expect, test } from "vitest";

const s = d.skip;

s("a suite silenced through a renamed-import const alias", () => {
  test("never runs", () => {
    expect(true).toBe(true);
  });
});
`,
      },
      {
        name: "namespace-import-alias",
        marker: "silenced through a namespace-import alias",
        needles: ["const s = v.describe.skip", "import * as v from \"vitest\""],
        source: `import * as v from "vitest";

const s = v.describe.skip;

s("a suite silenced through a namespace-import alias", () => {});
`,
      },
      {
        name: "let-alias",
        marker: "silenced through a let alias",
        needles: ["let s = describe.skip", "import { describe } from \"vitest\""],
        source: `import { describe, test } from "vitest";

let s = describe.skip;

s("a suite silenced through a let alias", () => {
  test("never runs", () => {});
});
`,
      },
      {
        name: "comma-declared-alias-chain",
        marker: "silenced through a comma-declared alias chain",
        needles: ["const s = skipped", "const skipped = describe.skip"],
        source: `import { describe } from "vitest";

const skipped = describe.skip, s = skipped;

s("a suite silenced through a comma-declared alias chain", () => {});
`,
      },
      {
        name: "object-destructured-alias",
        marker: "silenced through an object-destructured alias",
        needles: ["const { skip: s } = describe"],
        source: `import { describe } from "vitest";

const { skip: s } = describe;

s("a suite silenced through an object-destructured alias", () => {});
`,
      },
      {
        name: "ts-assertion-wrapped-alias",
        marker: "silenced through a TS-assertion-wrapped alias",
        needles: ["const s = describe.skip as typeof describe"],
        source: `import { describe } from "vitest";

const s = describe.skip as typeof describe;

s("a suite silenced through a TS-assertion-wrapped alias", () => {});
`,
      },
      {
        name: "static-element-access-member",
        marker: "silenced through a static element-access member",
        needles: ["const s = describe[\"skip\"]"],
        source: `import { describe } from "vitest";

const s = describe["skip"];

s("a suite silenced through a static element-access member", () => {});
`,
      },
    ];

    for (const c of cases) {
      const findings = lintSource(c.source, `${c.name}.test.ts`);
      expect(findings, c.name).toHaveLength(1);
      const [finding] = findings;
      expect(finding.file, c.name).toBe(`${c.name}.test.ts`);
      expect(finding.level, c.name).toBe("describe");
      expect(finding.alias, c.name).toBe("s");
      expect(finding.line, c.name).toBe(lineOf(c.source, c.marker));
      // the finding carries the whole binding chain that produced it, import to call site
      for (const needle of c.needles) expect(finding.via, `${c.name} names ${needle}`).toContain(needle);
    }
  });

  test("test: the lint reports nothing for a genuinely enabled suite and nothing for a single skipped test named in place, while a directly skipped describe is reported, which is the asymmetry the resolver implements deliberately", () => {
    const enabled = `import { describe, expect, test } from "vitest";

describe("a genuinely enabled suite", () => {
  test("runs", () => {
    expect(1).toBe(1);
  });
  test("runs too", () => {
    expect(2).toBe(2);
  });
});
`;
    expect(lintSource(enabled)).toEqual([]);

    const oneSkippedTest = `import { describe, expect, test } from "vitest";

describe("an enabled suite with one skipped test", () => {
  test("runs", () => {
    expect(1).toBe(1);
  });
  test.skip("a single skipped test, named in place", () => {
    expect(1).toBe(1);
  });
});
`;
    expect(lintSource(oneSkippedTest)).toEqual([]);

    const skippedSuite = `import { describe, expect, test } from "vitest";

describe.skip("a directly skipped describe", () => {
  test("never runs", () => {
    expect(1).toBe(1);
  });
});
`;
    const findings = lintSource(skippedSuite);
    expect(findings).toHaveLength(1);
    expect(findings[0].level).toBe("describe");
    expect(findings[0].line).toBe(lineOf(skippedSuite, "a directly skipped describe"));
    expect(findings[0].via).toContain("describe.skip");
  });

  test("test: the lint reports a suite silenced through todo and a suite reached through the suite root, proven member by member over the closed set of forms this task adds — a describe-todo alias, an it-todo alias, a renamed suite-root skip alias and a namespace suite-root skip alias", () => {
    const cases: Array<{ name: string; level: Level; marker: string; needles: string[]; source: string }> = [
      {
        name: "describe-todo-alias",
        level: "describe",
        marker: "silenced through a describe-todo alias",
        needles: ["const s = describe.todo", "import { describe } from \"vitest\""],
        source: `import { describe, expect, test } from "vitest";

const s = describe.todo;

s("a suite silenced through a describe-todo alias", () => {
  test("never runs", () => {
    expect(true).toBe(true);
  });
});
`,
      },
      {
        name: "it-todo-alias",
        level: "test",
        marker: "silenced through an it-todo alias",
        needles: ["const t = it.todo", "import { it } from \"vitest\""],
        source: `import { expect, it } from "vitest";

const t = it.todo;

t("a test silenced through an it-todo alias", () => {
  expect(true).toBe(true);
});
`,
      },
      {
        name: "renamed-suite-root-skip-alias",
        level: "describe",
        marker: "silenced through a renamed suite-root skip alias",
        needles: ["const x = s.skip", "import { suite as s } from \"vitest\""],
        source: `import { expect, suite as s, test } from "vitest";

const x = s.skip;

x("a suite silenced through a renamed suite-root skip alias", () => {
  test("never runs", () => {
    expect(true).toBe(true);
  });
});
`,
      },
      {
        name: "namespace-suite-root-skip-alias",
        level: "describe",
        marker: "silenced through a namespace suite-root skip alias",
        needles: ["const x = v.suite.skip", "import * as v from \"vitest\""],
        source: `import * as v from "vitest";

const x = v.suite.skip;

x("a suite silenced through a namespace suite-root skip alias", () => {});
`,
      },
    ];

    for (const c of cases) {
      const findings = lintSource(c.source, `${c.name}.test.ts`);
      expect(findings, c.name).toHaveLength(1);
      const [finding] = findings;
      expect(finding.level, c.name).toBe(c.level);
      expect(finding.line, c.name).toBe(lineOf(c.source, c.marker));
      for (const needle of c.needles) expect(finding.via, `${c.name} names ${needle}`).toContain(needle);
    }
  });

  test("test: the lint finds the disabling member anywhere in vitest's chainable-modifier chain — concurrent, sequential, shuffle, only and fails project through level-preserving with the disable sticky, and each/for resolve through their own call — proven member by member over aliased and direct forms at both binding levels", () => {
    const cases: Array<{ name: string; level?: Level; marker: string; needles: string[]; source: string }> = [
      {
        name: "aliased-chainable-before-skip",
        marker: "silenced through an aliased concurrent-before-skip chain",
        needles: ["const s = describe.concurrent.skip", "import { describe } from \"vitest\""],
        source: `import { describe } from "vitest";

const s = describe.concurrent.skip;

s("a suite silenced through an aliased concurrent-before-skip chain", () => {});
`,
      },
      {
        name: "aliased-skip-through-each-call",
        marker: "silenced through an aliased skip resolved through the each call",
        needles: ["const s = describe.skip", "s.each([1, 2])"],
        source: `import { describe } from "vitest";

const s = describe.skip;

s.each([1, 2])("a suite silenced through an aliased skip resolved through the each call", () => {});
`,
      },
      {
        name: "direct-concurrent-before-skip",
        marker: "silenced by a direct concurrent-before-skip chain",
        needles: ["describe.concurrent.skip"],
        source: `import { describe } from "vitest";

describe.concurrent.skip("a suite silenced by a direct concurrent-before-skip chain", () => {});
`,
      },
      {
        name: "direct-skip-before-concurrent",
        marker: "silenced by a direct skip-before-concurrent chain",
        needles: ["describe.skip.concurrent"],
        source: `import { describe } from "vitest";

describe.skip.concurrent("a suite silenced by a direct skip-before-concurrent chain", () => {});
`,
      },
      {
        name: "direct-shuffle-before-todo",
        marker: "silenced by a direct shuffle-before-todo chain",
        needles: ["describe.shuffle.todo"],
        source: `import { describe } from "vitest";

describe.shuffle.todo("a suite silenced by a direct shuffle-before-todo chain", () => {});
`,
      },
      {
        name: "direct-sequential-before-skip",
        marker: "silenced by a direct sequential-before-skip chain",
        needles: ["describe.sequential.skip"],
        source: `import { describe } from "vitest";

describe.sequential.skip("a suite silenced by a direct sequential-before-skip chain", () => {});
`,
      },
      {
        name: "direct-only-before-skip",
        marker: "silenced by a direct only-before-skip chain",
        needles: ["describe.only.skip"],
        source: `import { describe } from "vitest";

describe.only.skip("a suite silenced by a direct only-before-skip chain", () => {});
`,
      },
      {
        name: "aliased-test-skip-before-fails",
        level: "test",
        marker: "test silenced through an aliased skip-before-fails chain",
        needles: ["const t = test.skip.fails", "import { test } from \"vitest\""],
        source: `import { test } from "vitest";

const t = test.skip.fails;

t("a test silenced through an aliased skip-before-fails chain", () => {});
`,
      },
      {
        name: "direct-skip-through-each-call",
        marker: "silenced by a direct skip resolved through the each call",
        needles: ["describe.skip.each"],
        source: `import { describe } from "vitest";

describe.skip.each([1, 2])("a suite silenced by a direct skip resolved through the each call", () => {});
`,
      },
      {
        name: "aliased-skip-through-for-call",
        marker: "silenced through an alias of the callable returned by for",
        needles: ["const s = describe.skip.for([1, 2])"],
        source: `import { describe } from "vitest";

const s = describe.skip.for([1, 2]);

s("a suite silenced through an alias of the callable returned by for", () => {});
`,
      },
      {
        name: "control-direct-skip",
        marker: "silenced by a direct skip, the control",
        needles: ["describe.skip"],
        source: `import { describe } from "vitest";

describe.skip("a suite silenced by a direct skip, the control", () => {});
`,
      },
    ];

    for (const c of cases) {
      const findings = lintSource(c.source, `${c.name}.test.ts`);
      expect(findings, c.name).toHaveLength(1);
      const [finding] = findings;
      expect(finding.level, c.name).toBe(c.level ?? "describe");
      expect(finding.line, c.name).toBe(lineOf(c.source, c.marker));
      for (const needle of c.needles) expect(finding.via, `${c.name} names ${needle}`).toContain(needle);
    }

    // the asymmetry survives the chain at test level: a skipped TEST whose disabling member is
    // still named at the call site is conspicuous in place and stays exempt
    const directTestChains = `import { test } from "vitest";

test.concurrent.skip("a skipped test named in place through a chainable chain", () => {});
test.sequential.skip("a sequential skipped test named in place", () => {});
test.only.skip("an only skipped test named in place", () => {});
test.skip.each([1, 2])("a skipped test named in place through the each call", () => {});
`;
    expect(lintSource(directTestChains, "direct-test-chains.test.ts")).toEqual([]);

    // but the same chain reached through an ALIAS hides the member at the call site — a finding
    const aliasedTestChain = `import { it } from "vitest";

const t = it.skip;

t.each([1, 2])("a test silenced through an aliased skip resolved through the each call", () => {});
`;
    const aliasedFindings = lintSource(aliasedTestChain, "aliased-test-chain.test.ts");
    expect(aliasedFindings).toHaveLength(1);
    expect(aliasedFindings[0].level).toBe("test");
    expect(aliasedFindings[0].line).toBe(lineOf(aliasedTestChain, "silenced through an aliased skip"));
    expect(aliasedFindings[0].via).toContain("const t = it.skip");

    const aliasedTestFor = `import { it } from "vitest";

const t = it.skip.for([1, 2]);

t("a test silenced through an alias of the callable returned by for", () => {});
`;
    const testForFindings = lintSource(aliasedTestFor, "aliased-test-for.test.ts");
    expect(testForFindings).toHaveLength(1);
    expect(testForFindings[0].level).toBe("test");
    expect(testForFindings[0].via).toContain("const t = it.skip.for([1, 2])");

    // The real APIs are level-specific: `fails` is not a SuiteAPI modifier and `shuffle` is
    // not a TestAPI modifier. Invalid cross-level projections are not invented as lint roots.
    const crossLevelNonMembers = `import { describe, test } from "vitest";
const s = describe.skip.fails;
const t = test.skip.shuffle;
s("not a real SuiteAPI chain", () => {});
t("not a real TestAPI chain", () => {});
`;
    expect(lintSource(crossLevelNonMembers, "cross-level-non-members.test.ts")).toEqual([]);
  });

  test("test: the lint resolves bindings lexically, not by name alone — a nested declaration or parameter shadows the outer alias, so an enabled inner binding is not reported through the outer skipped name, a skipped inner binding is reported despite the outer enabled name, and a parameter shadow resolves to nothing", () => {
    // an enabled inner declaration shadows the outer skipped alias: only the outer call reports
    const enabledShadow = `import { describe } from "vitest";

const s = describe.skip;

s("a suite silenced through the outer alias", () => {});

function inner() {
  const s = describe;
  s("an enabled suite — the inner declaration shadows the outer skipped alias", () => {});
}
`;
    const enabledFindings = lintSource(enabledShadow, "enabled-shadow.test.ts");
    expect(enabledFindings).toHaveLength(1);
    expect(enabledFindings[0].line).toBe(lineOf(enabledShadow, "silenced through the outer alias"));

    // a skipped inner declaration shadows the outer enabled binding: only the inner call reports
    const skippedShadow = `import { describe } from "vitest";

const s = describe;

{
  const s = describe.skip;
  s("a suite silenced through the inner shadowing declaration", () => {});
}

s("an enabled suite — the outer binding is not the inner alias", () => {});
`;
    const skippedFindings = lintSource(skippedShadow, "skipped-shadow.test.ts");
    expect(skippedFindings).toHaveLength(1);
    expect(skippedFindings[0].line).toBe(lineOf(skippedShadow, "silenced through the inner shadowing declaration"));
    expect(skippedFindings[0].via).toContain("const s = describe.skip");

    // a parameter shadows the outer skipped alias and resolves to nothing — called with the
    // enabled root, the inner call site is not the outer alias
    const parameterShadow = `import { describe } from "vitest";

const s = describe.skip;

const run = (s) => {
  s("a call through the parameter, not the outer alias", () => {});
};
run(describe);

s("a suite silenced through the outer alias", () => {});
`;
    const parameterFindings = lintSource(parameterShadow, "parameter-shadow.test.ts");
    expect(parameterFindings).toHaveLength(1);
    expect(parameterFindings[0].line).toBe(lineOf(parameterShadow, "silenced through the outer alias"));
  });

  test(
    "test: a coverage run reports src/tui with a nonzero measured line figure, and the same run repeated with a line floor above that measured figure exits nonzero",
    { timeout: 420_000 },
    () => {
      // The shipped defect was a test that walked files and read vitest.config.ts while
      // `npm test` ran without coverage — no gate ever measured the figure. Here the figure
      // is MEASURED: an isolated coverage run (own config, rooted at this repo, the tui app
      // suite as the probe) instruments the whole src/tui tree and reports it.
      const workDir = mkdtempSync(join(tmpdir(), "tui-coverage-"));
      const reportsDir = join(workDir, "coverage");
      const configPath = join(workDir, "vitest.tui-coverage.config.ts");
      const writeConfig = (thresholds: string) =>
        writeFileSync(
          configPath,
          // a plain object, not defineConfig: the config lives in a tmp dir, where
          // "vitest/config" does not resolve — vitest accepts the bare shape
          `export default {
  root: ${JSON.stringify(repoRoot)},
  test: {
    setupFiles: ["tests/setup.ts"],
    include: ["tests/tui/app.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/tui/**"],
      reporter: ["text", "json-summary"],
      reportsDirectory: ${JSON.stringify(reportsDir)},
${thresholds}
    },
  },
};
`,
        );
      const runCoverage = (thresholds: string) => {
        writeConfig(thresholds);
        const run = spawnSync(
          process.execPath,
          [join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "run", "--coverage", "--config", configPath],
          { cwd: repoRoot, encoding: "utf8", timeout: 180_000 },
        );
        return { status: run.status, output: `${run.stdout ?? ""}\n${run.stderr ?? ""}` };
      };

      // the measured run: no floors, exit zero, and the report carries a real src/tui figure
      const measured = runCoverage("");
      expect(measured.status, measured.output).toBe(0);
      const summary = JSON.parse(readFileSync(join(reportsDir, "coverage-summary.json"), "utf8")) as Record<
        string,
        { lines: { total: number; covered: number } }
      >;
      const tuiPrefix = join(repoRoot, "src", "tui");
      let total = 0;
      let covered = 0;
      for (const [file, entry] of Object.entries(summary)) {
        if (file === "total" || !file.startsWith(tuiPrefix)) continue;
        total += entry.lines.total;
        covered += entry.lines.covered;
      }
      expect(total, "the coverage run reports src/tui files").toBeGreaterThan(0);
      const figure = (covered / total) * 100;
      expect(figure, "src/tui has a nonzero measured line figure").toBeGreaterThan(0);

      // the positive control: the same run with the floor raised above the measured figure
      // must exit nonzero — proving the threshold fires on this tree rather than silently
      // omitting it
      const floor = Math.min(100, Math.floor(figure) + 1);
      expect(floor, "the raised floor is above the measured figure").toBeGreaterThan(figure);
      const floored = runCoverage(`      thresholds: { "src/tui/**": { lines: ${floor} } },`);
      expect(floored.status, floored.output).not.toBe(0);
      expect(floored.output, "the failure is the src/tui line threshold firing").toMatch(
        /coverage for lines[\s\S]*does not meet[\s\S]*src\/tui/i,
      );
    },
  );

  test("no suite can be disabled THROUGH AN ALIAS this lint cannot name, at either binding level — a disabled describe or a disabled test — every residual category is enumerated in the test file rather than summarised as dynamic aliases, and the lint is pointed at this repository's own tests tree rather than only at its fixtures", () => {
    // the lint names both binding levels: a describe rebound to a skip, and a test rebound to one
    const bothLevels = `import { describe as d, test as t } from "vitest";

const describe = d.skip;
const test = t.skip;

describe("a describe disabled through an alias", () => {
  test("a test disabled through an alias", () => {});
});
`;
    const findings = lintSource(bothLevels, "both-levels.test.ts");
    expect(findings).toHaveLength(2);
    const disabledDescribe = findings.find((f) => f.level === "describe");
    const disabledTest = findings.find((f) => f.level === "test");
    expect(disabledDescribe?.line).toBe(lineOf(bothLevels, "a describe disabled through an alias"));
    expect(disabledDescribe?.via).toContain("const describe = d.skip");
    expect(disabledTest?.line).toBe(lineOf(bothLevels, "a test disabled through an alias"));
    expect(disabledTest?.via).toContain("const test = t.skip");

    // What stays open — every residual category, enumerated member by member with a concrete
    // fixture, never summarised as "dynamic aliases". Each returns zero findings today; each
    // is named here so the closed set above and the open set here are the same statement. The
    // chainable-modifier category is NOT here because it is closed: the chain test above
    // proves the level-specific modifier sets and `each`/`for` resolve.
    const residuals: Array<{ name: string; source: string }> = [
      {
        name: "directly-named members at test level — test.skip / test.todo are conspicuous in place and deliberately exempt",
        source: `import { describe, test } from "vitest";
describe("enabled", () => {
  test.skip("skipped in place", () => {});
  test.todo("todo in place");
});`,
      },
      {
        name: "conditional members — skipIf/todoIf carry their condition in the call, so they are runtime decisions, not aliases",
        source: `import { describe, test } from "vitest";
describe.skipIf(process.env.CI === "1")("conditionally skipped suite", () => {
  test.skipIf(process.env.CI !== "1")("conditionally skipped test", () => {});
});`,
      },
      {
        name: "an alias through a conditional expression — the branch is not resolved",
        source: `import { describe } from "vitest";
const flag = true;
const s = flag ? describe.skip : describe;
s("a suite silenced through a conditional alias", () => {});`,
      },
      {
        name: "an alias through a function call — the call result is not resolved",
        source: `import { describe } from "vitest";
const identity = <T>(value: T): T => value;
const s = identity(describe.skip);
s("a suite silenced through a function-call alias", () => {});`,
      },
      {
        name: "an alias parked on an object property — object literals are not tracked",
        source: `import { describe } from "vitest";
const box = { s: describe.skip };
box.s("a suite silenced through an object-parked alias", () => {});`,
      },
      {
        name: "a reassignment rather than a declaration — assignments are not declarations",
        source: `import { describe } from "vitest";
let s: typeof describe;
s = describe.skip;
s("a suite silenced through a reassigned alias", () => {});`,
      },
      {
        name: "a computed member whose key is not a string literal — the key is not resolved",
        source: `import { describe } from "vitest";
const member = "skip";
const s = describe[member];
s("a suite silenced through a computed-key alias", () => {});`,
      },
      {
        name: "an array-destructured alias — array binding patterns are not tracked",
        source: `import { describe } from "vitest";
const [s] = [describe.skip];
s("a suite silenced through an array-destructured alias", () => {});`,
      },
    ];
    for (const residual of residuals) {
      expect(lintSource(residual.source, `${residual.name}.test.ts`), residual.name).toEqual([]);
    }

    // and the lint is pointed at this repository's own tests tree, not only at its fixtures:
    // the live corpus carries no suite or test this lint would report (T28/T29 deleted the
    // silenced suites, so this sweep is green on arrival and stays green by construction)
    const reported: Finding[] = [];
    for (const file of walkTestFiles(join(repoRoot, "tests"))) {
      reported.push(...lintSource(readFileSync(file, "utf8"), file.slice(repoRoot.length + 1)));
    }
    expect(
      reported,
      reported.map((f) => `${f.file}:${f.line} [${f.level}] ${f.alias} — ${f.via}`).join("\n"),
    ).toEqual([]);
  });
});
