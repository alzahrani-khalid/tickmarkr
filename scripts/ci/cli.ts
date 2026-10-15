// v2.7.8 T1 — the one scripts/ci entry point (SHARED CONVENTIONS): `scripts/ci/cli.ts <mode>`,
// run through the repository's own tsx. Nothing imports this file; later tasks add modes here.
// Every verdict mode prints its closed format to stdout and exits 0 GREEN, 1 RED, 2 UNREADABLE —
// any validation failure fails closed to UNREADABLE with its counts unknowable.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { checkFloors, FLOOR_METRICS, loadFloors, parseSummary, renderFloors, UNREADABLE_FLOORS_LINE, type SummaryEntry } from "./floors.js";
import { isRecord, jsonLine, readJson } from "./json.js";
import { type CiRecord, headOf, parseRecord, type RecordUnhandled } from "./reporter.js";
import { isCanonicalPath, lptShards, readDurations, renderDurations, rootRelative, type ShardItem } from "./shard.js";

/** Write `text` to `path` through a temporary file and one rename, so a reader never sees a partial file. */
const writeAtomic = (path: string, text: string): void => {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
};

// v2.8.2 T1 — `floors <summary> [--out <file>]`: with --out the producer writes the same lines it prints to
// <file> itself (temp file, then rename), so the proof reads the floors step's own sidecar and no pipe or tee
// can mask its status. The exit status is the verdict's (0, 1, 2); a sidecar that cannot be written is 2.
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const runFloors = async (args: readonly string[]): Promise<number> => {
  const at = args.indexOf("--out");
  const out = at === -1 ? undefined : args[at + 1];
  const rest = at === -1 ? args : args.filter((_, i) => i !== at && i !== at + 1);
  let outcome: { lines: string[]; exitCode: number };
  try {
    if (at !== -1 && (out === undefined || out === "" || args.lastIndexOf("--out") !== at)) throw new Error("--out takes exactly one file path");
    if (rest.length !== 1) throw new Error(`floors takes exactly one summary path, got ${rest.length}`);
    const root = process.cwd();
    const floors = await loadFloors(root);
    const entries = parseSummary(readJson(readFileSync(resolve(root, rest[0]!), "utf8")));
    outcome = renderFloors(checkFloors(floors, entries, root));
  } catch (error) {
    // fail closed: the counts a broken input leaves unknowable print as UNREADABLE
    console.error(`floors: ${message(error)}`);
    outcome = { lines: [UNREADABLE_FLOORS_LINE], exitCode: 2 };
  }
  if (out !== undefined && out !== "") {
    try {
      writeAtomic(resolve(out), outcome.lines.map((line) => `${line}\n`).join(""));
    } catch (error) {
      console.error(`floors: cannot write ${out}: ${message(error)}`);
      outcome = { lines: [UNREADABLE_FLOORS_LINE], exitCode: 2 };
    }
  }
  for (const line of outcome.lines) console.log(line);
  return outcome.exitCode;
};

