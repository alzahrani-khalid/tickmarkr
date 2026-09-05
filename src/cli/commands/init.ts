import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { allAdapters, formatDoctorAgeForInit, formatDoctorReport, initDoctorReuse } from "../../adapters/registry.js";
import { configTemplate, DEFAULT_CONFIG, globalConfigDir, loadConfig, type TickmarkrConfig, type InitConfigOverlay } from "../../config/config.js";
import { LEGACY_PREFIX, specTemplate } from "../../compile/native.js";
import { BANNER, kvRow, legend, rule, statusRow, title } from "../../brand.js";
import { tickmarkrDir } from "../../graph/graph.js";
import { orcaHostDetected } from "../../drivers/index.js";
import { Journal, type JournalEvent } from "../../run/journal.js";
import { runLockRunId, runStatusLine } from "../../run/lock.js";
import { doctor } from "./doctor.js";
import { assembleFleetEditor } from "./fleet.js";

const SCAFFOLD_SPEC = "tickmarkr.spec.md";

// Operator-approved (2026-07-17) environments footer — no npm install for herdr (npm package
// "herdr" is a reserved 0.0.0 placeholder as of that date). Auto resolves herdr → orca →
// subprocess; the orca leg is environment-only, using the two markers Orca stamps in its terminals.
const ENVIRONMENTS_FOOTER = [
  "environments:",
  "  herdr — the full cockpit — every worker, judge, and consult is a visible pane you can watch and unblock · https://herdr.dev · auto picks it first when HERDR_ENV=1",
  "  orca — visible terminals in the Orca app — auto picks it inside an Orca terminal after herdr and before subprocess; set driver: orca to force it · https://onorca.dev",
  "  claude code — tickmarkr init --agent installs the /tkr skills + AGENTS.md so Claude Code (or any agent CLI) drives the loop natively",
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

### Commands

- \`tickmarkr compile <spec>\` — spec → RunGraph
- \`tickmarkr plan\` — routing table and human gates
- \`tickmarkr run\` — execute the graph
- \`tickmarkr status <runId>\` — run progress
- \`tickmarkr resume <runId>\` — continue a paused or failed run
- \`tickmarkr approve <runId> <taskId>\` — release a human gate
- \`tickmarkr report <runId> --md\` — execution record beside the spec
- \`tickmarkr verify --base <ref>\` — run the gate battery standalone against merge-base(base, HEAD)..HEAD: no daemon, no retries, one fail-closed verdict (\`--criteria <file>\` or \`--task <id>\` adds the semantic gates; \`--no-review\` for deterministic-only)

Loop: compile → plan → run → report. Watch the journal for run-end rather than polling workers.

### Role check (multi-agent environments)

- **Orchestrator:** run the loop in your session; do not start a second run.
- **Supervisor with a live orchestrator:** relay the mission via verified handoff (below), then supervise — do not duplicate the loop.
- **Primary session without an orchestrator:** spawn one child orchestration session, give it the mission and these rules, then supervise.

Outside multi-agent environments, run the loop directly.

### Version preflight

Before \`tickmarkr compile\` or \`tickmarkr run\`: run \`tickmarkr version\`, read \`package.json\` version, and stop if the versions differ anywhere (major, minor, or patch); the binary and repository must agree on the entire version, so binary \`2.1.0\` versus repository \`2.1.1\` is a stop. Tell the operator to update or link the correct binary. Never proceed on hope — stale binaries silently skip daemon gates. Also verify no run is live in this repository before starting one: lead with this repository's \`.tickmarkr/graph.lock\`, read its holder pid, and treat it as live until \`kill -0 <pid>\` proves that holder dead. Never require a machine-wide process pattern to be empty: a lawful run in another repository — or the probing shell's own argv — can match. If you use a process probe as secondary evidence, exclude the probing process, resolve every candidate's own cwd (for example with \`lsof -a -p <pid> -d cwd\`), and count only candidates whose cwd is this repository root.

### Tip-verify-before-green

A run is green only when ALL of these hold: the run-end event exists in the journal, tip verify is not "failed", AND the run-end summary's \`failed\`, \`human\`, \`blocked\` and \`pending\` buckets are every one of them empty. The shorter "run-end plus tip verify" form is NOT sufficient: a run ending \`done=[T1,T3,T4] human=[T2] tipVerify=passed\` is a closed PARTIAL run — three of four delivered, one parked — and calling it green is how a park becomes invisible. Never report green to the operator, tab titles, or records until every clause holds; when one does not, name the bucket that is not empty.

### Verified handoffs

When relaying missions between agents, never use bare send-text (\`herdr agent send\` / pane send-text) — it omits Enter. Use \`herdr pane run <pane> "<message>"\` or \`herdr notification show "<message>"\`. Confirm delivery by reading the target pane afterward; never report "relayed" without read-back.

### Orient before you act — this block may be the ONLY guidance your host loaded

These same bytes are written into EVERY repository guidance file this project has, because hosts disagree
about which one they read: some load only \`AGENTS.md\`, some also load a repo-level guidance file, some load
a user-level one instead. **Anything stated in only one file is invisible to some agent.** So do not assume
you were handed the whole picture — list the repository root, open every guidance file present, and then:

- **Read your host's PROJECT MEMORY before starting.** Hosts that keep one store it under a per-project
  state directory keyed by the absolute working-directory path; find it and read its index plus every entry
  whose name concerns METHOD or DISCIPLINE. It holds rules that cost real defects to learn. Entries may
  predate a project rename, so **search by CONCEPT, not by the current product name.** A memory nobody opens
  is worse than none: every seat assumes the lesson is recorded somewhere and no seat looks.
- **The gates are the product.** Seven, defined in \`src/graph/schema.ts\`:
  \`build test lint evidence scope acceptance review\`. **That is DECLARATION order, not execution order** —
  the first five run as a battery that stops at its first red, then \`acceptance\` and \`review\` run
  CONCURRENTLY (\`run-gates.ts:39\`, *"judge ‖ review"*). The first five are MANDATORY; only \`acceptance\` and
  \`review\` may be omitted per task. Implementations are in \`src/gates/\` — \`baseline.ts\` (build/test/lint,
  diffed against a recorded baseline so pre-existing failures are forgiven), \`evidence.ts\`, \`scope.ts\`,
  \`acceptance.ts\` (its judge reads the DIFF and every criterion must cite a changed hunk), \`review.ts\`
  (cross-vendor). \`run-gates.ts\` drives them. **A declared gate is not a passed gate, and a gate that
  returned zero findings is not the same as a gate that ran.**
- **Spec-authoring law ships in the spec template** that \`tickmarkr init\` writes: the hard bounds and which
  direction each moves, what makes a criterion real, and why an absence or a source-text grep is never a
  criterion. Read it before authoring or repairing acceptance items.
- **Editing \`src/gates/\`, \`src/compile/\` or \`src/graph/\`?** Read \`docs/codebase/ARCHITECTURE.md\` first.
${DOCS_END}
`;

// Every applicable host location gets the skills, each paired with its own repository guidance
// file: codex discovers .agents/skills + AGENTS.md (always applicable); claude discovers
// .claude/skills + CLAUDE.md (applicable when the repo already shows claude usage).
const hostTargets = (cwd: string) => {
  const targets = [{ skillsDir: join(cwd, ".agents", "skills"), docPath: join(cwd, "AGENTS.md") }];
  if (existsSync(join(cwd, ".claude")) || existsSync(join(cwd, "CLAUDE.md")))
    targets.push({ skillsDir: join(cwd, ".claude", "skills"), docPath: join(cwd, "CLAUDE.md") });
  return targets;
};
const packagedSkillDir = (skill: string) => fileURLToPath(new URL(`../../../skills/${skill}`, import.meta.url));

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

// Drift is only computed for skills that ARE installed. A skill never installed is not drift — `--agent`
// installs it and says so, and nagging about it would bury the case this exists for.
function skillDrift(cwd: string): SkillDrift[] {
  const drifted: SkillDrift[] = [];
  for (const { skillsDir } of hostTargets(cwd)) {
    for (const skill of AGENT_SKILLS) {
      const dir = join(skillsDir, skill);
      if (!existsSync(join(dir, "SKILL.md"))) continue;
      const src = packagedSkillDir(skill);
      const missing: string[] = [];
      const modified: string[] = [];
      for (const rel of skillFileList(src)) {
        // readFileSync resolves symlinks, so a symlinked mirror compares equal to a copied one.
        if (!existsSync(join(dir, rel))) missing.push(rel);
        else if (!readFileSync(join(dir, rel)).equals(readFileSync(join(src, rel)))) modified.push(rel);
      }
      if (missing.length || modified.length) drifted.push({ skill, dir, missing, modified });
    }
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
const docsDrift = (cwd: string): string[] =>
  hostTargets(cwd).map(({ docPath }) => docPath).filter((docPath) => {
    if (!existsSync(docPath)) return false;
    const current = readFileSync(docPath, "utf8");
    const begin = current.indexOf(DOCS_BEGIN);
    if (begin < 0) return false; // no block installed here — --docs writes one, that is not drift
    const end = current.indexOf(DOCS_END, begin);
    if (end < 0) return true; // a truncated block is stale by definition
    return current.slice(begin, end + DOCS_END.length) !== AGENT_DOCS.trimEnd();
  });

const describeDrift = (d: SkillDrift) => [
  d.missing.length ? `missing ${d.missing.join(", ")}` : "",
  d.modified.length ? `modified ${d.modified.join(", ")}` : "",
].filter(Boolean).join(", ");

// PRESENCE, deliberately — the wizard's question is "install these?", and a repo that already has them
// should not be asked again just because a copy drifted. Staleness is a different question with a
// different answer (`--agent --force`), and it is reported by name on every init path below.
const skillsInstalled = (cwd: string) =>
  hostTargets(cwd).every((t) => AGENT_SKILLS.every((s) => existsSync(join(t.skillsDir, s, "SKILL.md"))));
const wizardDriverDefault = (): TickmarkrConfig["driver"] => process.env.HERDR_ENV === "1" ? "herdr" : orcaHostDetected() ? "orca" : "auto";

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
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", rel], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function installAgentFiles(cwd: string, force: boolean, docs: boolean, notes: string[]): Promise<void> {
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
    const drift = skillDrift(cwd);
    for (const { skillsDir, docPath } of hostTargets(cwd)) {
      for (const skill of AGENT_SKILLS) {
        const dest = join(skillsDir, skill, "SKILL.md");
        const exists = existsSync(dest);
        const stale = drift.find((d) => d.dir === join(skillsDir, skill));
        // An install that already matches the package byte for byte needs no prompt and no write. Before
        // this, every re-init asked to overwrite a current skill and the answer meant nothing either way.
        if (exists && !stale) {
          notes.push(`kept current ${dest}`);
          continue;
        }
        const tracked = exists && gitTracked(cwd, dest);
        if (exists && !force && !(await confirm(`Overwrite ${dest} (${describeDrift(stale!)})?`))) {
          notes.push(`skipped existing ${tracked ? "tracked " : ""}${dest} — ${describeDrift(stale!)}; pass --force to overwrite it`);
          continue;
        }
        // whole skill dir, not just SKILL.md — the overseer ships its pane-watcher script
        cpSync(fileURLToPath(new URL(`../../../skills/${skill}`, import.meta.url)), join(skillsDir, skill), { recursive: true });
        notes.push(`${exists ? "overwrote" : "wrote"} ${tracked ? "tracked " : ""}${dest}`);
      }

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
      skillsDefault: existsSync(join(cwd, ".claude", "skills")) && !skillsInstalled(cwd),
    },
    input,
    output,
  });
  if (result.kind === "quit") return null;
  return { overlay: result.overlay, installSkills: result.installSkills, installDocs: result.installDocs };
}

