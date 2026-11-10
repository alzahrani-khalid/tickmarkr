// Queue rows 393 and 394 (D-2187 add.16): the board reads only the session's own project (R11) and flags an ended run
// older than the release card (R12). Every cell is a disposable repository whose git files this test writes; nothing
// here runs git.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readRelease, readRunBoard, stateRoots } from "../../src/board/read.js";
import { parseBoard } from "../../hooks/board/model.js";

const scratch: string[] = [];
afterEach(() => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); });
function put(path: string, body: string, mtime?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  if (mtime !== undefined) utimesSync(path, mtime, mtime);
}
/** A folder outside every repository: the control below proves no `.git` entry sits above it. */
function outside(): string {
  const d = mkdtempSync(join(tmpdir(), "tkr-board-proj-"));
  scratch.push(d);
  expect(stateRoots(d, [])).toEqual([join(d, ".tickmarkr")]); // R2 found no checkout at or above it
  return d;
}
/** A git config in the closed FORMAT table (D-2187 add.29) naming `origin`, beside sections that do not count. */
const config = (origin: string): string => "[core]\n\trepositoryformatversion = 0\n[remote \"upstream\"]\n\turl = /elsewhere\n"
  + `[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n`;
/** A checkout with a `.git` folder whose config names `origin` (or no config at all when origin is null). */
function checkout(dir: string, origin: string | null): string {
  mkdirSync(join(dir, ".git"), { recursive: true });
  if (origin !== null) put(join(dir, ".git", "config"), config(origin));
  return dir;
}
const T0 = 1793000000;
const iso = (t: number) => new Date(t * 1000).toISOString();
/** A run whose journal (at `mtime`) starts, and ends at `end` when given (resumed after it when `resume`). */
function run(state: string, id: string, mtime: number, end?: number, resume = false): void {
  const rows: object[] = [{ ts: iso(T0 - 600), event: "run-start", data: { runId: id } }];
  if (end !== undefined) rows.push({ ts: iso(end), event: "run-end", data: { runId: id, done: [], failed: [], human: [], blocked: [], pending: [] } });
  if (resume) rows.push({ ts: iso((end ?? T0) + 10), event: "run-resume", data: { runId: id } });
  put(join(state, "runs", id, "journal.jsonl"), rows.map((r) => JSON.stringify(r) + "\n").join(""), mtime);
}
const release = (dir: string, mtime: number) => put(join(dir, "backup-push.log"), "ok\n", mtime);
const id = (n: number) => `run-20261101-000000-${String(n).padStart(16, "0")}`;
type Full = { runId: string; release: { version: string; dir: string } | null; supersededBy: string | null };

