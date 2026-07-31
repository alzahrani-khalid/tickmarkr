import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  createCompilerHost,
  createProgram,
  createSourceFile,
  forEachChild,
  isArrayLiteralExpression,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isNonNullExpression,
  isNumericLiteral,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isReturnStatement,
  isSatisfiesExpression,
  isSourceFile,
  isSpreadElement,
  isStatement,
  isStringLiteral,
  isTypeAssertionExpression,
  isVariableDeclaration,
  JsxEmit,
  ModuleKind,
  ModuleResolutionKind,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  TypeFlags,
  type CompilerOptions,
  type Expression,
  type Node,
  type Program,
  type SourceFile,
  type Type,
  type TypeChecker,
} from "typescript";
import { describe, expect, test } from "vitest";

const COCKPIT = resolve(import.meta.dirname, "../../src/tui/cockpit");
const WIDTH_AUTHORITY = "width.ts";

const FINDING_KINDS = [
  "string-width-import",
  "spread-length",
  "string-length",
  "array-from-length",
  "local-width-helper",
  "east-asian-width-table",
] as const;
type FindingKind = (typeof FINDING_KINDS)[number];

type WidthFinding = {
  readonly file: string;
  readonly line: number;
  readonly kind: FindingKind;
};

const COMPILER_OPTIONS: CompilerOptions = {
  target: ScriptTarget.ES2022,
  module: ModuleKind.NodeNext,
  moduleResolution: ModuleResolutionKind.NodeNext,
  jsx: JsxEmit.ReactJSX,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  noResolve: true,
};

function cockpitFiles(): string[] {
  const entries = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return entries(path);
      return entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : [];
    });
  return entries(COCKPIT)
    .filter((file) => file !== join(COCKPIT, WIDTH_AUTHORITY))
    .sort();
}

/**
 * Build a typed syntax tree without resolving the source's imports. The width
 * sweep needs local expression types (not a second project build), while the
 * standard library is retained so `"x"` and `["x"].join("")` are both known
 * to be strings.
 */
function sourceProgram(sources: ReadonlyMap<string, string>): Program {
  const normalized = new Map(
    [...sources].map(([file, source]) => [resolve(file), source] as const),
  );
  const host = createCompilerHost(COMPILER_OPTIONS, true);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (file) =>
    normalized.has(resolve(file))
    || defaultFileExists(file);
  host.readFile = (file) =>
    normalized.get(resolve(file))
    ?? defaultReadFile(file);
  host.getSourceFile = (file, languageVersion, onError, shouldCreate) => {
    const source = normalized.get(resolve(file));
    if (source === undefined) {
      return defaultGetSourceFile(
        file,
        languageVersion,
        onError,
        shouldCreate,
      );
    }
    return createSourceFile(
      file,
      source,
      languageVersion,
      true,
      file.endsWith(".tsx") ? ScriptKind.TSX : ScriptKind.TS,
    );
  };
  return createProgram({
    rootNames: [...normalized.keys()],
    options: COMPILER_OPTIONS,
    host,
  });
}