/** Test seam mirroring FleetIO: production callers omit it and get the process streams. */
export type InitIO = { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream };

export async function init(argv: string[], cwd = process.cwd(), io: InitIO = {}): Promise<string> {
  let bannerEmitted = false;
  const emitBanner = () => {
    if (visual() && !bannerEmitted) {
      bannerEmitted = true;
      process.stdout.write(BANNER);
    }
  };

  const { values } = parseArgs({
    args: argv,
    options: {
      "global-dir": { type: "string" },
      agent: { type: "boolean" },
      force: { type: "boolean" },
      docs: { type: "boolean" },
      fresh: { type: "boolean" },
      yes: { type: "boolean" },
    },
  });
  // banner at START on the visual surface — every init path, not just the wizard, and never trailing the probe (operator report 2026-07-17)
  emitBanner();
  if (packageName(cwd) === "tickmarkr") {
    throw new Error("OBS-584: tickmarkr init refuses to run inside the tickmarkr source repository");
  }
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
  if (repoConfigExists) notes.push(`kept existing ${repoConfigPath}`);

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
  // operator's config; re-tuning is `tickmarkr fleet` (act 3 below still runs and writes overlays).
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
      writeFileSync(repoConfigPath, configTemplate(wizard.overlay));
      notes.push(`wrote ${repoConfigPath}`);
      if (wizard.installSkills) {
        await installAgentFiles(cwd, values.force ?? false, wizard.installDocs || (values.docs ?? false), notes);
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
  const { reuse, ageMs, health } = initDoctorReuse(cwd, fresh);
  let doc = reuse && health && ageMs !== null
    ? interactive
      ? `using probe results from ${formatDoctorAgeForInit(ageMs)} ago — full matrix: tickmarkr doctor · refresh: init --fresh`
      : `using probe results from ${formatDoctorAgeForInit(ageMs)} ago — run tickmarkr doctor to refresh (or init --fresh)\n${formatDoctorReport(cwd, loadConfig(cwd), health, allAdapters(), { wrote: false })}`
    : await doctor([], cwd, undefined, { banner: false, compact: interactive });

  // Act 3 — fleet. The compact discovery surface prints BETWEEN the acts so the operator reads
  // what the fleet browser (and its presets overlay, raised on the first Shapes entry) ranks
  // with; the final summary then carries a pointer, not a repeat.
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

  if (values.agent) await installAgentFiles(cwd, values.force ?? false, values.docs ?? false, notes);
  const next = nextSteps(cwd, SCAFFOLD_SPEC);
  if (!visual()) return `${notes.join("\n")}\n${doc}\n${next}\n${ENVIRONMENTS_FOOTER}`;

  const noteRows = notes.map((note) => `  ${statusRow(
    /^(?:wrote|overwrote|appended)/.test(note) ? "pass" : note.startsWith("skipped") ? "warn" : "neutral",
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
    legend("environments:"),
    ...footerRows,
  ].join("\n");
}