test("the project scope CASE table counts same project roots and release folders ignores another project's and keeps every root for a session outside every repository", () => {
  const tmp = outside();
  const proj = checkout(join(tmp, "proj"), "https://GitHub.com/acme/proj.git");
  // a linked worktree whose administrative gitdir file is gone: R2 skips it, but its common directory is proj's
  put(join(proj, ".git", "worktrees", "wt", "commondir"), "../..\n");
  put(join(tmp, "wt", ".git"), `gitdir: ${join(proj, ".git", "worktrees", "wt")}\n`);
  const byPath = checkout(join(tmp, "clone-path"), proj); // a clone whose origin is this checkout
  const byFile = checkout(join(tmp, "clone-file"), `file://${proj}/.git`); // a file:// URL is UNREADABLE (D-2187 add.29)
  const byUrl = checkout(join(tmp, "clone-url"), "https://GitHub.com/acme/proj.git"); // the same network remote: never a match (D-2187 add.52)
  const other = checkout(join(tmp, "other"), "https://github.com/acme/other.git"); // another project
  const chain = checkout(join(tmp, "chain"), byPath); // origin is a clone of proj: one hop, never a chain
  const noConfig = checkout(join(tmp, "noconfig"), null); // unreadable origin: compares by common directory alone
  const loose = join(tmp, "loose"); // outside every checkout
  const state = (d: string) => join(d, ".tickmarkr");
  const same = [state(join(tmp, "wt")), state(byPath)];
  const foreign = [state(other), state(chain), state(noConfig), state(loose), state(byFile), state(byUrl)];
  for (const d of [...same, ...foreign]) mkdirSync(d, { recursive: true });
  const given = [foreign[0], same[0], foreign[1], foreign[5], same[1], foreign[4], foreign[2], foreign[3]];

  // inside a repository: R2's own checkouts first, then each same-project root in R3 order; the rest never searched
  expect(stateRoots(proj, given)).toEqual([state(proj), ...same]);
  expect(stateRoots(join(proj, "src", "deep"), given)).toEqual([state(proj), ...same]); // the enclosing checkout, from below
  // the newest run sits in another project's root: it is never read, and the newest same-project run is
  run(state(other), id(9), T0 + 900);
  run(state(chain), id(8), T0 + 800);
  run(state(loose), id(7), T0 + 700);
  run(state(byUrl), id(6), T0 + 600);
  run(state(byFile), id(5), T0 + 500);
  run(same[1], id(4), T0 + 400);
  run(same[0], id(2), T0 + 200);
  expect((readRunBoard(proj, given, [], T0) as Full).runId).toBe(id(4));

  // release folders: the card chooses only among the session's project's folders, the newest foreign one ignored
  const rels = [join(other, "rel", "9.9.9"), join(proj, "rel", "2.0.0"), join(byPath, "rel", "2.1.0"), join(loose, "rel", "8.8.8"), join(byUrl, "rel", "7.7.7")];
  release(rels[0], T0 + 990);
  release(rels[1], T0 + 100);
  release(rels[2], T0 + 300);
  release(rels[3], T0 + 980);
  release(rels[4], T0 + 970);
  expect(readRelease(proj, rels, T0)?.version).toBe("2.1.0");
  expect((readRunBoard(proj, given, rels, T0) as Full).release?.version).toBe("2.1.0");
  expect(readRelease(proj, [rels[0], rels[3], rels[4]], T0)).toBeNull(); // only foreign folders: no card

  // the empty answer names what it searched and, apart, the foreign roots and folders it ignored
  const empty = readRunBoard(proj, foreign, [rels[0], rels[1]], T0);
  expect(empty).toStrictEqual({ version: 1,
    empty: `no tickmarkr run under ${state(proj)}; ignored as another project's: ${[...foreign, rels[0]].join(", ")}` });
  expect(readRunBoard(proj, [], [], T0)).toStrictEqual({ version: 1, empty: `no tickmarkr run under ${state(proj)}` }); // nothing ignored: the base text

  // a session in a linked worktree: R2's checkouts (its own, then the main one) always first, a foreign root ignored
  const linked = join(tmp, "linked");
  put(join(proj, ".git", "worktrees", "lnk", "gitdir"), join(linked, ".git") + "\n");
  put(join(proj, ".git", "worktrees", "lnk", "commondir"), "../..\n");
  put(join(linked, ".git"), `gitdir: ${join(proj, ".git", "worktrees", "lnk")}\n`);
  expect(stateRoots(linked, [foreign[0], same[1]])).toEqual([state(linked), state(proj), same[1]]);

  // the reverse direction: a session in the other project ignores proj's roots and folders
  expect(stateRoots(other, [state(proj), ...same])).toEqual([state(other)]);
  expect(readRelease(other, rels, T0)?.version).toBe("9.9.9");

  // a session outside every repository keeps every given root and folder, as at the base (R3)
  const away = join(tmp, "away");
  mkdirSync(away);
  expect(stateRoots(away, given)).toEqual([state(away), ...given]);
  expect((readRunBoard(away, given, rels, T0) as Full).runId).toBe(id(9));
  expect(readRelease(away, rels, T0)?.version).toBe("9.9.9");
});

