import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { init, skillDrift } from "../src/cli/commands/init.js";
import { version } from "../src/cli/commands/version.js";
import { dispatch } from "../src/cli/index.js";
import { writeDoctor } from "../src/adapters/registry.js";
import { hostViolations, skillCorpus, skillReading } from "./helpers/skill-reading.js";

const source = join(import.meta.dirname, "../skills/tickmarkr-overseer");
const heading = "## References — read each one before the step it names\n";
// Queue row 242; D-2141, D-2152: hashes of the deleted sections BEFORE the four path substitutions.
const sections = [
  ["pane-mechanics.md", "## Pane mechanics that bite", "a1f52460298f210c2571045af0d07c7939df7e8dbd67cc18889f7afb4cf39fc3"],
  // Queue row 242; D-2141, D-2152: after removing only the 34-line mixed-tree law.
  // Before that cut: 6cd55b5cf933afa9b90ca46f277b3a707176372ca2d42e31d2cc2b0cfa41c71c.
  ["watchers.md", "## Supervision watcher", "7af00694f3aacb2f40b674f30863a5b791a98ceacf3b4b73dcce0509c444fa62"],
  ["specialist-pipeline.md", "## Specialist pipeline rules", "fe9299cd69e4c02c60c34585772b479b9be4f201c137985ab75557c93d939d9b"],
  ["security-briefing.md", "## Briefing a seat to audit a security-shaped check — phrasing matters", "2f93beee243b722bfc3e8a5b0f3ef1141e13d425ac1b52103209b8b4d233d4fa"],
] as const;
// Queue row 242; D-2141, D-2152: fingerprint the deleted rules and the retained durable core before moving bytes.
const evidenceFile = "evidence-discipline.md";
const evidenceHash = "cd0a5671e3f0d796f7041f6002ff9adb292a458b3bc9749782413bd5acba8edf";
const durableHeading = "## Evidence discipline — the durable core\n";
const durableHash = "59d9f5b84e804b0307ec88266603663ff3b0fb7d9d47989420981c7b5758859d";
const evidenceBullet = "- Read [evidence discipline](references/evidence-discipline.md) before writing or inheriting a queue, handoff, finding or instrument.";
// Queue row 242; D-2141, D-2152: deleted section bytes, including the trailing blank line, before the five path substitutions.
const supervisionSections = [
  ["release-proof.md", "#### The release criterion, and the two clauses without which it grades work it never saw", "affd1d8cd84787630dd59b9b656d2199fcbc9539140d01f5491230025e60b80f", 1],
  ["context-supervision.md", "### Context is a supervised resource, for BOTH tiers (host-specific)", "b02c0bb25c5203049ebf4aea2d51159f75bf127c000567455c47c22fd1c969a1", 4],
] as const;
const releaseBullet = "- Read [release proof](references/release-proof.md) before ruling a release green or grading a verdict produced under load.";
const contextBullet = "- Read [context supervision](references/context-supervision.md) before every GO and before a mutual clear.";
const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function consumer(claude: boolean, env?: NodeJS.ProcessEnv) {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-references-"));
  scratchDirs.push(root);
  const repo = join(root, "consumer");
  mkdirSync(repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "scratch-consumer", version: "0.0.0" }));
  if (claude) mkdirSync(join(repo, ".claude"));
  // A fresh fake-only discovery snapshot makes init reuse it without probing any adapter.
  writeDoctor(repo, { fake: { installed: true, authed: true, models: [] } });
  await init(["--agent", "--docs", "--global-dir", join(root, "global")], repo, { env });
  return repo;
}

const check = (repo: string) => dispatch("version", ["--check"], {
  version: argv => version(argv, undefined, repo),
});

