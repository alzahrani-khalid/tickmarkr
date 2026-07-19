import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { allAdapters, formatDoctorAgeForInit, formatDoctorReport, initDoctorReuse } from "../../adapters/registry.js";
import { configTemplate, DEFAULT_CONFIG, globalConfigDir, loadConfig, type TickmarkrConfig, type InitConfigOverlay } from "../../config/config.js";
import { LEGACY_PREFIX, specTemplate } from "../../compile/native.js";
import { BANNER, kvRow, legend, rule, statusRow, title } from "../../brand.js";
import { tickmarkrDir } from "../../graph/graph.js";
import { Journal } from "../../run/journal.js";
import { doctor } from "./doctor.js";

const SCAFFOLD_SPEC = "tickmarkr.spec.md";

// Operator-approved (2026-07-17) environments footer — three rows; no npm install for herdr
// (npm package "herdr" is a reserved 0.0.0 placeholder as of that date).
const ENVIRONMENTS_FOOTER = [
  "environments:",
  "  herdr — the full cockpit — every worker, judge, and consult is a visible pane you can watch and unblock · https://herdr.dev",
  "  claude code — tickmarkr init --agent installs the /tkr skills + AGENTS.md so Claude Code (or any agent CLI) drives the loop natively",
  "  anywhere — no herdr? same fail-closed gates, headless subprocess driver",
].join("\n");