// R11's physical path class (D-2187 add.52 point 1): a symlink's TARGET decides, the displayed path keeps its spelling.
test("the physical path CASE table ignores a symlink to another project's root or release folder and counts a symlink alias to the session's own state", () => {
  const tmp = outside();
  const a = checkout(join(tmp, "a"), "https://github.com/acme/a.git");
  const b = checkout(join(tmp, "b"), "https://github.com/acme/b.git");
  const projects: Record<string, string> = { a, b };
  const targets: Record<string, { state: string; rel: string }> = {
    a: { state: join(a, "named", ".tickmarkr"), rel: join(a, "rel", "1.0.0") },
    b: { state: join(b, "named", ".tickmarkr"), rel: join(b, "rel", "9.0.0") },
  };
  for (const t of Object.values(targets)) {
    mkdirSync(t.state, { recursive: true });
    release(t.rel, T0);
  }
  // where each link sits: inside A, inside B, and outside every checkout (the alias folder `tmp/away`)
  const places: Record<string, string> = { a, b, away: join(tmp, "away") };
  const link = (place: string, name: string, target: string): string => {
    const p = join(places[place], "links", name);
    mkdirSync(dirname(p), { recursive: true });
    symlinkSync(target, p, "dir");
    return p;
  };
  const clone = (proj: string, place: string) => join(tmp, `clone-${proj}-via-${place}`);
  // the bounded class: every placement x every target project x {state root, release folder, local origin}, read by
  // both sessions; counted exactly when the target's project is the session's, never by where the link sits
  let cells = 0;
  for (const place of Object.keys(places)) {
    for (const proj of Object.keys(projects)) {
      const state = link(place, `${proj}-state`, targets[proj].state);
      const rel = link(place, `${proj}-rel`, targets[proj].rel);
      const viaOrigin = join(checkout(clone(proj, place), link(place, `${proj}-origin`, join(projects[proj], ".git"))), ".tickmarkr");
      mkdirSync(viaOrigin);
      for (const [who, cwd] of Object.entries(projects)) {
        const cell = `${place}/links/${proj}-* read from ${who}`;
        const mine = who === proj;
        expect(stateRoots(cwd, [state, viaOrigin]), cell).toEqual([join(cwd, ".tickmarkr"), ...(mine ? [state, viaOrigin] : [])]);
        expect(readRelease(cwd, [rel], T0)?.dir ?? null, cell).toBe(mine ? rel : null);
        cells++;
      }
    }
  }
  expect(cells).toBe(12);

  // a clone's link-spelled origin is one hop to A's physical common directory, so A's own state counts; two clones of
  // A are a chain, never one hop (D-2187 add.52 point 2), so each sibling is another project's, as is B's state
  const sib = (proj: string, place: string) => join(clone(proj, place), ".tickmarkr");
  expect(stateRoots(clone("a", "away"), [sib("b", "a"), sib("a", "b"), targets.b.state, sib("a", "a"), targets.a.state]))
    .toEqual([sib("a", "away"), targets.a.state]);

  // the consequence through readRunBoard: B's newer run behind a link inside A is never read, nor B's release card;
  // A's run and card behind links inside B or outside every checkout are, each under the spelling it was given
  run(targets.b.state, id(9), T0 + 900);
  run(targets.a.state, id(1), T0 + 100);
  release(targets.b.rel, T0 + 990);
  const inA = (n: string) => join(a, "links", n);
  const board = readRunBoard(a, [inA("b-state"), join(b, "links", "a-state")], [inA("b-rel"), join(places.away, "links", "a-rel")], T0) as Full;
  expect([board.runId, board.release?.dir]).toEqual([id(1), join(places.away, "links", "a-rel")]);
  expect((readRunBoard(a, [join(places.away, "links", "a-state")], [], T0) as Full).runId).toBe(id(1));
  expect(readRunBoard(a, [inA("b-state")], [inA("b-rel")], T0)).toStrictEqual({ version: 1,
    empty: `no tickmarkr run under ${join(a, ".tickmarkr")}; ignored as another project's: ${inA("b-state")}, ${inA("b-rel")}` });
  expect((readRunBoard(b, [inA("b-state")], [inA("b-rel")], T0) as Full).runId).toBe(id(9)); // B's own, wherever its link sits

  // the session path too: a session reached through an alias of a folder inside A reads as A, and since the alias
  // itself sits outside every checkout, R2 walks from its physical target, so A's own root comes first
  mkdirSync(join(a, "src"));
  symlinkSync(join(a, "src"), join(tmp, "a-src"), "dir");
  const session = join(tmp, "a-src");
  expect(stateRoots(session, [targets.b.state, inA("b-state"), join(places.away, "links", "a-state")]))
    .toEqual([join(realpathSync(a), ".tickmarkr"), join(places.away, "links", "a-state")]);
  expect(readRelease(session, [targets.b.rel, inA("a-rel")], T0)?.dir).toBe(inA("a-rel"));

  // R2's own roots are read the same way (row 394, D-2187 add.29): a session whose link moves it into another
  // checkout walks from its physical target, and an R2 root that is itself a symlink to another project's state is
  // ignored and named, so neither reaches the other project's journal
  const sym = (n: string) => checkout(join(tmp, "sym", n), `https://github.com/acme/${n}.git`);
  const [pa, pb, pc, pd] = ["a", "b", "c", "d"].map(sym);
  for (const d of [pa, pb]) mkdirSync(join(d, "src"));
  run(join(pb, ".tickmarkr"), id(7), T0 + 700);
  const bLink = join(pb, "link"); // inside B, pointing into A: physically A, so B's root is never walked
  symlinkSync(join(pa, "src"), bLink, "dir");
  expect(stateRoots(bLink, [])).toEqual([join(realpathSync(pa), ".tickmarkr")]);
  expect(readRunBoard(bLink, [], [], T0)).toStrictEqual({ version: 1, empty: `no tickmarkr run under ${join(realpathSync(pa), ".tickmarkr")}` });
  run(join(pa, ".tickmarkr"), id(3), T0 + 300);
  expect((readRunBoard(bLink, [], [], T0) as Full).runId).toBe(id(3)); // A's older run, never B's newer one
  const aLink = join(pa, "alias"); // inside A, pointing into B: physically B, so A's root is never walked
  symlinkSync(join(pb, "src"), aLink, "dir");
  expect(stateRoots(aLink, [])).toEqual([join(realpathSync(pb), ".tickmarkr")]);
  expect((readRunBoard(aLink, [], [], T0) as Full).runId).toBe(id(7));
  const self = join(pa, "self"); // control: a link within the session's own checkout keeps R2's walk from <cwd> as given
  symlinkSync(join(pa, "src"), self, "dir");
  expect(stateRoots(self, [])).toEqual([join(pa, ".tickmarkr")]);
  // C's own state root is a symlink to B's: never searched, given or walked, and named in the empty text
  symlinkSync(join(pb, ".tickmarkr"), join(pc, ".tickmarkr"), "dir");
  expect(stateRoots(pc, [join(pc, ".tickmarkr")])).toEqual([]);
  expect(readRunBoard(pc, [join(pc, ".tickmarkr")], [], T0)).toStrictEqual({ version: 1,
    empty: `no tickmarkr run; ignored as another project's: ${join(pc, ".tickmarkr")}` });
  // control: D's own state root is a symlink to a folder inside D, so it counts under its own spelling
  run(join(pd, "keep", "state"), id(5), T0 + 500);
  symlinkSync(join(pd, "keep", "state"), join(pd, ".tickmarkr"), "dir");
  expect(stateRoots(pd, [])).toEqual([join(pd, ".tickmarkr")]);
  expect((readRunBoard(pd, [], [], T0) as Full).runId).toBe(id(5));

  // run …2493's line 1375 cells (D-2187 add.52 point 1): a `..` after a link is the parent of the link's TARGET, so
  // every path is read with realpathSync.native as given, before any lexical step, and every read goes where the
  // kernel goes, never to the text-collapsed spelling. A has alias -> B/src; B has link -> A/src.
  const dot = (n: string) => checkout(join(tmp, "dot", n), `https://github.com/acme/dot-${n}.git`);
  const [da, db] = ["a", "b"].map(dot);
  for (const d of [da, db]) mkdirSync(join(d, "src"));
  mkdirSync(join(da, "sub"));
  symlinkSync(join(db, "src"), join(da, "alias"), "dir");
  symlinkSync(join(da, "src"), join(db, "link"), "dir");
  const up = `${da}/alias/..`; // physically B; never node's join, which collapses it to A as text
  const card = (dir: string, v: string, t: number) => { put(join(dir, "tag-and-publish.sh"), `V=${v}\n`, t); release(dir, t); };
  run(join(db, ".tickmarkr"), id(21), T0 + 100);
  run(join(da, "named"), id(22), T0 + 900); // A/named: what a text collapse of A/alias/../named would read
  run(join(db, "named"), id(23), T0 + 800); // B/named: what a text collapse of B/link/../named would read
  card(join(da, "rel", "shared"), "1.0.0", T0 + 950);
  card(join(db, "rel", "shared"), "9.0.0", T0 + 150);
  const [aRoot, bRel, eRoot, fRoot] = [`${up}/named`, `${up}/rel/shared`, `${db}/link/../named`, `${da}/sub/../named`];
  // (c) the session cwd A/alias/.. is physically B: R2 walks B from its real path, and B's run and release are read
  expect(stateRoots(up, [])).toEqual([join(realpathSync(db), ".tickmarkr")]);
  const fromUp = readRunBoard(up, [], [bRel, join(da, "rel", "shared")], T0) as Full;
  expect([fromUp.runId, fromUp.release?.dir, fromUp.release?.version]).toEqual([id(21), bRel, "9.0.0"]);
  // (a) and (b) from A: A/alias/../named and A/alias/../rel/shared are B's, ignored and named; B's card never read
  expect(stateRoots(da, [aRoot])).toEqual([join(da, ".tickmarkr")]);
  expect(readRelease(da, [bRel], T0)).toBeNull();
  expect(readRunBoard(da, [aRoot], [bRel], T0)).toStrictEqual({ version: 1,
    empty: `no tickmarkr run under ${join(da, ".tickmarkr")}; ignored as another project's: ${aRoot}, ${bRel}` });
  // (e) from A, B/link/../named is physically A/named: counted, and A/named's journal is read, never B/named's
  expect(stateRoots(da, [eRoot])).toEqual([join(da, ".tickmarkr"), eRoot]);
  expect((readRunBoard(da, [eRoot], [], T0) as Full).runId).toBe(id(22));
  // (f) control: A/sub/../named with no link is A/named, counted under its given spelling
  expect(stateRoots(da, [fRoot])).toEqual([join(da, ".tickmarkr"), fRoot]);
  expect((readRunBoard(da, [fRoot], [], T0) as Full).runId).toBe(id(22));
  // the reverse: from B, A/alias/../named and its release folder are B's own, read at the physical target
  expect((readRunBoard(db, [aRoot], [], T0) as Full).runId).toBe(id(23));
  expect(readRelease(db, [bRel], T0)).toMatchObject({ dir: bRel, version: "9.0.0" });
});

