import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { allAdapters, formatDoctorAgeForInit, formatDoctorReport, initDoctorReuse } from "../../adapters/registry.js";
import { configTemplate, DEFAULT_CONFIG, globalConfigDir, loadConfig, type TickmarkrConfig, type InitConfigOverlay } from "../../config/config.js";
import { LEGACY_PREFIX, specTemplate } from "../../compile/native.js";
import { BANNER, kvRow, legend, rule, statusRow, title } from "../../brand.js";
import { stateDirName, tickmarkrDir } from "../../graph/graph.js";
import { orcaHostDetected } from "../../drivers/index.js";
import { gitSync, WORKTREES_DIR } from "../../run/git.js";
import { assertGitTrust, GitTrustRefusal } from "../../run/git-trust.js";
import { Journal, type JournalEvent } from "../../run/journal.js";
import { runLockOwner, runLockRunId, runStatusLine } from "../../run/lock.js";
import { doctor } from "./doctor.js";
import { assembleFleetEditor } from "./fleet.js";
import { SHIPPED_DIGESTS, SHIPPED_SNAPSHOTS } from "../shipped-skill-files.js";

const SCAFFOLD_SPEC = "tickmarkr.spec.md";

// Operator-approved (2026-07-17) environments footer — no npm install for herdr (npm package
// "herdr" is a reserved 0.0.0 placeholder as of that date). Auto resolves herdr → orca →
// subprocess; the orca leg is environment-only, using the two markers Orca stamps in its terminals.
const ENVIRONMENTS_FOOTER = [
  "environments:",
  "  herdr — the full cockpit — every worker, judge, and consult is a visible pane you can watch and unblock · https://herdr.dev · auto picks it first when HERDR_ENV=1",
  "  orca — visible terminals in the Orca app — auto picks it inside an Orca terminal after herdr and before subprocess; set driver: orca to force it · https://onorca.dev",
  "  claude code — tickmarkr init --agent installs the tickmarkr-loop, tickmarkr-auto and tickmarkr-overseer skills + AGENTS.md so Claude Code (or any agent CLI) drives the loop natively; in Claude Desktop's Code tab (neither herdr nor Orca) one single-tier session runs the loop on the headless subprocess driver, watched with tickmarkr status --watch --plain",
  "  anywhere — no herdr or Orca terminal? same fail-closed gates, headless subprocess driver (legacy: no herdr? same fail-closed gates, headless subprocess driver when Orca markers are absent)",
].join("\n");

/** Current run truth, lock first; falls back to an abandoned journal. */
function activeRunLine(cwd: string): string | null {
  const locked = runLockRunId(cwd);
  const runId = locked ?? Journal.latestRunId(cwd, { withJournal: true });
  if (!runId) return null;
  let events: JournalEvent[] = [];
  try { events = Journal.open(cwd, runId).read(); } catch { /* lock may exist before first journal row */ }
  return runStatusLine(cwd, runId, events);
}

/** Relative paths of specs/*.spec.md already in the repo. */
function existingSpecs(cwd: string): string[] {
  const dir = join(cwd, "specs");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".spec.md"))
      .sort()
      .map((f) => `specs/${f}`);
  } catch {
    return [];
  }
}

/** Context-aware next-steps line (operator-approved 2026-07-17). */
function nextSteps(cwd: string, scaffoldedSpec: string): string {
  const runLine = activeRunLine(cwd);
  if (runLine) return `${runLine} — tickmarkr status`;

  const specs = existingSpecs(cwd);
  if (specs.length > 0) {
    const listed = specs.length <= 3 ? specs.join(", ") : `${specs.slice(0, 3).join(", ")}, …`;
    return `next: existing specs under specs/ (${listed}) — tickmarkr compile <spec> && tickmarkr plan && tickmarkr run`;
  }

  return `next: edit ${scaffoldedSpec}, then tickmarkr compile ${scaffoldedSpec} && tickmarkr plan && tickmarkr run`;
}

const visual = () => process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const AGENT_SKILLS = ["tickmarkr-loop", "tickmarkr-auto", "tickmarkr-overseer"];
const DOCS_BEGIN = "<!-- tickmarkr:agent-docs begin -->";
const DOCS_END = "<!-- tickmarkr:agent-docs end -->";
const AGENT_DOCS = `${DOCS_BEGIN}
## tickmarkr

tickmarkr compiles repository specs into isolated, independently verified agent work.

### Invariants

- Never run two tickmarkr runs in the same repository concurrently.
- Never let tickmarkr merge work to main; new runs consolidate on \`tickmarkr/<runId>\`.
- Do not edit compiled graphs to force outcomes; fix source specs and recompile.
- Gates verify commits, diffs, acceptance criteria, and reviews independently — never trust a worker's completion claim.
- Treat missing or unparseable machine results and verdicts as failures.
- Before \`tickmarkr compile\` or \`tickmarkr run\`, run \`tickmarkr version --check\` and stop on a non-zero exit.
- A run is green only when run-end is not fatal, every bucket but done is empty, tip verify did not fail and current \`tickmarkr status\` reads outstanding 0; the loop skill holds the full rule.
- Drive runs through the \`tickmarkr-loop\` skill (one spec) or the \`tickmarkr-auto\` skill (several specs); they carry the role check, the live-run check, verified handoffs and the green rule. Supervise a run with the \`tickmarkr-overseer\` skill.
${DOCS_END}
`;

