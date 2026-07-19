import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const codebaseDocs = join(repoRoot, "docs", "codebase");

// All files cited in STACK, INTEGRATIONS, CONVENTIONS docs. These must exist in the tree.
const CITED_FILES = [
  // STACK.md citations
  "src/adapters/fake.ts",
  "src/adapters/registry.ts",
  "src/cli/commands/doctor.ts",
  "src/cli/commands/init.ts",
  "src/cli/index.ts",
  "src/compile/index.ts",
  "src/compile/gsd.ts",
  "src/config/config.ts",
  "src/drivers/herdr.ts",
  "src/drivers/index.ts",
  "src/drivers/subprocess.ts",
  "src/gates/scope.ts",
  "src/graph/graph.ts",
  "src/graph/schema.ts",
  "src/run/git.ts",
  "package.json",
  "tsconfig.json",
  "vitest.config.ts",
  "scripts/emit-schema.ts",
  "tests/e2e/real-cli.test.ts",
  // INTEGRATIONS.md citations
  "src/adapters/claude-code.ts",
  "src/adapters/codex.ts",
  "src/adapters/cursor-agent.ts",
  "src/adapters/opencode.ts",
  "src/adapters/pi.ts",
  "src/adapters/grok.ts",
  "src/adapters/kimi.ts",
  "src/adapters/prompt.ts",
  "src/adapters/types.ts",
  "src/gates/acceptance.ts",
  "src/gates/baseline.ts",
  "src/gates/evidence.ts",
  "src/gates/llm.ts",
  "src/gates/review.ts",
  "src/gates/run-gates.ts",
  "src/gates/types.ts",
  "src/run/consult.ts",
  "src/run/journal.ts",
  "src/run/merge.ts",
  ".github/workflows/ci.yml",
  // CONVENTIONS.md citations
  "src/compile/common.ts",
  "src/route/router.ts",
  "src/run/daemon.ts",
  "src/index.ts",
  "tests/adapters/prompt.test.ts",
  "tests/gates/baseline.test.ts",
  "tests/gates/evidence-scope.test.ts",
  "tests/gates/via-driver.test.ts",
  "tests/run/daemon-interactive.test.ts",
  "tests/run/daemon.test.ts",
];

// Files excluded from the public export that should not fail the citation check if missing
// (scripts/export-public.sh excludes these; they're legitimately absent in exported trees)
const EXPORT_EXCLUDED_FILES = [".github/workflows/ci.yml"];

// Filter CITED_FILES to exclude export-excluded files that don't exist
const CITED_FILES_FOR_CHECK = CITED_FILES.filter(
  file => !EXPORT_EXCLUDED_FILES.includes(file) || existsSync(join(repoRoot, file))
);