// R11 physical first through git's own pointer files (queue row 394, D-2187 add.52): a `.git` file's `gitdir:`, a
// `commondir` and an administrative `gitdir` holding a link followed by `..` name the parent of the link's TARGET,
// never the text-collapsed folder. The bounded class: every pointer consumer x {A/alias/.. (physically B), B/link/..
// (physically A), A/sub/.. (no link, the control that keeps its tidy spelling)}, read from both projects.
test("a git pointer holding a symlink then .. names its physical target in every consumer of the checkout walk", () => {
  const tmp = outside();
  const state = (d: string) => join(d, ".tickmarkr");
  // [lexical project, physical project, the project root as the pointer spells it]
  const spellings: [string, (a: string, b: string) => ["a" | "b", "a" | "b", string]][] = [
    ["A/alias/..", (a) => ["a", "b", `${a}/alias/..`]],
    ["B/link/..", (_a, b) => ["b", "a", `${b}/link/..`]],
    ["A/sub/.. (control)", (a) => ["a", "a", `${a}/sub/..`]],
  ];
  let n = 0;
  for (const kind of ["gitdir", "commondir", "admin"] as const) {
    for (const [spelt, of] of spellings) {
      const d = join(tmp, `cell-${++n}`);
      const p = { a: checkout(join(d, "a"), "https://example.org/acme/a.git"), b: checkout(join(d, "b"), "https://example.org/acme/b.git") };
      for (const s of [join(p.a, "src"), join(p.a, "sub"), join(p.b, "src")]) mkdirSync(s);
      symlinkSync(join(p.b, "src"), join(p.a, "alias"), "dir");
      symlinkSync(join(p.a, "src"), join(p.b, "link"), "dir");
      const [lex, phys, root] = of(p.a, p.b);
      const other = phys === "a" ? p.b : p.a;
      const own = p[phys];
      const shown = (dir: string) => (lex === phys ? dir : join(realpathSync(own), dir.slice(own.length + 1))); // physical when the spelling lies
      const cell = `${kind} ${spelt}`;
      if (kind === "admin") {
        // L's administrative entry names <root>/linked/.git: physically <P>/linked, whose `.git` points back to it, so
        // it is L's worktree; the text-collapsed <L>/linked is the OTHER project's, with a newer run never read
        const admin = join(p[lex], ".git", "worktrees", "w");
        put(join(admin, "gitdir"), `${root}/linked/.git\n`);
        put(join(admin, "commondir"), "../..\n");
        put(join(own, "linked", ".git"), `gitdir: ${admin}\n`);
        run(state(join(own, "linked")), id(n), T0 + 100);
        if (lex !== phys) {
          const foreign = join(p[phys], ".git", "worktrees", "x"); // no gitdir file: R2's walk of P skips it
          put(join(foreign, "commondir"), "../..\n");
          put(join(p[lex], "linked", ".git"), `gitdir: ${foreign}\n`);
          run(state(join(p[lex], "linked")), id(90 + n), T0 + 900);
        }
        expect(stateRoots(p[lex], []), cell).toEqual([state(p[lex]), state(shown(join(own, "linked")))]);
        expect((readRunBoard(p[lex], [], [], T0) as Full).runId, cell).toBe(id(n));
        if (lex !== phys) expect(stateRoots(own, [state(join(own, "linked"))]), cell).toEqual([state(own)]); // L's worktree, not P's
      } else {
        // a checkout C whose git directory (gitdir) or common directory (commondir) is <root>/.git: P's project
        const c = join(d, "c");
        if (kind === "gitdir") put(join(c, ".git"), `gitdir: ${root}/.git\n`);
        else put(join(c, ".git", "commondir"), `${root}/.git\n`);
        const rel = join(c, "rel", "9.0.0");
        run(state(c), id(n), T0 + 100);
        release(rel, T0 + 200);
        expect(stateRoots(c, []), cell).toEqual([state(c), state(shown(own))]); // R2's main checkout: P, never L
        expect(stateRoots(own, [state(c)]), cell).toEqual([state(own), state(c)]);
        expect(stateRoots(other, [state(c)]), cell).toEqual([state(other)]);
        expect(readRelease(own, [rel], T0)?.dir, cell).toBe(rel);
        expect(readRelease(other, [rel], T0), cell).toBeNull();
        expect((readRunBoard(own, [state(c)], [rel], T0) as Full).runId, cell).toBe(id(n));
        expect(readRunBoard(other, [state(c)], [rel], T0), cell).toStrictEqual({ version: 1,
          empty: `no tickmarkr run under ${state(other)}; ignored as another project's: ${state(c)}, ${rel}` });
      }
    }
  }
  expect(n).toBe(9);
});

