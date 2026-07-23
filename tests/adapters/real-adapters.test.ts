import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { claudeCode } from "../../src/adapters/claude-code.js";
import { codex, codexMcpSuppressionFlags } from "../../src/adapters/codex.js";
import { cursorAgent } from "../../src/adapters/cursor-agent.js";
import { grok } from "../../src/adapters/grok.js";
import { kimi } from "../../src/adapters/kimi.js";
import { opencode } from "../../src/adapters/opencode.js";
import { pi } from "../../src/adapters/pi.js";
import { parseWorkerResult } from "../../src/adapters/prompt.js";
import { QUOTA_RE } from "../../src/adapters/types.js";
import { allAdapters, discoverChannels, getAdapter, readDoctor, writeDoctor } from "../../src/adapters/registry.js";
import { validateGraph } from "../../src/graph/schema.js";
import { authedModels } from "../helpers/tmprepo.js";

const REAL = [claudeCode, codex, cursorAgent, opencode, pi, grok, kimi];

const task = validateGraph({
  version: 1, spec: { source: "prd", paths: ["p"], hash: "h" },
  tasks: [{ id: "T1", title: "t", goal: "g", shape: "implement", complexity: 3, acceptance: ["a"] }],
}).tasks[0];

describe("real adapters", () => {
  test("ids/vendors match the seed tier table", () => {
    for (const a of REAL) expect(DEFAULT_CONFIG.tiers[a.id].vendor).toBe(a.vendor);
  });

  test("headless commands embed prompt file and model; invoke delegates", () => {
    const a = { model: "x", channel: "sub" as const, tier: "mid" as const };
    expect(claudeCode.headlessCommand("/tmp/p.md", "fable")).toContain(`"$(cat '/tmp/p.md')"`);
    expect(claudeCode.headlessCommand("/tmp/p.md", "fable")).toContain("--model 'fable'");
    // HYG-01: fresh-worktree headless workers/gates must never park on the MCP-enable dialog.
    // Value must be '{"mcpServers":{}}' — bare '{}' is rejected by claude 2.1.205
    // ("mcpServers: Invalid input: expected record") — live check 2026-07-10.
    expect(claudeCode.headlessCommand("/tmp/p.md", "fable")).toContain("--strict-mcp-config");
    expect(claudeCode.headlessCommand("/tmp/p.md", "fable")).toContain(`--mcp-config '{"mcpServers":{}}'`);
    // --mcp-config is VARIADIC: a positional directly after it is eaten as a config-file path
    // (live check 2026-07-10: it consumed the prompt). Token after the value must be another flag.
    expect(claudeCode.headlessCommand("/tmp/p.md", "fable")).toMatch(/--mcp-config '\{"mcpServers":\{\}\}' --/);
    // OBS-21: command changes are pinned here with the headless/interactive catalog.
    expect(claudeCode.resumeCommand!("prior-session", "/tmp/p.md", "fable")).toContain("claude -r 'prior-session'");
    // OBS-26: claude workers are autonomous — bypassPermissions everywhere, acceptEdits nowhere
    // (acceptEdits only auto-approves edits; an unlisted Bash pattern silently stalls an unattended worker).
    const claudeHeadless = claudeCode.headlessCommand("/tmp/p.md", "fable");
    const claudeInteractive = claudeCode.interactiveCommand("/tmp/p.md", "fable") as string;
    const claudeResume = claudeCode.resumeCommand!("prior-session", "/tmp/p.md", "fable") as string;
    for (const c of [claudeHeadless, claudeInteractive, claudeResume]) {
      expect(c).toContain("--permission-mode bypassPermissions");
      expect(c).not.toContain("acceptEdits");
    }
    // codex v0.144.1: --sandbox workspace-write replaces deprecated --full-auto
    const cxHeadless = codex.headlessCommand("/p", "gpt-5.2");
    expect(cxHeadless).toContain("--sandbox workspace-write");
    // OBS-24/OBS-82: MCP suppressed in BOTH modes — a down operator-global MCP server wedges codex
    // startup. codex ≥0.144 merges the empty table (no-op), so plugin loading is disabled and every
    // config-named server gets a per-name override too (see codex-mcp-suppress.test.ts).
    expect(cxHeadless).toContain(`-c 'mcp_servers={}'`);
    expect(cxHeadless).toContain("--disable plugins");
    expect(codex.interactiveCommand("/p", "gpt-5.2")).toContain(`-c 'mcp_servers={}'`);
    expect(codex.interactiveCommand("/p", "gpt-5.2")).toContain("--disable plugins");
    expect(cxHeadless).toContain('sandbox_workspace_write.writable_roots=[\\"$(git rev-parse --path-format=absolute --git-common-dir)\\"]');
    expect(cxHeadless).not.toContain("--full-auto");
    // OBS-125: codex 0.144.x per-worktree "Hooks need review" gate — bypass hook trust so the operator's
    // own trusted hooks run without stalling; the workspace-write sandbox stays (NOT the sandbox bypass).
    expect(cxHeadless).toContain("--dangerously-bypass-hook-trust");
    expect(cxHeadless).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cursorAgent.headlessCommand("/p", "composer-2")).toContain("--force");
    expect(opencode.headlessCommand("/p", "moonshotai/kimi-k2")).toMatch(/^opencode run -m/);
    // FLEET-01/02: pi headless — `pi -p ` prefix, model under shq, prompt via cat
    expect(pi.headlessCommand("/tmp/p.md", "zai/glm-5.2")).toContain(`"$(cat '/tmp/p.md')"`);
    expect(pi.headlessCommand("/tmp/p.md", "zai/glm-5.2")).toContain("--model 'zai/glm-5.2'");
    expect(pi.headlessCommand("/p", "m")).toMatch(/^pi -p /);
    // FLEET-02: --approve is a global option per pi --help v0.80.3 — unlike cursor's print-only --trust, legal in BOTH modes
    expect(pi.headlessCommand("/p", "m")).toContain("--approve");
    expect(pi.vendor).toBe("zhipu");
    for (const ad of REAL) {
      expect(ad.invoke(task, "/w", { ...a, adapter: ad.id }, { promptFile: "/p" }).command).toBe(
        ad.headlessCommand("/p", "x"),
      );
    }
  });

  test("v1.2 interactive commands: real TUI with initial prompt, verified flags, never print mode", () => {
    const c = claudeCode.interactiveCommand("/tmp/p.md", "fable") as string;
    expect(c).toContain(`"$(cat '/tmp/p.md')"`);
    expect(c).toContain("--model 'fable'");
    expect(c).toContain("--permission-mode bypassPermissions");
    // HYG-01: interactive TUI carries the same pinning (2.1.205 still shows the project MCP-enable
    // dialog interactively — trust/enablement, not config loading; Esc dismisses, paging surfaces it)
    expect(c).toContain("--strict-mcp-config");
    expect(c).toContain(`--mcp-config '{"mcpServers":{}}'`);
    // variadic --mcp-config regression guard: never the positional prompt directly after the value
    expect(c).toMatch(/--mcp-config '\{"mcpServers":\{\}\}' --/);
    expect(c).not.toMatch(/\s-p\s|--print/);
    const cu = cursorAgent.interactiveCommand("/p", "composer-2") as string;
    expect(cu).toContain("--force");
    expect(cu).not.toContain("--trust"); // print-only flag: interactive cursor exits 1 with it (v1.4 incident)
    expect(cu).not.toMatch(/\s-p\s|--print/);
    // codex TUI has no --full-auto (exec-only); its interactive equivalent is the expanded pair
    const cx = codex.interactiveCommand("/p", "gpt-5.2") as string;
    expect(cx).toMatch(/^codex (?!exec)/);
    // `on-failure` is not a valid codex approval policy (untrusted|on-request|never) —
    // it made every interactive codex dispatch exit 2 pre-inference (2026-07-09 incident)
    expect(cx).toContain("-a never");
    expect(cx).not.toContain("on-failure");
    expect(cx).toContain("-s workspace-write");
    // OBS-125: the interactive worker (the mode that stalled at the hooks gate) carries the hook-trust
    // bypass so it reasons past "Hooks need review"; sandbox kept (NOT --dangerously-bypass-approvals-and-sandbox).
    expect(cx).toContain("--dangerously-bypass-hook-trust");
    expect(cx).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    // worktree gitdirs live under the main repo's .git/worktrees — outside the sandbox root —
    // so both codex commands must whitelist the git common dir or every commit dies on index.lock
    expect(cx).toContain('sandbox_workspace_write.writable_roots=[\\"$(git rev-parse --path-format=absolute --git-common-dir)\\"]');
    const cxh = codex.headlessCommand("/p", "gpt-5.2") as string;
    expect(cxh).toContain("sandbox_workspace_write.writable_roots");
    const oc = opencode.interactiveCommand("/p", "m/k") as string;
    expect(oc).toMatch(/^opencode (?!run)/);
    expect(oc).toContain("--prompt");
    expect(oc).toContain("-m 'm/k'");
    // FLEET-02: pi interactive carries --approve (global option per pi --help v0.80.3 — unlike cursor's print-only --trust)
    // and the positional initial prompt, never print mode
    const pit = pi.interactiveCommand("/p", "m") as string;
    expect(pit).toContain("--approve");
    expect(pit).toContain(`"$(cat '/p')"`);
    expect(pit).not.toMatch(/\s-p\s|--print/);
    expect(pi.parse).toBe(parseWorkerResult);
    expect(pi.invoke(task, "/w", { model: "m", channel: "sub", tier: "mid", adapter: "pi" }, { promptFile: "/p" }).command).toBe(
      pi.headlessCommand("/p", "m"),
    );
  });

  test("kimi declares an interactiveSeed launch-then-seed capability", () => {
    expect(kimi.interactiveSeed).toBeDefined();
    expect(kimi.interactiveCommand("/tmp/p.md", "kimi-code/k3")).toBeNull();
    const launch = kimi.interactiveSeed!.launch("kimi-code/k3");
    expect(launch).toContain("kimi -y");
    expect(launch).toContain("-m");
    expect(launch).toContain("k3");
    expect(kimi.interactiveSeed!.readinessMatch).toBe("Send /help for help information.");
    const seed = kimi.interactiveSeed!.seedLine("/tmp/p.md");
    expect(seed).toContain("/tmp/p.md");
    expect(seed).toContain("do exactly what it says");
  });

  test("QUOTA_RE matches the ZAI coding-plan exhaustion text, not unrelated failures", () => {
    // research Pitfall 3: ZAI surfaces "Insufficient balance…", which "insufficient credit" missed
    expect(QUOTA_RE.test("Insufficient balance or no resource package. Please recharge.")).toBe(true);
    expect(QUOTA_RE.test("build failed")).toBe(false);
    // WR-01: the bare two-word fragment appears in ordinary billing/wallet task output the harness
    // edits — it must NOT read as quota exhaustion (would silently fail over an eligible channel).
    expect(QUOTA_RE.test("if (wallet.balance < amount) throw new Error('insufficient balance')")).toBe(false);
  });

  test("channels come from cfg.tiers; probe of a nonexistent binary reports uninstalled", async () => {
    expect(claudeCode.channels(DEFAULT_CONFIG).map((c) => c.model)).toContain("fable");
    const fakeCli = { ...codex, id: "codex" }; // probe uses real binary lookup
    const health = await fakeCli.probe();
    expect(typeof health.installed).toBe("boolean"); // machine-dependent; just shape-check
    expect(health.models).toBeInstanceOf(Array);
  });
});