// Every applicable host location gets the skills, each paired with its own repository guidance
// file: codex discovers .agents/skills + AGENTS.md (always applicable); claude discovers
// .claude/skills + CLAUDE.md (applicable when the repo already shows claude usage).
const hostTargets = (cwd: string) => {
  const targets = [{ skillsDir: join(cwd, ".agents", "skills"), docPath: join(cwd, "AGENTS.md") }];
  if (entryStat(join(cwd, ".claude")) || entryStat(join(cwd, "CLAUDE.md")))
    targets.push({ skillsDir: join(cwd, ".claude", "skills"), docPath: join(cwd, "CLAUDE.md") });
  return targets;
};

// Installation can discover a new host from init's environment. Readers deliberately
// keep hostTargets' repository-only rule, so a codex-only install remains current.
function installHostTargets(cwd: string, env: NodeJS.ProcessEnv) {
  const claudeOnPath = () => (env.PATH?.split(delimiter) ?? []).some((dir) => {
    try {
      const stat = statSync(resolve(cwd, dir, "claude"));
      return stat.isFile() && (stat.mode & 0o111) !== 0;
    } catch { return false; }
  });
  const reason = env.CLAUDE_CODE_ENTRYPOINT ? "CLAUDE_CODE_ENTRYPOINT set"
    : claudeOnPath() ? "claude on PATH"
      : entryStat(join(cwd, ".claude")) ? "existing .claude"
        : entryStat(join(cwd, "CLAUDE.md")) ? "existing CLAUDE.md" : undefined;
  return [
    { host: "codex", skillsDir: join(cwd, ".agents", "skills"), docPath: join(cwd, "AGENTS.md"), reason: undefined },
    ...(reason ? [{ host: "claude", skillsDir: join(cwd, ".claude", "skills"), docPath: join(cwd, "CLAUDE.md"), reason }] : []),
  ];
}
const packagedSkillDir = (skill: string) => fileURLToPath(new URL(`../../../skills/${skill}`, import.meta.url));

// Queue row 244 (D-2141; D-2152): lstat, including dangling links, at every step from
// the consumer boundary. Never inspect a descendant through a linked host ancestor.
const entryStat = (path: string) => {
  try { return lstatSync(path); } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
};
function guidanceLink(cwd: string, path: string): string | undefined {
  let at = resolve(cwd);
  if (entryStat(at)?.isSymbolicLink()) return at;
  for (const part of relative(cwd, path).split(sep).filter(Boolean)) {
    at = join(at, part);
    if (entryStat(at)?.isSymbolicLink()) return at;
  }
  return undefined;
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const parentDirs = (files: string[]) => {
  const dirs = new Set<string>();
  for (const file of files) {
    for (let dir = dirname(file); dir !== "."; dir = dirname(dir)) dirs.add(dir);
  }
  return dirs;
};
interface SkillTree {
  files: Map<string, string>;
  dirs: Set<string>;
  links: string[];
  other: string[];
}
function readSkillTree(root: string): SkillTree {
  const tree: SkillTree = { files: new Map(), dirs: new Set(), links: [], other: [] };
  const visit = (path: string, rel: string) => {
    const stat = entryStat(path);
    if (stat?.isSymbolicLink()) tree.links.push(path);
    else if (stat?.isFile()) tree.files.set(rel, digest(readFileSync(path)));
    else if (stat?.isDirectory()) {
      if (rel) tree.dirs.add(rel);
      for (const name of readdirSync(path).sort()) visit(join(path, name), rel ? `${rel}/${name}` : name);
    } else tree.other.push(path);
  };
  visit(root, "");
  return tree;
}
function tickmarkrMarked(dir: string): boolean {
  try {
    if (!entryStat(dir)?.isDirectory() || !entryStat(join(dir, "SKILL.md"))?.isFile()) return false;
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readFileSync(join(dir, "SKILL.md"), "utf8"));
    return !!frontmatter && parseYaml(frontmatter[1])?.metadata?.["installed-by"] === "tickmarkr";
  } catch { return false; }
}
interface SkillInspection {
  skill: string;
  dir: string;
  tree: SkillTree;
  removable: boolean;
  current: boolean;
  leftovers: string[];
  unproven: string[];
}
export function agentSkillEvidence(cwd: string): { skills: SkillInspection[]; links: string[] } {
  const skills: SkillInspection[] = [];
  const links = new Set<string>();
  for (const { skillsDir } of hostTargets(cwd)) {
    const linked = guidanceLink(cwd, skillsDir);
    if (linked) { links.add(linked); continue; }
    if (!entryStat(skillsDir)?.isDirectory()) continue;
    for (const skill of readdirSync(skillsDir).sort()) {
      const dir = join(skillsDir, skill);
      const snapshots = Object.hasOwn(SHIPPED_SNAPSHOTS, skill) ? SHIPPED_SNAPSHOTS[skill]! : [];
      const current = AGENT_SKILLS.includes(skill);
      const reserved = current || snapshots.length > 0;
      // Queue row 244 (D-2141; D-2152): unrelated user trees stay unread and unlisted.
      if (!reserved && !tickmarkrMarked(dir)) continue;
      const tree = readSkillTree(dir);
      for (const link of tree.links) links.add(link);
      if (tree.links.includes(dir)) continue;
      // ONE complete snapshot, including its implied directories. A subset, a union,
      // an empty tree or a marker cannot prove directory ownership.
      const removable = tree.files.has("SKILL.md") && !tree.links.length && !tree.other.length
        && snapshots.some((snapshot) => {
          const paths = Object.keys(snapshot);
          const dirs = parentDirs(paths);
          return paths.length > 0 && paths.length === tree.files.size && dirs.size === tree.dirs.size
            && [...tree.dirs].every((path) => dirs.has(path))
            && paths.every((path) => tree.files.get(path) === SHIPPED_DIGESTS[snapshot[path]!]);
        });
      const shipped = current ? skillFileList(packagedSkillDir(skill)) : [];
      const currentDirs = parentDirs(shipped);
      const leftovers = current ? [...tree.files].filter(([path, hash]) => !shipped.includes(path)
        && snapshots.some((snapshot) => snapshot[path] !== undefined && SHIPPED_DIGESTS[snapshot[path]!] === hash))
        .map(([path]) => join(dir, path)) : [];
      const unproven: string[] = [];
      if (!removable) {
        if (!current || !tree.files.has("SKILL.md")) unproven.push(dir);
        for (const [path, hash] of tree.files) {
          const full = join(dir, path);
          if (!leftovers.includes(full) && (!shipped.includes(path) || hash !== digest(readFileSync(join(packagedSkillDir(skill), path)))))
            unproven.push(full);
        }
        for (const path of tree.dirs) if (!currentDirs.has(path)) unproven.push(join(dir, path));
        unproven.push(...tree.other);
      }
      skills.push({ skill, dir, tree, removable, current, leftovers, unproven: [...new Set(unproven)] });
    }
  }
  return { skills, links: [...links] };
}
const keptLink = (path: string) => `kept ${path} (symbolic link)`;
function sweepAgentLeftovers(cwd: string, remove: boolean, notes: string[]): SkillInspection[] {
  const evidence = agentSkillEvidence(cwd);
  const deferred: SkillInspection[] = [];
  notes.push(...evidence.links.map(keptLink));
  for (const skill of evidence.skills) {
    if (skill.removable && !skill.current) {
      rmSync(skill.dir, { recursive: true });
      notes.push(`removed leftover ${skill.dir}`);
      continue;
    }
    // Queue row 244 (D-2141; D-2152): keep a complete earlier snapshot removable
    // when its refresh is skipped. Sweep it only after the consented copy succeeds.
    if (!remove && skill.removable) { deferred.push(skill); continue; }
    for (const path of skill.leftovers) {
      rmSync(path);
      notes.push(`removed leftover ${path}`);
    }
    // Sweeping can turn a current tree plus retired files into a complete snapshot.
    const refreshed = remove ? agentSkillEvidence(cwd).skills.find((s) => s.dir === skill.dir) : skill;
    if (remove && (skill.removable || refreshed?.removable)) {
      rmSync(skill.dir, { recursive: true });
      notes.push(`removed leftover ${skill.dir}`);
    } else {
      notes.push(...skill.unproven.map((path) => `kept ${path} (unproven)`));
      if (remove && !skill.unproven.length && !skill.tree.links.length) notes.push(`kept ${skill.dir} (unproven)`);
    }
  }
  return deferred;
}