// R11's origin read class, the closed FORMAT table (D-2187 add.29) under the narrowed rule (D-2187 add.52): every cell
// is a fresh pair of disposable checkouts, a session and another checkout holding a newer run and a release card, read
// through stateRoots, readRelease and readRunBoard in both directions. A cell meant UNREADABLE carries an absolute
// local origin a lax read would turn into the one hop, so only the FORMAT table keeps it out; a network URL never
// matches, however it is spelled. Either way the root is dropped, never wrongly counted.
test("the origin read CASE table makes partial quotes the single line section and relative origins unreadable and counts an absolute local origin but never matches spellings of one network URL", () => {
  const tmp = outside();
  const URL = "https://example.org/acme/a.git";
  const repo = (dir: string, body: string | null): string => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    if (body !== null) put(join(dir, ".git", "config"), body);
    return dir;
  };
  const origin = (head: string, body: string) => `[core]\n\tbare = false\n${head}\n${body}`;
  /** the session `<d>/s` has a readable network origin; the other checkout's config is `body`, or a function of the session's path */
  const vs = (body: string | ((s: string) => string)) => (d: string): [string, string] => {
    const s = repo(join(d, "s"), config(URL));
    return [s, repo(join(d, "o"), typeof body === "string" ? body : body(s))];
  };
  const pair = (a: string, b: string) => (d: string): [string, string] => [repo(join(d, "a"), config(a)), repo(join(d, "b"), config(b))];
  /** `../upstream` beside each of two clones: in one parent folder when `same`, else in two parents */
  const relative = (other: string, same: boolean) => (d: string): [string, string] => {
    const [pa, pb] = [join(d, "p1"), join(d, same ? "p1" : "p2")];
    repo(join(pa, "upstream"), config("https://example.org/acme/up1.git"));
    if (!same) repo(join(pb, "upstream"), config("https://example.org/acme/up2.git"));
    return [repo(join(pa, "x"), config("../upstream")), repo(join(pb, "y"), config(other))];
  };
  /** run …2493 line 1375 (d): A has alias -> B/src, and clone C's absolute origin is A/alias/.., physically B */
  const viaDotDot = (from: "a" | "b") => (d: string): [string, string] => {
    const [a, b] = [repo(join(d, "a"), config(URL)), repo(join(d, "b"), config("https://example.org/acme/b.git"))];
    mkdirSync(join(b, "src"));
    symlinkSync(join(b, "src"), join(a, "alias"), "dir");
    return [from === "a" ? a : b, repo(join(d, "c"), config(`${a}/alias/..`))];
  };
  const cells: [string, (d: string) => [string, string], boolean][] = [
    // counted: an ABSOLUTE local origin, bare or fully double-quoted, one hop onto a readable config (add.52 point 2b)
    ["a bare absolute path naming the session's checkout, one hop", vs((s) => config(s)), true],
    ["a fully double-quoted absolute path naming the session's checkout", vs((s) => config(`"${s}"`)), true],
    ["a bare absolute path with a whitespace-prefixed # comment", vs((s) => config(`${s} # mirror`)), true],
    ["a bare absolute path with a tab-prefixed ; comment", vs((s) => config(`${s}\t; note`)), true],
    ["a bare absolute path with a comment holding a quote", vs((s) => config(`${s} # the "main" mirror`)), true],
    ["line 1253: a bare absolute path with a space naming the session's checkout", (d) => {
      const s = repo(join(d, "my s"), config(URL));
      return [s, repo(join(d, "o"), config(s))];
    }, true],
    ["a quoted absolute path with a space naming the session's checkout", (d) => {
      const s = repo(join(d, "my s"), config(URL));
      return [s, repo(join(d, "o"), config(`"${s}"`))];
    }, true],
    ["the absolute path of the session's .git", vs((s) => config(join(s, ".git"))), true],
    ["a tkr-dev-shaped clone whose origin is the absolute path of the main checkout (control)", (d) => {
      const main = repo(join(d, "main"), config("https://example.org/acme/z.git"));
      return [repo(join(d, "dev"), config(main)), main];
    }, true],
    ["a partially quoted session and a common directory it shares (control)", (d) => {
      const s = repo(join(d, "s"), config(`"https://example.org/acme"/a.git`));
      put(join(s, ".git", "worktrees", "o", "commondir"), "../..\n"); // no gitdir file, so R2's walk skips it
      put(join(d, "o", ".git"), `gitdir: ${join(s, ".git", "worktrees", "o")}\n`);
      return [s, join(d, "o")];
    }, true],
    ["line 1375 (d): from B, a clone whose absolute origin is A/alias/..", viaDotDot("b"), true],
    ["line 1375 (d): from A, a clone whose absolute origin is A/alias/..", viaDotDot("a"), false],
    // a network URL never matches (add.52 point 3): no spelling, case or trimming makes two clones one project
    ["two independent clones of one network remote (control)", pair(URL, URL), false],
    ["the bare and the fully double-quoted spellings of one network URL", pair(URL, `"${URL}"`), false],
    ["the quoted and the bare spellings of one network URL", pair(`"${URL}"`, URL), false],
    ["line 1253: a quoted and a bare URL with a # inside", pair('"https://example.org/acme/a#fragment"', "https://example.org/acme/a#fragment"), false],
    ["line 1253: a quoted and a bare URL with a ; inside", pair('"https://example.org/acme/a;param"', "https://example.org/acme/a;param"), false],
    ["line 1282: a query differing only in case", pair("https://example.org?repo=ProjectA", "https://example.org?repo=projecta"), false],
    ["line 1282: a fragment differing only in case", pair("https://example.org#ProjectA", "https://example.org#projecta"), false],
    ["line 1282: a host differing only in case", pair("https://EXAMPLE.ORG?repo=User@Somewhere", "https://example.org?repo=User@Somewhere"), false],
    ["scheme and host case and one trailing slash", vs(config("HTTPS://Example.ORG/acme/a/")), false],
    ["one scp-like remote", pair("git@example.org:acme/a.git", "git@example.org:acme/a.git"), false],
    // UNREADABLE: partial quotes, the section in any other spelling, escapes, continuations, includes (add.29 row 3)
    ["different partially quoted URLs sharing a prefix", pair(`"https://example.org/acme"/a.git`, `"https://example.org/acme"/b.git`), false],
    ["a partially quoted spelling of the session's path", vs((s) => config(`"${dirname(s)}"/s`)), false],
    ["a quoted prefix naming the session's path", vs((s) => config(`"${s}"/x`)), false],
    ["the single-line section form with the session's path", vs((s) => origin(`[remote "origin"] url = ${s}`, "")), false],
    ["the section name in another case", vs((s) => origin('[Remote "origin"]', `\turl = ${s}\n`)), false],
    ["the dotted section spelling", vs((s) => origin("[remote.origin]", `\turl = ${s}\n`)), false],
    ["a trailing comment on the section line", vs((s) => origin('[remote "origin"] # main', `\turl = ${s}\n`)), false],
    ["line 1252: trailing text on another header line of the other checkout", vs((s) => `[core] trailing-garbage\n${config(s)}`), false],
    ["line 1252: trailing text on a header line of the session named by a readable local origin", (d) => {
      const s = repo(join(d, "s"), `[core] trailing-garbage\n${config(URL)}`);
      return [s, repo(join(d, "o"), config(s))];
    }, false],
    ["an assignment on another section's header line", vs((s) => `[core] bare = false\n${config(s)}`), false],
    ["an escape in the value", vs((s) => config(`"${s}\\\\"`)), false],
    ["a continuation inside the value", vs((s) => origin('[remote "origin"]', `\turl = ${dirname(s)}/\\\ns\n`)), false],
    ["a continuation folding the section line into another value", vs((s) => `[core]\n\tx = y\\\n[remote "origin"]\n\turl = ${s}\n`), false],
    ["an include section", vs((s) => `[include]\n\tpath = extra\n${config(s)}`), false],
    ["an includeIf section", vs((s) => `${config(s)}[includeIf "onbranch:main"]\n\tpath = extra\n`), false],
    ["two url lines", vs((s) => origin('[remote "origin"]', `\turl = ${s}\n\turl = /elsewhere\n`)), false],
    ["two origin sections", vs((s) => `${config(s)}[remote "origin"]\n\turl = /elsewhere\n`), false],
    ["a # with no whitespace before it stays in the value, never cut to the session's path", vs((s) => config(`${s}#frag`)), false],
    ["a ; with no whitespace before it stays in the value, never cut to the session's path", vs((s) => config(`${s};x`)), false],
    ["inner whitespace stays in a bare value, never cut to the session's path", vs((s) => config(`${s} x`)), false],
    ["a quoted value with a comment after it", vs((s) => config(`"${s}" # mirror`)), false],
    ["a value that is only a comment", vs(config("# none")), false],
    ["the key in another case", vs((s) => origin('[remote "origin"]', `\tURL = ${s}\n`)), false],
    ["no url line", vs(origin('[remote "origin"]', "\tfetch = +refs/heads/*:refs/remotes/origin/*\n")), false],
    ["an empty quoted value", vs(config('""')), false],
    // UNREADABLE local origins (add.29 row 4): a file:// URL, an absolute path that does not resolve, relative paths
    ["a file:// URL of the session's checkout", vs((s) => config(`file://${s}`)), false],
    ["an absolute path that does not resolve inside the session's checkout", vs((s) => config(join(s, "gone"))), false],
    ["a relative path to the session's checkout", vs(config("../s")), false],
    ["one relative spelling of two different repositories", relative("../upstream", false), false],
    ["two relative spellings of one repository", relative("../../p1/upstream", true), false],
    // line 1305, the one hop onto an UNREADABLE identity: common directory alone, checked first (add.52 point 4), so a
    // readable absolute origin naming that checkout never makes it the same project, in either direction
    ...([
      ["no config", null],
      ["a malformed config", origin('[remote "origin"]', '\turl = "https://example.org/acme"/z.git\n')],
      ["a continuation in its config", `[core]\n\tx = y\\\n${config("https://example.org/acme/z.git")}`],
      ["a config with no origin section", "[core]\n\tbare = false\n"],
    ] as const).flatMap(([what, body]): [string, (d: string) => [string, string], boolean][] => [
      [`the session's absolute origin names a checkout with ${what}`, (d) => {
        const o = repo(join(d, "o"), body);
        return [repo(join(d, "s"), config(o)), o];
      }, false],
      [`another checkout's absolute origin names a session with ${what}`, (d) => {
        const s = repo(join(d, "s"), body);
        return [s, repo(join(d, "o"), config(s))];
      }, false],
    ]),
  ];
  const state = (d: string) => join(d, ".tickmarkr");
  let n = 0;
  for (const [name, build, counted] of cells) {
    const d = join(tmp, `cell-${++n}`);
    const [session, other] = build(d);
    const rel = join(other, "rel", "9.0.0");
    mkdirSync(state(session), { recursive: true }); // a given root that does not exist expands to nothing (R3)
    run(state(other), id(n), T0 + 100);
    release(rel, T0 + 200);
    for (const [cwd, root] of [[session, state(other)], [other, state(session)]]) { // both directions
      expect(stateRoots(cwd, [root]), `${name} from ${cwd}`).toEqual([state(cwd), ...(counted ? [root] : [])]);
    }
    expect(readRelease(session, [rel], T0)?.dir ?? null, name).toBe(counted ? rel : null);
    const board = readRunBoard(session, [state(other)], [rel], T0);
    expect(board, name).toStrictEqual(counted ? expect.objectContaining({ runId: id(n), release: expect.objectContaining({ dir: rel }) })
      : { version: 1, empty: `no tickmarkr run under ${state(session)}; ignored as another project's: ${state(other)}, ${rel}` });
  }
  expect(n).toBe(60);
});

