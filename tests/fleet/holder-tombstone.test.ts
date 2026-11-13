// Queue row 456 / D-2187 add.215: the one holder of src/fleet/needs.ts reads a repository null above a
// path (the loader's tombstone) as holding it, so an edit beneath it is written in the repository file.
// The contract's holder table, every cell: the holder cells directly, the command cells through the
// fleet command (fleetCommand, the CLI's own entry for `tickmarkr fleet`) with disposable user and
// repository config files. In process, not the built dist: a dist spawner joins the serialized
// built-cli set pinned in tests/cli/cli.test.ts.
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";
import { allAdapters, writeDoctor } from "../../src/adapters/registry.js";
import { fleetCommand } from "../../src/cli/commands/fleet-screen.js";
import type { AuthHealth } from "../../src/adapters/types.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { holderIn, parsedLayers } from "../../src/fleet/needs.js";
import { makeRepo } from "../helpers/tmprepo.js";

const holder = (repoText: string, userText: string) => holderIn(parsedLayers({ repoText, userText }));
const P = ["routing", "deny", "workers", "models"];
/** The user holds four entries at P (the contract's captured shape). */
const FOUR = "routing:\n  deny:\n    workers:\n      models: [codex:gpt-6-sol, codex:gpt-6-terra, claude-code:opus, claude-code:sonnet]\n";

describe("the holder beneath a tombstone", () => {
  test("a null above the path in the repository config makes the repository hold it at the parent and the grandparent", () => {
    expect(holder("", FOUR)(P)).toBe("user");
    // parent
    expect(holder("routing:\n  deny:\n    workers: null\n", FOUR)(P)).toBe("repo");
    expect(holder("routing:\n  deny: null\n", FOUR)(["routing", "deny", "models"])).toBe("repo");
    // grandparent: a walk one level up is not enough
    expect(holder("routing:\n  deny: null\n", FOUR)(P)).toBe("repo");
    expect(holder("routing: null\n", FOUR)(["routing", "deny", "models"])).toBe("repo");
    // a null AT the path is a value there, not silence
    expect(holder("routing:\n  deny:\n    workers:\n      models: null\n", FOUR)(P)).toBe("repo");
  });
  test("a null in the user config holds the path only where the repository says nothing there", () => {
    expect(holder("", "routing:\n  deny: null\n")(P)).toBe("user");
    expect(holder("{}\n", "routing:\n  deny:\n    workers: null\n")(P)).toBe("user");
    // the repository has a value there, or a tombstone of its own above it
    expect(holder("routing:\n  deny:\n    workers:\n      models: [codex:gpt-6-sol]\n", "routing:\n  deny: null\n")(P)).toBe("repo");
    expect(holder("routing:\n  deny: null\n", "routing: null\n")(P)).toBe("repo");
    // the 2.26.0 rule: both silent, repository only, both hold → repository; user only → user
    expect(holder("", "")(P)).toBe("repo");
    expect(holder(FOUR, "")(P)).toBe("repo");
    expect(holder(FOUR, FOUR)(P)).toBe("repo");
    expect(holder("", FOUR)(P)).toBe("user");
  });
  test("an empty or comment-only repository file and a null beside the path say nothing about it", () => {
    for (const repo of ["", "# nothing here\n", "\n\n", "null\n"]) expect(holder(repo, FOUR)(P)).toBe("user");
    // beside the path: a sibling null, at the leaf's level and above it
    expect(holder("routing:\n  allow: null\n", FOUR)(P)).toBe("user");
    expect(holder("routing:\n  deny:\n    adapters: null\n", FOUR)(P)).toBe("user");
    expect(holder("routing:\n  deny:\n    workers:\n      adapters: null\n", FOUR)(P)).toBe("user");
    // and a user null beside the path holds nothing either
    expect(holder("", "routing:\n  deny:\n    adapters: null\n")(P)).toBe("repo");
  });
});

function health(): Record<string, AuthHealth> {
  const out: Record<string, AuthHealth> = {};
  for (const [adapter, t] of Object.entries(DEFAULT_CONFIG.tiers)) {
    const models = Object.keys(t.models);
    out[adapter] = { installed: true, authed: true, models, modelAuth: Object.fromEntries(models.map((m) => [m, { authed: true, probedAt: new Date().toISOString() }])) };
  }
  return out;
}
const USER = `# the user's own\n${FOUR.replace("\n", "   # kept\n")}    models: [opencode:glm]\n    adapters: [opencode]\n`;
const TOMB = "# the repository's\nrouting:\n  deny: null\n";