// Every file the package ships for a skill, DERIVED from the tree rather than listed. OBS-373: a script
// was added to the shipped overseer skill long after repos had installed it, and because the SKILL.md
// that MANDATES that script was already on disk, every existence check reported "installed" while the
// thing the skill tells you to run was absent. A literal list here would be the same closed-set-restated
// defect one layer down, so this walks instead.
function skillFileList(root: string, prefix = ""): string[] {
  return readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? skillFileList(join(root, entry.name), rel) : [rel];
    });
}

interface SkillDrift { skill: string; dir: string; missing: string[]; modified: string[] }

// Reserved directories count as installed even when their skill file is missing or malformed.
// An absent directory is not drift; --agent installs it and says so.
export function skillDrift(cwd: string): SkillDrift[] {
  const drifted: SkillDrift[] = [];
  for (const { skill, dir, tree, current } of agentSkillEvidence(cwd).skills) {
    if (!current) continue;
    const src = packagedSkillDir(skill);
    const missing: string[] = [];
    const modified: string[] = [];
    for (const rel of skillFileList(src)) {
      if (guidanceLink(cwd, join(dir, rel))) continue;
      if (!tree.files.has(rel)) missing.push(rel);
      else if (tree.files.get(rel) !== digest(readFileSync(join(src, rel)))) modified.push(rel);
    }
    if (missing.length || modified.length) drifted.push({ skill, dir, missing, modified });
  }
  return drifted;
}

// Name what drifted. "stale" alone sends the reader to diff three directories by hand, and the file that
// matters is usually the one they never knew shipped.
// The GENERATED GUIDANCE BLOCK goes stale by exactly the shape skillDrift exists for: the package
// moves, the rendered copy does not, and nothing in the repo changes to hint at it. Worse than a skill,
// because a doc the host reads as law can be gitignored — this project's own AGENTS.md kept two
// superseded preflight rules (patch-version drift tolerated, a machine-wide process match required)
// through the very release that fixed the tracked copy, and a consultation was launched under the stale
// text with nobody able to see it. Same rule as skillDrift: a doc that was never written is not drift.
export const docsDrift = (cwd: string): string[] =>
  hostTargets(cwd).map(({ docPath }) => docPath).filter((docPath) => {
    if (guidanceLink(cwd, docPath) || !entryStat(docPath)?.isFile()) return false;
    const current = readFileSync(docPath, "utf8");
    const begin = current.indexOf(DOCS_BEGIN);
    if (begin < 0) return false; // no block installed here — --docs writes one, that is not drift
    const end = current.indexOf(DOCS_END, begin);
    if (end < 0) return true; // a truncated block is stale by definition
    return current.slice(begin, end + DOCS_END.length) !== AGENT_DOCS.trimEnd();
  });

export function installedAgentGuidance(cwd: string): string[] {
  const evidence = agentSkillEvidence(cwd);
  return [
    ...evidence.skills.map(({ dir, tree }) => tree.files.has("SKILL.md") ? join(dir, "SKILL.md") : dir),
    ...evidence.links,
    ...hostTargets(cwd).map(({ docPath }) => docPath).filter((path) => !guidanceLink(cwd, path)
      && entryStat(path)?.isFile() && readFileSync(path, "utf8").includes(DOCS_BEGIN)),
  ];
}