// R11's narrowed point 3 (queue row 394, D-2187 add.52), a bounded class over network spellings: a network URL never
// makes a match, so two clones of one remote, spelled identically or by any case, trimming or quoting variant, are two
// projects. The URL is still READABLE, so a third clone whose absolute origin names either one is that one's (one hop).
test("two clones of one network remote never match whatever the spelling of their URLs while a local hop onto either still counts", () => {
  const tmp = outside();
  const urls = ["https://example.org/acme/a.git", "HTTPS://Example.ORG/acme/a/", "ssh://git@example.org:22/acme/a.git",
    "git@example.org:acme/a.git", "git://example.org/acme/a", "https://example.org?repo=a#top"];
  const variants = (u: string) => [u, u.toUpperCase(), `${u.replace(/\.git$/, "")}/`, `"${u}"`];
  const state = (d: string) => join(d, ".tickmarkr");
  let n = 0;
  for (const u of urls) {
    for (const v of variants(u)) {
      const d = join(tmp, `cell-${++n}`);
      const [s, o] = [checkout(join(d, "s"), u), checkout(join(d, "o"), v)];
      const hop = checkout(join(d, "h"), o); // its absolute origin names o, whose network config is readable
      for (const cwd of [s, o, hop]) mkdirSync(state(cwd));
      const rel = join(o, "rel", "9.0.0");
      release(rel, T0);
      const cell = `${u} vs ${v}`;
      expect(stateRoots(s, [state(o), state(hop)]), cell).toEqual([state(s)]);
      expect(stateRoots(o, [state(s), state(hop)]), cell).toEqual([state(o), state(hop)]);
      expect(readRelease(s, [rel], T0), cell).toBeNull();
      expect(readRelease(hop, [rel], T0)?.dir, cell).toBe(rel);
    }
  }
  expect(n).toBe(24);
});

