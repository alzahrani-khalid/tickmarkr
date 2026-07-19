import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const REPO = join(import.meta.dirname, "../..");
const SECURITY = readFileSync(join(REPO, "SECURITY.md"), "utf8");
const COC = readFileSync(join(REPO, "CODE_OF_CONDUCT.md"), "utf8");

const PERSONAL_EMAIL = /alzahrani\.khalid@gmail\.com/i;
const ANY_EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const GITHUB_REPO = /github\.com\/alzahrani-khalid\/tickmarkr/i;

describe("T4 contact surface removes the personal email", () => {
  test("the security policy contains no personal email address", () => {
    expect(SECURITY).not.toMatch(PERSONAL_EMAIL);
    expect(SECURITY).not.toMatch(ANY_EMAIL);
  });

  test("the code of conduct contains no personal email address", () => {
    expect(COC).not.toMatch(PERSONAL_EMAIL);
    expect(COC).not.toMatch(ANY_EMAIL);
  });

  test("the security policy routes vulnerability reports through github only", () => {
    expect(SECURITY).toMatch(/github/i);
    expect(SECURITY).toMatch(/private vulnerability reporting/i);
    expect(SECURITY).toMatch(GITHUB_REPO);
    expect(SECURITY).not.toMatch(/mailto:/i);
    expect(SECURITY).not.toMatch(/fallback/i);
  });

  test("the code of conduct routes enforcement reports through github only", () => {
    expect(COC).toMatch(/github/i);
    expect(COC).toMatch(/report abuse/i);
    expect(COC).toMatch(GITHUB_REPO);
    expect(COC).not.toMatch(/mailto:/i);
  });

  test("a reporter reading the security policy has one clear github path with no email fallback", () => {
    expect(SECURITY).toMatch(/through GitHub only/i);
    expect(SECURITY).toMatch(GITHUB_REPO);
    expect(SECURITY).not.toMatch(PERSONAL_EMAIL);
    expect(SECURITY).not.toMatch(ANY_EMAIL);
    expect(SECURITY).not.toMatch(/email the maintainer|If you cannot use GitHub/i);
  });

  test("a reporter reading the code of conduct has one clear github path with no email fallback", () => {
    expect(COC).toMatch(/through GitHub only/i);
    expect(COC).toMatch(GITHUB_REPO);
    expect(COC).not.toMatch(PERSONAL_EMAIL);
    expect(COC).not.toMatch(ANY_EMAIL);
  });
});