const describeDrift = (d: SkillDrift) => [
  d.missing.length ? `missing ${d.missing.join(", ")}` : "",
  d.modified.length ? `modified ${d.modified.join(", ")}` : "",
].filter(Boolean).join(", ");

// PRESENCE, deliberately — the wizard's question is "install these?", and a repo that already has them
// should not be asked again just because a copy drifted. Staleness is a different question with a
// different answer (`--agent --force`), and it is reported by name on every init path below.
const skillsInstalled = (cwd: string) =>
  hostTargets(cwd).every((t) => AGENT_SKILLS.every((s) => !guidanceLink(cwd, join(t.skillsDir, s, "SKILL.md"))
    && entryStat(join(t.skillsDir, s, "SKILL.md"))?.isFile()));
export type DetectedHost = "herdr" | "orca" | "subprocess";

export function detectedHost(env: NodeJS.ProcessEnv = process.env): DetectedHost {
  if (env.HERDR_ENV === "1") return "herdr";
  if (orcaHostDetected(env)) return "orca";
  return "subprocess";
}

const wizardDriverDefault = (): TickmarkrConfig["driver"] => "auto";
function packageName(cwd: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

function gitTracked(cwd: string, path: string): boolean {
  const rel = relative(cwd, path);
  if (rel.startsWith("..")) return false;
  // queue row 2 item b: protected git; a trust refusal throws, an ordinary failure still reads as untracked
  return gitSync(cwd, ["ls-files", "--error-unmatch", "--", rel]).status === 0;
}

async function installAgentFiles(cwd: string, force: boolean, docs: boolean, notes: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  let prompt: Interface | undefined;
  const confirm = async (question: string) => {
    if (!interactive) return false;
    // Post-wizard hardening: an Ink act that ran earlier in this process leaves stdin paused and
    // unref'd on unmount, and readline revives neither — the process exits mid-question (found by
    // the consolidated-init smoke). Revive explicitly before asking.
    process.stdin.resume();
    process.stdin.ref();
    prompt ??= createInterface({ input: process.stdin, output: process.stdout });
    return /^(?:y|yes)$/i.test((await prompt.question(`${question} [y/N] `)).trim());
  };

  try {
    const deferred = sweepAgentLeftovers(cwd, false, notes);
    const drift = skillDrift(cwd);
    for (const { host, skillsDir, docPath, reason } of installHostTargets(cwd, env)) {
      let receivedSkills = false;
      for (const skill of AGENT_SKILLS) {
        const dest = join(skillsDir, skill, "SKILL.md");
        const dir = join(skillsDir, skill);
        // Queue row 244 (D-2141; D-2152): a linked SKILL.md exempts only itself;
        // unlinked siblings still receive their consented refresh below.
        const linked = guidanceLink(cwd, dir);
        if (linked) { if (!notes.includes(keptLink(linked))) notes.push(keptLink(linked)); continue; }
        if (entryStat(dir) && !entryStat(dir)?.isDirectory()) continue;
        const destStat = entryStat(dest);
        const exists = !!destStat;
        const stale = drift.find((d) => d.dir === join(skillsDir, skill));
        const leftovers = deferred.find((s) => s.dir === dir)?.leftovers ?? [];
        // An install that already matches the package byte for byte needs no prompt and no write. Before
        // this, every re-init asked to overwrite a current skill and the answer meant nothing either way.
        if (exists && !stale && !leftovers.length) {
          if (!destStat?.isSymbolicLink()) {
            notes.push(`kept current ${dest}`);
            receivedSkills ||= destStat?.isFile() === true;
          }
          continue;
        }
        const tracked = exists && gitTracked(cwd, dest);
        const changes = stale ? describeDrift(stale) : "retired files";
        if (exists && !force && !(await confirm(`Overwrite ${dest} (${changes})?`))) {
          notes.push(`skipped existing ${tracked ? "tracked " : ""}${dest} — ${changes}; pass --force to overwrite it`);
          notes.push(...leftovers.map((path) => `kept leftover ${path}; pass --force to refresh ${dir}`));
          continue;
        }
        // Copy only regular shipped files after checking every destination component.
        // cpSync can abort natively on a dangling destination, even with a filter.
        for (const rel of skillFileList(packagedSkillDir(skill))) {
          const path = join(dir, rel);
          const link = guidanceLink(cwd, path);
          if (link) { notes.push(keptLink(link)); continue; }
          let blocked = false;
          for (let parent = dirname(path); parent !== cwd && parent !== dirname(parent); parent = dirname(parent)) {
            if (entryStat(parent) && !entryStat(parent)?.isDirectory()) { blocked = true; break; }
          }
          if (blocked || (entryStat(path) && !entryStat(path)?.isFile())) continue;
          mkdirSync(dirname(path), { recursive: true });
          copyFileSync(join(packagedSkillDir(skill), rel), path);
          receivedSkills = true;
          const kept = notes.indexOf(`kept ${path} (unproven)`);
          if (kept >= 0) notes[kept] = `overwrote ${path}`;
        }
        for (const path of leftovers) {
          rmSync(path);
          notes.push(`removed leftover ${path}`);
        }
        if (!destStat?.isSymbolicLink()) notes.push(`${exists ? "overwrote" : "wrote"} ${tracked ? "tracked " : ""}${dest}`);
      }

      if (receivedSkills && !notes.some(note => note.startsWith(`agent skills for ${host}:`))) {
        notes.push(`agent skills for ${host}: ${relative(cwd, skillsDir)} (${basename(docPath)})${reason ? ` — ${reason}` : ""}`);
      }
      const linkedDoc = guidanceLink(cwd, docPath);
      if (linkedDoc) { notes.push(keptLink(linkedDoc)); continue; }
      if (entryStat(docPath) && !entryStat(docPath)?.isFile()) continue;
      const current = existsSync(docPath) ? readFileSync(docPath, "utf8") : "";
      // The block is CANONICAL guidance ("stated once here, restated nowhere"), so a repo that has
      // run init once must still be able to receive corrections to it. Before v1.86 this branch only
      // ever said "kept", with no lever — not even --force, which IS honoured for skills above. So
      // the block was write-once and every later improvement reached new repos only. Under --force,
      // replace the marked region in place and leave every human-authored line outside it untouched.
      const marked = new RegExp(
        `<!-- (?:tickmarkr|${LEGACY_PREFIX}):agent-docs begin -->[\\s\\S]*?`
        + `<!-- (?:tickmarkr|${LEGACY_PREFIX}):agent-docs end -->`,
      );
      if (marked.test(current)) {
        if (force) {
          writeFileSync(docPath, current.replace(marked, AGENT_DOCS.trimEnd()));
          notes.push(`refreshed tickmarkr agent docs in ${docPath}`);
        } else {
          notes.push(`kept existing tickmarkr agent docs in ${docPath}; pass --force to refresh them`);
        }
      } else if (docs || await confirm(`Append tickmarkr agent docs to ${docPath}?`)) {
        appendFileSync(docPath, `${current ? current.endsWith("\n") ? "\n" : "\n\n" : ""}${AGENT_DOCS}`);
        notes.push(`appended tickmarkr agent docs to ${docPath}`);
      } else {
        notes.push(`skipped agent docs for ${docPath}; pass --docs to append them`);
      }
    }
  } finally {
    prompt?.close();
  }
}

// The consolidated wizard (operator directive 2026-08-12): init walks three acts in one
// command — preferences (Ink form) → discovery (doctor, the sensor) → fleet (the browser opens
// on the models view; the presets overlay raises on the first Shapes entry). The readline asks
// this replaced live on in git history; the Ink act keeps the same four questions and the same
// defaults, so `--yes` and non-TTY paths are unchanged.
async function runInitWizard(
  cwd: string,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): Promise<{ overlay: InitConfigOverlay; installSkills: boolean; installDocs: boolean } | null> {
  // Dynamic import, deliberately (same seam as fleet.ts): the Ink/React runtime must stay out of
  // the non-TTY and --yes paths — init runs in CI and agent shells where importing Ink at module
  // load would drag a renderer into paths that never draw.
  const { runInitWizardApp } = await import("../../tui/ink/init-app.js");
  const result = await runInitWizardApp({
    fields: {
      driver: wizardDriverDefault(),
      concurrency: DEFAULT_CONFIG.concurrency,
      visibilityLlm: DEFAULT_CONFIG.visibility.llm,
      offerSkills: !skillsInstalled(cwd),
      skillsDefault: !guidanceLink(cwd, join(cwd, ".claude", "skills"))
        && entryStat(join(cwd, ".claude", "skills"))?.isDirectory() === true && !skillsInstalled(cwd),
      detectedHost: detectedHost(),
    },
    input,
    output,
  });
  if (result.kind === "quit") return null;
  return { overlay: result.overlay, installSkills: result.installSkills, installDocs: result.installDocs };
}
function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    return join(realpathSafe(parent), basename(p));
  }
}

