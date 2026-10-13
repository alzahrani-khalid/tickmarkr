import { execSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { verify, verifyStateDir } from "../../src/cli/commands/verify.js";
import { COMMIT, makeRepo, makeTestTempDir } from "../helpers/tmprepo.js";

// ANL-023 §7.1 W, read by the verify latch. Exit 0 and no lines is git's empty witness
// (no log, or logs/HEAD unreadable on a detached checkout — X18). Attached HEAD falls
// back to the branch log, so the unreadable cases detach first.
const CLI = [
  process.execPath,
  "--import",
  pathToFileURL(join(import.meta.dirname, "../../node_modules/tsx/dist/loader.mjs")).href,
  join(import.meta.dirname, "../../src/cli/index.ts"),
];

const git = (repo: string, command: string): string =>
  execSync(`git ${command}`, { cwd: repo, encoding: "utf8" }).trim();

const headLog = (repo: string): string => join(git(repo, "rev-parse --absolute-git-dir"), "logs", "HEAD");

function filesRepo(): string {
  const repo = makeRepo({
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "true" } }),
    "src.txt": "base\n",
  });
  git(repo, "checkout -b feature");
  writeFileSync(join(repo, "src.txt"), "base\nfeature\n");
  execSync(`${COMMIT} feature`, { cwd: repo });
  return repo;
}

function gate(repo: string, build: string): void {
  const dir = join(repo, ".tickmarkr");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n");
  writeFileSync(join(dir, "config.yaml"), `gates:\n  build: ${JSON.stringify(build)}\n`);
}

const MOVE = "git commit -q --allow-empty --no-gpg-sign -m moved && git reset -q --hard HEAD~1";
const RESTORED = (head: string) => `HEAD moved and was restored to ${head.slice(0, 12)} (its reflog recorded the move)`;

function refStorage(repo: string): string {
  try { return git(repo, "config --get extensions.refStorage"); } catch { return "files"; }
}

function reftableRepo(): string {
  const repo = makeTestTempDir("tickmarkr-reftable-");
  const run = (command: string) => execSync(`git ${command}`, { cwd: repo, encoding: "utf8" });
  run("init -q --ref-format=reftable -b main");
  run("config gc.auto 0");
  run("config maintenance.auto false");
  run("config user.email tickmarkr@test.local");
  run("config user.name tickmarkr-test");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "true" } }));
  writeFileSync(join(repo, "src.txt"), "base\n");
  run("add -A");
  run("commit -q -m init --no-gpg-sign");
  run("checkout -q -b feature");
  writeFileSync(join(repo, "src.txt"), "base\nfeature\n");
  run("add -A");
  run("commit -q -m feature --no-gpg-sign");
  return repo;
}

function repoWithoutReflog(): string {
  const repo = makeTestTempDir("tickmarkr-nolog-");
  const run = (command: string) => execSync(`git ${command}`, { cwd: repo, encoding: "utf8" });
  run("init -q -b main");
  run("config gc.auto 0");
  run("config maintenance.auto false");
  run("config core.logAllRefUpdates false");
  run("config user.email tickmarkr@test.local");
  run("config user.name tickmarkr-test");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "true" } }));
  writeFileSync(join(repo, "src.txt"), "base\n");
  run("add -A");
  run("commit -q -m init --no-gpg-sign");
  run("checkout -q -b feature");
  writeFileSync(join(repo, "src.txt"), "base\nfeature\n");
  run("add -A");
  run("commit -q -m feature --no-gpg-sign");
  return repo;
}

/** Newest reflog line becomes HEAD~1 while HEAD itself stays put. */
function newestIsNotHead(repo: string): string {
  const head = git(repo, "rev-parse HEAD");
  const newest = git(repo, "rev-parse HEAD~1");
  const log = headLog(repo);
  const existing = readFileSync(log, "utf8").replace(/\n$/, "");
  const last = existing.split("\n").at(-1)!;
  const tab = last.indexOf("\t");
  const fields = last.slice(0, tab).split(" ");
  fields[0] = head;
  fields[1] = newest;
  writeFileSync(log, `${existing}\n${fields.join(" ")}${last.slice(tab)}\n`);
  expect(git(repo, "reflog show --no-abbrev --format=%H HEAD").split("\n")[0]).toBe(newest);
  expect(git(repo, "rev-parse HEAD")).toBe(head);
  return newest;
}

function cliVerify(repo: string): { status: number | null; stdout: string; stderr: string } {
  const ran = spawnSync(CLI[0]!, CLI.slice(1).concat(["verify", "--no-review"]), { cwd: repo, encoding: "utf8", timeout: 120_000 });
  return { status: ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

const verdictLines = (stdout: string): string[] =>
  stdout.split("\n").filter((line) => /^(PASS|FAIL) /.test(line) || line.includes("verify GREEN") || line.includes("verify RED") || /verdict/i.test(line));

function stampedSubjects(repo: string): string[] {
  const dir = join(repo, ".tickmarkr", "verdicts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith("verdict-") && name.endsWith(".json")).flatMap((name) => {
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as { verdict?: { meta?: { validatedSubject?: unknown } } };
      const subject = record.verdict?.meta?.validatedSubject;
      return typeof subject === "string" ? [subject] : [];
    } catch { return []; }
  });
}

