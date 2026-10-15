// v2.8.2 T6 (ANL-022 §7.5, D-1960) — each release link reads the previous link's machine output: the export proof
// `bash scripts/verify-export.sh` writes into the source checkout's git directory (D-1974) is what
// `bash scripts/export-public.sh --onto <mirror>` reads before it writes the mirror commit, so the proven tree and
// the published tree are one tree. Both production entries run as the runbook calls them, from a synthetic source
// repository carrying both scripts and the record tooling, against a scratch mirror whose raw origin is the public
// URL with a repository-local insteadOf onto a local stand-in (tests/repo/release-docs.test.ts's mirror fixtures).
// The candidate's npm is a stand-in: `ci` links the dependencies, `test` writes the record a green suite would.
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { ownedFailures, runOwned } from "../helpers/owned-process.js";
import { childEnv, recordText, ROOT, scratch } from "../fixtures/ci/recorded-run.js";

const EXPORT_SCRIPT = join(ROOT, "scripts/export-public.sh");
const VERIFY_SCRIPT = join(ROOT, "scripts/verify-export.sh");
const MIRROR_HOOK_INSTALLER = join(ROOT, ".planning/install-mirror-hooks.sh");
const PUBLIC_HTTPS = "https://github.com/alzahrani-khalid/tickmarkr.git";
const PAGES = ["ARCHITECTURE.md", "CLI-DESIGN.md", "CONVENTIONS.md", "INTEGRATIONS.md", "STACK.md", "STRUCTURE.md", "TESTING.md"];
const TESTS = ["tests/chain/a.test.ts", "tests/chain/b.test.ts"];

