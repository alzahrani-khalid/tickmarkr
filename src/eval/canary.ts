import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerAdapter } from "../adapters/types.js";
import { compileSource } from "../compile/index.js";
import { acceptanceGate } from "../gates/acceptance.js";
import type { Task } from "../graph/schema.js";
import { shGitOk } from "../run/git.js";
import { seedFixture, type Fixture } from "./fixtures.js";

export const CANARY_FIXTURE_ID = "canary";

export interface CanaryJudgeResult {
  fixtureId: string;
  expectedPass: boolean;
  judgePass: boolean;
  breach: boolean;
  details: string;
}

export interface FixtureChannelResult {
  fixtureId: string;
  channelKey: string;
  skipped: boolean;
  pass?: boolean;
}

export interface ChannelQualificationTotal {
  channelKey: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

export function isCanaryFixture(fixture: Fixture): boolean {
  return fixture.id === CANARY_FIXTURE_ID;
}

export function isCanaryResult(result: FixtureChannelResult): boolean {
  return result.fixtureId === CANARY_FIXTURE_ID;
}

export function resolveCanaryFixture(root: string): Fixture | undefined {
  const path = join(root, CANARY_FIXTURE_ID);
  if (!existsSync(path) || !lstatSync(path).isDirectory()) return undefined;
  const startDir = join(path, "start");
  const solutionDir = join(path, "solution");
  if (!existsSync(startDir) || !lstatSync(startDir).isDirectory()) return undefined;
  if (!existsSync(solutionDir) || !lstatSync(solutionDir).isDirectory()) return undefined;
  return { id: CANARY_FIXTURE_ID, path, startDir, solutionDir };
}

/**
 * Return a fixture list that always includes the held-out canary fixture.
 * If the canary is already present, the list is returned unchanged.
 */
export function ensureCanary(fixtures: Fixture[], root: string): Fixture[] {
  if (fixtures.some(isCanaryFixture)) return fixtures;
  const canary = resolveCanaryFixture(root);
  return canary ? [canary, ...fixtures] : fixtures;
}

function compileCanaryTask(fixture: Fixture): Task {
  const specPath = join(fixture.path, "spec.md");
  const graph = compileSource(specPath);
  if (graph.tasks.length !== 1) {
    throw new Error(`canary spec must contain exactly one task (found ${graph.tasks.length})`);
  }
  return graph.tasks[0]!;
}

// Apply a known-bad change so the judged diff contains quotable evidence of an unmet criterion.
async function applyKnownBadChange(repo: string): Promise<void> {
  writeFileSync(join(repo, "a.txt"), "canary-wrong");
  await shGitOk("git add -A", repo);
  await shGitOk("git commit -m 'canary bad change' --no-gpg-sign", repo);
}

/**
 * Run the held-out canary fixture against a judge adapter.
 * The fixture is seeded, a deliberately failing change is committed, and the judge oracle
 * is evaluated against the resulting diff. A correct judge returns pass=false; any pass=true
 * verdict is flagged as a judge-integrity breach.
 */
export async function runCanaryJudge(
  fixture: Fixture,
  judgeAdapter: WorkerAdapter,
  model: string,
): Promise<CanaryJudgeResult> {
  if (!isCanaryFixture(fixture)) {
    throw new Error(`fixture ${fixture.id} is not the canary fixture`);
  }

  const task = compileCanaryTask(fixture);
  const seeded = await seedFixture(fixture);
  const initialCommit = (await shGitOk("git rev-parse HEAD", seeded.repo)).trim();

  try {
    await applyKnownBadChange(seeded.repo);
    const gateResult = await acceptanceGate(task, seeded.repo, initialCommit, { adapter: judgeAdapter, model });
    const expectedPass = false;
    const judgePass = gateResult.pass;
    const breach = judgePass === true && expectedPass === false;

    return {
      fixtureId: fixture.id,
      expectedPass,
      judgePass,
      breach,
      details: gateResult.details,
    };
  } finally {
    await seeded.cleanup();
  }
}

/**
 * Aggregate per-channel qualification totals from fixture-channel results.
 * Results marked as canary (by the supplied predicate, defaulting to isCanaryResult) are excluded
 * from every total so the canary never contributes to a channel's qualification score.
 */
export function aggregateChannelTotals(
  results: FixtureChannelResult[],
  options: { isCanary?: (r: FixtureChannelResult) => boolean } = {},
): ChannelQualificationTotal[] {
  const isCanary = options.isCanary ?? isCanaryResult;
  const byChannel = new Map<string, ChannelQualificationTotal>();

  for (const r of results) {
    if (isCanary(r)) continue;

    let total = byChannel.get(r.channelKey);
    if (!total) {
      total = { channelKey: r.channelKey, passed: 0, failed: 0, skipped: 0, total: 0 };
      byChannel.set(r.channelKey, total);
    }

    total.total++;
    if (r.skipped) {
      total.skipped++;
    } else if (r.pass === true) {
      total.passed++;
    } else if (r.pass === false) {
      total.failed++;
    } else {
      // A result with no pass verdict is treated as neither passed nor failed; it still counts
      // toward the total so the aggregate is not silently distorted.
    }
  }

  return [...byChannel.values()].sort((a, b) => a.channelKey.localeCompare(b.channelKey));
}