// v2.7.8 T2 — `durations <record>...`: per path the rounded mean durationMs over its finished (passed,
// failed, skipped) entries, minimum 1, printed as FORMAT F1. Not a verdict mode: a malformed record
// exits 2 with EMPTY stdout, so a redirect into scripts/ci/durations.json never holds a partial table.
const FINISHED = new Set(["passed", "failed", "skipped"]);
const runDurations = async (args: readonly string[]): Promise<number> => {
  try {
    if (args.length === 0) throw new Error("durations takes at least one record path");
    const totals = new Map<string, { sum: number; n: number }>();
    for (const path of args) {
      for (const entry of parseRecord(readJson(readFileSync(resolve(path), "utf8")), path).files) {
        if (!FINISHED.has(entry.state)) continue;
        const total = totals.get(entry.file) ?? { sum: 0, n: 0 };
        totals.set(entry.file, { sum: total.sum + entry.durationMs, n: total.n + 1 });
      }
    }
    const durationsMs: Record<string, number> = Object.create(null);
    for (const [file, { sum, n }] of totals) {
      if (!Number.isSafeInteger(sum)) throw new Error(`${file}: summed durationMs exceeds a safe integer`);
      durationsMs[file] = Math.max(1, Math.round(sum / n));
    }
    const table = renderDurations(durationsMs);
    // flushed before the caller's process.exit: an asynchronous pipe could otherwise drop the tail
    await new Promise<void>((done) => process.stdout.write(table, () => done()));
    return 0;
  } catch (error) {
    console.error(`durations: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
};

const loadRecord = (path: string): CiRecord => parseRecord(readJson(readFileSync(resolve(path), "utf8")), path);
// one write, flushed before the caller's process.exit (see runDurations)
const emit = (lines: readonly string[]) =>
  new Promise<void>((done) => process.stdout.write(lines.map((line) => `${line}\n`).join(""), () => done()));
const UNREADABLE = "UNREADABLE";

// v2.7.8 T3 — `contract --record <path> -- <command...>` (FORMAT F4): ONE invocation held to its plan as a SET
// of {file, project} (G5). The command must match the CLOSED GRAMMAR below. SHARDED (one --shard): the plan is
// lptShards over Vitest's own discovery (`vitest list --filesOnly --json`) of the command's projects and
// readDurations — the partition the root sequencer applies — and the record's shard must equal the command's.
// UNSHARDED (v2.8.2 T1, no --shard): the plan is that discovery itself, every declared --project selector must
// select at least one discovered file as Vitest matches it (`empty-project`), and the record's shard must be null.
// scripts/run-ci-vitest.sh calls it at status 0 and 1 of every invocation.
type Defect = Record<string, unknown> & { kind: string };
const COMMAND_FORMS = [["npm", "run", "test:coverage", "--"], ["npx", "vitest", "run"]] as const;
const CANONICAL_SHARD = /^([1-9][0-9]*)\/([1-9][0-9]*)$/;
const argvDefect = (token: string | null, reason: string): Defect => ({ kind: "argv", token, reason });

/** CLOSED GRAMMAR: a COMMAND_FORMS prefix, then any `--project p` / `--project=p` and at most one canonical `--shard=k/n` / `--shard k/n`;
 * no shard argument is the unsharded form (shard null, no defect). */
export function parseShardCommand(command: readonly string[]): { projects: string[]; shard: { index: number; count: number } | null; defects: Defect[] } {
  let matched = 0;
  while (COMMAND_FORMS.some((form) => matched < form.length && form.slice(0, matched + 1).every((token, i) => command[i] === token))) matched++;
  if (!COMMAND_FORMS.some((form) => form.length === matched && form.every((token, i) => command[i] === token))) {
    return { projects: [], shard: null, defects: [argvDefect(command[matched] ?? null, "the command is neither `npm run test:coverage -- <args>` nor `npx vitest run <args>`")] };
  }
  const projects: string[] = [];
  const shards: { token: string; value: string }[] = [];
  const defects: Defect[] = [];
  for (let i = matched; i < command.length; i++) {
    const token = command[i]!;
    if (token === "--project" || token === "--shard") {
      const value = command[i + 1];
      if (value === undefined || value === "" || value.startsWith("-")) {
        defects.push(argvDefect(token, `${token} needs a value`));
        continue;
      }
      i++;
      if (token === "--project") projects.push(value);
      else shards.push({ token: `${token} ${value}`, value });
    } else if (token.startsWith("--project=") && token.length > "--project=".length) projects.push(token.slice("--project=".length));
    else if (token.startsWith("--shard=")) shards.push({ token, value: token.slice("--shard=".length) });
    else defects.push(argvDefect(token, "not a --project or --shard argument"));
  }
  let shard: { index: number; count: number } | null = null;
  for (const [n, { token, value }] of shards.entries()) {
    const match = CANONICAL_SHARD.exec(value);
    const [index, count] = match ? [Number(match[1]), Number(match[2])] : [Number.NaN, Number.NaN];
    if (n > 0) defects.push(argvDefect(token, "a second shard argument"));
    else if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index > count) defects.push(argvDefect(token, "not a canonical k/n shard with 1 <= k <= n"));
    else shard = { index, count };
  }
  return { projects, shard: defects.length === 0 ? shard : null, defects };
}

/** FORMAT F3: Vitest's own `vitest list --filesOnly --json=<tmp>` of `projects` in `root`, without the record variable. */
function discover(root: string, projects: readonly string[]): ShardItem[] {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-shard-contract-"));
  try {
    const out = join(dir, "files.json");
    const env = { ...process.env };
    delete env.TICKMARKR_CI_RECORD;
    const args = ["vitest", "list", "--filesOnly", `--json=${out}`, ...projects.flatMap((project) => ["--project", project])];
    const run = spawnSync("npx", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
    if (run.status !== 0) throw new Error(`discovery \`npx ${args.join(" ")}\` exited ${run.status ?? run.signal}: ${(run.stderr ?? "").trim() || String(run.error ?? "")}`);
    const doc = readJson(readFileSync(out, "utf8"));
    if (!Array.isArray(doc)) throw new Error("discovery output is not a JSON array");
    const seen = new Set<string>();
    return doc.map((entry, i): ShardItem => {
      if (!isRecord(entry) || typeof entry.file !== "string" || !isAbsolute(entry.file)) throw new Error(`discovery entry ${i} has no absolute file`);
      if (typeof entry.projectName !== "string" || entry.projectName === "") throw new Error(`discovery entry ${i} (${entry.file}) has no projectName`);
      const file = rootRelative(root, entry.file);
      if (!isCanonicalPath(file)) throw new Error(`discovery entry ${i}: ${entry.file} lies outside ${root}`);
      const key = `${file}\0${entry.projectName}`;
      if (seen.has(key)) throw new Error(`discovery lists ${file} in ${entry.projectName} twice`);
      seen.add(key);
      return { file, project: entry.projectName };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A `--project` selector as Vitest 3.2.7 matches it (wildcardPatternToRegExp): `*` is any run of characters, a
 * leading `!` negates, and the whole name matches case-insensitively — so `suite*`, `*` and `!other` own what they select. */
const projectSelector = (pattern: string): RegExp => {
  const negated = pattern.startsWith("!");
  const body = `${(negated ? pattern.slice(1) : pattern).split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`;
  return new RegExp(`^${negated ? `(?!${body})` : body}`, "i");
};

const runContract = async (args: readonly string[]): Promise<number> => {
  const defects: Defect[] = [];
  let shard = UNREADABLE;
  let planned: number | string = UNREADABLE;
  let recorded: number | string = UNREADABLE;
  let verdict: "GREEN" | "RED" | "UNREADABLE" = "UNREADABLE";
  try {
    if (args[0] !== "--record" || args[1] === undefined || args[2] !== "--" || args.length < 4) throw new Error("usage: contract --record <path> -- <command...>");
    const parsed = parseShardCommand(args.slice(3));
    defects.push(...parsed.defects);
    if (parsed.defects.length > 0) throw new Error("the command is outside the closed grammar");
    shard = parsed.shard === null ? "none" : `${parsed.shard.index}/${parsed.shard.count}`;
    const root = process.cwd();
    const discovered = discover(root, parsed.projects);
    let plan: ShardItem[];
    if (parsed.shard === null) {
      plan = discovered;
      for (const project of new Set(parsed.projects)) {
        const selects = projectSelector(project);
        if (!discovered.some((item) => selects.test(item.project))) defects.push({ kind: "empty-project", project });
      }
    } else {
      plan = lptShards(discovered, readDurations(root), parsed.shard.count)[parsed.shard.index - 1]!;
    }
    planned = plan.length;
    const record = loadRecord(args[1]);
    recorded = record.files.length;
    const recordedShard = record.shard && `${record.shard.index}/${record.shard.count}`;
    if ((recordedShard ?? "none") !== shard) {
      defects.push({ kind: "shard-mismatch", expected: shard, recorded: recordedShard });
      throw new Error(`the record's shard is not ${shard}`);
    }
    const key = (item: ShardItem) => `${item.file}\0${item.project}`;
    const inPlan = new Set(plan.map(key));
    const seen = new Map<string, number>();
    for (const { file, project, state } of record.files) {
      const k = key({ file, project });
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      if (n === 2) defects.push({ kind: "duplicate", file, project });
      if (n === 1 && !inPlan.has(k)) defects.push({ kind: "unexpected", file, project });
      if (!FINISHED.has(state)) defects.push({ kind: "unfinished", file, project, state });
    }
    for (const { file, project } of plan) if (!seen.has(key({ file, project }))) defects.push({ kind: "missing", file, project });
    verdict = defects.length === 0 ? "GREEN" : "RED";
  } catch (error) {
    console.error(`contract: ${message(error)}`);
  }
  const lines = defects.map((defect) => `SHARD_CONTRACT_DEFECT ${jsonLine(defect)}`).sort();
  await emit([...lines, `SHARD_CONTRACT verdict=${verdict} shard=${shard} planned=${planned} recorded=${recorded} defects=${lines.length}`]);
  return verdict === "GREEN" ? 0 : verdict === "RED" ? 1 : 2;
};

// v2.7.8 T3 — `assert <record>...` (FORMAT F5): the set oracle (G3) over checkManifest, which T6's parity reuses.
export interface ManifestCheck { expected: number; actual: number; defects: Defect[] }

/**
 * THE manifest check: the manifest is `git ls-files -z -- ':(glob)tests/**\/*.test.ts'` at `root`; every manifest
 * file must appear exactly once across `records`, finished (passed, failed, skipped: presence, not pass), in
 * records whose head equals HEAD (null never does). Throws when git cannot read the manifest or HEAD.
 */
export function checkManifest(root: string, records: readonly { source: string; record: CiRecord }[]): ManifestCheck {
  const listed = spawnSync("git", ["ls-files", "-z", "--", ":(glob)tests/**/*.test.ts"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
  if (listed.status !== 0) throw new Error(`git ls-files exited ${listed.status ?? listed.signal}: ${(listed.stderr ?? "").trim()}`);
  const head = headOf(root);
  if (head === null) throw new Error(`no HEAD at ${root}`);
  return manifestRules(new Set(listed.stdout.split("\0").filter((path) => path !== "")), head, records);
}

/** The checkManifest rules over a given manifest and head: shared by `assert` (the checkout) and `proof` (a commit). */
function manifestRules(manifest: ReadonlySet<string>, head: string, records: readonly { source: string; record: CiRecord }[]): ManifestCheck {
  const defects: Defect[] = [];
  const counts = new Map<string, number>();
  let actual = 0;
  for (const { source, record } of records) {
    if (record.head !== head) defects.push({ kind: "wrong-head", source, head: record.head, expected: head });
    for (const { file, project, state } of record.files) {
      actual++;
      if (manifest.has(file)) counts.set(file, (counts.get(file) ?? 0) + 1);
      else defects.push({ kind: "unknown", source, file, project });
      if (!FINISHED.has(state)) defects.push({ kind: "unfinished", source, file, project, state });
    }
  }
  for (const file of manifest) {
    const n = counts.get(file) ?? 0;
    if (n === 0) defects.push({ kind: "missing", file });
    if (n > 1) defects.push({ kind: "duplicate", file, count: n });
  }
  return { expected: manifest.size, actual, defects };
}

const runAssert = async (args: readonly string[]): Promise<number> => {
  const defects: Defect[] = [];
  let expected: number | string = UNREADABLE;
  let actual: number | string = UNREADABLE;
  let verdict: "GREEN" | "RED" | "UNREADABLE" = "UNREADABLE";
  try {
    if (args.length === 0) throw new Error("assert takes at least one record path");
    const records: { source: string; record: CiRecord }[] = [];
    for (const source of args) {
      try {
        records.push({ source, record: loadRecord(source) });
      } catch (error) {
        defects.push({ kind: "unreadable", source, error: message(error) });
      }
    }
    const check = checkManifest(process.cwd(), records);
    expected = check.expected;
    if (defects.length === 0) {
      actual = check.actual;
      defects.push(...check.defects);
      verdict = defects.length === 0 ? "GREEN" : "RED";
    }
  } catch (error) {
    console.error(`assert: ${message(error)}`);
  }
  const lines = defects.map((defect) => `SET_ORACLE_DEFECT ${jsonLine(defect)}`).sort();
  await emit([...lines, `SET_ORACLE verdict=${verdict} expected=${expected} actual=${actual} defects=${lines.length}`]);
  return verdict === "GREEN" ? 0 : verdict === "RED" ? 1 : 2;
};

// v2.7.8 T6 — compare two complete manifest forms and their coverage over one runner root.
type ParityForm = "serial" | "sharded";
type ParityArgs = { root: string; serial: string[]; sharded: string[]; serialCoverage: string; shardedCoverage: string };

function parseParityArgs(args: readonly string[]): ParityArgs {
  const values: Record<string, string[]> = Object.create(null);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!["--root", "--serial", "--sharded", "--serial-coverage", "--sharded-coverage"].includes(flag)) {
      throw new Error(`unknown parity argument ${flag}`);
    }
    const group = values[flag] ??= [];
    while (i + 1 < args.length && !args[i + 1]!.startsWith("--")) {
      const value = args[++i]!;
      if (value === "") throw new Error(`${flag} needs a nonempty value`);
      group.push(value);
      if (flag !== "--serial" && flag !== "--sharded") break;
    }
    if (group.length === 0) throw new Error(`${flag} needs a value`);
  }
  for (const flag of ["--root", "--serial-coverage", "--sharded-coverage"]) {
    if (values[flag]?.length !== 1) throw new Error(`${flag} must occur exactly once`);
  }
  for (const flag of ["--serial", "--sharded"]) {
    if (!values[flag]?.length) throw new Error(`${flag} needs at least one record`);
  }
  const root = values["--root"]![0]!;
  if (!isAbsolute(root)) throw new Error("--root must be absolute");
  return {
    root: resolve(root), serial: values["--serial"]!, sharded: values["--sharded"]!,
    serialCoverage: values["--serial-coverage"]![0]!, shardedCoverage: values["--sharded-coverage"]![0]!,
  };
}

function parityCoverage(root: string, source: string): Map<string, SummaryEntry> {
  const entries = parseSummary(readJson(readFileSync(resolve(source), "utf8")));
  const normalized = new Map<string, SummaryEntry>();
  for (const entry of entries) {
    const file = rootRelative(root, entry.path);
    if (!isCanonicalPath(file)) throw new Error(`${source}: source ${entry.path} lies outside --root`);
    if (normalized.has(file)) throw new Error(`${source}: source ${file} repeats after normalization`);
    normalized.set(file, { path: resolve(root, file), metrics: entry.metrics });
  }
  return normalized;
}

const runParity = async (args: readonly string[]): Promise<number> => {
  const defects: Defect[] = [];
  const notes: string[] = [];
  let files: number | string = UNREADABLE;
  let sources: number | string = UNREADABLE;
  let globs: number | string = UNREADABLE;
  let verdict: "GREEN" | "RED" | "UNREADABLE" = "UNREADABLE";
  let reading: ParityForm | "both" = "both";
  try {
    const input = parseParityArgs(args);
    const forms: Record<ParityForm, { source: string; record: CiRecord }[]> = { serial: [], sharded: [] };
    for (const form of ["serial", "sharded"] as const) {
      reading = form;
      for (const source of input[form]) forms[form].push({ source, record: loadRecord(source) });
    }
    reading = "both";
    // The same exported set oracle used by `assert` is authoritative for each form.
    const checkout = process.cwd();
    const serialCheck = checkManifest(checkout, forms.serial);
    const shardedCheck = checkManifest(checkout, forms.sharded);
    files = serialCheck.expected;
    for (const [form, check] of [["serial", serialCheck], ["sharded", shardedCheck]] as const) {
      for (const defect of check.defects) defects.push({ form, ...defect });
    }
    const states = (form: ParityForm) => new Map(forms[form].flatMap(({ record }) =>
      record.files.map(({ file, project, state }) => [file, { project, state }] as const)));
    const serialStates = states("serial");
    const shardedStates = states("sharded");
    for (const [file, serial] of serialStates) {
      const sharded = shardedStates.get(file);
      if (sharded && (serial.project !== sharded.project || serial.state !== sharded.state)) {
        defects.push({ form: "sharded", kind: "state-differs", file, serial, sharded });
      }
    }

    reading = "serial";
    const serialCoverage = parityCoverage(input.root, input.serialCoverage);
    reading = "sharded";
    const shardedCoverage = parityCoverage(input.root, input.shardedCoverage);
    reading = "both";
    sources = new Set([...serialCoverage.keys(), ...shardedCoverage.keys()]).size;
    for (const [file, serial] of serialCoverage) {
      const sharded = shardedCoverage.get(file);
      if (!sharded) {
        defects.push({ form: "serial", kind: "source-only-serial", file });
        continue;
      }
      for (const metric of FLOOR_METRICS) {
        const a = serial.metrics[metric];
        const b = sharded.metrics[metric];
        if (a.total !== b.total) defects.push({ form: "sharded", kind: "totals-differ", file, metric, serial: a.total, sharded: b.total });
        if (a.covered !== b.covered) notes.push(`PARITY_COVERAGE_NOTE ${jsonLine({ file, metric, serial: a.covered, sharded: b.covered })}`);
      }
    }
    for (const file of shardedCoverage.keys()) {
      if (!serialCoverage.has(file)) defects.push({ form: "sharded", kind: "source-only-sharded", file });
    }

    // `floors` and parity load the same live thresholds and use the same glob ownership and pct math.
    const floors = await loadFloors(checkout);
    const serialFloors = checkFloors(floors, [...serialCoverage.values()], input.root);
    const shardedFloors = checkFloors(floors, [...shardedCoverage.values()], input.root);
    globs = serialFloors.length;
    for (let i = 0; i < serialFloors.length; i++) {
      const serial = serialFloors[i]!;
      const sharded = shardedFloors[i]!;
      for (const [form, check] of [["serial", serial], ["sharded", sharded]] as const) {
        for (const kind of check.defects) {
          if (kind === "no-file" || kind === "zero-statements") defects.push({ form, kind, glob: check.glob });
        }
      }
      for (const metric of FLOOR_METRICS) {
        const a = serial.metrics[metric];
        const b = sharded.metrics[metric];
        if (a === undefined || b === undefined) continue;
        const serialHundredths = Math.round(a.pct * 100);
        const shardedHundredths = Math.round(b.pct * 100);
        if (Math.abs(serialHundredths - shardedHundredths) > 10) {
          defects.push({ form: "sharded", kind: "pct-differs", glob: serial.glob, metric, serial: a.pct, sharded: b.pct });
        }
      }
    }
    verdict = defects.length === 0 ? "GREEN" : "RED";
  } catch (error) {
    defects.length = 0;
    notes.length = 0;
    files = sources = globs = UNREADABLE;
    defects.push({ form: reading, kind: "unreadable", error: message(error) });
  }
  const lines = defects.map((defect) => `PARITY_DEFECT ${jsonLine(defect)}`).sort();
  await emit([...lines, ...notes.sort(), `PARITY verdict=${verdict} files=${files} sources=${sources} globs=${globs} defects=${lines.length}`]);
  return verdict === "GREEN" ? 0 : verdict === "RED" ? 1 : 2;
};

// v2.8.2 T1 (ANL-022 §7.1, amended by §9 P1/P2 as executed on Vitest 3.2.7, D-1974) — `verdict
// [--require-test <file>::<fullName>]... <record>...`: one invocation's outcome from its own F3 records. The
// decision is the closed matrix below, first matching row wins; every defect found prints as a sorted
// RECORD_DEFECT line, then exactly one RECORD_VERDICT line. Exit 0 CLEAN or RPC_ONLY, 1 RED, 2 UNREADABLE.
//    1 a record absent, unparsable or of another schema; a head null; heads unequal      UNREADABLE
//    2 a file or test state failed                                                       RED failed
//    3 a file state pending or queued, a test state pending                              RED unfinished
//    4 a reason interrupted                                                              RED interrupted
//    5 a --require-test with no entry of that file and fullName                          RED required-absent
//    6 a --require-test entry whose state is not passed                                 RED required-not-passed
//    7 an unhandled entry that is not an exact RPC timeout                               RED unhandled
//    8 at least one unhandled entry, every one an exact RPC timeout                      RPC_ONLY
//    9 a record whose reason is failed with no failed or unfinished state and no unhandled entry   RED unexplained-failure
//   10 otherwise                                                                          CLEAN
// Row 9 reads per record: only a record's OWN unhandled entries explain its failed reason, so another record's
// RPC timeout never clears it (rows 8 and 9 cannot both hold for one record).
// The exact RPC timeout is the observed shape of Vitest's worker RPC timeout at onTestRunEnd: name `Error`,
// the WHOLE message `[vitest-worker]: Timeout calling "<m>"` (<m> letters only, nothing before or after) and
// type `Unhandled Error`, as a structured field — never a reason, never text a test printed.
type RecordVerdict = "CLEAN" | "RPC_ONLY" | "RED" | "UNREADABLE";
type RequiredTest = { file: string; name: string };
type LoadedRecord = { source: string; record: CiRecord };
type RecordOutcome = { verdict: RecordVerdict; defects: Defect[]; line: string; records: LoadedRecord[]; readable: boolean };
const RPC_TIMEOUT_MESSAGE = /^\[vitest-worker\]: Timeout calling "[A-Za-z]+"$/;
const isExactRpcTimeout = (entry: RecordUnhandled): boolean =>
  entry.name === "Error" && entry.type === "Unhandled Error" && RPC_TIMEOUT_MESSAGE.test(entry.message);
const UNFINISHED_FILE = new Set(["pending", "queued"]);

function recordVerdict(sources: readonly string[], required: readonly RequiredTest[]): RecordOutcome {
  const unreadable: Defect[] = [];
  const records: LoadedRecord[] = [];
  for (const source of sources) {
    try {
      records.push({ source, record: loadRecord(source) });
    } catch (error) {
      unreadable.push({ kind: "unreadable", source, error: message(error) });
    }
  }
  if (sources.length === 0) unreadable.push({ kind: "unreadable", source: null, error: "no record" });
  const readable = unreadable.length === 0;
  for (const { source, record } of records) if (record.head === null) unreadable.push({ kind: "wrong-head", source, head: null });
  const heads = new Set(records.map(({ record }) => record.head).filter((head) => head !== null));
  if (heads.size > 1) for (const { source, record } of records) if (record.head !== null) unreadable.push({ kind: "wrong-head", source, head: record.head });
  if (unreadable.length > 0) {
    const field = UNREADABLE;
    return { verdict: "UNREADABLE", defects: unreadable, records, readable,
      line: `RECORD_VERDICT verdict=UNREADABLE files=${field} tests=${field} failed=${field} unfinished=${field} unhandled=${field} rpc=${field} reason=${field}` };
  }

  const red: Defect[] = [];
  let failed = 0;
  let unfinished = 0;
  let unhandled = 0;
  let rpc = 0;
  for (const { source, record } of records) {
    const before = { failed, unfinished };
    for (const { file, project, state } of record.files) {
      if (state === "failed") { failed++; red.push({ kind: "failed", source, file, project }); }
      if (UNFINISHED_FILE.has(state)) { unfinished++; red.push({ kind: "unfinished", source, file, project, state }); }
    }
    for (const { file, project, name, state } of record.tests) {
      if (state === "failed") { failed++; red.push({ kind: "failed", source, file, project, name }); }
      if (state === "pending") { unfinished++; red.push({ kind: "unfinished", source, file, project, name, state }); }
    }
    if (record.reason === "interrupted") red.push({ kind: "interrupted", source });
    for (const entry of record.unhandled) {
      unhandled++;
      if (isExactRpcTimeout(entry)) rpc++;
      else red.push({ kind: "unhandled", source, ...entry });
    }
    if (record.reason === "failed" && failed === before.failed && unfinished === before.unfinished && record.unhandled.length === 0) {
      red.push({ kind: "unexplained-failure", source });
    }
  }
  for (const { file, name } of required) {
    const entries = records.flatMap(({ source, record }) =>
      record.tests.filter((test) => test.file === file && test.name === name).map((test) => ({ source, ...test })));
    if (entries.length === 0) red.push({ kind: "required-absent", file, name });
    for (const entry of entries) if (entry.state !== "passed") red.push({ kind: "required-not-passed", source: entry.source, file, project: entry.project, name, state: entry.state });
  }
  // rows 2-7 and the per-record row 9 are RED whatever row 8 would say
  const verdict: RecordVerdict = red.length > 0 ? "RED" : unhandled > 0 ? "RPC_ONLY" : "CLEAN";
  const reasons = new Set(records.map(({ record }) => record.reason));
  const reason = reasons.size === 1 ? [...reasons][0] : "mixed";
  const files = records.reduce((n, { record }) => n + record.files.length, 0);
  const tests = records.reduce((n, { record }) => n + record.tests.length, 0);
  return { verdict, defects: red, records, readable,
    line: `RECORD_VERDICT verdict=${verdict} files=${files} tests=${tests} failed=${failed} unfinished=${unfinished} unhandled=${unhandled} rpc=${rpc} reason=${reason}` };
}

const verdictExit = (verdict: RecordVerdict): number => (verdict === "CLEAN" || verdict === "RPC_ONLY" ? 0 : verdict === "RED" ? 1 : 2);

const runVerdict = async (args: readonly string[]): Promise<number> => {
  const required: RequiredTest[] = [];
  const sources: string[] = [];
  let usage: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== "--require-test") { sources.push(arg); continue; }
    const value = args[++i];
    const split = value?.indexOf("::") ?? -1;
    if (value === undefined || split <= 0 || split + 2 >= value.length) { usage = "--require-test takes <file>::<fullName>"; break; }
    required.push({ file: value.slice(0, split), name: value.slice(split + 2) });
  }
  const outcome: RecordOutcome = usage === null ? recordVerdict(sources, required) : {
    verdict: "UNREADABLE", defects: [{ kind: "unreadable", source: null, error: usage }], records: [], readable: false,
    line: "RECORD_VERDICT verdict=UNREADABLE files=UNREADABLE tests=UNREADABLE failed=UNREADABLE unfinished=UNREADABLE unhandled=UNREADABLE rpc=UNREADABLE reason=UNREADABLE",
  };
  if (usage !== null) console.error(`verdict: ${usage}`);
  await emit([...outcome.defects.map((defect) => `RECORD_DEFECT ${jsonLine(defect)}`).sort(), outcome.line]);
  return verdictExit(outcome.verdict);
};

// v2.8.2 T1 — the floors grammar, read back from the producer's own sidecar (`floors --out`): k >= 1
// COVERAGE_FLOOR lines sorted by glob, then exactly one last COVERAGE_FLOORS line whose floors= is k, whose
// failing= counts the lines with defects and whose verdict is GREEN iff that count is 0; or exactly the one
// UNREADABLE line. Anything else reads UNREADABLE: the reader checks consistency and never recomputes floors.
// A COVERAGE_FLOOR line must also agree with itself, as checkFloors (floors.ts) builds it: metrics a nonempty
// subset of FLOOR_METRICS, each exactly {pct in [0, 100], floor in (0, 100], ok === pct >= floor}; files 0 holds
// statements 0; defects exactly no-file iff files is 0, zero-statements iff files > 0 and statements 0, then one
// below-floor per metric not ok, in FLOOR_METRICS order.
const FLOOR_LINE_KEYS = "defects,files,glob,metrics,statements";
const isPct = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
function floorDefects(files: number, statements: number, metrics: Record<string, unknown>): string[] | null {
  const keys = Object.keys(metrics);
  if (keys.length === 0 || !keys.every((key) => (FLOOR_METRICS as readonly string[]).includes(key))) return null;
  if (files === 0 && statements !== 0) return null;
  const defects = files === 0 ? ["no-file"] : statements === 0 ? ["zero-statements"] : [];
  for (const metric of FLOOR_METRICS) {
    const check = metrics[metric];
    if (check === undefined) continue;
    if (!isRecord(check) || Object.keys(check).sort().join(",") !== "floor,ok,pct") return null;
    const { pct, floor, ok } = check;
    if (!isPct(pct) || !isPct(floor) || floor === 0 || ok !== pct >= floor) return null;
    if (!ok) defects.push("below-floor");
  }
  return defects;
}
function readFloorsOut(text: string): "GREEN" | "RED" | "UNREADABLE" {
  try {
    if (!text.endsWith("\n")) return UNREADABLE;
    const lines = text.slice(0, -1).split("\n");
    if (lines.length === 1 && lines[0] === UNREADABLE_FLOORS_LINE) return UNREADABLE;
    const last = /^COVERAGE_FLOORS verdict=(GREEN|RED) floors=(0|[1-9][0-9]*) failing=(0|[1-9][0-9]*)$/.exec(lines.at(-1)!);
    const floorLines = lines.slice(0, -1);
    if (!last || floorLines.length === 0 || Number(last[2]) !== floorLines.length) return UNREADABLE;
    let failing = 0;
    let previous: string | null = null;
    for (const line of floorLines) {
      if (!line.startsWith("COVERAGE_FLOOR ")) return UNREADABLE;
      const entry = readJson(line.slice("COVERAGE_FLOOR ".length));
      if (!isRecord(entry) || Object.keys(entry).sort().join(",") !== FLOOR_LINE_KEYS) return UNREADABLE;
      const { glob, files, statements, metrics, defects } = entry;
      if (typeof glob !== "string" || (previous !== null && glob <= previous)) return UNREADABLE;
      if (!Number.isSafeInteger(files) || (files as number) < 0 || !Number.isSafeInteger(statements) || (statements as number) < 0) return UNREADABLE;
      if (!isRecord(metrics) || !Array.isArray(defects)) return UNREADABLE;
      const expected = floorDefects(files as number, statements as number, metrics);
      if (expected === null || jsonLine(defects) !== jsonLine(expected)) return UNREADABLE;
      previous = glob;
      if (defects.length > 0) failing++;
    }
    if (Number(last[3]) !== failing || (last[1] === "GREEN") !== (failing === 0)) return UNREADABLE;
    return last[1] as "GREEN" | "RED";
  } catch {
    return UNREADABLE;
  }
}

// v2.8.2 T1 — `proof --head <sha> --repo <git dir> <dir>...`: one <dir> per OS proof group holding ONLY that
// group's original invocation records (`*.record.json`) and its floors sidecar (`floors.out`). Per dir:
// (1) `verdict` over its records reads CLEAN or RPC_ONLY and every record's head equals <sha>; (2) the manifest
// is recomputed from the commit itself (`git ls-tree <sha> -- tests`, kept where the path is tests/**/*.test.ts)
// and the checkManifest rules run over the DOWNLOADED records; (3) floors.out reads GREEN under the floors
// grammar. No line the job printed is read. PROOF_DEFECT lines, one PROOF line per dir, then one PROOF_RUN
// line; UNREADABLE outranks RED, as in the record matrix. Exit 0 GREEN, 1 RED, 2 UNREADABLE.
// v2.8.2 T7 (ANL-022 §7.4) — `--merge-record <file> --blobs <dir>`, both or neither: the sharded aggregate's merge
// record, which Vitest writes by replaying every blob and which therefore re-lists every suite file, is checked
// SEPARATELY and never counted into a group's set (counted in, every suite file reads `duplicate`). Per dir, its
// {file, project} set must equal the union of the dir's SHARD records (shard non-null), each once and finished, its
// head must be <sha>, and <dir> of --blobs must hold exactly blob-1.json..blob-<n>.json for the shards' count n. A
// record can be present while its blob is not, and a blob that is a byte copy of another is present by name while
// its shard's files reach the merge twice and its own never, so both checks are needed; the blob format itself is
// never decoded. The PROOF line then ends ` merge=<GREEN|RED|UNREADABLE>`.
const MANIFEST_PATH = /^tests\/(.+\/)?[^/]+\.test\.ts$/;
type ProofVerdict = "GREEN" | "RED" | "UNREADABLE";
const worst = (verdicts: readonly ProofVerdict[]): ProofVerdict =>
  verdicts.includes("UNREADABLE") ? "UNREADABLE" : verdicts.includes("RED") ? "RED" : "GREEN";

function checkMerge(records: readonly LoadedRecord[], merge: LoadedRecord, blobDir: string): Defect[] {
  const defects: Defect[] = [];
  const key = (file: string, project: string) => `${file}\0${project}`;
  const shards = records.filter(({ record }) => record.shard !== null);
  const union = new Map(shards.flatMap(({ record }) => record.files.map(({ file, project }) => [key(file, project), { file, project }] as const)));
  const seen = new Map<string, number>();
  for (const { file, project, state } of merge.record.files) {
    const k = key(file, project);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n === 2) defects.push({ kind: "merge-duplicate", file, project });
    if (n === 1 && !union.has(k)) defects.push({ kind: "merge-unexpected", file, project });
    if (!FINISHED.has(state)) defects.push({ kind: "unfinished", source: merge.source, file, project, state });
  }
  for (const [k, { file, project }] of union) if (!seen.has(k)) defects.push({ kind: "merge-missing", file, project });
  const expectedBlobs = new Set(shards.flatMap(({ record }) => Array.from({ length: record.shard!.count }, (_, i) => `blob-${i + 1}.json`)));
  const present = new Set<string>();
  for (const entry of readdirSync(blobDir, { withFileTypes: true })) {
    if (entry.isFile() && expectedBlobs.has(entry.name)) present.add(entry.name);
    else defects.push({ kind: "blob-unexpected", blob: entry.name });
  }
  for (const blob of expectedBlobs) if (!present.has(blob)) defects.push({ kind: "blob-missing", blob });
  return defects;
}

function commitManifest(repo: string, sha: string): Set<string> {
  const listed = spawnSync("git", ["-C", repo, "ls-tree", "-r", "-z", "--name-only", sha, "--", "tests"], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (listed.status !== 0) throw new Error(`git ls-tree ${sha} exited ${listed.status ?? listed.signal}: ${(listed.stderr ?? "").trim()}`);
  return new Set(listed.stdout.split("\0").filter((path) => MANIFEST_PATH.test(path)));
}

const runProof = async (args: readonly string[]): Promise<number> => {
  const lines: string[] = [];
  const verdicts: ProofVerdict[] = [];
  let head: string | null = null;
  let repo: string | null = null;
  let mergeRecord: string | null = null;
  let blobs: string | null = null;
  let usage = false;
  const dirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--head" || arg === "--repo" || arg === "--merge-record" || arg === "--blobs") {
      const value = args[++i];
      const seen = arg === "--head" ? head : arg === "--repo" ? repo : arg === "--merge-record" ? mergeRecord : blobs;
      if (value === undefined || value === "" || seen !== null) { usage = true; break; }
      if (arg === "--head") head = value;
      else if (arg === "--repo") repo = value;
      else if (arg === "--merge-record") mergeRecord = value;
      else blobs = value;
    } else dirs.push(arg);
  }
  if (usage || head === null || !/^[0-9a-f]{40}$/.test(head) || repo === null || dirs.length === 0 || (mergeRecord === null) !== (blobs === null)) {
    console.error("usage: proof --head <40-hex sha> --repo <git dir> [--merge-record <file> --blobs <dir>] <dir>...");
    await emit(["PROOF_RUN verdict=UNREADABLE"]);
    return 2;
  }
  let manifest: Set<string> | null = null;
  let manifestError: string | null = null;
  try {
    manifest = commitManifest(repo, head);
  } catch (error) {
    manifestError = message(error);
  }
  for (const dir of dirs) {
    const defects: Defect[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".record.json")).sort();
    } catch (error) {
      defects.push({ dir, kind: "unreadable", source: dir, error: message(error) });
    }
    const sources = names.map((name) => join(dir, name));
    const record = recordVerdict(sources, []);
    for (const defect of record.defects) defects.push({ dir, ...defect });
    let expected: number | string = UNREADABLE;
    let actual: number | string = UNREADABLE;
    let set: ProofVerdict = "UNREADABLE";
    if (manifestError !== null) defects.push({ dir, kind: "manifest", error: manifestError });
    if (manifest !== null) {
      expected = manifest.size;
      if (record.readable) {
        const check = manifestRules(manifest, head, record.records);
        actual = check.actual;
        for (const defect of check.defects) defects.push({ dir, ...defect });
        set = check.defects.some((defect) => defect.kind === "wrong-head") ? "UNREADABLE" : check.defects.length > 0 ? "RED" : "GREEN";
      }
    }
    let floors: ProofVerdict = "UNREADABLE";
    try {
      floors = readFloorsOut(readFileSync(join(dir, "floors.out"), "utf8"));
    } catch (error) {
      defects.push({ dir, kind: "floors-unreadable", error: message(error) });
    }
    if (floors === "RED") defects.push({ dir, kind: "floors-red" });
    let merge: ProofVerdict | null = null;
    if (mergeRecord !== null && blobs !== null) {
      merge = "UNREADABLE";
      try {
        const merged = { source: mergeRecord, record: loadRecord(mergeRecord) };
        if (merged.record.head !== head) defects.push({ dir, kind: "wrong-head", source: mergeRecord, head: merged.record.head, expected: head });
        else if (record.readable) {
          const mergeDefects = checkMerge(record.records, merged, blobs);
          for (const defect of mergeDefects) defects.push({ dir, ...defect });
          merge = mergeDefects.length > 0 ? "RED" : "GREEN";
        }
      } catch (error) {
        defects.push({ dir, kind: "merge-unreadable", error: message(error) });
      }
    }
    const recordProof: ProofVerdict = record.verdict === "UNREADABLE" ? "UNREADABLE" : record.verdict === "RED" ? "RED" : "GREEN";
    const verdict = worst([recordProof, set, floors, ...(merge === null ? [] : [merge])]);
    verdicts.push(verdict);
    lines.push(...defects.map((defect) => `PROOF_DEFECT ${jsonLine(defect)}`).sort());
    lines.push(`PROOF dir=${dir} verdict=${verdict} head=${head} expected=${expected} actual=${actual} records=${names.length} record=${record.verdict} floors=${floors}${merge === null ? "" : ` merge=${merge}`}`);
  }
  const run = worst(verdicts);
  await emit([...lines, `PROOF_RUN verdict=${run}`]);
  return run === "GREEN" ? 0 : run === "RED" ? 1 : 2;
};