/** Latest journal without a run-end event, if any. */
function activeRunId(cwd: string): string | null {
  const runId = Journal.latestRunId(cwd, { withJournal: true });
  if (!runId) return null;
  try {
    const events = Journal.open(cwd, runId).read();
    if (events.some((e) => e.event === "run-end")) return null;
    return runId;
  } catch {
    return null;
  }
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
  const runId = activeRunId(cwd);
  if (runId) return `run ${runId} active — tickmarkr status`;

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

Loop: compile → plan → run → report. Watch the journal for run-end rather than polling workers.

### Role check (multi-agent environments)

- **Orchestrator:** run the loop in your session; do not start a second run.
- **Supervisor with a live orchestrator:** relay the mission via verified handoff (below), then supervise — do not duplicate the loop.
- **Primary session without an orchestrator:** spawn one child orchestration session, give it the mission and these rules, then supervise.

Outside multi-agent environments, run the loop directly.

### Version preflight

Before \`tickmarkr compile\` or \`tickmarkr run\`: run \`tickmarkr version\`, read \`package.json\` version, and if the binary is older on major.minor, stop and tell the operator to update. Never proceed on hope — stale binaries silently skip daemon gates.

### Tip-verify-before-green

A run is green only when the run-end event exists in the journal AND tip verify is not "failed". Never report green to the operator, tab titles, or records until both hold.

### Verified handoffs

When relaying missions between agents, never use bare send-text (\`herdr agent send\` / pane send-text) — it omits Enter. Use \`herdr pane run <pane> "<message>"\` or \`herdr notification show "<message>"\`. Confirm delivery by reading the target pane afterward; never report "relayed" without read-back.
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
const skillsInstalled = (cwd: string) =>
  hostTargets(cwd).every((t) => AGENT_SKILLS.every((s) => existsSync(join(t.skillsDir, s, "SKILL.md"))));
const wizardDriverDefault = (): TickmarkrConfig["driver"] => process.env.HERDR_ENV === "1" ? "herdr" : "auto";

async function installAgentFiles(cwd: string, force: boolean, docs: boolean, notes: string[]): Promise<void> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  let prompt: Interface | undefined;
  const confirm = async (question: string) => {
    if (!interactive) return false;
    prompt ??= createInterface({ input: process.stdin, output: process.stdout });
    return /^(?:y|yes)$/i.test((await prompt.question(`${question} [y/N] `)).trim());
  };

  try {
    for (const { skillsDir, docPath } of hostTargets(cwd)) {
      for (const skill of AGENT_SKILLS) {
        const dest = join(skillsDir, skill, "SKILL.md");
        const exists = existsSync(dest);
        if (exists && !force && !(await confirm(`Overwrite ${dest}?`))) {
          notes.push(`skipped existing ${dest}; pass --force to overwrite it`);
          continue;
        }
        // whole skill dir, not just SKILL.md — the overseer ships its pane-watcher script
        cpSync(fileURLToPath(new URL(`../../../skills/${skill}`, import.meta.url)), join(skillsDir, skill), { recursive: true });
        notes.push(`${exists ? "overwrote" : "wrote"} ${dest}`);
      }

      const current = existsSync(docPath) ? readFileSync(docPath, "utf8") : "";
      if (current.includes(DOCS_BEGIN) || current.includes(`<!-- ${LEGACY_PREFIX}:agent-docs begin -->`)
        || current.includes(DOCS_END) || current.includes(`<!-- ${LEGACY_PREFIX}:agent-docs end -->`)) {
        notes.push(`kept existing tickmarkr agent docs in ${docPath}`);
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

const askDefault = async (rl: Interface, label: string, def: string) => {
  const answer = (await rl.question(`${label} [${def}] `)).trim();
  return answer || def;
};

const askYesNo = async (rl: Interface, label: string, def: boolean) => {
  const hint = def ? "Y/n" : "y/N";
  const answer = (await rl.question(`${label} [${hint}] `)).trim();
  if (!answer) return def;
  return /^(?:y|yes)$/i.test(answer);
};

async function runInitWizard(cwd: string): Promise<{ overlay: InitConfigOverlay; installSkills: boolean }> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const driverDef = wizardDriverDefault();
    const driverRaw = await askDefault(rl, "Driver (auto|herdr|subprocess)", driverDef);
    const driver: TickmarkrConfig["driver"] = (["auto", "herdr", "subprocess"] as const).includes(driverRaw as TickmarkrConfig["driver"])
      ? driverRaw as TickmarkrConfig["driver"]
      : driverDef;

    const concRaw = await askDefault(rl, "Concurrency", String(DEFAULT_CONFIG.concurrency));
    const parsed = Number.parseInt(concRaw, 10);
    const concurrency = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CONFIG.concurrency;

    const llmDef = DEFAULT_CONFIG.visibility.llm;
    const llmRaw = await askDefault(rl, "visibility.llm (pane|headless)", llmDef);
    const llm = llmRaw === "pane" || llmRaw === "headless" ? llmRaw : llmDef;

    let installSkills = false;
    if (!skillsInstalled(cwd)) {
      const skillsDef = existsSync(join(cwd, ".claude", "skills")) && !skillsInstalled(cwd);
      installSkills = await askYesNo(rl, "Install agent skills (tickmarkr-loop/tickmarkr-auto/tickmarkr-overseer)?", skillsDef);
    }

    return { overlay: { driver, concurrency, visibility: { llm } }, installSkills };
  } finally {
    rl.close();
  }
}

export async function init(argv: string[], cwd = process.cwd()): Promise<string> {
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

  const fresh = values.fresh ?? false;
  const { reuse, ageMs, health } = initDoctorReuse(cwd, fresh);
  const doc = reuse && health && ageMs !== null
    ? `using probe results from ${formatDoctorAgeForInit(ageMs)} ago — run tickmarkr doctor to refresh (or init --fresh)\n${formatDoctorReport(cwd, loadConfig(cwd), health, allAdapters(), { wrote: false })}`
    : await doctor([], cwd, undefined, { banner: false });

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true && !(values.yes ?? false);
  if (!repoConfigExists) {
    if (interactive) {
      emitBanner();
      const wizard = await runInitWizard(cwd);
      writeFileSync(repoConfigPath, configTemplate(wizard.overlay));
      notes.push(`wrote ${repoConfigPath}`);
      if (wizard.installSkills) await installAgentFiles(cwd, values.force ?? false, values.docs ?? false, notes);
    } else {
      writeFileSync(repoConfigPath, configTemplate());
      notes.push(`wrote ${repoConfigPath}`);
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
