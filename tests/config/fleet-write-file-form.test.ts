// Queue row 452: a write keeps the form of the file it found. The 2.24.0 editor's write and the
// screen's go through one serialiser; each is driven here on the same file in four forms.
import { expect, test } from "vitest";
import { parse } from "yaml";
import { renderFleetOverlayWrite, type FleetEditable } from "../../src/config/config.js";
import { applyEdits, applyLayer, type Edit } from "../../src/fleet/edits.js";

const state: FleetEditable = { denyAdapters: [], denyModels: [], denyWorkersAdapters: [], denyWorkersModels: [], tiers: {}, map: {}, floors: {} };
const prior = "# a note\nreview:\n  required: true   # kept\nrouting:\n  mode: partner-led\n  deny:\n    models:\n      # keep\n      - a\n      - b\n";
const crlf = (t: string): string => t.replace(/\n/g, "\r\n");
const writers: Record<string, (bytes: string) => string> = {
  "the editor's write (renderFleetOverlayWrite)": (bytes) => renderFleetOverlayWrite(bytes, { initial: state, edited: state, mode: "staff-led" }),
  "the screen's write (applyLayer)": (bytes) => applyLayer(bytes, [{ layer: "repo", path: ["routing", "mode"], value: "staff-led", label: "mode" }] satisfies Edit[]),
};

for (const [name, write] of Object.entries(writers)) {
  test(`${name}: one changed key changes one line, and that holds whatever the file's line endings and with a byte-order mark`, () => {
    const plain = write(prior);
    expect(plain).toBe(prior.replace("mode: partner-led", "mode: staff-led"));
    // every line ends CR LF before and after: nothing but the changed line differs
    expect(write(crlf(prior))).toBe(crlf(plain));
    expect(write(crlf(prior)).split("\n").every((line, i, all) => i === all.length - 1 || line.endsWith("\r"))).toBe(true);
    // a byte-order mark stays where it was
    expect(write(`\uFEFF${prior}`)).toBe(`\uFEFF${plain}`);
    expect(write(`\uFEFF${crlf(prior)}`)).toBe(`\uFEFF${crlf(plain)}`);
  });
  test(`${name}: a tab between a value and its comment stays a tab, on a line the change does not touch`, () => {
    const tabbed = prior.replace("required: true   # kept", "required: true\t# kept");
    const out = write(tabbed);
    expect(out).toBe(tabbed.replace("mode: partner-led", "mode: staff-led"));
    expect(out).toContain("required: true\t# kept");
    // no private mark of the writer reaches the file
    expect(out).not.toMatch(/[\uE000-\uF8FF]/);
  });
  test(`${name}: the file's own style is kept on the lines the change does not touch: a four-space indent, lines over 80 columns, padded flow lists, list items at their key's indent`, () => {
    const changed = (t: string): string => t.replace("mode: partner-led", "mode: staff-led");
    // four spaces: before, every line was re-indented to two
    const four = prior.replace(/^( +)/gm, (m) => m + m);
    expect(write(four)).toBe(changed(four));
    // a command and a flow list longer than 80 columns stay on their line: before, yaml folded both
    const long = `commands:\n  test: npm run build && npm run lint && npm run test -- --reporter=dot --maxWorkers=2 --passWithNoTests\nreview:\n  prefer: [codex:gpt-6-astra, claude-code:opus, omp:google/gemini-4-carbon, pi:zai/glm-5.3, kimi:kimi-code/kimi-for-coding]\n${prior.replace("review:\n", "reviewNotes:\n")}`;
    expect(write(long)).toBe(changed(long));
    // a file that pads its flow lists keeps them padded
    const padded = `consult:\n  prefer: [ claude-code:fable, codex:gpt-6-astra ]\n${prior}`;
    expect(write(padded)).toBe(changed(padded));
    // list items written at the indent of their key stay there
    const flat = prior.replace("      # keep\n      - a\n      - b\n", "    # keep\n    - a\n    - b\n");
    expect(write(flat)).toBe(changed(flat));
  });
  test(`${name}: a file with mixed line endings is not guessed at: it is written as before`, () => {
    const mixed = prior.replace("review:\n", "review:\r\n");
    expect(() => write(mixed)).not.toThrow();
  });
}

test("a write never leaves a file that does not parse: a list emptied under a comment, in a file whose list items sit at their key's indent", () => {
  // yaml writes that list as "[]" at the key's own indent, which is not YAML: such a file gets its lists indented instead
  const flat = "routing:\n  deny:\n    models:\n    # keep\n    - nosuch:model\n  map:\n    plan:\n      pool:\n        mode: any\n        channels:\n        - a:b\n        - c:d\n";
  const out = applyLayer(flat, [{ layer: "repo", path: ["routing", "deny", "models"], value: [], label: "empty" }]);
  expect(parse(out)).toEqual({ routing: { deny: { models: [] }, map: { plan: { pool: { mode: "any", channels: ["a:b", "c:d"] } } } } });
  expect(out).toContain("# keep");
});