describe("tickmarkr verify — HEAD reflog witness latch", () => {
  test("through the verify command on the files backend a gate that commits and resets HEAD is refused as moved and restored with the default logging and after reflog logging is disabled over an existing log and a reftable repository is refused by git trust with no verdict versus nothing moving staying green (V-P1 P2 P3 P4)", async () => {
    const still = filesRepo();
    expect(refStorage(still)).toBe("files");
    expect(existsSync(headLog(still))).toBe(true);
    const green = await verify(["--no-review"], still);
    expect(green.code, green.out).toBe(0);
    expect(green.out).toContain("verify GREEN");

    const moved = filesRepo();
    const movedHead = git(moved, "rev-parse HEAD");
    gate(moved, MOVE);
    const restored = await verify(["--no-review"], moved);
    expect(restored.code, restored.out).toBe(2);
    expect(restored.out).toContain(RESTORED(movedHead));
    expect(git(moved, "rev-parse HEAD")).toBe(movedHead);
    expect(restored.out).not.toContain("verify GREEN");

    const table = reftableRepo();
    expect(refStorage(table)).toBe("reftable");
    const refused = await verify(["--no-review"], table).then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/git trust refusal/);
    expect((refused as Error).message).toMatch(/reftable/);
    expect((refused as Error).message).not.toMatch(/PASS|verify GREEN|verdict/);

    const disabled = filesRepo();
    const disabledHead = git(disabled, "rev-parse HEAD");
    expect(existsSync(headLog(disabled))).toBe(true);
    git(disabled, "config core.logAllRefUpdates false");
    gate(disabled, MOVE);
    const again = await verify(["--no-review"], disabled);
    expect(again.code, again.out).toBe(2);
    expect(again.out).toContain(RESTORED(disabledHead));
    expect(git(disabled, "rev-parse HEAD")).toBe(disabledHead);
  }, 180_000);

  test("through the CLI verify command a checkout whose HEAD never had a reflog and one whose HEAD log is unreadable and one whose newest HEAD reflog entry is not HEAD each exit non-zero before any baseline capture naming the witness and print no verdict, PASS or GREEN line on stdout versus the same checkout with a valid HEAD reflog capturing and verifying green (V-F2 F3 F4 V-P1)", () => {
    const refused = (repo: string, witness: string) => {
      const ran = cliVerify(repo);
      expect(ran.status, ran.stderr).not.toBe(0);
      expect(ran.status, ran.stderr).not.toBeNull();
      expect(ran.stderr).toContain(`HEAD's reflog cannot witness the candidate (${witness})`);
      expect(verdictLines(ran.stdout)).toEqual([]);
      expect(ran.stderr).not.toContain("capturing baseline");
      expect(existsSync(verifyStateDir(repo))).toBe(false);
    };

    const never = repoWithoutReflog();
    expect(existsSync(headLog(never))).toBe(false);
    expect(git(never, "reflog show --no-abbrev --format=%H HEAD")).toBe("");
    refused(never, "no reflog");

    const unreadable = filesRepo();
    git(unreadable, "checkout -q --detach");
    chmodSync(headLog(unreadable), 0);
    expect(git(unreadable, "reflog show --no-abbrev --format=%H HEAD")).toBe("");
    refused(unreadable, "no reflog");

    const foreign = filesRepo();
    const newest = newestIsNotHead(foreign);
    refused(foreign, `newest is ${newest.slice(0, 12)}`);

    const valid = filesRepo();
    const green = cliVerify(valid);
    expect(green.status, green.stderr).toBe(0);
    expect(green.stdout).toContain("verify GREEN");
    expect(green.stdout).toMatch(/^PASS /m);
    expect(green.stderr).toContain("capturing baseline");
  }, 180_000);

  test("through the verify command a HEAD reflog that turns unreadable between two subject checks latches the candidate so no verdict is published versus a reflog read unchanged at every check publishing the stamped verdicts (V-F5 V-P1)", async () => {
    const repo = filesRepo();
    const head = git(repo, "rev-parse HEAD");
    git(repo, "checkout -q --detach");
    const seen = join(makeTestTempDir("tickmarkr-witness-"), "lines");
    gate(repo, `git reflog show --no-abbrev --format=%H HEAD > ${JSON.stringify(seen)} && chmod 000 "$(git rev-parse --absolute-git-dir)/logs/HEAD"`);
    const latched = await verify(["--no-review"], repo);
    expect(latched.code, latched.out).toBe(2);
    expect(latched.out).toContain(RESTORED(head));
    expect(latched.out).not.toContain("cannot witness the candidate");
    expect(readFileSync(seen, "utf8").trim().split("\n")[0]).toBe(head);
    expect(readdirSync(join(repo, ".tickmarkr", "verdicts")).filter((name) => name.startsWith("verdict-"))).toEqual([]);

    const unchanged = filesRepo();
    const published = await verify(["--no-review"], unchanged);
    expect(published.code, published.out).toBe(0);
    expect(published.out).toContain("verify GREEN");
    expect(stampedSubjects(unchanged)).toContain(git(unchanged, "rev-parse HEAD"));
  }, 180_000);
});