test("an ended run older than the chosen release card carries that release while a live or newer run carries null and the plugin accepts the field absent", () => {
  const tmp = outside();
  const proj = checkout(join(tmp, "proj"), null);
  const state = join(proj, ".tickmarkr");
  const named = join(proj, "rel", "release-2240"); // no version in the folder name or a script: the folder name stands in
  const versioned = join(proj, "rel", "2.24.0");
  const cell = (journal: (s: string) => void, card: [string, number] | null): Full => {
    rmSync(state, { recursive: true, force: true });
    rmSync(join(proj, "rel"), { recursive: true, force: true });
    journal(state);
    if (card) release(card[0], card[1]);
    return readRunBoard(proj, [], card ? [card[0]] : [], T0 + 3600) as Full;
  };
  const end = T0 + 100;
  const table: [string, (s: string) => void, [string, number] | null, string | null][] = [
    ["ended, card newer, empty version", (s) => run(s, id(1), end, end), [named, end + 1], "release-2240"],
    ["ended, card newer, versioned", (s) => run(s, id(1), end, end), [versioned, end + 50], "2.24.0"],
    ["ended, card at the run's end", (s) => run(s, id(1), end, end), [versioned, end], null],
    ["ended, card older than the end", (s) => run(s, id(1), end, end), [versioned, end - 50], null],
    ["ended, no card", (s) => run(s, id(1), end, end), null, null],
    ["live, card newer", (s) => run(s, id(1), end), [versioned, end + 50], null],
    ["resumed after its end, card newer", (s) => run(s, id(1), end + 20, end, true), [versioned, end + 50], null],
  ];
  for (const [name, journal, card, want] of table) {
    const got = cell(journal, card);
    expect(Object.hasOwn(got, "supersededBy"), name).toBe(true);
    expect(got.supersededBy, name).toBe(want);
    expect(got.release?.dir ?? null, name).toBe(card?.[0] ?? null);
  }

  // the plugin: the field absent (an older CLI) reads as null; a string passes; any other value is a misshapen snapshot
  const full = cell((s) => run(s, id(1), end, end), [named, end + 1]);
  const ok = (body: unknown) => parseBoard({ exitCode: 0, stdout: `${JSON.stringify(body)}\n`, stderr: "" });
  const { supersededBy: _drop, ...older } = full;
  const absent = ok(older);
  expect(absent.error).toBeNull();
  expect(absent.snapshot?.supersededBy ?? null).toBeNull();
  expect(ok(full).snapshot?.supersededBy).toBe("release-2240");
  expect(ok({ ...full, supersededBy: null }).snapshot?.supersededBy).toBeNull();
  for (const bad of [7, true, ["release-2240"], {}]) {
    expect(ok({ ...full, supersededBy: bad }).error, JSON.stringify(bad)).toBe("tickmarkr board printed a misshapen snapshot");
  }
});