// A `%YAML 1.1` file: the library builds a missing parent from a JS Map, which that schema writes
// as `!!omap` (a list that reads back as an EMPTY map), so the save landed and the setting was not there.
const Y11 = "%YAML 1.1\n---\n";
const floor = (bytes: string): string => renderFleetOverlayWrite(bytes, { initial: state, edited: { ...state, floors: { plan: "mid" } } });
const deny = (bytes: string): string => applyLayer(bytes, [{ layer: "repo", path: ["routing", "deny", "workers", "models"], value: ["a:b"], label: "deny" }] satisfies Edit[]);
test("a %YAML 1.1 file: a write that needs a new map writes a map, and the file reads back with the setting in it (both writers)", () => {
  const mode = writers["the editor's write (renderFleetOverlayWrite)"];
  expect(mode(`${Y11}concurrency: 3\n`)).toBe(`${Y11}concurrency: 3\nrouting:\n  mode: staff-led\n`);
  const floored = floor(`${Y11}routing:\n  mode: partner-led\n`);
  expect(floored).not.toContain("!!omap");
  expect(parse(floored)).toEqual({ routing: { mode: "partner-led", floors: { plan: "mid" } } });
  const denied = deny(`${Y11}routing:\n  mode: partner-led\n`);
  expect(denied).not.toContain("!!omap");
  expect(parse(denied)).toEqual({ routing: { mode: "partner-led", deny: { workers: { models: ["a:b"] } } } });
  // the same writes in a file with no directive are unchanged by this
  expect(parse(deny("routing:\n  mode: partner-led\n"))).toEqual({ routing: { mode: "partner-led", deny: { workers: { models: ["a:b"] } } } });
});
test("a file that is a document marker, a directive or comments under one and nothing else is written to, not thrown on, and keeps its comments on top", () => {
  for (const write of Object.values(writers)) {
    expect(write("---\n")).toBe("---\nrouting:\n  mode: staff-led\n");
    expect(write("---\n# nothing yet\n")).toBe("---\n# nothing yet\nrouting:\n  mode: staff-led\n");
    expect(write(Y11)).toBe(`${Y11}routing:\n  mode: staff-led\n`);
    expect(write(`${Y11}# nothing yet\n`)).toBe(`${Y11}# nothing yet\nrouting:\n  mode: staff-led\n`);
  }
});

