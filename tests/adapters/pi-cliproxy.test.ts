// Queue row 392 R6 law 4 (D-2187 add.13, add.21): the proxied pi launch line, built by the production command
// builders against a doctor cache in a disposable repository. No pi is launched and no token is spent.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { pi, piCliproxyExtensionPath } from "../../src/adapters/pi.js";

const CREDENTIAL = "sk-cliproxy-launch-SECRET-5c1e";
const BASE = "http://127.0.0.1:8317";

function repoWithGateway(gateway: unknown): string {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-pi-cliproxy-"));
  mkdirSync(join(repo, ".tickmarkr"));
  writeFileSync(join(repo, ".tickmarkr", "doctor.json"), JSON.stringify({ pi: { installed: true, authed: true, models: [] }, gateway }));
  // the host's Claude settings carry the gateway credential; the launch must never read it into the line
  writeFileSync(join(repo, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: CREDENTIAL } }));
  return repo;
}

const confirmed = (models: { id: string; vendor: string | null }[], extra: object = {}) => ({
  host: "127.0.0.1", baseUrl: BASE, source: "claude-settings",
  listing: { status: "succeeded", checkedAt: "2026-11-08T00:00:00.000Z" }, models, ...extra,
});

afterEach(() => vi.restoreAllMocks());

test("the pi launch line for a proxied model carries the quoted base url model prefix and extension path and no credential byte", async () => {
  const repo = repoWithGateway(confirmed([{ id: "gemini-2.5-pro", vendor: "google" }, { id: "gpt-5.5", vendor: "openai" }, { id: "claude-opus-5-5", vendor: "anthropic" }]));
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  const ext = `'${piCliproxyExtensionPath}'`;

  const headless = pi.headlessCommand("/tmp/p.md", "cliproxy/gemini-2.5-pro");
  const interactive = pi.interactiveCommand("/tmp/p.md", "cliproxy/gemini-2.5-pro", undefined, { cwd: "/w", branch: "b", repoRoot: repo });
  expect(headless).toBe(`TICKMARKR_CLIPROXY_BASE_URL='${BASE}' TICKMARKR_CLIPROXY_MODEL='gemini-2.5-pro' pi -p --approve -e ${ext} --model 'cliproxy/gemini-2.5-pro' "$(cat '/tmp/p.md')"`);
  expect(interactive).toBe(`TICKMARKR_CLIPROXY_BASE_URL='${BASE}' TICKMARKR_CLIPROXY_MODEL='gemini-2.5-pro' pi --approve -e ${ext} --model 'cliproxy/gemini-2.5-pro' "$(cat '/tmp/p.md')"`);
  for (const line of [headless, interactive]) expect(line).not.toContain(CREDENTIAL);

  // the -e path is the shipped module itself, absolute, and its default export is the factory pi awaits
  expect(isAbsolute(piCliproxyExtensionPath)).toBe(true);
  expect(existsSync(piCliproxyExtensionPath)).toBe(true);
  expect(typeof (await import(pathToFileURL(piCliproxyExtensionPath).href)).default).toBe("function");

  // every value is shell-quoted: a base URL with shell syntax rides the prefix as one quoted literal
  const hostile = `${BASE}/$(touch pwned)'x`;
  vi.spyOn(process, "cwd").mockReturnValue(repoWithGateway(confirmed([{ id: "grok-4", vendor: "xai" }], { baseUrl: hostile })));
  expect(pi.headlessCommand("/tmp/p.md", "cliproxy/grok-4")).toContain(`TICKMARKR_CLIPROXY_BASE_URL='${BASE}/$(touch pwned)'\\''x' TICKMARKR_CLIPROXY_MODEL='grok-4' `);

  // no record that admits the id → an empty base URL, on which the extension refuses to load (fails closed)
  const cases: [string, unknown][] = [
    ["failed listing", { ...confirmed([{ id: "gemini-2.5-pro", vendor: "google" }]), listing: { status: "failed", failure: "down", checkedAt: "x" } }],
    ["id not listed", confirmed([{ id: "gpt-5.5", vendor: "openai" }])],
    ["no gateway record", undefined],
    ["an adapter verdict named gateway", { installed: true, authed: true, models: [] }],
  ];
  for (const [, gateway] of cases) {
    vi.spyOn(process, "cwd").mockReturnValue(repoWithGateway(gateway));
    expect(pi.headlessCommand("/tmp/p.md", "cliproxy/gemini-2.5-pro")).toMatch(/^TICKMARKR_CLIPROXY_BASE_URL='' TICKMARKR_CLIPROXY_MODEL='gemini-2.5-pro' pi -p --approve -e /);
  }
  // an override the Claude CLI does not use never carries anthropic ids, so it admits none through pi either
  vi.spyOn(process, "cwd").mockReturnValue(repoWithGateway(confirmed([{ id: "claude-opus-5-5", vendor: "anthropic" }, { id: "gemini-2.5-pro", vendor: "google" }], { source: "config", anthropicUnusable: { claudeHost: "api.anthropic.com" } })));
  expect(pi.headlessCommand("/tmp/p.md", "cliproxy/claude-opus-5-5")).toMatch(/^TICKMARKR_CLIPROXY_BASE_URL='' /);
  expect(pi.headlessCommand("/tmp/p.md", "cliproxy/gemini-2.5-pro")).toMatch(/^TICKMARKR_CLIPROXY_BASE_URL='http:\/\/127\.0\.0\.1:8317' /);

  // control: a configured pi channel's launch is byte-identical to the base, gateway or not
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  expect(pi.headlessCommand("/tmp/p.md", "zai/glm-5.2")).toBe(`pi -p --approve --model 'zai/glm-5.2' "$(cat '/tmp/p.md')"`);
  expect(pi.interactiveCommand("/tmp/p.md", "zai/glm-5.2")).toBe(`pi --approve --model 'zai/glm-5.2' "$(cat '/tmp/p.md')"`);
});
