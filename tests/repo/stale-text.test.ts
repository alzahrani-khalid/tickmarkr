// Queue row 294 (D-2177 add.2): the wake parenthetical and the named buffering reviewer are stale.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { catalogEntries } from "../../src/adapters/catalog.js";
import { allAdapters } from "../../src/adapters/registry.js";
import { CURRENT_SNAPSHOT, SHIPPED_DIGESTS, SHIPPED_SNAPSHOTS } from "../../src/cli/shipped-skill-files.js";

const ROOT = join(import.meta.dirname, "../..");
const RUN_SKILLS = ["tickmarkr-loop", "tickmarkr-auto", "tickmarkr-overseer"] as const;
const WAKE = "On every wake read CURRENT `tickmarkr status <runId>` first, then re-arm.";
const PAREN = "(`<journal>` is `<state-dir>/runs/<runId>/journal.jsonl`, `<pid>` the lock pid).";
const SEATS_STREAM = "since claude seats stream";

const shipped = allAdapters({ operatorYaml: null });
const adapterNames = [...new Set([
  ...shipped.flatMap((adapter) => [adapter.id, adapter.hardcodedFlags?.binary ?? ""]),
  ...catalogEntries({ operatorYaml: null }).flatMap((entry) => [entry.id, entry.binary]),
].filter((name) => name.length > 0))];

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An adapter name outside the historical "seats stream" clause. The stale comment cites `claude -p`. */
function namedAdapter(comment: string): string | undefined {
  const stripped = comment.replaceAll(SEATS_STREAM, "");
  return adapterNames.find((name) => new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(name)}(?![A-Za-z0-9-])`, "i").test(stripped));
}

function bufferingComment(source: string): string {
  const at = source.indexOf("\n  paneReviewBuffersOutput?: boolean;");
  if (at < 0) throw new Error("missing paneReviewBuffersOutput");
  const lines: string[] = [];
  for (const line of source.slice(0, at).split("\n").reverse()) {
    if (!line.startsWith("  //")) break;
    lines.push(line.slice("  //".length).trimStart());
  }
  return lines.reverse().join(" ");
}

function wakeIntact(text: string): boolean {
  return text.split("\n").includes(`  ${WAKE}`) && !text.includes(PAREN) && !text.includes("<pid>` the lock pid");
}

function skillTree(root: string): Record<string, Record<string, string>> {
  const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const walk = (dir: string, prefix = ""): [string, string][] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix + entry.name;
    if (entry.isDirectory()) return walk(join(dir, entry.name), `${path}/`);
    return entry.isFile() ? [[path, digest(join(dir, entry.name))]] : [];
  });
  return Object.fromEntries(readdirSync(join(root, "skills"), { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const files = Object.fromEntries(walk(join(root, "skills", entry.name)));
    return Object.keys(files).length ? [[entry.name, files]] : [];
  }));
}

function recordedTree(): Record<string, Record<string, string>> {
  return Object.fromEntries(Object.entries(CURRENT_SNAPSHOT).map(([skill, index]) => {
    const snapshot = SHIPPED_SNAPSHOTS[skill]?.[index];
    if (!snapshot) throw new Error(`missing snapshot ${skill}[${index}]`);
    return [skill, Object.fromEntries(Object.entries(snapshot).map(([path, digest]) => {
      const hash = SHIPPED_DIGESTS[digest];
      if (hash === undefined) throw new Error(`missing digest ${digest}`);
      return [path, hash];
    }))];
  }));
}

test("test: the three shipped run skills keep the wake instruction without the journal-and-lock-pid parenthetical and the buffering-reviewer comment names no adapter, so stale text fails", () => {
  for (const skill of RUN_SKILLS) {
    const text = readFileSync(join(ROOT, "skills", skill, "SKILL.md"), "utf8");
    expect(wakeIntact(text), skill).toBe(true);
    expect(wakeIntact(`${text}\n  ${PAREN} ${WAKE}`), skill).toBe(false);
  }
  expect(wakeIntact(`  On every wake read\n  CURRENT \`tickmarkr status <runId>\` first, then re-arm.`)).toBe(false);

  const comment = bufferingComment(readFileSync(join(ROOT, "src/adapters/types.ts"), "utf8"));
  expect(comment).toContain("a CLI whose print mode buffers");
  expect(comment).toContain(`No shipped adapter declares this ${SEATS_STREAM}`);
  expect(comment).toContain("Queue row 294");
  expect(comment).not.toContain("`");
  expect(namedAdapter(comment)).toBeUndefined();
  expect(namedAdapter("(`claude -p`) has written zero seat-authored bytes until its verdict")).toBe("claude");
  for (const adapter of shipped) expect(adapter.paneReviewBuffersOutput, adapter.id).not.toBe(true);
});

test("test: the shipped-skill provenance module's current snapshot equals the digests of the shipped skill files, so a skill edited without regenerating the module fails", () => {
  const live = skillTree(ROOT);
  const recorded = recordedTree();
  expect(recorded).toEqual(live);
  for (const skill of RUN_SKILLS) expect(recorded[skill]?.["SKILL.md"]).toBe(live[skill]?.["SKILL.md"]);
  const edited = {
    ...live,
    "tickmarkr-loop": { ...live["tickmarkr-loop"], "SKILL.md": "f".repeat(64) },
  };
  expect(recorded).not.toEqual(edited);
});