function unwrap(expression: Expression): Expression {
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

/**
 * The element expansion `Array.from(x)` iterates, or undefined when the call is
 * not that shape. Returned rather than a boolean so the caller can ask what was
 * expanded: only expanding a *string* counts characters, and only counting
 * characters is a hand-rolled cell measurement.
 */
function arrayFromSource(expression: Expression): Expression | undefined {
  const candidate = unwrap(expression);
  if (
    !isCallExpression(candidate)
    || !isPropertyAccessExpression(candidate.expression)
    || !isIdentifier(candidate.expression.expression)
    || candidate.expression.expression.text !== "Array"
    || candidate.expression.name.text !== "from"
  ) {
    return undefined;
  }
  return candidate.arguments[0];
}

/** The single expression `[...x]` spreads, or undefined for any other literal. */
function spreadSource(expression: Expression): Expression | undefined {
  const candidate = unwrap(expression);
  if (!isArrayLiteralExpression(candidate) || candidate.elements.length !== 1) {
    return undefined;
  }
  const [element] = candidate.elements;
  return element && isSpreadElement(element) ? element.expression : undefined;
}

function isStringType(type: Type): boolean {
  if ((type.flags & TypeFlags.StringLike) !== 0) return true;
  return type.isUnion() && type.types.some(isStringType);
}

const ARITHMETIC_OPERATORS = new Set<SyntaxKind>([
  SyntaxKind.PlusToken,
  SyntaxKind.MinusToken,
  SyntaxKind.AsteriskToken,
  SyntaxKind.SlashToken,
  SyntaxKind.PercentToken,
]);

/**
 * Climb out of the numeric arithmetic surrounding `node`, so a length buried in
 * `budget - text.length` is judged by where the whole sum lands rather than by
 * its immediate parent. Comparison stops the climb: `text.length > 0` asks
 * whether the string is empty, which is not a cell measurement.
 */
function arithmeticRoot(node: Node): Node {
  let current = node;
  while (
    current.parent
    && ((isBinaryExpression(current.parent)
      && ARITHMETIC_OPERATORS.has(current.parent.operatorToken.kind))
      || isParenthesizedExpression(current.parent))
  ) {
    current = current.parent;
  }
  return current;
}

/**
 * String length has non-width uses (`input.length === 1`, empty checks and
 * code-unit slicing). It becomes a cell-count offender when its enclosing
 * statement names cell geometry, or when the numeric value — alone or as a term
 * of an arithmetic expression — is captured or returned for further arithmetic.
 */
function isCountedStringLength(node: Node, source: SourceFile): boolean {
  const counted = arithmeticRoot(node);
  if (
    (isVariableDeclaration(counted.parent)
      && counted.parent.initializer === counted)
    || isReturnStatement(counted.parent)
  ) {
    return true;
  }

  let current = node;
  while (current.parent && !isSourceFile(current.parent)) {
    if (
      isArrowFunction(current.parent)
      || isFunctionExpression(current.parent)
      || isStatement(current.parent)
    ) {
      break;
    }
    current = current.parent;
  }
  return /(?:cell|column|width)/iu.test(current.getText(source));
}

function localHelper(node: Node): Node | undefined {
  if (
    isFunctionDeclaration(node)
    && node.name
    && /^(?:charWidth|isWide)$/iu.test(node.name.text)
  ) {
    return node.name;
  }
  if (
    isVariableDeclaration(node)
    && isIdentifier(node.name)
    && node.initializer
    && (isArrowFunction(node.initializer) || isFunctionExpression(node.initializer))
    && /^(?:charWidth|isWide)$/iu.test(node.name.text)
  ) {
    return node.name;
  }
  return undefined;
}

function numericRangeCount(expression: Expression): number {
  const candidate = unwrap(expression);
  if (!isArrayLiteralExpression(candidate)) return 0;
  return candidate.elements.filter((element) => {
    if (!isArrayLiteralExpression(element) || element.elements.length !== 2) {
      return false;
    }
    return element.elements.every((bound) =>
      isNumericLiteral(bound) && Number(bound.text) > 0xff
    );
  }).length;
}

function eastAsianWidthTable(node: Node): Node | undefined {
  if (
    !isVariableDeclaration(node)
    || !isIdentifier(node.name)
    || !node.initializer
    || numericRangeCount(node.initializer) < 2
  ) {
    return undefined;
  }
  return /(?:eastAsian|wide|width).*?(?:range|table)|(?:range|table).*?(?:wide|width)/iu
      .test(node.name.text)
    ? node.name
    : undefined;
}

function detectWidthArithmetic(program: Program): WidthFinding[] {
  const checker = program.getTypeChecker();
  const findings: WidthFinding[] = [];

  const add = (source: SourceFile, node: Node, kind: FindingKind): void => {
    findings.push({
      file: relative(COCKPIT, source.fileName),
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      kind,
    });
  };

  const visit = (
    source: SourceFile,
    checker: TypeChecker,
    node: Node,
  ): void => {
    if (
      isImportDeclaration(node)
      && isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === "string-width"
    ) {
      add(source, node, "string-width-import");
    }

    const helper = localHelper(node);
    if (helper) add(source, helper, "local-width-helper");

    const table = eastAsianWidthTable(node);
    if (table) add(source, table, "east-asian-width-table");

    if (
      isPropertyAccessExpression(node)
      && node.name.text === "length"
    ) {
      // Expanding a string counts its characters, which is a cell measurement
      // that charges one cell per code point. Expanding anything else counts
      // elements — regex matches, rows, entries — and is not width arithmetic.
      const expandsString = (expanded: Expression | undefined): boolean =>
        expanded !== undefined
        && isStringType(checker.getTypeAtLocation(expanded));
      const spread = spreadSource(node.expression);
      const arrayFrom = arrayFromSource(node.expression);

      if (spread !== undefined) {
        if (expandsString(spread)) add(source, node, "spread-length");
      } else if (arrayFrom !== undefined) {
        if (expandsString(arrayFrom)) add(source, node, "array-from-length");
      } else if (
        isStringType(checker.getTypeAtLocation(node.expression))
        && isCountedStringLength(node, source)
      ) {
        add(source, node, "string-length");
      }
    }

    forEachChild(node, (child) => visit(source, checker, child));
  };

  for (const root of program.getRootFileNames()) {
    const source = program.getSourceFile(root);
    if (source) visit(source, checker, source);
  }
  return findings.sort((left, right) =>
    left.file.localeCompare(right.file)
    || left.line - right.line
    || left.kind.localeCompare(right.kind)
  );
}

describe("cockpit width migration", () => {
  test("test: the width sweep enumerates a non-empty set of src/tui/cockpit files — named members including capture.ts, components.tsx, run-cockpit.tsx and setup-cockpit.tsx — and reports an empty offender list across them", () => {
    const files = cockpitFiles();
    const names = files.map((file) => basename(file));

    expect(files.length).toBeGreaterThan(0);
    expect(names).toEqual(expect.arrayContaining([
      "capture.ts",
      "components.tsx",
      "run-cockpit.tsx",
      "setup-cockpit.tsx",
    ]));

    const sources = new Map(
      files.map((file) => [file, readFileSync(file, "utf8")]),
    );
    expect(detectWidthArithmetic(sourceProgram(sources))).toEqual([]);
  });

  test("test: the detector flags every shape it claims, proven by feeding it a fixture containing each of a string-width import, [...x].length, .length on a string, Array.from(x).length, a local charWidth or isWide helper and a hand-rolled East-Asian-width table, and requiring a flag for each", () => {
    const fixture = `
      import stringWidth from "string-width";
      const text: string = "界";
      const spreadCells = [...text].length;
      const directCells = text.length;
      // The shape real code writes: the length is a term of a budget
      // subtraction, and no identifier in the statement names cell geometry —
      // so only the arithmetic climb can reach it.
      const budget = 40;
      const remaining = budget - text.length;
      const arrayFromCells = Array.from(text).length;
      function charWidth(character: string): number {
        return character === "" ? 0 : 2;
      }
      const EAST_ASIAN_WIDTH_RANGES = [
        [0x1100, 0x115f],
        [0x2329, 0x232a],
        [0x2e80, 0xa4cf],
      ] as const;
      // Expansions of non-strings count elements, not cells. They sit in the
      // fixture so the exact-set assertion below charges the detector for a
      // seventh finding if it ever flags one again.
      const matchCount = [...text.matchAll(/./gu)].length;
      const rowCount = Array.from([1, 2]).length;
      void [
        stringWidth,
        spreadCells,
        directCells,
        remaining,
        arrayFromCells,
        charWidth,
        EAST_ASIAN_WIDTH_RANGES,
        matchCount,
        rowCount,
      ];
    `;
    const findings = detectWidthArithmetic(sourceProgram(
      new Map([["/width-migration-fixture.ts", fixture]]),
    ));

    // `string-length` twice: the direct initializer and the nested budget
    // subtraction. Exact equality — never a superset — is what charges the
    // detector for an eighth finding if the matchAll-spread false positive or
    // any other over-flag returns.
    expect(findings.map(({ kind }) => kind).sort()).toEqual(
      [...FINDING_KINDS, "string-length"].sort(),
    );
  });
});
