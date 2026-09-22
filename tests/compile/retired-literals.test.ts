import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { retiredLiteralErrors, type PinScanIo } from "../../src/compile/retired-literals.js";
import { makeRepo } from "../helpers/tmprepo.js";

const literal = (glob: string) => [{ kind: "literal" as const, text: "oldName", glob }];

describe("declared pin scan (v2.5.8 T14)", () => {
  test("a declared literal scan over a surface holding a text fixture reports that fixture's hit by path plus line, so a scan that skips files lacking a code extension fails", () => {
    const repo = makeRepo({
      "src/a.ts": "export const newName = 1;\n",
      "tests/fixtures/golden.txt": "header\nstill fine\ncalls oldName here\n",
      "tests/a.test.ts": "void 0;\n",
    });
    const errors = retiredLiteralErrors([{ id: "T1", files: ["src/a.ts"], pins: literal("tests/**") }], repo);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("tests/fixtures/golden.txt:3");
    expect(errors[0]).toContain('"oldName"');
    expect(retiredLiteralErrors([{ id: "T1", files: ["src/a.ts", "tests/fixtures/golden.txt"], pins: literal("tests/**") }], repo)).toEqual([]);
  });

  test("a declared scan encountering an unreadable file, a truncated read or an empty search surface refuses certification naming its cause, so partial evidence certified as complete fails", () => {
    const repo = makeRepo({ "tests/fixtures/golden.txt": "clean\n", "src/a.ts": "x\n" });
    // owned by the task: only a COMPLETE read may certify it, so ownership cannot mask the refusal
    const tasks = [{ id: "T1", files: ["src/a.ts", "tests/**"], pins: literal("tests/**") }];
    const node: PinScanIo = { size: (abs) => statSync(abs).size, read: (abs) => readFileSync(abs), isDirectory: (abs) => statSync(abs).isDirectory(), isFile: (abs) => statSync(abs).isFile() };
    expect(retiredLiteralErrors(tasks, repo, node)).toEqual([]);

    const unreadable = retiredLiteralErrors(tasks, repo, { ...node, read: () => { throw new Error("EACCES: permission denied"); } });
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toMatch(/refuses certification: unreadable file tests\/fixtures\/golden\.txt \(EACCES/);

    const truncated = retiredLiteralErrors(tasks, repo, { ...node, read: (abs) => readFileSync(abs).subarray(0, 2) });
    expect(truncated[0]).toMatch(/refuses certification: truncated read of tests\/fixtures\/golden\.txt \(2 of 6 bytes\)/);

    // a fixture pin is held to the same whole-file read, owned or not
    const fixtureTasks = [{ id: "T1", files: ["src/a.ts", "tests/**"], pins: [{ kind: "fixture" as const, paths: ["tests/fixtures/**"] }] }];
    expect(retiredLiteralErrors(fixtureTasks, repo, node)).toEqual([]);
    expect(retiredLiteralErrors(fixtureTasks, repo, { ...node, read: () => { throw new Error("EACCES: permission denied"); } })[0])
      .toMatch(/fixture pin tests\/fixtures\/\*\* refuses certification: unreadable file tests\/fixtures\/golden\.txt/);
    expect(retiredLiteralErrors(fixtureTasks, repo, { ...node, read: (abs) => readFileSync(abs).subarray(0, 2) })[0])
      .toMatch(/fixture pin tests\/fixtures\/\*\* refuses certification: truncated read of tests\/fixtures\/golden\.txt/);

    const empty = retiredLiteralErrors([
      { id: "T1", files: ["src/a.ts"], pins: [...literal("nowhere/**"), { kind: "fixture" as const, paths: ["fixtures/none/**"] }] },
    ], repo);
    expect(empty).toHaveLength(2);
    for (const line of empty) expect(line).toMatch(/refuses certification: empty search surface/);

    // the real file system reaches the same refusal (skipped where chmod cannot deny, e.g. root)
    chmodSync(`${repo}/tests/fixtures/golden.txt`, 0o000);
    try {
      let denied = false;
      try { readFileSync(`${repo}/tests/fixtures/golden.txt`); } catch { denied = true; }
      if (denied) expect(retiredLiteralErrors(tasks, repo)[0]).toMatch(/refuses certification: unreadable file/);
    } finally {
      chmodSync(`${repo}/tests/fixtures/golden.txt`, 0o644);
    }
  });

  test("the declared surface is the whole file system under the glob, decided by the one matcher: nothing is pruned, a directory symlink is followed, a cycle refuses", () => {
    const repo = makeRepo({
      "fixtures/plain.txt": "clean\n",
      "fixtures/node_modules/golden.txt": "calls oldName\n",
      "fixtures/a,b/hit.txt": "oldName\n",
      "fixtures/c/clean.txt": "clean\n",
      "elsewhere/real.txt": "oldName\n",
      ".gitignore": "fixtures/cache/\nnode_modules/\n",
    });
    const fixture = (glob: string) => [{ kind: "fixture" as const, paths: [glob] }];
    const run = (files: string[], pins: ReturnType<typeof literal> | ReturnType<typeof fixture>) =>
      retiredLiteralErrors([{ id: "T1", files, pins }], repo);

    // picomatch reads {a\,b,c} as the branches "a,b" and "c": the clean owned c file never masks the a,b hit
    const brace = "fixtures/{a\\,b,c}/**";
    expect(run(["fixtures/c/**"], literal(brace))).toEqual([expect.stringContaining("fixtures/a,b/hit.txt:1")]);
    expect(run(["fixtures/c/**"], fixture(brace))).toEqual([expect.stringContaining("obligates fixtures/a,b/hit.txt")]);

    // a nested node_modules is declared surface like any other directory
    const owned = ["fixtures/plain.txt", "fixtures/a,b/**", "fixtures/c/**"];
    expect(run(owned, literal("fixtures/**"))).toEqual([expect.stringContaining("fixtures/node_modules/golden.txt:1")]);
    expect(run(owned, fixture("fixtures/**"))).toEqual([expect.stringContaining("obligates fixtures/node_modules/golden.txt")]);

    // an IGNORED match is still a declared match: the clean tracked plain.txt never masks it
    mkdirSync(`${repo}/fixtures/cache`);
    writeFileSync(`${repo}/fixtures/cache/hit.txt`, "oldName\n");
    const visible = [...owned, "fixtures/node_modules/**"];
    expect(run(visible, literal("fixtures/**"))).toEqual([expect.stringContaining("fixtures/cache/hit.txt:1")]);
    expect(run(visible, fixture("fixtures/**"))).toEqual([expect.stringContaining("obligates fixtures/cache/hit.txt")]);
    rmSync(`${repo}/fixtures/cache`, { recursive: true });

    // root node_modules and .git are scanned whenever the glob reaches them, broad or brace spelled
    mkdirSync(`${repo}/node_modules/dep`, { recursive: true });
    writeFileSync(`${repo}/node_modules/dep/x.txt`, "oldName\n");
    writeFileSync(`${repo}/.git/note.txt`, "fine\noldName\n");
    expect(run(["fixtures/**", "elsewhere/**"], literal("**/*.txt"))).toEqual([
      expect.stringContaining(".git/note.txt:2"),
      expect.stringContaining("node_modules/dep/x.txt:1"),
    ]);
    expect(run(["fixtures/**"], fixture("{node_modules,fixtures}/**"))).toEqual([expect.stringContaining("obligates node_modules/dep/x.txt")]);

    // a directory symlink is followed: the match behind it is listed under the link's own path
    symlinkSync(`${repo}/elsewhere`, `${repo}/fixtures/linked`);
    expect(run(visible, literal("fixtures/**/*.txt"))).toEqual([expect.stringContaining("fixtures/linked/real.txt:1")]);
    expect(run(visible, fixture("fixtures/**/*.txt"))).toEqual([expect.stringContaining("obligates fixtures/linked/real.txt")]);
    expect(run(["fixtures/**"], literal("fixtures/**"))).toEqual([]);
    // and a glob that cannot reach beneath it is not refused because of it
    for (const glob of ["fixtures/*.txt", "fixtures/**.txt", "{fixtures,fixtures/golden}/*.txt"]) {
      expect(run(visible, literal(glob))).toEqual([]);
      expect(run(visible, fixture(glob))).toEqual([]);
    }
    // a directory symlink beside an owned plain file: neither the link nor anything beneath it can match these globs
    symlinkSync(`${repo}/elsewhere`, `${repo}/fixtures/cache`);
    for (const glob of ["fixtures/**.txt", "{fixtures,fixtures/golden}/*.txt", "fixtures/*.txt"]) {
      expect(run(["fixtures/plain.txt"], literal(glob))).toEqual([]);
      expect(run(["fixtures/plain.txt"], fixture(glob))).toEqual([]);
    }
    rmSync(`${repo}/fixtures/cache`);

    // a matched broken link is unreadable evidence, never a silent skip
    symlinkSync(`${repo}/gone.txt`, `${repo}/fixtures/c/dangling.txt`);
    expect(run(["fixtures/**"], literal("fixtures/c/**"))).toEqual([expect.stringMatching(/refuses certification: unreadable file fixtures\/c\/dangling\.txt/)]);
    rmSync(`${repo}/fixtures/c/dangling.txt`);

    // a link back into its own ancestry has no finite listing: it refuses by name, only where walked
    symlinkSync(`${repo}/fixtures`, `${repo}/fixtures/c/loop`);
    for (const pins of [literal("fixtures/**"), fixture("fixtures/**")]) {
      expect(run(["fixtures/**"], pins)).toEqual([expect.stringMatching(/refuses certification: symlink cycle at fixtures\/c\/loop cannot be enumerated/)]);
    }
    expect(run(["elsewhere/**"], literal("elsewhere/**"))).toEqual([]);
    // nor where no match could sit beneath it: a one-level glob stays certifiable beside a nested cycle
    for (const glob of ["fixtures/*.txt", "fixtures/**.txt", "{fixtures,fixtures/golden}/*.txt", "fixtures/{a\\,b,plain.txt}"]) {
      expect(run(["fixtures/**"], literal(glob))).toEqual([]);
      expect(run(["fixtures/**"], fixture(glob))).toEqual([]);
    }
    expect(run(["fixtures/**"], literal("fixtures/{a\\,b,c}/*/*.txt"))).toEqual([expect.stringContaining("symlink cycle at fixtures/c/loop")]);
    // a slash-holding brace is expanded the way picomatch reads it: an unrelated cycle or unlistable directory
    // at fixtures/c itself (where the walk would otherwise descend) cannot refuse {fixtures/a,fixtures/b}/*.txt
    rmSync(`${repo}/fixtures/c/loop`);
    rmSync(`${repo}/fixtures/c`, { recursive: true });
    symlinkSync(`${repo}/fixtures`, `${repo}/fixtures/c`);
    mkdirSync(`${repo}/fixtures/a`);
    writeFileSync(`${repo}/fixtures/a/ok.txt`, "clean\n");
    for (const glob of ["{fixtures/a,fixtures/b}/*.txt", "fixtures/{a,b}/*.txt"]) {
      expect(run(["fixtures/a/**"], literal(glob))).toEqual([]);
      expect(run(["fixtures/a/**"], fixture(glob))).toEqual([]);
    }
    expect(run(["fixtures/a/**"], literal("{fixtures/a,fixtures/c}/*.txt"))).toEqual([expect.stringContaining("symlink cycle at fixtures/c")]);
    rmSync(`${repo}/fixtures/c`);
    mkdirSync(`${repo}/fixtures/c`);
    writeFileSync(`${repo}/fixtures/c/clean.txt`, "clean\n");
    // a cycle nested one level down never refuses a one-level glob over its parent
    mkdirSync(`${repo}/fixtures/sub`);
    symlinkSync(`${repo}/fixtures`, `${repo}/fixtures/sub/loop`);
    expect(run(["fixtures/plain.txt"], literal("fixtures/*.txt"))).toEqual([]);
    expect(run(["fixtures/**"], literal("fixtures/**"))).toEqual([expect.stringContaining("symlink cycle at fixtures/sub/loop")]);
    rmSync(`${repo}/fixtures/sub`, { recursive: true });
    // a leading `!` inside a later segment is literal text, never a negation: an unrelated cycle beside
    // an owned fixtures/!cache/ok.txt cannot refuse fixtures/!cache/*.txt for either pin kind
    mkdirSync(`${repo}/fixtures/!cache`);
    writeFileSync(`${repo}/fixtures/!cache/ok.txt`, "clean\n");
    symlinkSync(`${repo}/fixtures`, `${repo}/fixtures/other`);
    expect(run(["fixtures/!cache/**"], literal("fixtures/!cache/*.txt"))).toEqual([]);
    expect(run(["fixtures/!cache/**"], fixture("fixtures/!cache/*.txt"))).toEqual([]);
    expect(run(["fixtures/!cache/**"], literal("fixtures/*/*.txt"))).toContainEqual(expect.stringContaining("symlink cycle at fixtures/other"));
    rmSync(`${repo}/fixtures/other`);
    rmSync(`${repo}/fixtures/!cache`, { recursive: true });

    // an entry nobody could stat may be a directory hiding obligations: it refuses by name, never filtered away by the glob
    const node: PinScanIo = { size: (abs) => statSync(abs).size, read: (abs) => readFileSync(abs), isDirectory: (abs) => statSync(abs).isDirectory(), isFile: (abs) => statSync(abs).isFile() };
    const eio: PinScanIo = { ...node, isDirectory: (abs) => { if (abs.endsWith("/elsewhere")) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); return node.isDirectory(abs); } };
    const tasks = (glob: string) => [{ id: "T1", files: ["**"], pins: literal(glob) }];
    expect(retiredLiteralErrors(tasks("{elsewhere,fixtures/c}/*.txt"), repo, node)).toEqual([]);
    expect(retiredLiteralErrors(tasks("{elsewhere,fixtures/c}/*.txt"), repo, eio)).toEqual([expect.stringMatching(/refuses certification: unstattable path elsewhere \(EIO/)]);
    expect(retiredLiteralErrors(tasks("fixtures/c/*.txt"), repo, eio)).toEqual([]);

    // a leading `!` matches everything its body does not: a cycle the body wholly covers cannot refuse it,
    // while a cycle the body leaves reachable still does
    mkdirSync(`${repo}/fixtures/cache`);
    symlinkSync(`${repo}/fixtures`, `${repo}/fixtures/cache/loop`);
    writeFileSync(`${repo}/owned.txt`, "clean\n");
    expect(run(["**"], literal("!fixtures/cache/**"))).toEqual([]);
    expect(run(["**"], fixture("!fixtures/cache/**"))).toEqual([]);
    expect(run(["**"], literal("!fixtures/cache/*.txt"))).toEqual([expect.stringContaining("symlink cycle at fixtures/cache/loop")]);
    // a globstar before the excluded subtree still covers it: `!**\/cache/**` reaches fixtures/cache/loop
    expect(run(["**"], literal("!**/cache/**"))).toEqual([]);
    expect(run(["**"], fixture("!**/cache/**"))).toEqual([]);
    expect(run(["**"], literal("!**/other/**"))).toEqual([expect.stringContaining("symlink cycle at fixtures/cache/loop")]);
    rmSync(`${repo}/fixtures/cache`, { recursive: true });
    rmSync(`${repo}/owned.txt`);

    // a FIFO matched by the glob is refused by kind, never opened for a read that could block forever
    execFileSync("mkfifo", [`${repo}/fixtures/c/pipe.txt`]);
    expect(run(["fixtures/**"], literal("fixtures/c/*.txt"))).toEqual([expect.stringMatching(/unreadable file fixtures\/c\/pipe\.txt \(unsupported file fixtures\/c\/pipe\.txt \(not a regular file\)\)/)]);
    expect(run(["fixtures/**"], fixture("fixtures/c/*.txt"))).toEqual([expect.stringContaining("not a regular file")]);
    rmSync(`${repo}/fixtures/c/pipe.txt`);

    // a pattern matching nothing on disk has an empty surface
    expect(run(["fixtures/**"], literal("fixtures/none/**"))).toEqual([expect.stringContaining("empty search surface")]);
  });
});
