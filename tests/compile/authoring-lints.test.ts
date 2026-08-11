import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test, vi } from "vitest";
import { CompileError } from "../../src/compile/common.js";
import { compileSource } from "../../src/compile/index.js";

const CORPUS = "fixtures/authoring-lints";

const MATRIX = [
  ["01-awk-range-self-pass.spec.md", "dependency-closure", "Finding 0 awk-range self-pass"],
  ["02-judge-text-key-miss.spec.md", "external-referent", "judge-text extractor"],
  ["03-c1-t41-rendered-observable.spec.md", "criterion-scope", "T41 amendment 10422761"],
  ["04-c1-t24-named-file.spec.md", "criterion-scope", "T24 amendment 46e744bf"],
  ["05-c2-t24-t28-dep-inversion.spec.md", "dependency-closure", "T24-T28 inversion"],
  ["06-c2-denumbered-coupling.spec.md", "dependency-coupling", "T26 de-numbered T28 coupling"],
  ["07-c3a-t41-line-count-proxy.spec.md", "proxy-metric", "T41 physical-line proxy"],
  ["08-c3b-t41-governance-referent.spec.md", "external-referent", "T41 the-audit referent"],
  ["09-c4-universals-without-pointer.spec.md", "closed-enumeration", "T26-T28 open universals"],
  ["10-c5-t34-conjunct-flood.spec.md", "one-behavior", "T34 criterion 3"],
  ["11-c6-t34-q3-q9-q20-bundle.spec.md", "concern-bundle", "T34 bundled Q3-Q9-Q20"],
  ["12-c7-t24-prose-seam.spec.md", "seam-exists", "T24 production-driver prose seam"],
] as const;

test("authoring-lint corpus matrix compiles all twelve fixtures and each emits its named lint", () => {
  const listing = readdirSync(CORPUS).filter((name) => name.endsWith(".spec.md")).sort();
  expect(listing).toEqual(MATRIX.map(([name]) => name));

  for (const [name, code, incident] of MATRIX) {
    const path = join(CORPUS, name);
    const provenance = readFileSync(path, "utf8").match(/^<!-- provenance: v1\.89 .* -->$/gm) ?? [];
    expect(provenance, `${name} must carry exactly one v1.89 provenance comment`).toHaveLength(1);
    expect(provenance[0], `${name} must name its incident`).toContain(incident);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let graph: ReturnType<typeof compileSource> | undefined;
    let error: unknown;
    try {
      graph = compileSource(path, "native");
    } catch (caught) {
      error = caught;
    }
    const emitted = [...warn.mock.calls.map(([message]) => String(message)), error instanceof Error ? error.message : ""].join("\n");
    warn.mockRestore();

    const id = basename(name).replace(/\.spec\.md$/, "");
    expect(emitted, `${name} must emit ${code}`).toContain(`authoring-lint[${code}]`);
    expect(emitted, `${name} finding must identify its fixture`).toContain(`fixture ${id}`);
    if (code === "criterion-scope") expect(error).toBeInstanceOf(CompileError);
    else expect(graph?.spec.source, `${name} must otherwise compile`).toBe("native");
  }

  const cleanFile = join(mkdtempSync(join(tmpdir(), "tickmarkr-authoring-clean-")), "clean.spec.md");
  writeFileSync(cleanFile, "<!-- tickmarkr:spec -->\n## T1: Clean control\n- goal: Ship one bounded behavior\n- acceptance:\n  - judge: the bounded behavior is observable\n");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(compileSource(cleanFile, "native").tasks).toHaveLength(1);
  expect(warn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes("authoring-lint"))).toEqual([]);
  warn.mockRestore();
});