// D-1973 — read-only release guards. A git or binary read failure is UNREADABLE; a
// successful read that disproves the release condition is RED.
type ReleaseCheck = "subject" | "tag-absent" | "trees-equal" | "prune-safe" | "installed-version";
const releaseChecks = new Set<ReleaseCheck>(["subject", "tag-absent", "trees-equal", "prune-safe", "installed-version"]);
const hexCommit = /^[0-9a-fA-F]{40}$/;
const field = (value: string | number | boolean) => typeof value === "string" ? JSON.stringify(value) : String(value);

function readCommand(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 1 << 24 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal}): ${message(result.error ?? result.stderr)}`);
  }
  return result.stdout.trim();
}

function gitRead(repo: string, ...args: string[]): string {
  return readCommand("git", ["-C", repo, ...args]);
}

function gitStatus(repo: string, ...args: string[]): number {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 24 });
  if (result.error || result.status === null || result.status === undefined) {
    throw new Error(`git ${args.join(" ")} failed: ${message(result.error ?? result.stderr)}`);
  }
  if (result.status !== 0 && result.stderr.trim() !== "") throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim()}`);
  if (result.status > 2) throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim()}`);
  return result.status;
}

function repository(path: string): string {
  const repo = resolve(path);
  if (gitRead(repo, "rev-parse", "--is-inside-work-tree") !== "true") throw new Error(`${repo} is not a worktree`);
  return repo;
}

function releaseTag(repo: string, tag: string): string {
  if (tag === "" || tag.startsWith("-") || tag.startsWith("refs/")) throw new Error("tag must be a short tag name");
  gitRead(repo, "check-ref-format", `refs/tags/${tag}`);
  return `refs/tags/${tag}`;
}

function releaseBranch(repo: string, branch: string): string {
  if (branch === "" || branch.startsWith("-") || branch.startsWith("refs/")) throw new Error("branch must be a short branch name");
  gitRead(repo, "check-ref-format", `refs/heads/${branch}`);
  return `refs/heads/${branch}`;
}

function commit(repo: string, sha: string): string {
  if (!hexCommit.test(sha)) throw new Error("commit must be a 40-hex SHA");
  return gitRead(repo, "rev-parse", "--verify", `${sha}^{commit}`);
}

function releaseTrees(repo: string, ref: string): Map<string, string> {
  const rows = gitRead(repo, "ls-tree", ref, "--", "src", "skills", "schema");
  const trees = new Map<string, string>();
  for (const row of rows.split("\n")) {
    const match = /^040000 tree ([0-9a-f]{40})\t(src|skills|schema)$/.exec(row);
    if (match) trees.set(match[2]!, match[1]!);
  }
  return trees;
}

const runRelease = async (args: readonly string[]): Promise<number> => {
  const [name, ...values] = args;
  const check = releaseChecks.has(name as ReleaseCheck) ? name! : "unknown";
  const defects: Defect[] = [];
  const fields: Record<string, string | number | boolean> = {};
  let verdict: ProofVerdict = "UNREADABLE";
  try {
    if (!releaseChecks.has(name as ReleaseCheck)) throw new Error("usage: release <subject|tag-absent|trees-equal|prune-safe|installed-version> <args...>");
    const arity = name === "trees-equal" ? 4 : name === "prune-safe" ? 3 : 2;
    if (name === "prune-safe" ? values.length < arity : values.length !== arity) throw new Error(`${name} takes ${name === "prune-safe" ? "at least " : ""}${arity} arguments`);
    if (values.some((value) => value === "")) throw new Error("empty argument");
    if (name === "subject") {
      const [path, sha] = values as [string, string];
      if (!hexCommit.test(sha)) throw new Error("subject needs a 40-hex SHA");
      const repo = repository(path);
      gitRead(repo, "fetch", "origin", "main");
      const head = gitRead(repo, "rev-parse", "--verify", "HEAD^{commit}");
      const origin = gitRead(repo, "rev-parse", "--verify", "refs/remotes/origin/main^{commit}");
      const dirty = gitRead(repo, "status", "--porcelain", "--ignored", "--untracked-files=all") !== "";
      Object.assign(fields, { head, origin, dirty });
      if (head !== sha) defects.push({ kind: "head", expected: sha, actual: head });
      if (origin !== sha) defects.push({ kind: "origin", expected: sha, actual: origin });
      if (dirty) defects.push({ kind: "dirty" });
    } else if (name === "tag-absent") {
      const [path, tag] = values as [string, string];
      const repo = repository(path);
      const ref = releaseTag(repo, tag);
      const localStatus = gitStatus(repo, "show-ref", "--verify", "--quiet", ref);
      if (localStatus !== 0 && localStatus !== 1) throw new Error("cannot read local tag");
      const local = localStatus === 0;
      const remote = gitRead(repo, "ls-remote", "--refs", "origin", ref).split("\n")
        .some((row) => row.endsWith(`\t${ref}`));
      Object.assign(fields, { local, remote });
      if (local) defects.push({ kind: "local", tag });
      if (remote) defects.push({ kind: "remote", tag });
    } else if (name === "trees-equal") {
      const [privatePath, sha, mirrorPath, tag] = values as [string, string, string, string];
      const privateRepo = repository(privatePath);
      const mirror = repository(mirrorPath);
      const privateCommit = commit(privateRepo, sha);
      const publicCommit = gitRead(mirror, "rev-parse", "--verify", `${releaseTag(mirror, tag)}^{commit}`);
      const privateTrees = releaseTrees(privateRepo, privateCommit);
      const publicTrees = releaseTrees(mirror, publicCommit);
      for (const path of ["src", "skills", "schema"]) {
        const equal = privateTrees.has(path) && privateTrees.get(path) === publicTrees.get(path);
        fields[path] = equal ? "equal" : "differ";
        if (!equal) defects.push({ kind: "tree", path });
      }
    } else if (name === "prune-safe") {
      const [path, sha, ...branches] = values as [string, string, ...string[]];
      const repo = repository(path);
      const releaseCommit = commit(repo, sha);
      let missing = 0;
      let notAncestor = 0;
      for (const branch of branches) {
        const ref = releaseBranch(repo, branch);
        const exists = gitStatus(repo, "show-ref", "--verify", "--quiet", ref);
        if (exists === 1) { missing++; defects.push({ kind: "missing", branch }); continue; }
        if (exists !== 0) throw new Error(`cannot read branch ${branch}`);
        const ancestor = gitStatus(repo, "merge-base", "--is-ancestor", ref, releaseCommit);
        if (ancestor === 1) { notAncestor++; defects.push({ kind: "not-ancestor", branch }); }
        else if (ancestor !== 0) throw new Error(`cannot compare branch ${branch}`);
      }
      Object.assign(fields, { branches: branches.length, "not-ancestor": notAncestor, missing });
    } else if (name === "installed-version") {
      const [bin, expected] = values as [string, string];
      const actual = readCommand(bin, ["version"]);
      Object.assign(fields, { expected, actual });
      if (actual !== expected) defects.push({ kind: "version", expected, actual });
    }
    verdict = defects.length === 0 ? "GREEN" : "RED";
  } catch (error) {
    console.error(`release ${check}: ${message(error)}`);
  }
  const lines = defects.map((defect) => `RELEASE_CHECK_DEFECT ${jsonLine(defect)}`);
  const details = Object.entries(fields).map(([key, value]) => `${key}=${field(value)}`).join(" ");
  await emit([...lines, `RELEASE_CHECK check=${check} verdict=${verdict}${details ? ` ${details}` : ""}`]);
  return verdict === "GREEN" ? 0 : verdict === "RED" ? 1 : 2;
};

const MODES: Record<string, (args: readonly string[]) => Promise<number>> = {
  floors: runFloors, durations: runDurations, contract: runContract, assert: runAssert, parity: runParity,
  verdict: runVerdict, proof: runProof, release: runRelease,
};

const [mode, ...args] = process.argv.slice(2);
if (mode === undefined || !(mode in MODES)) {
  console.error(`usage: cli.ts <${Object.keys(MODES).join("|")}> ...`);
  process.exit(2);
}
process.exit(await MODES[mode]!(args));