// Queue row 242; D-2141, D-2152: the cockpit body is the original 104 lines, each newline retained.
const cockpitHash = "92e7c27db6c39de2023dc94e83135b8e0f75dd227f665c8f02524051cf30d747";
const cockpitHeading = "## Cockpit, parked decisions and printed twins\n";
const cockpitPointer = "Read [the cockpit walkthrough](references/cockpit.md) before operating the cockpit, deciding a park or reading a printed twin.";

function assertCockpitPointer(dir: string, skill = readFileSync(join(dir, "SKILL.md"), "utf8")) {
  expect(skill.split(cockpitHeading)).toHaveLength(2);
  const section = skill.split(cockpitHeading)[1].split(/\n## /)[0].trim();
  expect(section).toBe(cockpitPointer);
  const reference = join(dir, "references/cockpit.md");
  expect(existsSync(reference), reference).toBe(true);
  expect(digest(readFileSync(reference, "utf8")), reference).toBe(cockpitHash);
  for (const host of ["herdr", "orca", "plain"] as const) {
    expect(skillReading(skill, host), host).toContain(cockpitPointer);
  }
}

function assertCockpitRoute(file: string, text = readFileSync(file, "utf8")) {
  const links = [...text.matchAll(/\[[^\]\n]+\]\(([^)\n]+)#cockpit-parked-decisions-and-printed-twins\)/g)];
  expect(links, file).toHaveLength(1);
  const target = join(dirname(file), links[0][1]);
  expect(existsSync(target), target).toBe(true);
  assertCockpitPointer(dirname(target));
}

test("test: an agent init into a scratch consumer installs the loop's cockpit reference beside its skill file at every host location, the loop skill keeps its cockpit heading naming that reference so the auto, overseer and architecture-page links still resolve to it, and version check names the reference missing once it is deleted, so a move that strands the cockpit links or leaves the reference uninstalled fails", async () => {
  const repo = await consumer(true);
  const loopSource = join(dirname(source), "tickmarkr-loop");
  const packaged = readFileSync(join(loopSource, "references/cockpit.md"));
  expect(packaged.byteLength).toBe(8879);
  expect(packaged.toString("utf8").split("\n")).toHaveLength(105);
  assertCockpitPointer(loopSource);
  for (const host of [".agents", ".claude"]) {
    const skillsDir = join(repo, host, "skills");
    const dir = join(skillsDir, "tickmarkr-loop");
    const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
    const reference = join(dir, "references/cockpit.md");
    expect(readFileSync(reference), host).toEqual(packaged);
    expect(readFileSync(join(dir, "SKILL.md"))).toEqual(readFileSync(join(loopSource, "SKILL.md")));
    assertCockpitPointer(dir);
    for (const name of ["auto", "overseer"]) assertCockpitRoute(join(skillsDir, `tickmarkr-${name}/SKILL.md`));
    expect(skillDrift(repo)).toEqual([]);
    expect(await check(repo)).toMatchObject({ code: 0, out: expect.stringContaining("installed guidance matches") });
    for (const mutated of [
      skill.replace(cockpitHeading, "## Cockpit\n"),
      skill.replace(cockpitPointer, ""),
      skill.replace("(references/cockpit.md)", "(references/missing.md)"),
      skill.replace("before operating the cockpit, deciding a park or reading a printed twin.", ""),
    ]) expect(() => assertCockpitPointer(dir, mutated)).toThrow();
    const auto = join(skillsDir, "tickmarkr-auto/SKILL.md");
    expect(() => assertCockpitRoute(auto, readFileSync(auto, "utf8").replace("../tickmarkr-loop/SKILL.md#", "../missing/SKILL.md#"))).toThrow();
    unlinkSync(reference);
    expect(() => assertCockpitRoute(auto)).toThrow();
    expect(await check(repo)).toMatchObject({ code: 1, out: expect.stringContaining(`missing ${host}/skills/tickmarkr-loop/references/cockpit.md`) });
    expect(skillDrift(repo)).toContainEqual(expect.objectContaining({ dir, missing: ["references/cockpit.md"], modified: [] }));
    writeFileSync(reference, packaged);
  }
  // Docs are intentionally absent from the public export; validate this route wherever it ships.
  const architecture = join(import.meta.dirname, "../docs/codebase/ARCHITECTURE.md");
  if (existsSync(architecture)) assertCockpitRoute(architecture);
  expect(await check(repo)).toMatchObject({ code: 0, out: expect.stringContaining("installed guidance matches") });
});

test("test: an agent init into a scratch consumer installs the pane mechanics, watcher, specialist pipeline and security briefing references beside the overseer skill file at every host location byte for byte, and version check reads that install current while the same install with one reference deleted is reported missing by name with a non-zero exit, so a split whose references init leaves behind or version check cannot see fails", async () => {
  const repo = await consumer(true);
  expect(skillDrift(repo)).toEqual([]);
  expect(await check(repo)).toMatchObject({ code: 0, out: expect.stringContaining("installed guidance matches") });
  for (const host of [".agents", ".claude"]) {
    const installed = join(repo, host, "skills/tickmarkr-overseer");
    expect(readFileSync(join(installed, "SKILL.md"))).toEqual(readFileSync(join(source, "SKILL.md")));
    for (const [file] of sections) {
      const path = join(installed, "references", file);
      const packaged = readFileSync(join(source, "references", file));
      expect(readFileSync(path), `${host}/${file}`).toEqual(packaged);
      unlinkSync(path);
      const missing = `${host}/skills/tickmarkr-overseer/references/${file}`;
      expect(await check(repo)).toMatchObject({ code: 1, out: expect.stringContaining(`missing ${missing}`) });
      expect(skillDrift(repo)).toContainEqual(expect.objectContaining({ dir: installed, missing: [`references/${file}`], modified: [] }));
      writeFileSync(path, packaged);
    }
  }
  expect(await check(repo)).toMatchObject({ code: 0, out: expect.stringContaining("installed guidance matches") });
});

test("test: an agent init into a scratch consumer installs the evidence-discipline reference beside the overseer skill file at every host location byte for byte and version check reads it current until it is deleted, when it names it missing with a non-zero exit, so rules init leaves behind fail", async () => {
  const repo = await consumer(true);
  const packaged = readFileSync(join(source, "references", evidenceFile));
  assertEvidence(packaged.toString("utf8"));
  for (const host of [".agents", ".claude"]) {
    const installed = join(repo, host, "skills/tickmarkr-overseer");
    const path = join(installed, "references", evidenceFile);
    expect(readFileSync(join(installed, "SKILL.md"))).toEqual(readFileSync(join(source, "SKILL.md")));
    expect(readFileSync(path), host).toEqual(packaged);
    expect(skillDrift(repo)).toEqual([]);
    expect(await check(repo)).toMatchObject({ code: 0, out: expect.stringContaining("installed guidance matches") });
    unlinkSync(path);
    expect(await check(repo)).toMatchObject({ code: 1, out: expect.stringContaining(`missing ${host}/skills/tickmarkr-overseer/references/${evidenceFile}`) });
    expect(skillDrift(repo)).toContainEqual(expect.objectContaining({ dir: installed, missing: [`references/${evidenceFile}`], modified: [] }));
    writeFileSync(path, packaged);
    expect(await check(repo)).toMatchObject({ code: 0, out: expect.stringContaining("installed guidance matches") });
  }
  expect(skillDrift(repo)).toEqual([]);
});

test("test: an agent init into a scratch consumer installs the release-proof and context-supervision references beside the overseer skill file at every host location byte for byte and version check reads them current until one is deleted, when it names it missing with a non-zero exit, so a split init leaves behind fails", async () => {
  const repo = await consumer(true);
  expect(skillDrift(repo)).toEqual([]);
  expect(await check(repo)).toMatchObject({ code: 0, out: expect.stringContaining("installed guidance matches") });
  for (const host of [".agents", ".claude"]) {
    const installed = join(repo, host, "skills/tickmarkr-overseer");
    expect(readFileSync(join(installed, "SKILL.md"))).toEqual(readFileSync(join(source, "SKILL.md")));
    for (const [file] of supervisionSections) {
      const packaged = readFileSync(join(source, "references", file));
      assertSupervisionSection(file, packaged.toString("utf8"));
      const path = join(installed, "references", file);
      expect(readFileSync(path), `${host}/${file}`).toEqual(packaged);
      unlinkSync(path);
      expect(await check(repo)).toMatchObject({ code: 1, out: expect.stringContaining(`missing ${host}/skills/tickmarkr-overseer/references/${file}`) });
      expect(skillDrift(repo)).toContainEqual(expect.objectContaining({ dir: installed, missing: [`references/${file}`], modified: [] }));
      writeFileSync(path, packaged);
      expect(await check(repo)).toMatchObject({ code: 0, out: expect.stringContaining("installed guidance matches") });
    }
  }
  expect(skillDrift(repo)).toEqual([]);
});

function assertLinks(skill: string, dir: string) {
  expect(skill.split(heading)).toHaveLength(2);
  const start = skill.indexOf(heading);
  const end = skill.indexOf("\n## ", start + heading.length);
  expect(start).toBeLessThan(skill.indexOf("## Hand-made checkout law"));
  expect(end).toBeGreaterThan(start);
  const index = skill.slice(start, end);
  expect(index).toContain("`<skill-dir>` is this skill's directory relative to the repository root (`.agents/skills/tickmarkr-overseer` or `.claude/skills/tickmarkr-overseer`).");
  const files = readdirSync(join(dir, "references")).filter(file => file.endsWith(".md") && statSync(join(dir, "references", file)).isFile()).sort();
  const links = (text: string) => [...text.matchAll(/\[[^\]\n]+\]\((references\/[^)\n]+)\)/g)].map(match => match[1]);
  const expected = files.map(file => `references/${file}`);
  expect(links(skill).sort()).toEqual(expected);
  expect(links(index).sort()).toEqual(expected);
  const bullets = index.split("\n").filter(line => /^- /.test(line));
  expect(bullets).toHaveLength(files.length);
  for (const bullet of bullets) {
    expect(bullet).toMatch(/^- Read \[[^\]]+\]\(references\/[^)]+\) before .+\.$/);
    for (const host of ["herdr", "orca", "plain"] as const) expect(skillReading(skill, host), host).toContain(bullet);
  }
  for (const target of links(index)) expect(existsSync(join(dir, target)), target).toBe(true);
}

