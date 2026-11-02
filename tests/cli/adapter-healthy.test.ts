import { expect, test } from "vitest";
import type { AuthHealth } from "../../src/adapters/types.js";
import { adapterHealthy } from "../../src/cli/commands/doctor.js";

const h = (over: Partial<AuthHealth>): AuthHealth => ({ installed: true, authed: true, models: [], ...over });

test("adapterHealthy is false for missing health, a not-installed adapter, an installed kimi without auth and a codex whose commit probe escaped, and true for an installed authed adapter, a codex whose commit probe is protected and an installed non-kimi adapter without auth", () => {
  expect(adapterHealthy("claude-code", undefined)).toBe(false);
  expect(adapterHealthy("claude-code", h({ installed: false }))).toBe(false);
  expect(adapterHealthy("kimi", h({ authed: false }))).toBe(false);
  expect(adapterHealthy("codex", h({ codexCommit: "escape" }))).toBe(false);
  expect(adapterHealthy("claude-code", h({}))).toBe(true);
  expect(adapterHealthy("codex", h({ codexCommit: "protected" }))).toBe(true);
  expect(adapterHealthy("claude-code", h({ authed: false }))).toBe(true);
});
