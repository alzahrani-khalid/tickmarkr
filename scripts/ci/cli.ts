// v2.7.8 T1 — the one scripts/ci entry point (SHARED CONVENTIONS): `scripts/ci/cli.ts <mode>`,
// run through the repository's own tsx. Nothing imports this file; later tasks add modes here.
// Every verdict mode prints its closed format to stdout and exits 0 GREEN, 1 RED, 2 UNREADABLE —
// any validation failure fails closed to UNREADABLE with its counts unknowable.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { checkFloors, FLOOR_METRICS, loadFloors, parseSummary, renderFloors, UNREADABLE_FLOORS_LINE, type SummaryEntry } from "./floors.js";
import { isRecord, jsonLine, readJson } from "./json.js";
import { type CiRecord, headOf, parseRecord } from "./reporter.js";
import { isCanonicalPath, lptShards, readDurations, renderDurations, rootRelative, type ShardItem } from "./shard.js";

const runFloors = async (args: readonly string[]): Promise<number> => {
  try {
    if (args.length !== 1) throw new Error(`floors takes exactly one summary path, got ${args.length}`);
    const root = process.cwd();
    const floors = await loadFloors(root);
    const entries = parseSummary(readJson(readFileSync(resolve(root, args[0]!), "utf8")));
    const outcome = renderFloors(checkFloors(floors, entries, root));
    for (const line of outcome.lines) console.log(line);
    return outcome.exitCode;
  } catch (error) {
    // fail closed: the counts a broken input leaves unknowable print as UNREADABLE
    console.log(UNREADABLE_FLOORS_LINE);
    console.error(`floors: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
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

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const loadRecord = (path: string): CiRecord => parseRecord(readJson(readFileSync(resolve(path), "utf8")), path);
// one write, flushed before the caller's process.exit (see runDurations)
const emit = (lines: readonly string[]) =>
  new Promise<void>((done) => process.stdout.write(lines.map((line) => `${line}\n`).join(""), () => done()));
const UNREADABLE = "UNREADABLE";

// v2.7.8 T3 — `contract --record <path> -- <command...>` (FORMAT F4): ONE sharded invocation held to its plan
// as a SET of {file, project} (G5). The command must match the CLOSED GRAMMAR below; the plan is lptShards over
// Vitest's own discovery (FORMAT F3) of the command's projects and readDurations — the partition the root
// sequencer applies — and the record's shard must equal the command's. scripts/run-ci-vitest.sh calls it at
// status 0 and 1 of every sharded invocation.
type Defect = Record<string, unknown> & { kind: string };
const COMMAND_FORMS = [["npm", "run", "test:coverage", "--"], ["npx", "vitest", "run"]] as const;
const CANONICAL_SHARD = /^([1-9][0-9]*)\/([1-9][0-9]*)$/;
const argvDefect = (token: string | null, reason: string): Defect => ({ kind: "argv", token, reason });

/** CLOSED GRAMMAR: a COMMAND_FORMS prefix, then any `--project p` / `--project=p` and exactly one canonical `--shard=k/n` / `--shard k/n`. */
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
  if (shards.length === 0 && defects.length === 0) defects.push(argvDefect(null, "no --shard argument"));
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
    if (parsed.shard === null) throw new Error("the command is outside the closed sharded grammar");
    const { index, count } = parsed.shard;
    shard = `${index}/${count}`;
    const root = process.cwd();
    const plan = lptShards(discover(root, parsed.projects), readDurations(root), count)[index - 1]!;
    planned = plan.length;
    const record = loadRecord(args[1]);
    recorded = record.files.length;
    if (record.shard?.index !== index || record.shard.count !== count) {
      defects.push({ kind: "shard-mismatch", expected: shard, recorded: record.shard && `${record.shard.index}/${record.shard.count}` });
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
  const manifest = new Set(listed.stdout.split("\0").filter((path) => path !== ""));
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

const MODES: Record<string, (args: readonly string[]) => Promise<number>> = {
  floors: runFloors, durations: runDurations, contract: runContract, assert: runAssert, parity: runParity,
};

const [mode, ...args] = process.argv.slice(2);
if (mode === undefined || !(mode in MODES)) {
  console.error(`usage: cli.ts <${Object.keys(MODES).join("|")}> ...`);
  process.exit(2);
}
process.exit(await MODES[mode]!(args));