/** One disposable user config dir; the built CLI pointed at it, never at the real user config. */
function setup() {
  const globalDir = mkdtempSync(join(tmpdir(), "tickmarkr-holder-tombstone-"));
  writeFileSync(join(globalDir, "config.yaml"), USER);
  const cli = async (at: string, argv: string[]): Promise<{ code: number; out: string }> => {
    try {
      const r = await fleetCommand([...argv, "--global-dir", globalDir], at, adapters, { input: Object.assign(new PassThrough(), { isTTY: false }) as never, output: { isTTY: false, write: () => true } });
      return typeof r === "string" ? { code: 0, out: r } : r;
    } catch (e) {
      return { code: 1, out: e instanceof Error ? e.message : String(e) };
    }
  };
  const lines = async (at: string) => {
    const r = await cli(at, ["--json"]);
    expect(r.code, r.out).toBe(0);
    const data = JSON.parse(r.out) as { ok: boolean; lines: Array<{ line: string; layer?: string; models: string[] }> };
    expect(data.ok).toBe(true);
    return Object.fromEntries(data.lines.map((l) => [l.line, l]));
  };
  return { cli, lines, user: () => readFileSync(join(globalDir, "config.yaml"), "utf8") };
}
function repoWith(text: string | undefined): string {
  const cwd = makeRepo({ "keep.txt": "x" });
  if (text !== undefined) {
    mkdirSync(join(cwd, ".tickmarkr"), { recursive: true });
    writeFileSync(join(cwd, ".tickmarkr", "config.yaml"), text);
  }
  writeDoctor(cwd, health());
  return cwd;
}
const repoFile = (cwd: string) => readFileSync(join(cwd, ".tickmarkr", "config.yaml"), "utf8");
const adapters = allAdapters({ operatorYaml: null, operatorPath: false });
const SET = ["--set", "deny.workers.models=codex:gpt-6-sol", "--save"];

describe("the fleet command beneath a repository tombstone", () => {
  test("fleet set and save beneath a repository tombstone writes the repository file which loads and leaves the user file byte-equal", async () => {
    const cwd = repoWith(TOMB);
    const { cli, lines, user } = setup();
    const before = await lines(cwd);
    // the tombstone masks every deny list the user holds here, and the hand line says the repository keeps it
    for (const l of ["deny.workers.models", "deny.models", "deny.adapters"]) expect(before[l]).toMatchObject({ models: [] });
    expect(before["deny.workers.models"].layer).toBe("repo");
    const saved = await cli(cwd, SET);
    expect(saved.code, saved.out).toBe(0);
    expect(saved.out).toContain("Saved to .tickmarkr/config.yaml.");
    expect(user()).toBe(USER);
    const repo = repoFile(cwd);
    expect(repo).toContain("# the repository's");
    expect(parse(repo).routing.deny.workers.models).toEqual(["codex:gpt-6-sol"]);
    expect(repo).not.toContain("claude-code:opus");
    // the file loads; the edit applies, and every inherited setting it does not name stays masked
    const after = await lines(cwd);
    expect(after["deny.workers.models"].models).toEqual(["codex:gpt-6-sol"]);
    expect(after["deny.models"].models).toEqual([]);
    expect(after["deny.adapters"].models).toEqual([]);
  });

  test("the control without a repository tombstone writes the user file and leaves the repository file byte-equal", async () => {
    const silent = "# the repository's\nrouting:\n  allow: null\n";
    const cwd = repoWith(silent);
    const { cli, lines, user } = setup();
    expect((await lines(cwd))["deny.workers.models"].layer).toBe("user");
    const saved = await cli(cwd, SET);
    expect(saved.code, saved.out).toBe(0);
    expect(repoFile(cwd)).toBe(silent);
    expect(parse(user()).routing.deny.workers.models).toEqual(["codex:gpt-6-sol"]);
    expect(user()).toContain("# the user's own");
  });

  test("a repository null the loader refuses is not a holder case and the save exits non-zero naming the repository file with neither file changed", async () => {
    for (const refused of ["routing: null\n", "routing:\n  floors: null\n", "tiers: null\n"]) {
      const cwd = repoWith(refused);
      const { cli, user } = setup();
      const r = await cli(cwd, SET);
      expect(r.code, `${refused}: ${r.out}`).not.toBe(0);
      expect(r.out).toContain(".tickmarkr/config.yaml");
      expect(repoFile(cwd)).toBe(refused);
      expect(user()).toBe(USER);
    }
  });

  test("in a linked worktree an edit beneath the main checkout's tombstone is written to the worktree copy and neither the main nor the user file changes", async () => {
    const main = repoWith(TOMB);
    const linked = join(main, ".claude", "worktrees", "session");
    execFileSync("git", ["worktree", "add", "--detach", linked, "HEAD"], { cwd: main, stdio: "pipe" });
    writeDoctor(linked, health());
    expect(existsSync(join(linked, ".tickmarkr", "config.yaml"))).toBe(false);
    const { cli, lines, user } = setup();
    expect((await lines(linked))["deny.workers.models"]).toMatchObject({ layer: "repo", models: [] });
    const saved = await cli(linked, SET);
    expect(saved.code, saved.out).toBe(0);
    expect(saved.out).toContain("Saved to .tickmarkr/config.yaml.");
    expect(user()).toBe(USER);
    expect(readFileSync(join(realpathSync(main), ".tickmarkr", "config.yaml"), "utf8")).toBe(TOMB);
    const copy = repoFile(linked);
    expect(copy).toContain("# the repository's");
    expect(parse(copy).routing.deny.workers.models).toEqual(["codex:gpt-6-sol"]);
    const after = await lines(linked);
    expect(after["deny.workers.models"].models).toEqual(["codex:gpt-6-sol"]);
    expect(after["deny.models"].models).toEqual([]);
    expect(after["deny.adapters"].models).toEqual([]);
  });
});
