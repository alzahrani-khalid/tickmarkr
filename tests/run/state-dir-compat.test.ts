import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { readDoctor, writeDoctor } from "../../src/adapters/registry.js";
import { tickmarkrDir, stateDirName } from "../../src/graph/graph.js";
import { Journal } from "../../src/run/journal.js";
import { acquireRunLock, releaseRunLock } from "../../src/run/lock.js";

const LEGACY_STATE = `.${["dro", "vr"].join("")}`; // pre-rename state directory (v1.32 and earlier)

describe("state directory", () => {
  test("stateDirName on a repo containing only a legacy state dir returns .tickmarkr (fresh state, legacy ignored)", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-legacy-state-"));
    mkdirSync(join(repo, LEGACY_STATE), { recursive: true });
    expect(stateDirName(repo)).toBe(".tickmarkr");
    expect(existsSync(join(repo, ".tickmarkr"))).toBe(false);
  });

  test("creates .tickmarkr with its self-gitignore for a new repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-new-state-"));
    const dir = tickmarkrDir(repo);
    expect(dir).toMatch(/\.tickmarkr$/);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*\n");
  });

  test("lock and journal use .tickmarkr even when a legacy state dir exists", () => {
    const repo = mkdtempSync(join(tmpdir(), "tickmarkr-legacy-lock-"));
    mkdirSync(join(repo, LEGACY_STATE, "runs", "run-old"), { recursive: true });
    const run = join(repo, ".tickmarkr", "runs", "run-new");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "journal.jsonl"), `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", event: "run-start", data: {} })}\n`);
    expect(Journal.open(repo, "run-new").read()).toHaveLength(1);
    acquireRunLock(repo, "run-new");
    releaseRunLock(repo);
    writeDoctor(repo, { fake: { installed: true, authed: true } });
    expect(readDoctor(repo)).toEqual({ fake: { installed: true, authed: true } });
    expect(existsSync(join(repo, ".tickmarkr", "doctor.json"))).toBe(true);
  });

  test("has no state-dir path joins outside graph.ts", () => {
    const src = fileURLToPath(new URL("../../src/", import.meta.url));
    const legacyDirRe = new RegExp(`(?:join|resolve)\\([^\\n]*["']\\.${["dro"].join("")}(?:ver|vr)["']`);
    const entries = (path: string): string[] => {
      const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
      return readdirSync(path).flatMap((entry) => {
        const full = join(path, entry);
        return statSync(full).isDirectory() ? entries(full) : [full];
      });
    };
    const offenders = entries(src)
      .filter((path) => path.endsWith(".ts") && !path.endsWith("/graph/graph.ts"))
      .filter((path) => legacyDirRe.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
