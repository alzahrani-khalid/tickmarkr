import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const readmeFile = join(process.cwd(), "README.md");
const quickstartFile = join(process.cwd(), "docs", "operator-quickstart.md");

describe("README steering documentation", () => {
  test("the readme names all three routing modes", () => {
    const readme = readFileSync(readmeFile, "utf8");
    expect(readme).toMatch(/partner-led/);
    expect(readme).toMatch(/risk-based/);
    expect(readme).toMatch(/staff-led/);
  });

  test("the readme documents the review prefer list", () => {
    const readme = readFileSync(readmeFile, "utf8");
    expect(readme).toMatch(/review\.prefer/);
    expect(readme).toMatch(/review\s+prefer/i);
  });

  test("the readme documents the consult prefer list", () => {
    const readme = readFileSync(readmeFile, "utf8");
    expect(readme).toMatch(/consult\.prefer/);
    expect(readme).toMatch(/consult\s+prefer/i);
  });

  test("the readme documents the supersedes rerun flag", () => {
    const readme = readFileSync(readmeFile, "utf8");
    expect(readme).toMatch(/--supersedes/);
  });

  test("the retired operator quickstart doc is absent", () => {
    expect(existsSync(quickstartFile)).toBe(false);
  });

  test("the readme states that consult prefer entries require an adapter colon model form", () => {
    const readme = readFileSync(readmeFile, "utf8");
    // Look for text that says consult prefer requires adapter:model
    expect(readme).toMatch(/consult.*prefer.*adapter:model/is);
  });

  test("the readme states that review prefer entries may name a bare adapter", () => {
    const readme = readFileSync(readmeFile, "utf8");
    // Look for text that says review prefer may name a bare adapter
    expect(readme).toMatch(/review.*prefer.*bare\s+adapter/is);
  });

  test("the readme names the fleet candidate picker", () => {
    const readme = readFileSync(readmeFile, "utf8");
    expect(readme).toMatch(/candidate\s+picker/i);
  });

  test("the readme fleet section counts six steps", () => {
    const readme = readFileSync(readmeFile, "utf8");
    // Look for text that mentions six steps in the fleet section
    expect(readme).toMatch(/step.*6|six\s+step|6[/\\]6/i);
  });
});