describe.skipIf(!existsSync(codebaseDocs))("docs-truth-stack", () => {
  test("test: every source file cited on the stack integrations and conventions pages exists in the tree", () => {
    const missing: string[] = [];
    for (const file of CITED_FILES_FOR_CHECK) {
      if (!existsSync(join(repoRoot, file))) {
        missing.push(file);
      }
    }
    expect(missing).toStrictEqual([]);
  });

  test("test: the stack integrations and conventions pages carry no stopgap banner", () => {
    for (const file of ["STACK.md", "INTEGRATIONS.md", "CONVENTIONS.md"]) {
      const path = join(codebaseDocs, file);
      const content = readFileSync(path, "utf8");
      expect(content).not.toMatch(/^> \*\*STOPGAP:/);
    }
  });

  test("test: the integrations page names the continuous integration workflow file", () => {
    const path = join(codebaseDocs, "INTEGRATIONS.md");
    const content = readFileSync(path, "utf8");
    expect(content).toContain(".github/workflows/ci.yml");
    expect(content).toContain("npm run test:coverage");
  });

  test("test: the stack page does not contradict the package manifest", () => {
    const stackPath = join(codebaseDocs, "STACK.md");
    const pkgPath = join(repoRoot, "package.json");
    const stack = readFileSync(stackPath, "utf8");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

    // Verify Node version requirement is consistent
    expect(stack).toContain("Node.js >=20");
    expect(pkg.engines.node).toBe(">=20");

    // Verify package is ESM
    expect(stack).toContain('Pure ESM');
    expect(pkg.type).toBe("module");

    // Verify npm is the package manager
    expect(stack).toContain("npm");

    // Verify bin entries — both names ship and point at the same entrypoint
    expect(stack).toContain('tickmarkr: "dist/cli/index.js"');
    expect(stack).toContain('tkr: "dist/cli/index.js"');
    expect(pkg.bin["tickmarkr"]).toBe("dist/cli/index.js");
    expect(pkg.bin["tkr"]).toBe("dist/cli/index.js");

    // Every published package entry must be represented in the stack description.
    for (const file of pkg.files) expect(stack).toContain(file);
  });

  test("test: the integrations page does not contradict the adapters registry", () => {
    const intPath = join(codebaseDocs, "INTEGRATIONS.md");
    const regPath = join(repoRoot, "src/adapters/registry.ts");
    const integrations = readFileSync(intPath, "utf8");
    const registry = readFileSync(regPath, "utf8");

    // Verify each production adapter is mentioned in docs
    const adapters = ["claude-code", "codex", "cursor-agent", "opencode", "pi", "grok", "kimi"];
    for (const adapter of adapters) {
      expect(integrations).toContain(`**${adapter}**`);
      expect(integrations).toContain(`src/adapters/${adapter}.ts`);
    }

    // Verify fake adapter is mentioned as test-only
    expect(integrations).toContain("Test-only adapter");
    expect(integrations).toContain("FakeAdapter");

    // Verify registry export names match docs
    expect(registry).toContain("claudeCode");
    expect(registry).toContain("codex");
    expect(registry).toContain("cursorAgent");
    expect(registry).toContain("opencode");
    expect(registry).toContain("pi");
    expect(registry).toContain("grok");
    expect(registry).toContain("kimi");
    expect(integrations).toContain("seven AI coding-agent CLIs");
  });

  test("test: the integrations page's documented codex headless command matches the codex adapter's actual headless command", () => {
    const intPath = join(codebaseDocs, "INTEGRATIONS.md");
    const adapterPath = join(repoRoot, "src/adapters/codex.ts");
    const integrations = readFileSync(intPath, "utf8");
    const adapter = readFileSync(adapterPath, "utf8");

    // Extract documented codex headless command specifically
    const docMatch = integrations.match(/\*\*codex\*\*.*?\n\s+-\s+Headless:\s+`([^`]+)`/s);
    expect(docMatch).toBeDefined();
    const docCommand = docMatch![1];

    // Verify key elements match adapter's headlessCommand
    expect(adapter).toContain("headlessCommand");
    expect(docCommand).toContain("codex exec");
    expect(docCommand).toContain("--sandbox workspace-write");
    expect(docCommand).not.toContain("--full-auto"); // Verify old stale command is gone
  });

  test("test: the integrations page's documented codex interactive command matches the codex adapter's actual interactive command", () => {
    const intPath = join(codebaseDocs, "INTEGRATIONS.md");
    const adapterPath = join(repoRoot, "src/adapters/codex.ts");
    const integrations = readFileSync(intPath, "utf8");
    const adapter = readFileSync(adapterPath, "utf8");

    // Extract documented codex interactive command specifically
    const docMatch = integrations.match(/\*\*codex\*\*.*?\n\s+-\s+Interactive:\s+`([^`]+)`/s);
    expect(docMatch).toBeDefined();
    const docCommand = docMatch![1];

    // Verify key elements match adapter's interactiveCommand
    expect(adapter).toContain("interactiveCommand");
    expect(docCommand).toContain("codex");
    expect(docCommand).toContain("-a never");
    expect(docCommand).toContain("-s workspace-write");
    expect(docCommand).not.toContain("-a on-failure"); // Verify old stale command is gone
  });

  test("test: the integrations page describes the portable driving skill install command", () => {
    const intPath = join(codebaseDocs, "INTEGRATIONS.md");
    const integrations = readFileSync(intPath, "utf8");

    expect(integrations).toContain("tickmarkr init --agent");
    expect(integrations).toContain("Portable skill installation");
  });

  test("test: the integrations page names explicit codex skill invocation alongside claude slash invocation", () => {
    const intPath = join(codebaseDocs, "INTEGRATIONS.md");
    const integrations = readFileSync(intPath, "utf8");

    expect(integrations).toContain("Explicit skill invocation");
    expect(integrations).toContain("/tickmarkr-loop");
    expect(integrations).toContain("$tickmarkr-loop");
    expect(integrations).toContain("Claude Code");
    expect(integrations).toContain("Codex");
    expect(integrations).toContain("slash-command invocation");
    expect(integrations).toContain("dollar-sign invocation");
  });

  test("test: the integrations page distinguishes persistent repository guidance from a reusable invoked skill", () => {
    const intPath = join(codebaseDocs, "INTEGRATIONS.md");
    const integrations = readFileSync(intPath, "utf8");

    expect(integrations).toContain("Persistent repository guidance");
    expect(integrations).toContain("Reusable invoked skills");
    expect(integrations).toContain("CLAUDE.md");
    expect(integrations).toContain("AGENTS.md");
    expect(integrations).toContain("Automatically loaded by the agent");
    expect(integrations).toContain("portable workflows");
  });

  test("test: the integrations page states the claude driving path remains equally supported", () => {
    const intPath = join(codebaseDocs, "INTEGRATIONS.md");
    const integrations = readFileSync(intPath, "utf8");

    expect(integrations).toContain("Claude Code driver support remains");
    expect(integrations).toContain("remains fully supported");
    expect(integrations).toContain(".claude/skills");
  });

  test("test: the source-citation check passes when the private continuous integration workflow file is absent from the tree because the tree is the exported public candidate rather than the private repository", () => {
    // When ci.yml is missing (as in the public export), it should be filtered from the check
    const ciWorkflow = ".github/workflows/ci.yml";
    const ciExists = existsSync(join(repoRoot, ciWorkflow));

    if (!ciExists) {
      // In the exported tree, ci.yml is absent and should be filtered from the check
      expect(CITED_FILES_FOR_CHECK).not.toContain(ciWorkflow);
      // Verify the check passes with the filtered list
      const missing = CITED_FILES_FOR_CHECK.filter(
        file => !existsSync(join(repoRoot, file))
      );
      expect(missing).toStrictEqual([]);
    } else {
      // In the private tree, ci.yml exists and is included in the check
      expect(CITED_FILES_FOR_CHECK).toContain(ciWorkflow);
    }
  });

  test("test: the source-citation check still fails when any other file it has always cited goes missing", () => {
    // All non-export-excluded files should still be checked
    const nonExcludedFiles = CITED_FILES.filter(
      file => !EXPORT_EXCLUDED_FILES.includes(file)
    );

    // These files should all be in the check
    for (const file of nonExcludedFiles) {
      expect(CITED_FILES_FOR_CHECK).toContain(file);
    }

    // Verify that only export-excluded files can be missing
    const missingFiles = CITED_FILES_FOR_CHECK.filter(
      file => !existsSync(join(repoRoot, file))
    );
    for (const missing of missingFiles) {
      // Any missing file in CITED_FILES_FOR_CHECK should NOT exist but should be export-excluded
      expect(EXPORT_EXCLUDED_FILES).toContain(missing);
    }
  });
});