// An anchor on an edited list is released: each alias of it becomes a copy where it stood. The copy
// keeps the comment written on the alias, in either writer.
test("an alias whose anchor an edit releases becomes a copy that keeps the alias's comment", () => {
  const anchored = "review:\n  prefer: [&lead codex:a, claude-code:b]\nrouting:\n  mode: partner-led\n  deny:\n    models:\n      - *lead   # the lead\n      - claude-code:b   # the second\n";
  const out = applyLayer(anchored, [{ layer: "repo", path: ["review", "prefer"], value: ["claude-code:b"], label: "review" }] satisfies Edit[]);
  // (the line changed, so it is written the writer's way; the comment is what must stay)
  expect(out).toMatch(/^ {6}- codex:a +# the lead$/m);
  expect(out).toContain("      - claude-code:b   # the second\n");
  expect(parse(out)).toEqual({ review: { prefer: ["claude-code:b"] }, routing: { mode: "partner-led", deny: { models: ["codex:a", "claude-code:b"] } } });
});

// A private-use character the writer marks with internally, written by the user in a value or a
// comment, is the user's text: every one the writers have used (U+E002, U+E003) comes back as it went.
test("a private-use character in an untouched value or comment survives a save through both writers", () => {
  for (const ch of ["", ""]) {
    const marked = `commands:\n  test: echo ${ch}done\ngates:\n  test: echo ${ch}done\n#${ch} block note\n${prior.replace("# kept", `# ${ch}note`).replace("required: true   #", `required: true #${ch}`)}`;
    for (const write of Object.values(writers)) expect(write(marked)).toBe(marked.replace("mode: partner-led", "mode: staff-led"));
  }
});

// The file's style is read from its collections, never from a scalar's text or a comment: a
// command that holds brackets does not decide flow padding, and a long line is a long node.
test("style is read from the file's own collections and nodes: brackets and hashes inside a command decide nothing", () => {
  const unpadded = `review:\n  prefer: [codex:a, claude-code:b]\nrouting:\n  mode: partner-led\n`;
  const padded = unpadded.replace("[codex:a, claude-code:b]", "[ codex:a, claude-code:b ]");
  const files = [
    `commands:\n  test: test -f x && [ -f y ] && [ -f z ]\n${unpadded}`,
    `commands:\n  test: echo "[PASS]" "[DONE]"\n${padded}`,
    `commands:\n  test: |\n    if [ -f a ] && [ -f b ]; then\n      echo ok\n    fi\n${unpadded}`,
    `commands:\n  test: 'echo "hello #world" && npm run build && npm run lint && npm run test -- --reporter=dot --maxWorkers=2'\n${unpadded}`,
  ];
  for (const file of files) for (const write of Object.values(writers)) expect(write(file)).toBe(file.replace("mode: partner-led", "mode: staff-led"));
});

// Review round 2 (row 452): a long line inside a multi-line scalar is a long line of the file, and
// the gap before a comment is kept after a scalar, a flow list and an alias, through every writer.
// (A comment in a block map's or list's header, or after an implicit null, is not kept on its line by
// the YAML document model: OBSERVER ruling 2 put those out of this writer's reach.)
const allWriters: Record<string, (bytes: string) => string> = {
  ...writers,
  "applyEdits": (bytes) => applyEdits({ userText: "", repoText: bytes }, [{ layer: "repo", path: ["routing", "mode"], value: "staff-led", label: "mode" }]).repoText,
};
const LONG = "echo hello && npm run build && npm run lint && npm run test -- --reporter=dot --maxWorkers=2 --passWithNoTests";
test("a long command inside a folded block or a multi-line quoted scalar stays whole on a mode-only edit", () => {
  const folded = `commands:\n  test: >-\n    ${LONG}\nrouting:\n  mode: partner-led\n`;
  const quoted = `commands:\n  test: 'echo hello\n    ${LONG}'\nrouting:\n  mode: partner-led\n`;
  for (const write of Object.values(allWriters)) {
    expect(write(folded)).toBe(folded.replace("mode: partner-led", "mode: staff-led"));
    // (the library joins the quoted scalar's own line break; the long command is not wrapped)
    const out = write(quoted);
    expect(out).toContain(LONG);
    expect(parse(out)).toEqual(parse(quoted.replace("mode: partner-led", "mode: staff-led")));
  }
});
test("the gap before a comment is kept after a scalar, a flow list and an alias", () => {
  const lines = [
    (g: string) => `commands:\n  test: &cmd echo done${g}# scalar\n`,
    (g: string) => `review:\n  prefer: [codex:a]${g}# flow\n`,
    (g: string) => `gates:\n  test: *cmd${g}# alias\n`,
  ];
  for (const gap of ["\t", " \t", "   ", " "]) {
    const file = `${lines.map((line) => line(gap)).join("")}routing:\n  mode: partner-led\n`;
    for (const write of Object.values(allWriters)) expect(write(file)).toBe(file.replace("mode: partner-led", "mode: staff-led"));
  }
});
// Review round 3 (row 452): a trailing comment that runs on over indented lines below it keeps its
// first line inline, with its gap, after a scalar, a flow list and an alias, and its lines below as written.
test("the gap before a comment is kept when the comment runs on over the lines below it", () => {
  const lines = [
    (g: string, more: string) => `commands:\n  test: &cmd echo done${g}# keep scalar\n${more}# more scalar\n`,
    (g: string, more: string) => `review:\n  prefer: [codex:a]${g}# keep flow\n${more}# more flow\n${more}# and more\n`,
    (g: string, more: string) => `gates:\n  test: *cmd${g}# keep alias\n${more}# more alias\n`,
  ];
  for (const gap of ["\t", " \t", "   ", " "]) for (const more of ["    ", "          ", "    \t"]) {
    const file = `${lines.map((line) => line(gap, more)).join("")}routing:\n  mode: partner-led\n`;
    for (const write of Object.values(allWriters)) expect(write(file)).toBe(file.replace("mode: partner-led", "mode: staff-led"));
  }
});
// Review round 4 (row 452): yaml reads a bare `#` line inside a comment that runs on as one space;
// the gap and the lines are kept with a bare `#` first, in the middle or last.
test("the gap before a comment that runs on is kept when a line of it is a bare hash", () => {
  for (const tail of ["\t#\n    # more\n", "\t# first\n    #\n    # more\n", "\t# first\n    # more\n    #\n"]) {
    const file = `commands:\n  test: &cmd echo done${tail}review:\n  prefer: [codex:a]${tail}gates:\n  test: *cmd${tail}routing:\n  mode: partner-led\n`;
    for (const write of Object.values(allWriters)) expect(write(file)).toBe(file.replace("mode: partner-led", "mode: staff-led"));
  }
});