function isPathInside(parentDir: string, candidatePath: string): boolean {
  const resolvedParent = realpathSafe(resolve(parentDir));
  const resolvedCandidate = realpathSafe(resolve(candidatePath));
  const rel = relative(resolvedParent, resolvedCandidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The ONLY way the --remove path runs git: GIT_DIR, GIT_WORK_TREE and GIT_COMMON_DIR are stripped so the repository acted on
 * is always cwd's own, and LC_ALL=C keeps stderr parseable. Queue row 2 item b: it runs through the protected path (gitSync),
 * whose GitTrustRefusal propagates unchanged; a failed git throws an error carrying its status and stderr.
 */
function removeGit(cwd: string, args: string[]): string {
  const { GIT_DIR: _dir, GIT_WORK_TREE: _workTree, GIT_COMMON_DIR: _commonDir, ...env } = process.env;
  const r = gitSync(cwd, args, { env: { ...env, LC_ALL: "C" } });
  if (r.error) throw r.error;
  if (r.status !== 0) throw Object.assign(new Error(`git ${args.join(" ")} failed (${r.status ?? r.signal})`), { status: r.status, stderr: r.stderr });
  return r.stdout;
}

/** A trust refusal is never one of the --remove path's fail-open answers. */
const rethrowRefusal = (error: unknown): void => { if (error instanceof GitTrustRefusal) throw error; };

function isLinkedWorktree(cwd: string): boolean {
  try {
    const gitDir = removeGit(cwd, ["rev-parse", "--git-dir"]).trim();
    const gitCommonDir = removeGit(cwd, ["rev-parse", "--git-common-dir"]).trim();
    return resolve(cwd, gitDir) !== resolve(cwd, gitCommonDir);
  } catch (error) {
    rethrowRefusal(error);
    return false;
  }
}

function checkLiveLock(cwd: string): { pid?: number; live: boolean } | undefined {
  const localOwner = runLockOwner(cwd);
  if (localOwner?.live) return localOwner;

  try {
    const gitDir = removeGit(cwd, ["rev-parse", "--git-dir"]).trim();
    const gitCommonDir = removeGit(cwd, ["rev-parse", "--git-common-dir"]).trim();
    if (resolve(cwd, gitDir) !== resolve(cwd, gitCommonDir)) {
      const mainRepo = dirname(resolve(cwd, gitCommonDir));
      const mainOwner = runLockOwner(mainRepo);
      if (mainOwner?.live) return mainOwner;
    }
  } catch (error) {
    rethrowRefusal(error);
    // not a git repo
  }

  return undefined;
}

/**
 * Only git's discovery answer — exit 128, stderr `fatal: not a git repository (or any of the parent directories)` — means false.
 * Every other failure (explicit bad GIT_DIR, invalid gitfile, permission, missing binary) refuses: unregistration could not be verified.
 */
function isGitRepo(cwd: string): boolean {
  try {
    removeGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch (err) {
    rethrowRefusal(err);
    const e = err as { status?: unknown; stderr?: unknown; message?: string };
    const stderr = String(e.stderr ?? "").trim();
    if (e.status === 128 && stderr.startsWith("fatal: not a git repository (or any of the parent directories)")) return false;
    throw new Error(`cannot remove: git repository probe failed: ${stderr || e.message || "unknown error"}`);
  }
}

/** Runs git and throws `message` plus git's stderr on failure — a remove never proceeds past a failed step. */
function git(cwd: string, args: string[], message: string): string {
  try {
    return removeGit(cwd, args);
  } catch (err) {
    rethrowRefusal(err);
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(stderr ? `${message}: ${stderr}` : message);
  }
}

function registeredWorktrees(cwd: string, worktreesDir: string): string[] {
  const out = git(cwd, ["worktree", "list", "--porcelain"], "cannot remove: git worktree list failed");
  return out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter((wt) => isPathInside(worktreesDir, wt));
}

function handleRemove(cwd: string): string {
  const owner = checkLiveLock(cwd);
  if (owner?.live) {
    const holder = typeof owner.pid === "number" ? `live pid ${owner.pid}` : (owner.pid ?? "unreadable payload");
    throw new Error(`cannot remove: graph.lock held by ${holder}`);
  }

  if (isLinkedWorktree(cwd)) {
    throw new Error("cannot remove from inside a linked worktree");
  }

  const notes: string[] = [];
  const stateDir = join(cwd, stateDirName(cwd));
  const worktreesDir = join(stateDir, WORKTREES_DIR);

  // 1. Unregister every git worktree under stateDir/WORKTREES_DIR, and prove it, before deleting anything
  if (isGitRepo(cwd)) {
    for (const wt of registeredWorktrees(cwd, worktreesDir)) {
      // double --force: git refuses a locked worktree (present or already deleted) with a single one
      git(cwd, ["worktree", "remove", "--force", "--force", wt], `cannot remove: failed to unregister worktree ${wt}`);
    }
    git(cwd, ["worktree", "prune"], "cannot remove: git worktree prune failed");
    const left = registeredWorktrees(cwd, worktreesDir);
    if (left.length > 0) {
      throw new Error(`cannot remove: worktrees still registered: ${left.join(", ")}`);
    }
  }

  // 2. Delete .tickmarkr state directory
  if (existsSync(stateDir)) {
    rmSync(stateDir, { recursive: true, force: true });
    notes.push(`deleted state directory ${stateDir}`);
  }

  // Queue row 244 (D-2141; D-2152): remove only what shipped bytes prove.
  sweepAgentLeftovers(cwd, true, notes);

  // 4. Delete marker-bounded guidance block in AGENTS.md and CLAUDE.md leaving every byte outside identical
  const marked = new RegExp(
    `<!-- (?:tickmarkr|${LEGACY_PREFIX}):agent-docs begin -->[\\s\\S]*?`
    + `<!-- (?:tickmarkr|${LEGACY_PREFIX}):agent-docs end -->`,
  );
  for (const doc of ["AGENTS.md", "CLAUDE.md"]) {
    const docPath = join(cwd, doc);
    const linked = guidanceLink(cwd, docPath);
    if (linked) { notes.push(keptLink(linked)); continue; }
    if (entryStat(docPath)?.isFile()) {
      const current = readFileSync(docPath, "utf8");
      const m = current.match(marked);
      if (m && m.index !== undefined) {
        const before = current.slice(0, m.index);
        const after = current.slice(m.index + m[0].length);
        writeFileSync(docPath, before + after);
        notes.push(`removed guidance block from ${docPath}`);
      }
    }
  }

  // 5. Delete scaffold spec only while it still equals the shipped template
  const specPath = join(cwd, SCAFFOLD_SPEC);
  if (existsSync(specPath)) {
    const currentSpec = readFileSync(specPath, "utf8");
    if (currentSpec === specTemplate()) {
      rmSync(specPath, { force: true });
      notes.push(`deleted scaffold spec ${specPath}`);
    } else {
      notes.push(`kept edited spec ${specPath}`);
    }
  }

  // 6. Query and print remaining branches and preserved refs
  let branches: string[] = [];
  try {
    const out = removeGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads/tickmarkr/"]);
    branches = out.split("\n").map((b) => b.trim()).filter(Boolean);
  } catch (error) {
    rethrowRefusal(error);
  }

  let preservedRefs: string[] = [];
  try {
    const out = removeGit(cwd, ["for-each-ref", "--format=%(refname)", "refs/tickmarkr/preserved/"]);
    preservedRefs = out.split("\n").map((r) => r.trim()).filter(Boolean);
  } catch (error) {
    rethrowRefusal(error);
  }

  for (const b of branches) {
    notes.push(`left branch: ${b}`);
  }
  for (const r of preservedRefs) {
    notes.push(`left ref: ${r}`);
  }

  return notes.join("\n");
}


/** Test seam mirroring FleetIO: production callers get the process streams and environment. */
export type InitIO = { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream; env?: NodeJS.ProcessEnv };

export async function init(argv: string[], cwd = process.cwd(), io: InitIO = {}): Promise<string> {
  const env = io.env ?? process.env;
  let bannerEmitted = false;
  const emitBanner = () => {
    if (visual() && !bannerEmitted) {
      bannerEmitted = true;
      process.stdout.write(BANNER);
    }
  };
  // banner at START on the visual surface — every init path, not just the wizard, and never trailing the probe (operator report 2026-07-17)
  emitBanner();

  const { values } = parseArgs({
    args: argv,
    options: {
      "global-dir": { type: "string" },
      agent: { type: "boolean" },
      force: { type: "boolean" },
      docs: { type: "boolean" },
      fresh: { type: "boolean" },
      yes: { type: "boolean" },
      remove: { type: "boolean" },
    },
  });
  if (packageName(cwd) === "tickmarkr") {
    throw new Error("OBS-584: tickmarkr init refuses to run inside the tickmarkr source repository");
  }
  if (values.remove) {
    return handleRemove(cwd);
  }
  // Refuse redirected linked-worktree metadata before discovery can launch a child.
  // All later operator git goes through gitSync's guarded, forced-last entry.
  assertGitTrust(cwd);
  const gdir = values["global-dir"] ?? globalConfigDir();
  mkdirSync(gdir, { recursive: true });
  const notes: string[] = [];
  const globalPath = join(gdir, "config.yaml");
  if (!existsSync(globalPath)) {
    writeFileSync(globalPath, configTemplate());
    notes.push(`wrote ${globalPath}`);
  } else {
    notes.push(`kept existing ${globalPath}`);
  }

  const repoConfigPath = join(tickmarkrDir(cwd), "config.yaml");
  const repoConfigExists = existsSync(repoConfigPath);
  if (repoConfigExists) {
    if (values.force) {
      const currentRaw = readFileSync(repoConfigPath, "utf8");
      let parsedDriver: string | undefined;
      try {
        const parsed = parseYaml(currentRaw) as { driver?: unknown } | null;
        if (typeof parsed?.driver === "string") parsedDriver = parsed.driver;
      } catch {
        // malformed: fall back to regex
      }
      if (!parsedDriver) {
        const m = currentRaw.match(/^\s*driver:\s*([^\s#]+)/m);
        if (m) parsedDriver = m[1];
      }
      const host = detectedHost();
      if (parsedDriver && parsedDriver === host) {
        const rewritten = currentRaw.replace(
          new RegExp(`^(\\s*driver:\\s*)${parsedDriver}\\b.*$`, "m"),
          `$1auto            # auto — resolves to ${host} here`,
        );
        writeFileSync(repoConfigPath, rewritten);
        notes.push(`rewrote driver: ${parsedDriver} to auto in ${repoConfigPath}`);
      } else {
        notes.push(`kept existing ${repoConfigPath}`);
      }
    } else {
      notes.push(`kept existing ${repoConfigPath}`);
    }
  }

  const specPath = join(cwd, SCAFFOLD_SPEC);
  if (existsSync(specPath)) {
    notes.push(`kept existing ${specPath}`);
  } else {
    const legacySpec = join(cwd, `${LEGACY_PREFIX}.spec.md`);
    if (existsSync(legacySpec)) {
      writeFileSync(specPath, readFileSync(legacySpec, "utf8"));
      notes.push(`wrote ${specPath}`);
    } else {
      writeFileSync(specPath, specTemplate());
      notes.push(`wrote ${specPath}`);
    }
  }

  // Say it on EVERY init, not only the --agent path. The upgrade that produced OBS-373 is silent by
  // shape: the package moves, the installed copy does not, and nothing in the repo changes to hint at it.
  // --agent reports drift per skill below, so this only speaks when that path will not.
  if (!values.agent) {
    const evidence = agentSkillEvidence(cwd);
    notes.push(...evidence.links.map(keptLink));
    for (const skill of evidence.skills) {
      if (!skill.current && skill.removable) notes.push(`leftover ${skill.dir}; run tickmarkr init --agent to remove it`);
      notes.push(...skill.leftovers.map((path) => `leftover ${path}; run tickmarkr init --agent${skill.removable ? " --force" : ""} to remove it`));
      notes.push(...skill.unproven.map((path) => `kept ${path} (unproven)`));
    }
    for (const d of skillDrift(cwd)) {
      notes.push(`stale ${join(d.dir, "SKILL.md")} — ${describeDrift(d)}; run tickmarkr init --agent --force to refresh it`);
    }
  }
  // Same reasoning, one layer up — and the refresh command is `--agent --force`, the same one the skill
  // note names. `--docs` governs only the APPEND path for a repo with no block yet; replacing an existing
  // block is gated on force (see the marked-region branch in installAgentFiles). Naming `--docs` here
  // would send the reader to a flag that silently does nothing for the case they are in.
  if (!(values.agent && values.force)) {
    for (const docPath of docsDrift(cwd)) {
      notes.push(`stale ${docPath} — its tickmarkr guidance block does not match this version; run tickmarkr init --agent --force to refresh it`);
    }
  }

  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const interactive = input.isTTY === true && output.isTTY === true && !(values.yes ?? false);

  // Act 1 — preferences. Only when the repo config does not exist yet: init never rewrites an
  // operator's config; re-tuning is `tickmarkr fleet` (act 3 below still runs). Act 1 writes only
  // project execution preferences; model choices are act 3's, saved by Fleet's one destination rule:
  // the USER overlay (B2), except a membership edit the repo overlay holds (T10).
  if (!repoConfigExists) {
    if (interactive) {
      emitBanner();
      const wizard = await runInitWizard(cwd, input, output);
      if (wizard === null) {
        // Operator field report 2026-08-13: quit means QUIT — no probe, no report wall, no fleet
        // act, one line out. Scaffolding above already happened (spec/global config), and saying
        // so costs one clause; everything else stops here. Esc and ctrl+c both land here.
        return `init: wizard quit — nothing further run (scaffolding kept: ${notes.filter((n) => n.startsWith("wrote")).length} file(s) written above). Re-run tickmarkr init to continue.`;
      }
      const host = detectedHost();
      const renderedConfig = configTemplate(wizard.overlay).replace(
        /^driver: auto$/m,
        `driver: auto            # auto — resolves to ${host} here`,
      );
      writeFileSync(repoConfigPath, renderedConfig);
      notes.push(`wrote ${repoConfigPath}`);
      if (wizard.installSkills) {
        await installAgentFiles(cwd, values.force ?? false, wizard.installDocs || (values.docs ?? false), notes, env);
      }
    } else {
      writeFileSync(repoConfigPath, configTemplate());
      notes.push(`wrote ${repoConfigPath}`);
    }
  }

  // Act 2 — discovery. Doctor is the sensor (fleet never re-probes); runs after preferences so the
  // probe reads the config the operator just chose. Reuse keeps init fast; --fresh forces the probe.
  // Interactive journeys get the COMPACT surface (status rows + pointer) — the full matrix between
  // two TUIs was the operator's clutter report; non-TTY keeps the complete machine surface.
  const fresh = values.fresh ?? false;
  const adapters = allAdapters();
  const cfg = loadConfig(cwd, { globalDir: gdir });
  // Match the preflight's executable scope: a tier with no registered adapter cannot
  // receive a model probe. Its historical verdict must not trigger discovery forever.
  const probeCfg = { ...cfg, tiers: Object.fromEntries(adapters
    .filter((a) => cfg.tiers[a.id])
    .map((a) => [a.id, cfg.tiers[a.id]])) };
  const { reuse, ageMs, health } = initDoctorReuse(cwd, fresh, probeCfg);
  let doc = reuse && health && ageMs !== null
    ? interactive
      ? `using probe results from ${formatDoctorAgeForInit(ageMs)} ago — full matrix: tickmarkr doctor · refresh: init --fresh`
      : `using probe results from ${formatDoctorAgeForInit(ageMs)} ago — run tickmarkr doctor to refresh (or init --fresh)\n${formatDoctorReport(cwd, cfg, health, adapters, { wrote: false })}`
    : await doctor([], cwd, adapters, { banner: false, compact: interactive, globalDir: gdir });

  // Act 3 — fleet. The compact discovery surface prints BETWEEN the acts so the operator reads
  // what the fleet browser (and its presets overlay, raised on the first Shapes entry) ranks
  // with; the final summary then carries a pointer, not a repeat. Its confirmation is the shared
  // Fleet actuator's: a preset (routing.mode) lands in the user overlay (gdir), and so does every
  // choice except a routing.allow/deny membership edit this repo overlay holds — T10 writes that one
  // where it is effective, and the review names the destination before y.
  if (interactive) {
    output.write(`${doc}\n`);
    doc = "discovery shown above — full matrix any time with `tickmarkr doctor`";
    // Same lazy-Ink seam as fleet.ts: load the editor runtime up front so the assembler's
    // returned props need no startup-input capture window on this path.
    const { runFleetInkEditor } = await import("../../tui/ink/fleet-app.js");
    const editor = await assembleFleetEditor(cwd, allAdapters(), { input, output }, { globalDir: gdir, entry: "presets" });
    if ("unavailable" in editor) {
      notes.push(`fleet: ${editor.unavailable}`);
    } else {
      const result = await runFleetInkEditor(editor.props);
      notes.push(editor.commit(result));
    }
  }

  if (values.agent) await installAgentFiles(cwd, values.force ?? false, values.docs ?? false, notes, env);
  const next = nextSteps(cwd, SCAFFOLD_SPEC);
  // Queue row 243 (D-2141; D-2152): explain skipped guidance after next steps on either surface.
  const guidedSetupHint = !interactive && !values.yes
    ? "guided setup skipped (no interactive terminal): run `! tkr init` yourself, or in a visible pane"
    : null;
  if (!visual()) return `${notes.join("\n")}\n${doc}\n${next}${guidedSetupHint ? `\n${guidedSetupHint}` : ""}\n${ENVIRONMENTS_FOOTER}`;

  const noteRows = notes.map((note) => `  ${statusRow(
    /^(?:wrote|overwrote|appended|rewrote)/.test(note) ? "pass" : note.startsWith("skipped") ? "warn" : "neutral",
    note,
  )}`);
  const footerRows = ENVIRONMENTS_FOOTER.split("\n").slice(1).map((line) => {
    const separator = line.indexOf(" — ");
    return kvRow(line.slice(2, separator), line.slice(separator + 1), 12);
  });
  return [
    title("tickmarkr init"),
    legend("· setup notes"),
    rule(),
    ...noteRows,
    doc,
    title("next steps"),
    legend("· continue from the repository's current state"),
    rule(),
    kvRow("next", next.replace(/^next:\s*/, "")),
    ...(guidedSetupHint ? [`  ${guidedSetupHint}`] : []),
    legend("environments:"),
    ...footerRows,
  ].join("\n");
}