test("test: the overseer skill links every file in its references folder exactly once, in one section every host reading follows, with the step before which it is read, and every named reference exists, so a reference no line links, a pointer inside one host's scope or a pointer to a missing file fails", async () => {
  const repo = await consumer(false);
  const dir = join(repo, ".agents/skills/tickmarkr-overseer");
  const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
  assertLinks(skill, dir);
  const bullet = skill.split("\n").find(line => line.startsWith("- Read [pane mechanics]"))!;
  for (const mutated of [
    skill.replace(bullet, ""),
    skill.replace(bullet, `${bullet}\n${bullet}`),
    skill.replace(heading, `${heading}\n### On herdr\n`),
    skill.replace("references/pane-mechanics.md)", "references/missing.md)"),
    skill.replace("before briefing or sending input to a seat.", ""),
  ]) expect(() => assertLinks(mutated, dir)).toThrow();
  const orphan = join(dir, "references/orphan.md");
  writeFileSync(orphan, "unlinked reference\n");
  expect(() => assertLinks(skill, dir)).toThrow();
  unlinkSync(orphan);
  unlinkSync(join(dir, "references/pane-mechanics.md"));
  expect(() => assertLinks(skill, dir)).toThrow();
});

function assertScripts(dir: string, text: string) {
  // Script instructions must use the selected install rather than a claude-only script path.
  expect(text).not.toMatch(/\.claude\/skills\/[^\s`]+\/scripts\//);
  // Source-tree and skill-relative script names identify the same bundled file at the chosen install.
  const names = [...text.matchAll(/(?:<skill-dir>\/|skills\/tickmarkr-overseer\/)?scripts\/([\w-]+\.sh)\b/g)].map(match => match[1]);
  for (const name of names) expect(statSync(join(dir, "scripts", name)).isFile(), name).toBe(true);
  return names;
}

test("test: every bundled script an overseer reference names resolves to a file of an agent install written only into the codex skills directory, so a reference still naming the claude skills directory fails", async () => {
  const repo = await consumer(false, {});
  expect(existsSync(join(repo, ".claude"))).toBe(false);
  const dir = join(repo, ".agents/skills/tickmarkr-overseer");
  const names = new Set<string>();
  for (const file of readdirSync(join(dir, "references")).filter(file => file.endsWith(".md"))) {
    const text = readFileSync(join(dir, "references", file), "utf8");
    for (const name of assertScripts(dir, text)) names.add(name);
    expect(() => assertScripts(dir, `${text}\n.claude/skills/tickmarkr-overseer/scripts/watch-panes.sh`)).toThrow();
  }
  expect([...names].sort()).toEqual(["context-statusline.sh", "seat-send.sh", "watch-artifacts.sh", "watch-contamination.sh", "watch-context.sh", "watch-launch.sh", "watch-panes.sh", "watch-pending-input.sh"]);
  assertScripts(dir, readFileSync(join(dir, "SKILL.md"), "utf8"));
  expect(() => assertScripts(dir, "<skill-dir>/scripts/missing.sh")).toThrow();
});

function assertBundledScripts(skillsDir: string, skill: string, text: string): string[] {
  expect(text).not.toMatch(/\.claude\/skills\/[^\s`]+\/scripts\//);
  const found: string[] = [];
  // Resolve sibling-skill and skill-local paths against the selected host's installation.
  const remaining = text.replace(/(?:(?:<skills-dir>\/|(?:\.agents\/)?skills\/)(tickmarkr-[\w-]+)\/|<skill-dir>\/)?scripts\/([\w-]+\.sh)\b/g, (_match, owner: string | undefined, name: string) => {
    const path = join(owner ?? skill, "scripts", name);
    expect(existsSync(join(skillsDir, path)), path).toBe(true);
    expect(statSync(join(skillsDir, path)).isFile(), path).toBe(true);
    found.push(path);
    return "";
  });
  // Bare script names in prose still name bundled files; source-only scripts are not bundled.
  const scriptOwners = readdirSync(dirname(source)).flatMap(owner => {
    const scripts = join(dirname(source), owner, "scripts");
    return existsSync(scripts) ? readdirSync(scripts).filter(name => name.endsWith(".sh")).map(name => ({ owner, name })) : [];
  });
  for (const match of remaining.matchAll(/\b([\w-]+\.sh)\b/g)) {
    for (const { owner, name } of scriptOwners.filter(script => script.name === match[1])) {
      const path = join(owner, "scripts", name);
      expect(existsSync(join(skillsDir, path)), path).toBe(true);
      expect(statSync(join(skillsDir, path)).isFile(), path).toBe(true);
      found.push(path);
    }
  }
  return found;
}

test("test: every bundled script any shipped skill file or reference names resolves to a file of an agent install written only into the codex skills directory, so the loop or auto run watcher still naming the claude skills directory fails", async () => {
  const repo = await consumer(false, {});
  expect(existsSync(join(repo, ".claude"))).toBe(false);
  const skillsDir = join(repo, ".agents/skills");
  const found = new Set<string>();
  for (const skill of readdirSync(skillsDir)) {
    const dir = join(skillsDir, skill);
    const references = join(dir, "references");
    const files = ["SKILL.md", ...(existsSync(references) ? readdirSync(references).filter(file => file.endsWith(".md")).map(file => join("references", file)) : [])];
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const path of assertBundledScripts(skillsDir, skill, text)) found.add(path);
      expect(() => assertBundledScripts(skillsDir, skill, `${text}\n.claude/skills/tickmarkr-overseer/scripts/watch-journal.sh`)).toThrow();
      if (skill !== "tickmarkr-overseer" && file === "SKILL.md") {
        expect(text).toContain("`<skills-dir>` is the skills directory holding this skill.");
        expect(text).toContain("<skills-dir>/tickmarkr-overseer/scripts/watch-journal.sh");
        expect(() => assertBundledScripts(skillsDir, skill, text.replaceAll("<skills-dir>", ".claude/skills"))).toThrow();
      }
    }
  }
  expect([...found].sort()).toEqual(readdirSync(join(source, "scripts")).filter(file => file.endsWith(".sh")).sort()
    .map(file => `tickmarkr-overseer/scripts/${file}`));
  expect(() => assertBundledScripts(skillsDir, "tickmarkr-loop", "<skills-dir>/tickmarkr-overseer/scripts/missing.sh")).toThrow();
  const watcher = join(skillsDir, "tickmarkr-overseer/scripts/watch-journal.sh");
  unlinkSync(watcher);
  expect(() => assertBundledScripts(skillsDir, "tickmarkr-loop", "<skills-dir>/tickmarkr-overseer/scripts/watch-journal.sh")).toThrow(/watch-journal\.sh/);
});

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function assertSupervisionSection(file: typeof supervisionSections[number][0], text: string) {
  const [, title, hash, substitutions] = supervisionSections.find(section => section[0] === file)!;
  expect(text.startsWith(`${title}\n\n`), file).toBe(true);
  expect(text.endsWith("\n\n"), file).toBe(true);
  expect(text.split("<skill-dir>/scripts/").length - 1, file).toBe(substitutions);
  expect(text).not.toContain(".claude/skills/tickmarkr-overseer/scripts/");
  expect(digest(text.replaceAll("<skill-dir>/scripts/", ".claude/skills/tickmarkr-overseer/scripts/")), file).toBe(hash);
  expect(hostViolations(text), file).toEqual([]);
}

