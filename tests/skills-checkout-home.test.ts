import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { hostViolations, skillReading } from "./helpers/skill-reading.js";

// Queue row 240; D-2138 add.1 R4, add.4; gap G7. These are text-only shipping guards.
const skills = Object.fromEntries(["overseer", "loop", "auto"].map(name => [name,
  readFileSync(new URL(`../skills/tickmarkr-${name}/SKILL.md`, import.meta.url), "utf8"),
]));
const overseer = skills.overseer!;
const architecture = readFileSync(new URL("../docs/codebase/ARCHITECTURE.md", import.meta.url), "utf8");
const lawHeading = "## Hand-made checkout law (queue row 240; D-2138 add.1 R4, add.4; gap G7)";

function lawOf(markdown: string): string {
  expect(markdown.split(lawHeading)).toHaveLength(2);
  return markdown.split(lawHeading)[1]!.split(/\n## /)[0]!.replace(/\s+/g, " ");
}

function assertHome(law: string): void {
  expect(law).toContain("applies on herdr, on Orca and on a plain host, to EVERY hand-made checkout");
  expect(law).toContain("integration snapshots, SCOPER, REF, oracle and any other manually created worktree");
  expect(law).toContain("`<repo>-seats/<name>`, a sibling of the repository root");
  expect(law).toContain("on Orca an Orca-managed worktree is also allowed");
  expect(law).toContain("Never create one inside `.tickmarkr/worktrees.noindex`, or under `/private/tmp`");
  expect(law).toContain("including the `/tmp` alias");
  expect(law).toContain("a reboot wipes that temporary root");
}

function assertNoForbiddenCheckoutExample(markdown: string): void {
  const adds = markdown.match(/\bgit(?:\s+-C\s+\S+)?\s+worktree\s+add\b[^`\n]*/g) ?? [];
  for (const command of adds) {
    expect(command).not.toMatch(/(?:\/private)?\/tmp(?:\/|\b)|\.tickmarkr\/worktrees\.noindex\b/);
  }
}

function assertOwnedRemoval(law: string): void {
  expect(law).toContain("Immediately after each successful creation, before using the checkout, append one line");
  expect(law).toContain("`<repo>/.tickmarkr/overseer/checkouts.ledger`");
  for (const field of ["path=<repo>-seats/<name>", "purpose=<snapshot/scoper/REF/oracle/...>",
    "owner=<seat>", "remove-when=mission <mission> ends", "keep=none", "state=open"]) {
    expect(law).toContain(field);
  }
  expect(law).toContain("At mission end (green, failed or parked), after users of the checkout have stood down");
  expect(law).toContain("read only open lines whose `owner` is THIS seat");
  expect(law).toContain("Use each line's exact `path`: an unledgered checkout or another seat's checkout is untouched");
  expect(law).toContain("Never discover removal targets by directory glob, directory sweep or worktree-list inventory");
  expect(law).toContain("`git -C <dir> status --porcelain`");
  expect(law).toContain("require successful exit and capture the entire output");
  expect(law).toContain("Nonempty means **dirty → kept**: record `state=kept` and report its status and path");
  expect(law).toContain("A recorded keep reason means **kept**, even if clean");
  expect(law).toContain("the reason, owner seat and condition for eventual removal, and report them");
  expect(law).toContain("Only a clean checkout with no keep reason can proceed");
  expect(law).toContain("Then use `git worktree remove <dir>` from `<repo>`, **without force, never `--force` or `-f`**");
  expect(law).toContain("Only successful removal closes that ledger line (`state=closed`)");
  expect(law).toContain("a refusal leaves it open/kept and is reported");
  for (const command of law.match(/`git [^`]*worktree remove[^`]*`/g) ?? []) {
    expect(command).not.toMatch(/\s(?:--force|-f)(?:\s|`)|[*?[\]{}]/);
  }
}

function assertReachability(law: string): void {
  expect(law).toContain("Before ANY such removal (including a snapshot refresh)");
  expect(law).toContain("`git -C <dir> symbolic-ref -q HEAD` (exit 1 means detached)");
  expect(law).toContain("`git -C <dir> rev-parse --verify HEAD`");
  expect(law).toContain("For a detached head, prove it reachable from a retained named ref");
  const query = "`git -C <repo> for-each-ref --contains <sha> --format='%(refname)'`";
  const pin = "`git -C <repo> update-ref refs/tickmarkr/preserved/<sha> <sha>`";
  const ledger = "write `preserved=refs/tickmarkr/preserved/<sha>` on THIS checkout's ledger line BEFORE removal";
  const remove = "Then use `git worktree remove <dir>`";
  for (const text of [query, pin, ledger, remove]) expect(law).toContain(text);
  expect(law.indexOf(query)).toBeLessThan(law.indexOf(pin));
  expect(law.indexOf(pin)).toBeLessThan(law.indexOf(ledger));
  expect(law.indexOf(ledger)).toBeLessThan(law.indexOf(remove));
  expect(law).toContain("Record the retained ref on the ledger line and retain it after removal");
  expect(law).toContain("HEAD and a reflog are not named refs");
  expect(law).toContain("A successful query with no retained named ref means **pin first**");
  expect(law).toContain("verify that ref resolves to `<sha>`");
  expect(law).toContain("Keep that recovery ref after removal");
  expect(law).toContain("A failed status, HEAD/ref query, pin or ledger write means kept and reported, never permission to continue");
}

function snapshotOf(markdown: string): string {
  const match = markdown.match(/- \*\*the operator view of that branch\*\*[\s\S]*?(?=\n   - \*\*and, where)/);
  expect(match).not.toBeNull();
  return match![0].replace(/\s+/g, " ");
}