// OBS-82 live surface: `codex mcp list` is a pure config listing — no server launched, no model
// call, zero tokens (verified 2026-07-18, codex-cli 0.144.5: returns instantly, spends nothing).
// The hermetic pins in codex-mcp-suppress.test.ts only prove flag-string construction; this test
// proves the SHIPPED flag set actually suppresses on the real surface. Skipped where codex is
// not installed (CI, fresh machines) — the operator machine and doctor sweeps keep it honest.
const codexInstalled = spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0;

describe("codex mcp suppression — live surface (OBS-82)", () => {
  test.skipIf(!codexInstalled)("LIVE: shipped flag set produces zero enabled servers on the real codex mcp list surface", () => {
    // same builder both worker commands interpolate, against the real $CODEX_HOME/config.toml
    const out = execSync(`codex mcp list ${codexMcpSuppressionFlags()} --json`, {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const raw = JSON.parse(out) as unknown;
    const servers = (
      Array.isArray(raw)
        ? raw
        : ((raw as { servers?: unknown[] }).servers ??
            Object.entries(raw as Record<string, object>).map(([name, v]) => ({ name, ...v })))
    ) as { name?: string; enabled?: boolean }[];
    // project to {name, enabled} BEFORE asserting: full entries can carry operator env values
    // (secret hygiene — a failure dump must never echo config secrets)
    const view = servers.map((s) => ({ name: s.name, enabled: s.enabled === true }));
    expect(view.filter((s) => s.enabled)).toEqual([]);
  });
});

describe("registry + doctor", () => {
  test("getAdapter throws on unknown; fake only present when scripted", () => {
    // deliberate order assertion — pi+grok registered LAST so the Phase 6 matrix stays byte-identical
    expect(allAdapters().map((a) => a.id)).toEqual(["claude-code", "codex", "cursor-agent", "opencode", "pi", "grok", "kimi"]);
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-reg-"));
    const sp = join(dir, "s.json");
    writeFileSync(sp, JSON.stringify({ tasks: {} }));
    expect(allAdapters({ fakeScriptPath: sp }).map((a) => a.id)).toContain("fake");
    expect(() => getAdapter("gemini", allAdapters())).toThrow(/unknown adapter/i);
  });

  test("doctor round-trip and channel discovery gated on health", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-doc-"));
    const health = {
      "claude-code": { installed: true, authed: true, models: [], modelAuth: authedModels(Object.keys(DEFAULT_CONFIG.tiers["claude-code"].models)) },
      codex: { installed: false, authed: false, models: [] },
      "cursor-agent": { installed: true, authed: true, models: [], modelAuth: authedModels(Object.keys(DEFAULT_CONFIG.tiers["cursor-agent"].models)) },
      opencode: { installed: true, authed: true, models: [], modelAuth: authedModels(Object.keys(DEFAULT_CONFIG.tiers.opencode.models)) },
    };
    writeDoctor(repo, health);
    expect(readDoctor(repo)!["codex"].installed).toBe(false);
    const chans = discoverChannels(DEFAULT_CONFIG, allAdapters(), health);
    expect(chans.some((c) => c.adapter === "claude-code")).toBe(true);
    expect(chans.some((c) => c.adapter === "codex")).toBe(false); // not installed → no channels
  });
});