type Ran = { status: number | null; stdout: string; stderr: string };
const git = (dir: string, ...args: string[]): Promise<Ran> => sh(dir, "git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args]);
async function sh(cwd: string, cmd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<Ran> {
  const run = await runOwned(cmd, args, { cwd, env: childEnv(env), ms: 300_000 });
  const failures = ownedFailures(run, cmd);
  if (failures.length > 0) throw new Error(`${failures.join("; ")}\n${run.out}\n${run.err}`);
  return { status: run.exitCode, stdout: run.out, stderr: run.err };
}
async function out(dir: string, ...args: string[]): Promise<string> {
  const ran = await git(dir, ...args);
  expect(ran.status, `git ${args.join(" ")}: ${ran.stderr}`).toBe(0);
  return ran.stdout.trim();
}

/** Every path under `dir`, its .git included, to the bytes it holds (a link to its target). */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
    else files[relative(dir, path)] = stat.isSymbolicLink() ? `-> ${readlinkSync(path)}`
      : `${stat.mode.toString(8)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  };
  walk(dir);
  return files;
}

/** A synthetic source checkout (both release scripts, the record tooling, two tracked test files, the docs pages
 * the exporter ships), a scratch mirror with its identity guard installed, and the two production entries. */
async function chain(root: string) {
  const source = join(root, "source");
  const write = (path: string, text: string | Buffer) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };
  write(join(source, "package.json"), `${JSON.stringify({ name: "fixture", version: "9.9.9", type: "module" }, null, 2)}\n`);
  for (const page of PAGES) write(join(source, "docs/codebase", page), `# ${page}\n`);
  for (const script of [EXPORT_SCRIPT, VERIFY_SCRIPT]) write(join(source, "scripts", script.split("/").at(-1)!), readFileSync(script));
  cpSync(join(ROOT, "scripts/ci"), join(source, "scripts/ci"), { recursive: true });
  for (const file of TESTS) write(join(source, file), "");
  await out(source, "init", "-q");
  await out(source, "add", "-A");
  await out(source, "commit", "-qm", "source");

  const origin = join(root, "origin");
  write(join(origin, "previous-release.txt"), "previous public release\n");
  await out(origin, "init", "-q", "-b", "main");
  await out(origin, "add", "-A");
  await out(origin, "commit", "-qm", "previous release");
  const mirror = join(root, "mirror");
  await out(root, "clone", "-q", origin, mirror);
  await out(mirror, "remote", "set-url", "origin", PUBLIC_HTTPS);
  await out(mirror, "config", `url.${origin}.insteadOf`, PUBLIC_HTTPS);
  expect((await sh(ROOT, "bash", [MIRROR_HOOK_INSTALLER, mirror])).status).toBe(0);

  const bin = join(root, "bin");
  write(join(bin, "npm"), `#!/usr/bin/env bash
case "$1" in
  ci) ln -s "$NODE_MODULES_FIXTURE" node_modules ;;
  test) sed "s/@HEAD@/$(git rev-parse HEAD)/" "$SUITE_RECORD" > "$TICKMARKR_CI_RECORD"; echo " Test Files  2 passed (2)" ;;
esac
`);
  chmodSync(join(bin, "npm"), 0o755);
  write(join(root, "suite.record.json"), recordText("@HEAD@", TESTS.map((file) => [file, "suite"] as const)));
  const env = {
    PATH: `${bin}:${process.env.PATH}`, VITEST_MAX_FORKS: "1",
    NODE_MODULES_FIXTURE: join(ROOT, "node_modules"), SUITE_RECORD: join(root, "suite.record.json"),
  };
  const proofPath = await out(source, "rev-parse", "--path-format=absolute", "--git-path", "tickmarkr-release/export-proof.json");
  return {
    source, origin, mirror, proofPath,
    verify: () => sh(source, "bash", ["scripts/verify-export.sh"], env),
    publish: () => sh(source, "bash", ["scripts/export-public.sh", "--onto", mirror], env),
    proof: () => JSON.parse(readFileSync(proofPath, "utf8")) as Record<string, string>,
  };
}

// skipped on the exported tree: scripts/export-public.sh, scripts/verify-export.sh and the .planning mirror-hook
// installer are absent there (the exporter excludes all three), as tests/repo/release-docs.test.ts's mirror suite is
describe.skipIf(!existsSync(MIRROR_HOOK_INSTALLER) || !existsSync(EXPORT_SCRIPT) || !existsSync(VERIFY_SCRIPT))("the release chain from the proven export to the mirror commit (skipped on the exported tree: scripts/export-public.sh is absent)", () => {
  test("test: a green verify export writes the export proof naming the source head, the export tree, the version and its record and set lines, and the mirror publish with the head unchanged prints the mirror commit whose tree equals that export tree (C-P1)", { timeout: 600_000 }, async () => {
    const root = scratch("tickmarkr-release-chain-");
    try {
      const c = await chain(root);
      const verified = await c.verify();
      expect(verified.status, `${verified.stdout}${verified.stderr}`).toBe(0);
      const decided = verified.stdout.split("\n").filter((line) => /^(RECORD_VERDICT|SET_ORACLE) /.test(line));
      expect(decided).toEqual([
        "RECORD_VERDICT verdict=CLEAN files=2 tests=2 failed=0 unfinished=0 unhandled=0 rpc=0 reason=passed",
        "SET_ORACLE verdict=GREEN expected=2 actual=2 defects=0",
      ]);
      const proof = c.proof();
      expect(proof).toEqual({
        schema: "tickmarkr-export-proof/1", source_head: await out(c.source, "rev-parse", "HEAD"),
        export_tree: expect.stringMatching(/^[0-9a-f]{40}$/), version: "9.9.9", record_verdict: decided[0], set_oracle: decided[1],
      });
      // the proof sits in the git directory, so the checkout the exporter refuses when dirty stays clean
      expect(await out(c.source, "status", "--porcelain", "--ignored")).toBe("");

      const originMain = await out(c.origin, "rev-parse", "main");
      const published = await c.publish();
      expect(published.status, `${published.stdout}${published.stderr}`).toBe(0);
      const commits = published.stdout.split("\n").filter((line) => line.startsWith("MIRROR_COMMIT="));
      expect(commits).toHaveLength(1);
      const commit = /^MIRROR_COMMIT=([0-9a-f]{40})$/.exec(commits[0]!)?.[1];
      expect(commit, commits[0]).toBeDefined();
      expect(await out(c.mirror, "rev-parse", "HEAD")).toBe(commit);
      expect(await out(c.mirror, "rev-parse", `${commit}^{tree}`)).toBe(proof.export_tree);
      expect(await out(c.mirror, "rev-parse", `${commit}~1`)).toBe(originMain);
      // nothing pushed: the push stays the operator's act
      expect(await out(c.origin, "rev-parse", "main")).toBe(originMain);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("test: the mirror publish refuses with the mirror byte-identical when the export proof is missing, names another source head, or was proven over another export tree (C-F1 C-F2)", { timeout: 600_000 }, async () => {
    const root = scratch("tickmarkr-release-chain-refuse-");
    try {
      const c = await chain(root);
      const before = snapshot(c.mirror);
      let stamp = 1_000_000_000;
      const refused = async (why: RegExp, label: string) => {
        // content-clean but stat-stale: a tracked file's timestamps moved since the index recorded them, so a
        // preflight read that refreshed the index would rewrite .git/index before the refusal
        stamp += 86_400;
        utimesSync(join(c.mirror, "previous-release.txt"), stamp, stamp);
        const ran = await c.publish();
        expect(ran.status, `${label}\n${ran.stdout}${ran.stderr}`).toBe(1);
        expect(ran.stderr, label).toMatch(why);
        expect(ran.stdout, label).not.toContain("MIRROR_COMMIT=");
        expect(snapshot(c.mirror), label).toEqual(before);
      };
      // C-F2: no proof at all — the source and mirror are otherwise publishable (the last step below publishes them)
      expect(existsSync(c.proofPath)).toBe(false);
      await refused(/--onto refusing, the mirror untouched: no readable export proof/, "no proof");

      // C-F1: HEAD moved after a green verify export — the proof names another source head
      expect((await c.verify()).status).toBe(0);
      const proven = c.proof();
      writeFileSync(join(c.source, "tests/chain/a.test.ts"), "// moved\n");
      await out(c.source, "commit", "-qam", "moved after the proof");
      const moved = await out(c.source, "rev-parse", "HEAD");
      await refused(new RegExp(`names source head ${proven.source_head}, not HEAD ${moved}`), "head moved");

      // C-F2: a proof naming this HEAD but proven over another export tree
      writeFileSync(c.proofPath, `${JSON.stringify({ ...proven, source_head: moved }, null, 2)}\n`);
      await refused(new RegExp(`proven over tree ${proven.export_tree}, not the tree of this export [0-9a-f]{40}`), "another tree");

      // control: a green verify export of the moved HEAD is accepted, and that publish is the first mirror change
      expect((await c.verify()).status).toBe(0);
      const published = await c.publish();
      expect(published.status, `${published.stdout}${published.stderr}`).toBe(0);
      expect(published.stdout).toMatch(/^MIRROR_COMMIT=[0-9a-f]{40}$/m);
      expect(snapshot(c.mirror)).not.toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