function scoperOf(markdown: string): string {
  const match = markdown.match(/^- \*\*Scoper worktree rule\*\*:.*$/m);
  expect(match).not.toBeNull();
  return match![0];
}

function assertRecipe(recipe: string): void {
  for (const phrase of ["<repo>-seats/<name>", ".tickmarkr/overseer/checkouts.ledger",
    "purpose", "owner seat", "mission-end removal condition", "D-2138 add.1 R4, add.4",
    "detached HEAD", "retained named ref", "git for-each-ref --contains <sha>",
    "refs/tickmarkr/preserved/<sha>", "handle on its ledger line first", "without force"]) {
    expect(recipe).toContain(phrase);
  }
  expect(recipe).toMatch(/git worktree remove <repo>-seats\//);
  expect(recipe).toMatch(/close its (?:ledger )?line/);
  assertNoForbiddenCheckoutExample(recipe);
}

test("test: a reading of the shipped overseer skill on herdr, on Orca and on a plain host reaches one hand-made checkout law that places every hand-made checkout in the repository's sibling seats directory or an Orca-managed worktree, never inside the tickmarkr worktrees folder or under the temporary root a reboot wipes, and no example command in the three shipped skills places a checkout there, so a skill that still shows a temporary scoper path fails", () => {
  expect(hostViolations(overseer)).toEqual([]);
  for (const host of ["herdr", "orca", "plain"] as const) {
    assertHome(lawOf(skillReading(overseer, host)));
  }
  for (const markdown of Object.values(skills)) {
    assertNoForbiddenCheckoutExample(markdown);
    for (const forbidden of ["/private/tmp/tkr-scoper-v155", "/tmp/scoper", "<repo>/.tickmarkr/worktrees.noindex/REF"]) {
      expect(() => assertNoForbiddenCheckoutExample(`${markdown}\n\`git worktree add ${forbidden}\``)).toThrow();
    }
  }
  // A correct law hidden inside one host's scope is still missing from the other readings.
  const hostOnly = overseer.replace(lawHeading, `## On herdr\n\n#${lawHeading}`);
  for (const host of ["orca", "plain"] as const) expect(() => lawOf(skillReading(hostOnly, host))).toThrow();
});

test("test: that law appends one ledger line per checkout naming its path, purpose, owner seat and removal condition, and at mission end removes a clean ledgered checkout with no keep reason by worktree remove without force, keeps a dirty one reporting its status, keeps one with a recorded keep reason naming its owner and condition, and touches no checkout outside this seat's ledger, so a removal by directory glob or with force fails", () => {
  const law = lawOf(overseer);
  assertOwnedRemoval(law);
  for (const [before, after] of [
    ["`git worktree remove <dir>`", "`git worktree remove --force <dir>`"],
    ["`git worktree remove <dir>`", "`git worktree remove -f <dir>`"],
    ["`git worktree remove <dir>`", "`git worktree remove <repo>-seats/*`"],
    ["read only open lines whose `owner` is THIS seat", "read every line regardless of owner"],
    ["**dirty → kept**", "**dirty → removed**"],
    ["A recorded keep reason means **kept**, even if clean", "Clean means removed even with a keep reason"],
    ["remove-when=mission <mission> ends", "remove-when=unspecified"],
  ]) {
    const regressed = law.replace(before!, after!);
    expect(regressed).not.toBe(law);
    expect(() => assertOwnedRemoval(regressed)).toThrow();
  }
});

test("test: before removing a clean detached checkout that law proves its head reachable from a retained named ref, and when no named ref reaches it pins the head under a recovery ref and writes that handle on the checkout's ledger line first, so a clean-status removal that drops commits no ref reaches fails", () => {
  const law = lawOf(overseer);
  assertReachability(law);
  for (const omitted of ["`git -C <repo> for-each-ref --contains <sha> --format='%(refname)'`",
    "`git -C <repo> update-ref refs/tickmarkr/preserved/<sha> <sha>`",
    "write `preserved=refs/tickmarkr/preserved/<sha>` on THIS checkout's ledger line BEFORE removal"]) {
    expect(() => assertReachability(law.replace(omitted, "omitted"))).toThrow();
  }
  const remove = "Then use `git worktree remove <dir>`";
  const premature = remove + law.replace(remove, "Already removed");
  expect(() => assertReachability(premature)).toThrow();
});

test("test: the overseer skill's integration snapshot recipe and its scoper example, and the architecture page's operator view of a live run, name the seats-directory home and the ledger line, so a snapshot or scoper recipe left without a home fails", () => {
  const operator = architecture.match(/^- \*\*Operator view of a live run.*$/m)?.[0];
  expect(operator).toBeDefined();
  for (const recipe of [snapshotOf(overseer), scoperOf(overseer), operator!]) {
    assertRecipe(recipe);
    for (const field of ["<repo>-seats/<name>", ".tickmarkr/overseer/checkouts.ledger"]) {
      expect(() => assertRecipe(recipe.replaceAll(field, "<dir>"))).toThrow();
    }
  }
  // Replaying the old scoper location must fail even beside the correct universal law.
  const oldScoper = overseer.replace("git worktree add -b spec/<mission> <repo>-seats/scoper-<mission>",
    "git worktree add /private/tmp/tkr-scoper-v155 -b spec/...");
  expect(oldScoper).not.toBe(overseer);
  expect(() => assertNoForbiddenCheckoutExample(oldScoper)).toThrow();
});
