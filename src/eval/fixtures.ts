import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { shGitOk } from "../run/git.js";

export interface Fixture {
  id: string;
  path: string;
  startDir: string;
  solutionDir: string;
}

export interface InvalidFixture {
  id: string;
  path: string;
  reason: string;
}

export interface SeededFixture {
  repo: string;
  cleanup: () => Promise<void>;
}

export const FIXTURE_REQUIRED_PARTS = ["start", "solution"] as const;

function isFixtureDir(dir: string): boolean {
  for (const part of FIXTURE_REQUIRED_PARTS) {
    const p = join(dir, part);
    if (!existsSync(p) || !lstatSync(p).isDirectory()) return false;
  }
  return true;
}

function missingPart(dir: string): string | undefined {
  for (const part of FIXTURE_REQUIRED_PARTS) {
    const p = join(dir, part);
    if (!existsSync(p) || !lstatSync(p).isDirectory()) return part;
  }
  return undefined;
}

function copyDirContents(src: string, dst: string): void {
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, ent.name);
    const to = join(dst, ent.name);
    if (ent.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyDirContents(from, to);
    } else {
      writeFileSync(to, readFileSync(from));
    }
  }
}

export function discoverFixtures(root: string): { valid: Fixture[]; invalid: InvalidFixture[] } {
  const valid: Fixture[] = [];
  const invalid: InvalidFixture[] = [];

  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    return { valid, invalid };
  }

  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = join(root, ent.name);
    if (isFixtureDir(dir)) {
      valid.push({
        id: relative(root, dir),
        path: dir,
        startDir: join(dir, "start"),
        solutionDir: join(dir, "solution"),
      });
    } else {
      const part = missingPart(dir);
      invalid.push({
        id: relative(root, dir),
        path: dir,
        reason: part ? `missing required part: ${part}` : "missing required part",
      });
    }
  }

  valid.sort((a, b) => a.id.localeCompare(b.id));
  invalid.sort((a, b) => a.id.localeCompare(b.id));
  return { valid, invalid };
}

export async function seedFixture(fixture: Fixture): Promise<SeededFixture> {
  const repo = mkdtempSync(join(tmpdir(), "tickmarkr-eval-"));
  await shGitOk("git init -b main", repo);
  await shGitOk("git config user.email tickmarkr@eval.local", repo);
  await shGitOk("git config user.name tickmarkr-eval", repo);

  // Copy only the starting files; the reference solution must never be seeded.
  copyDirContents(fixture.startDir, repo);

  await shGitOk("git add -A", repo);
  await shGitOk("git commit -m init --no-gpg-sign", repo);

  return {
    repo,
    cleanup: async () => {
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

export function resolveFixturesRoot(arg: string | undefined, cwd: string): string {
  const root = arg ?? "fixtures/eval";
  return isAbsolute(root) ? root : join(cwd, root);
}