function assertSupervisionCore(skill: string) {
  expect(skill).toContain(releaseBullet);
  expect(skill).toContain(contextBullet);
  expect(skill).toContain("no proof of their union — see *a green leg beside a green parent*, in `references/release-proof.md`\n     — because the union's own conflict resolutions, ordering and collected-count changes are");
  expect(skill).not.toMatch(/under the release criterion\s+below/);
  expect(skill).toContain("### What YOU do\n\nRead the evidence file the orchestrator writes, rule on it against your pre-committed release criterion,\nrecord the ruling with what it set aside, and hand the ruling back for execution. That is the whole job,\nand it is the only work that cannot be delegated — which is exactly why nothing else should occupy you.\n\n");
  for (const [, title] of supervisionSections) expect(skill).not.toContain(`${title}\n`);
  expect(skill).not.toContain("### A GO has a deadline");
  for (const host of ["herdr", "orca", "plain"] as const) {
    const reading = skillReading(skill, host);
    expect(reading, host).toContain(releaseBullet);
    expect(reading, host).toContain(contextBullet);
  }
}

test("Cite the deleted skill-file hunks of the two sections beside the added reference lines, identical except the five script-path lines, the two added reference bullets and the retained core pointer that now names the release-proof reference instead of the release criterion below, versus a diff that rewraps or edits a moved line, parts a herdr scope from its Orca sibling or leaves that pointer saying below", () => {
  const skill = readFileSync(join(source, "SKILL.md"), "utf8");
  assertLinks(skill, source);
  assertSupervisionCore(skill);
  expect(skillCorpus(source).match(/^### A GO has a deadline/gm)).toHaveLength(1);
  for (const [file] of supervisionSections) {
    const text = readFileSync(join(source, "references", file), "utf8");
    assertSupervisionSection(file, text);
    const sibling = text.indexOf("##### On Orca") >= 0 ? "##### On Orca" : "#### On Orca";
    for (const mutated of [
      text.replace(" ", "\n"),
      text.replace(" ", "  "),
      text.slice(0, -1),
      text + "\n",
      text.replace(sibling, sibling.replace("Orca", "Other")),
      text.slice(0, text.lastIndexOf(sibling)),
      text.replaceAll("<skill-dir>/scripts/", ".claude/skills/tickmarkr-overseer/scripts/"),
    ]) {
      expect(mutated).not.toBe(text);
      expect(() => assertSupervisionSection(file, mutated)).toThrow();
    }
  }
  for (const mutated of [
    skill.replace(releaseBullet, ""),
    skill.replace(contextBullet, ""),
    skill.replace("in `references/release-proof.md`\n     — because", "under the release criterion\n     below — because"),
    skill.replace("### What YOU do\n", ""),
  ]) expect(() => assertSupervisionCore(mutated)).toThrow();
});

function assertEvidence(text: string) {
  expect(text.startsWith("**Rot**\n\n")).toBe(true);
  expect(digest(text)).toBe(evidenceHash);
  expect([...text.matchAll(/^(\d+)\. \*\*/gm)].map(match => Number(match[1]))).toEqual(Array.from({ length: 37 }, (_, i) => i + 1));
  expect(text).toContain("10a. **A CONTROL NAMES THE PROPERTY IT VERIFIES, NEVER AN INSTANCE OF IT**");
}

function assertDurableCore(skill: string, evidence: string, dir: string) {
  assertLinks(skill, dir);
  expect(skill).toContain(evidenceBullet);
  const core = skill.slice(skill.indexOf(durableHeading));
  expect(digest(core)).toBe(durableHash);
  const laws = [...core.matchAll(/^[1-5]\. \*\*.+$/gm)].map(match => match[0]);
  expect(laws).toHaveLength(5);
  const rules = [...evidence.matchAll(/^\d+[a-z]?\. \*\*.+$/gm)].map(match => match[0]);
  expect(rules).toHaveLength(38);
  expect(skill).not.toContain("**Rot**");
  for (const law of laws) expect(evidence).not.toContain(law);
  for (const rule of rules) expect(skill).not.toContain(rule);
  for (const host of ["herdr", "orca", "plain"] as const) {
    const reading = skillReading(skill, host);
    expect(reading, host).toContain(core);
    expect(reading, host).toContain(evidenceBullet);
    for (const law of laws) expect(reading, host).toContain(law);
    for (const rule of rules) expect(skillReading(evidence, host), host).toContain(rule);
  }
}

test("test: the overseer skill keeps the five queue-and-handoff laws in its own text on every host reading and names the evidence-discipline reference in its references section with its read-when step, while the numbered rules are read from that reference alone, so a core that drops a law or a rule no pointer reaches fails", async () => {
  const repo = await consumer(true);
  for (const dir of [source, ...[".agents", ".claude"].map(host => join(repo, host, "skills/tickmarkr-overseer"))]) {
    const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
    const evidence = readFileSync(join(dir, "references", evidenceFile), "utf8");
    assertEvidence(evidence);
    assertDurableCore(skill, evidence, dir);
    for (const law of skill.slice(skill.indexOf(durableHeading)).match(/^[1-5]\. \*\*.+$/gm)!) {
      expect(() => assertDurableCore(skill.replace(law, ""), evidence, dir), law).toThrow();
    }
    for (const mutated of [
      skill.replace(evidenceBullet, ""),
      skill.replace(evidenceBullet, `- On herdr:\n  ${evidenceBullet}`),
      skill.replace(evidenceBullet, evidenceBullet.replace(" before writing or inheriting a queue, handoff, finding or instrument.", ".")),
      skill + evidence,
    ]) expect(() => assertDurableCore(mutated, evidence, dir)).toThrow();
  }
});

test("Cite the deleted skill-file hunk of the numbered rules beside the identical added reference lines and the two retargeted core pointers, versus a diff that rewraps or edits a moved rule or moves a law of the durable core", () => {
  const skill = readFileSync(join(source, "SKILL.md"), "utf8");
  const evidence = readFileSync(join(source, "references", evidenceFile), "utf8");
  assertEvidence(evidence);
  assertDurableCore(skill, evidence, source);
  expect(skill).toContain("rule 11 in `references/evidence-discipline.md`, verbatim in substance.");
  expect(skill).toContain("mission-independent guard into **this skill** (`references/evidence-discipline.md`) or the project's `CLAUDE.md`,");
  expect(skill).not.toMatch(/rule 11 below|\(Evidence discipline, below\)/);
  for (const mutated of [
    evidence.replace("quotation is exact bytes", "quotation is exact text"),
    evidence.replace("   quotation. A fabricated", "   quotation.\n   A fabricated"),
    evidence.replace("   quotation. A fabricated", "    quotation. A fabricated"),
    evidence.slice(0, -1),
    evidence + "\n",
  ]) {
    expect(mutated).not.toBe(evidence);
    expect(() => assertEvidence(mutated)).toThrow();
  }
  const core = skill.slice(skill.indexOf(durableHeading));
  const laws = [...core.matchAll(/^[1-5]\. \*\*/gm)];
  for (const [i, match] of laws.entries()) {
    const law = core.slice(match.index, laws[i + 1]?.index ?? core.length);
    expect(() => assertDurableCore(skill.replace(law, ""), evidence + law, source)).toThrow();
    expect(() => assertEvidence(evidence + law)).toThrow();
  }
});

function assertSection(file: typeof sections[number][0], text: string) {
  const [, title, hash] = sections.find(section => section[0] === file)!;
  expect(text.startsWith(`${title}\n\n`), file).toBe(true);
  expect(text.endsWith("\n\n"), file).toBe(true);
  expect(digest(text.replaceAll("<skill-dir>/scripts/", ".claude/skills/tickmarkr-overseer/scripts/")), file).toBe(hash);
}

test("Cite the deleted skill-file hunks of the four sections beside the added reference lines, identical except the four script-path lines, and the added references section, versus a diff that rewraps, edits or drops a moved line or leaves a core pointer to a moved section by position", () => {
  const skill = readFileSync(join(source, "SKILL.md"), "utf8");
  assertLinks(skill, source);
  let substitutions = 0;
  for (const [file, title] of sections) {
    const text = readFileSync(join(source, "references", file), "utf8");
    assertSection(file, text);
    substitutions += text.split("<skill-dir>/scripts/").length - 1;
    expect(skill).not.toContain(`${title}\n`);
    for (const mutated of [text.slice(0, -1), text.replace(" ", "\n"), text.replace(" ", "  ")]) {
      expect(() => assertSection(file, mutated)).toThrow();
    }
  }
  expect(substitutions).toBe(4);
  expect(skill).toContain("the pane mechanics in `references/pane-mechanics.md`, rules 1–2");
  for (const host of ["herdr", "Orca"]) expect(skill).toContain(`On ${host} section of \`references/watchers.md\``);
  expect(skill).toContain("the shipped watcher in `references/watchers.md`");
  expect(skill).toContain("the BLOCKED-STATE watcher in `references/watchers.md` is blind on this vendor");
  expect(skill).not.toMatch(/the pane mechanics below|section of Supervision watcher|the shipped watcher below/);
});
