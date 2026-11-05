// Queue row 340; D-2180 contract S: the shipped overseer/loop/auto skills read on the Herdr app (HC pair, no
// classic marker) route two visible tiers through hc, never classic herdr or the plain-host single tier.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { generateShippedSkillFiles } from "../scripts/ci/shipped-skill-files.js";
import * as provenance from "../src/cli/shipped-skill-files.js";
import { hcOnly, herdrOnly, hostOf, hostViolations, plainLineFindings, skillDirViolations, skillReading } from "./helpers/skill-reading.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const installedRoot = join(ROOT, ".claude/skills");
const SKILLS = ["overseer", "loop", "auto"] as const;
const APP_HEADING = "On the Herdr app (HC pair, no classic marker)";
const APP_ANCHOR = "#on-the-herdr-app-hc-pair-no-classic-marker";
const PLAIN_ANCHOR = "#on-a-plain-host-neither-herdr-nor-orca";
const read = (name: string) => readFileSync(join(ROOT, `skills/tickmarkr-${name}/SKILL.md`), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
/** The canonical app guidance: the overseer's own app section, read on the app. */
const canonical = (overseer = read("overseer")) => {
  const reading = skillReading(overseer, "app");
  const start = reading.indexOf(`\n## ${APP_HEADING}\n`);
  expect(start, "canonical app section").toBeGreaterThan(0);
  return reading.slice(start, reading.indexOf("\n## ", start + 1));
};
/** Paragraph and bullet blocks, so a route that wraps is judged whole. */
const blocks = (text: string) => text.split(/\n(?=\s*(?:[-+*]|\d+[.)])\s)|\n\s*\n/).map(flat);

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function visibleSeatFindings(name: string, markdown: string, overseer: string): string[] {
  const findings: string[] = [];
  const reading = skillReading(markdown, "app");
  const guidance = flat(canonical(overseer));
  // Row 1: two visible tiers in this skill's own app scope, or an explicit delegation to the canonical guidance.
  const own = flat(reading);
  if (!/two(?:-tier| visible tiers)/.test(own)) findings.push(`${name}: no two-tier app route`);
  if (name !== "overseer" && !own.includes(`(../tickmarkr-overseer/SKILL.md${APP_ANCHOR})`)) findings.push(`${name}: no delegation to the canonical app guidance`);
  if (!own.includes("hc run --bg --json --no-parent --no-notify")) findings.push(`${name}: no detached visible hc launch`);
  for (const need of ["--name \"ORCH · <label>\"", "--cwd \"<", "tickmarkr.owner", "tickmarkr.repo", "herdr.space", "first task"]) {
    if (!own.includes(need)) findings.push(`${name}: launch lacks ${need}`);
  }
  // Row 4: the seat launch table, held once in the canonical guidance.
  for (const need of [
    "tickmarkr fleet --pick <purpose>", "returned `adapter` and `model`", "`--no-daemon`", "--permission-mode bypassPermissions",
    "--dangerously-bypass-approvals-and-sandbox", "The first task travels IN the launch argv", "seat ledger",
    "`hc get <address> --json` returns that same address, both labels, the checkout as `cwd` and `parent` null",
    "`hc read <address> --json --lines 0` shows the model banner", "No headless `-p` or `exec` auxiliary seat and no in-process subagent",
  ]) if (!guidance.includes(need)) findings.push(`canonical: lacks ${need}`);
  // No classic herdr command and no single-tier fallback is reachable on the app reading.
  for (const line of reading.split("\n")) if (herdrOnly.test(line)) findings.push(`${name}: classic herdr reachable: ${line.trim()}`);
  if (/runs SINGLE-TIER as the orchestrator/.test(own)) findings.push(`${name}: plain single-tier scope reachable`);
  for (const block of blocks(reading)) {
    if (block.includes(PLAIN_ANCHOR) && !/HC pair|Herdr app/.test(block)) findings.push(`${name}: plain route without the HC pair: ${block.slice(0, 120)}`);
  }
  return findings;
}

test("all three app skill routes satisfy the closed visible-seat table while neither classic herdr commands nor single-tier fallback are reachable", () => {
  const overseer = read("overseer");
  // The canonical anchor resolves to the overseer's app heading.
  expect(overseer).toContain(`\n## ${APP_HEADING}\n`);
  expect(APP_ANCHOR).toBe(`#${APP_HEADING.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-")}`);
  for (const name of SKILLS) expect(visibleSeatFindings(name, read(name), overseer), name).toEqual([]);
  // Host order (case H): classic first, the HC pair next and outranking Orca, a lone HC marker is no app.
  const order = flat(canonical(overseer));
  expect(order).toContain("`HERDR_ENV=1` is classic herdr even beside every other marker");
  expect(order).toContain("both `HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET` nonblank after trim is the Herdr app, even beside Orca's markers");
  expect(order).toContain("either HC marker alone, or a blank one, is no app");
  // Discriminators: each mutant must be caught.
  const loop = read("loop");
  const role = loop.split("\n").find((line) => line.startsWith("  - **On the Herdr app"))!;
  const mutants: [string, string, string][] = [
    ["loop", loop.replace(role, ""), "role bullet deleted"],
    ["loop", loop.replace(/^With neither herdr, the Herdr app \(HC pair\) nor Orca/m, "With neither herdr nor Orca"), "plain route ignores the HC pair"],
    ["overseer", overseer.replace(/, or the Herdr app — .*?; if none is detected/, "; if none is detected"), "host line drops the app"],
    ["auto", read("auto").replace("--no-parent ", ""), "launch keeps a parent"],
    ["auto", `${read("auto")}\n## ${APP_HEADING}\n\n- \`herdr pane run <pane> "go"\`\n`, "classic command in the app scope"],
    ["overseer", overseer.replace(`\n## ${APP_HEADING}\n`, "\n## On a plain host too\n"), "app section re-headed plain"],
  ];
  // A mutant is caught by a finding, or by the canonical section no longer existing at all.
  const caught = (run: () => string[]) => { try { return run().length > 0; } catch { return true; } };
  for (const [name, mutant, why] of mutants) {
    expect(mutant, why).not.toBe(read(name));
    expect(caught(() => visibleSeatFindings(name, mutant, name === "overseer" ? mutant : overseer)), why).toBe(true);
  }
});

function deliveryFindings(markdown: Record<(typeof SKILLS)[number], string>): string[] {
  const findings: string[] = [];
  const guidance = flat(canonical(markdown.overseer));
  for (const need of [
    "`hc send <address> \"<message>\" --json`, never `--force`", "A booting seat, an occupied composer, a blocked dialog, an uncertain submit (`started` not `true`) or `first_message` false is NO handoff",
    "resolve readiness, then send once more", "A read never proves a queued message was submitted unless composer or turn evidence says so",
    "wait each recorded detached seat at its own address with `hc wait <address> --timeout <seconds> --json`, never an empty `--children` census",
    "`hc wait <parent> --children any --timeout <seconds> --json` (or `all`) is only for helpers actually launched as that parent's children",
    "`timeout` or `message` is a wake reason to read the seat, never completion proof",
    "The blocking file consumer is `tickmarkr wait <runId>`, supervised with `hc wait` at the ORCH's recorded address",
    "read CURRENT `tickmarkr status <runId>` and re-arm", "No sleep watcher, and never an agent-idle state as mission completion",
  ]) if (!guidance.includes(need)) findings.push(`canonical: lacks ${need}`);
  for (const name of SKILLS) {
    const reading = skillReading(markdown[name], "app");
    const own = flat(reading);
    for (const need of ["tickmarkr wait <runId>", "hc wait <", "CURRENT `tickmarkr status <runId>`"]) if (!own.includes(need)) findings.push(`${name}: lacks ${need}`);
    if (name !== "overseer") {
      for (const need of ["hc send <address> \"<message>\" --json", "`first_message` false is no handoff", "never a `--children` census of a `--no-parent` seat", "never a sleep watcher"]) {
        if (!own.includes(need)) findings.push(`${name}: lacks ${need}`);
      }
    }
    // A children wait is only ever qualified; no sleep loop or classic watcher wakes an app seat.
    for (const line of reading.split("\n")) {
      if (line.includes("--children") && !/\bnever\b|\bonly for\b/.test(line)) findings.push(`${name}: unqualified children wait: ${line.trim()}`);
      if (/\bdo sleep\b|\bsleep \d/.test(line)) findings.push(`${name}: sleep watcher: ${line.trim()}`);
    }
  }
  return findings;
}

test("app skill waits satisfy the closed delivery table while detached seats cannot be falsely covered by children waits or sleep watchers", () => {
  const markdown = { overseer: read("overseer"), loop: read("loop"), auto: read("auto") };
  expect(deliveryFindings(markdown)).toEqual([]);
  const mutants: [string, typeof markdown][] = [
    ["children census covers detached seats", { ...markdown, overseer: markdown.overseer.replace(", never an empty\n  `--children` census", ", or `hc wait <parent> --children all`") }],
    ["readiness skipped", { ...markdown, overseer: markdown.overseer.replace("resolve readiness, then send", "send") }],
    ["sleep watcher", { ...markdown, loop: markdown.loop.replace("never a sleep watcher", "`while :; do sleep 20; done`") }],
    ["wake taken as completion", { ...markdown, overseer: markdown.overseer.replace("never completion proof", "completion proof") }],
    ["loop consumer dropped", { ...markdown, auto: markdown.auto.replace(/^ {3}- \*\*On the Herdr app.*tickmarkr wait <runId>.*\n/m, "") }],
  ];
  for (const [why, mutant] of mutants) {
    expect(Object.values(mutant).some((text, i) => text !== Object.values(markdown)[i]), why).toBe(true);
    expect(deliveryFindings(mutant), why).not.toEqual([]);
  }
});

const LAUNCH = (verb: string) => new RegExp(`^ {2}cd "<repo>" && env -u HC_SCOPE HC_TERMINAL_ID="<ORCH terminal>" HC_TERMINAL_SOCKET="<ORCH socket>" node -e .* ${verb.replace(/[<>]/g, "\\$&")} >> "<state-dir>/daemon\\.log" 2>&1 < /dev/null$`, "m");

/** A scratch dir whose path carries spaces, so an unquoted checkout, repo or log path splits. */
function spacedDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix} `));
  scratch.push(dir);
  return dir;
}

/** Execute one shipped launch line against a fake tickmarkr (explicit path), from a launcher holding its own HC scope. */
async function launchEnv(line: string): Promise<Record<string, string>> {
  const dir = spacedDir("tickmarkr app launch");
  const repo = join(dir, "my repo"), state = join(repo, ".tickmarkr state");
  mkdirSync(state, { recursive: true });
  const out = join(dir, "env.json");
  const fake = join(dir, "tickmarkr");
  writeFileSync(fake, `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));\n`);
  chmodSync(fake, 0o755);
  const command = line.replaceAll("<repo>", repo).replaceAll("<state-dir>", state).replaceAll("<ORCH terminal>", "orch-terminal")
    .replaceAll("<ORCH socket>", join(dir, "orch.sock")).replaceAll("<runId>", "run-1");
  execFileSync("/bin/sh", ["-c", command], {
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, HC_SCOPE: "launcher-scope", HC_TERMINAL_ID: "overseer-terminal", HC_TERMINAL_SOCKET: join(dir, "overseer.sock") },
    stdio: "pipe",
  });
  for (let i = 0; i < 200 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 25));
  const { argv, cwd, env } = JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; cwd: string; env: Record<string, string> };
  return { argv: argv.join(" "), CWD: cwd, REPO: realpathSync(repo), LOG: String(existsSync(join(state, "daemon.log"))), ...env, SOCKET: join(dir, "orch.sock") };
}

/** Execute the canonical hc seat-launch recipe against a fake hc by explicit path, with spaced checkout, repo and space. */
function seatLaunchArgv(template: string): { argv: string[]; checkout: string; repo: string } {
  const dir = spacedDir("tickmarkr app seat");
  const out = join(dir, "argv.json"), fake = join(dir, "fake hc");
  writeFileSync(fake, `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(fake, 0o755);
  const checkout = join(dir, "my checkout"), repo = join(dir, "my repo");
  const command = template.replace(/^hc /, `${JSON.stringify(fake)} `).replaceAll("<label>", "2.20.0").replaceAll("<checkout>", checkout)
    .replaceAll("<seat>", "ORCH").replaceAll("<repo>", repo).replaceAll("<verified space>", "work space")
    .replaceAll("<fleet-selected agent command>", "claude --model opus").replaceAll("<first task>", "Read the brief and follow it.");
  execFileSync("/bin/sh", ["-c", command], { env: { PATH: process.env.PATH }, stdio: "pipe" });
  return { argv: JSON.parse(readFileSync(out, "utf8")) as string[], checkout, repo };
}
const SEAT = /^ {2}(hc run --bg --json --no-parent --no-notify [^\n]*)$/m;

function addressFindings(name: string, markdown: string): string[] {
  const findings: string[] = [];
  const section = markdown.slice(markdown.indexOf("## Host-owned daemon and detached beats"));
  const daemon = section.slice(0, section.indexOf("Detached beats are product-owned"));
  for (const verb of ["tickmarkr run", "tickmarkr resume <runId>"]) if (!LAUNCH(verb).test(daemon)) findings.push(`${name}: no scope-cleared ${verb} at the ORCH address`);
  const app = flat(skillReading(daemon, "app"));
  if (!app.includes("run the `env -u HC_SCOPE` lines")) findings.push(`${name}: app bullet does not select the scope-cleared lines`);
  if (!app.includes("substitute that recorded ORCH address, never its own terminal")) findings.push(`${name}: fallback may target the launcher`);
  const teardown = flat(skillReading(markdown.slice(markdown.indexOf("## Mission-end teardown")), "app").split(/\n## /)[0]!);
  for (const need of [
    "verify `hc get <address> --json` at the recorded address", "`tickmarkr.owner` and `tickmarkr.repo` labels, `address` and `cwd` equal the ledger's exact owner, repo, address and checkout",
    "Only then `hc kill <address> --json` and `hc rm <address> --json`", "prove the terminal absent from `hc ls --all --json` and the app window",
    "A mismatch or an unreadable read closes nothing and leaves the terminal protected", "never target the other tier's terminal, a foreign terminal or your own launching terminal",
  ]) if (!teardown.includes(need)) findings.push(`${name}: teardown lacks ${need}`);
  return findings;
}

test("scope-cleared app run and resume preserve the recorded ORCH address while fallback and teardown never target the other tier", async () => {
  for (const name of SKILLS) {
    const markdown = read(name);
    expect(addressFindings(name, markdown), name).toEqual([]);
    for (const verb of ["tickmarkr run", "tickmarkr resume <runId>"]) {
      const line = LAUNCH(verb).exec(markdown)![0].trim();
      const env = await launchEnv(line);
      expect(env.HC_SCOPE, `${name}: ${verb}`).toBeUndefined();
      expect(env.HC_TERMINAL_ID).toBe("orch-terminal");
      expect(env.HC_TERMINAL_SOCKET).toBe(env.SOCKET);
      expect(env.argv).toBe(verb === "tickmarkr run" ? "run" : "resume run-1");
      // A checkout and state dir with spaces reach the daemon whole: it runs in the repo and logs beside it.
      expect(env.CWD, `${name}: ${verb}`).toBe(env.REPO);
      expect(env.LOG, `${name}: ${verb}`).toBe("true");
      // Pre-fix control: the unquoted recipe splits the spaced paths and never launches.
      const unquoted = line.replace('cd "<repo>"', "cd <repo>").replace('>> "<state-dir>/daemon.log"', ">> <state-dir>/daemon.log");
      expect(unquoted, name).not.toBe(line);
      await expect(launchEnv(unquoted), `${name}: unquoted ${verb}`).rejects.toThrow();
    }
    for (const mutant of [
      markdown.replaceAll("env -u HC_SCOPE HC_TERMINAL_ID", "HC_TERMINAL_ID"),
      markdown.replaceAll('HC_TERMINAL_ID="<ORCH terminal>"', 'HC_TERMINAL_ID="$HC_TERMINAL_ID"'),
      markdown.replace("substitute that recorded ORCH address, never its own terminal", "use its own terminal"),
      markdown.replace("never target\n  the other tier's terminal", "may target\n  the other tier's terminal"),
    ]) {
      expect(mutant, name).not.toBe(markdown);
      expect(addressFindings(name, mutant), name).not.toEqual([]);
    }
  }
  // The canonical seat launch hands hc the exact checkout, owner, repo and space values, and the agent its first task.
  const template = SEAT.exec(read("overseer"))![1]!;
  const seat = seatLaunchArgv(template);
  expect(seat.argv).toEqual(["run", "--bg", "--json", "--no-parent", "--no-notify", "--name", "ORCH · 2.20.0", "--cwd", seat.checkout,
    "--label", "tickmarkr.owner=ORCH", "--label", `tickmarkr.repo=${seat.repo}`, "--label", "herdr.space=work space",
    "--", "claude", "--model", "opus", "Read the brief and follow it."]);
  // Pre-fix control: the unquoted template truncates the cwd and repo label.
  const truncated = seatLaunchArgv(template.replace('"<checkout>"', "<checkout>").replace('"tickmarkr.repo=<repo>"', "tickmarkr.repo=<repo>"));
  expect(truncated.argv[truncated.argv.indexOf("--cwd") + 1]).not.toBe(truncated.checkout);
  expect(truncated.argv).not.toContain(`tickmarkr.repo=${truncated.repo}`);
  // The OVERSEER's sandbox-denial fallback uses the recorded ORCH terminal and socket, never its own.
  const fallback = flat(skillReading(read("overseer"), "app"));
  expect(fallback).toContain("record the ORCH's `address` from its `hc run` receipt and the core's `HC_TERMINAL_SOCKET`");
  expect(fallback).toContain("with that recorded ORCH terminal and socket; never the OVERSEER's own `HC_TERMINAL_ID`");
});

test("host-reading guards satisfy the closed scope table while misplaced hc commands fail and canonical/installed bytes and symlink targets stay intact", () => {
  expect(hostOf(`**${APP_HEADING}**: x`)).toBe("app");
  expect(hostOf("On the Herdr app")).toBe("app");
  expect(hostOf("**On herdr (`HERDR_ENV=1`)**: x")).toBe("herdr");
  expect(hostOf("On Orca")).toBe("orca");
  expect(hostOf("On a plain host (neither herdr nor Orca)")).toBe("plain");
  for (const command of ["hc run --bg", "hc ls --all", "hc get t", "hc label t", "hc kill t", "hc keep t --off", "hc read t", "hc send t x", "hc keys t enter", "hc wait t", "hc rm t", "hc server status"]) {
    expect(hostViolations(`## ${APP_HEADING}\n${command}`), command).toEqual([]);
    expect(hostViolations(`## ${APP_HEADING}\n\n- bullet\n  \`${command}\``), command).toEqual([]);
    for (const outside of [`## Universal\n${command}`, `## On herdr\n${command}\n## On Orca\nfiles`, `## On Orca\n${command}`, `## On a plain host (neither herdr nor Orca)\n${command}`]) {
      expect(hostViolations(outside), outside).not.toEqual([]);
    }
    expect(plainLineFindings(`## Universal\n${command}`), command).toContainEqual(expect.stringContaining("hc command"));
  }
  // Closed scope table: every spelling of the hc executable, in every non-app scope (an explicit plain scope nested
  // under an app scope overrides it), is a misplaced command — and stays legal inside the app scope.
  const spellings = (sub: string) => [`hc ${sub}`, `"hc" ${sub}`, `'hc' ${sub}`, `\\hc ${sub}`, `/usr/local/bin/hc ${sub}`,
    `"/opt/my tools/hc" ${sub}`, `~/bin/hc ${sub}`, `command hc ${sub}`, `env X=1 hc ${sub.replace(/^(\w+)/, "\"$1\"")}`];
  const outsideApp = (cmd: string) => [
    `## Universal\n${cmd}`, `- universal \`${cmd}\``, `## On Orca\n${cmd}`, `## On herdr\n${cmd}\n## On Orca\nfiles`,
    `## ${APP_HEADING}\n### On a plain host (neither herdr nor Orca)\n${cmd}`,
    `## ${APP_HEADING}\n\n- On a plain host (neither herdr nor Orca): \`${cmd}\``,
    `## ${APP_HEADING}\n\n- **On a plain host**: run\n  \`${cmd}\``,
  ];
  for (const sub of ["kill t --json", "rm t --json", "send t x --json"]) {
    for (const cmd of spellings(sub)) {
      expect(hcOnly.test(cmd), cmd).toBe(true);
      expect(hostViolations(`## ${APP_HEADING}\n\n- app \`${cmd}\``), cmd).toEqual([]);
      for (const doc of outsideApp(cmd)) expect(hostViolations(doc), doc).toContainEqual(expect.stringContaining("hc outside the app scope"));
      expect(plainLineFindings(`## Universal\n${cmd}`), cmd).toContainEqual(expect.stringContaining("hc command"));
    }
  }
  // The four reproduced escapes, by name.
  for (const doc of [`## ${APP_HEADING}\n### On a plain host (neither herdr nor Orca)\nhc kill t --json`,
    `## ${APP_HEADING}\n\n- On a plain host (neither herdr nor Orca): \`hc kill t --json\``,
    `## Universal\n"hc" kill t --json`, `## Universal\n/usr/local/bin/hc kill t --json`]) {
    expect(hostViolations(doc), doc).not.toEqual([]);
    if (doc.startsWith("## Universal")) expect(plainLineFindings(doc), doc).not.toEqual([]);
  }
  // Both guards match LOGICAL commands: a fenced line ending in a backslash joins the next, an inline code span
  // reads its internal newlines as spaces, and the command keeps the scope and source line where it starts.
  const fenced = (cmd: string) => `\`\`\`bash\n${cmd}\n\`\`\``;
  const plainHeading = "On a plain host (neither herdr nor Orca)";
  const continued = fenced("hc \\\n  kill t --json"), wrapped = "`hc\nkill t --json`";
  // The four multiline reproductions, by name — each invisible to any single physical line.
  const reproductions: [string, string, number][] = [
    ["universal fenced backslash-continued hc kill", `## Universal\n${continued}`, 3],
    ["plain-host fenced backslash-continued hc kill", `## ${plainHeading}\n${continued}`, 3],
    ["plain-host heading nested beneath an app heading", `## ${APP_HEADING}\n### ${plainHeading}\n${continued}`, 4],
    ["universal inline code with a newline between hc and kill", `## Universal\n${wrapped}`, 2],
  ];
  for (const [why, doc, line] of reproductions) {
    expect(doc.split("\n").some((physical) => hcOnly.test(physical)), why).toBe(false);
    expect(hostViolations(doc), why).toEqual([expect.stringMatching(new RegExp(`^line ${line}: hc outside the app scope: .*hc .*kill t --json`))]);
    expect(plainLineFindings(doc), why).toEqual([expect.stringMatching(/^hc command: .*hc .*kill t --json/)]);
  }
  // Controls: the same commands inside the app scope report nothing.
  for (const body of [continued, wrapped]) {
    expect(hostViolations(`## ${APP_HEADING}\n${body}`), body).toEqual([]);
    expect(plainLineFindings(`## ${APP_HEADING}\n${body}`), body).toEqual([]);
  }
  // Bounded generalisation: every spelling, split at every whitespace gap of the command, by a fenced continuation
  // (single or repeated) or a wrapped inline span (with or without a trailing backslash), in every non-app scope.
  const splits = (cmd: string) => [...cmd.matchAll(/ /g)].map((gap) => [cmd.slice(0, gap.index), cmd.slice(gap.index! + 1)] as const);
  const multiline = (cmd: string) => splits(cmd).flatMap(([head, tail]) => [
    fenced(`${head} \\\n  ${tail}`), fenced(`${head} \\\n\\\n  ${tail}`), `\`${head}\n${tail}\``, `\`${head} \\\n  ${tail}\``,
  ]);
  // The first four are read on a plain host; the last two are not, so only hostViolations owns them.
  const scopes = (body: string) => [`## Universal\n${body}`, `## ${plainHeading}\n${body}`, `## ${APP_HEADING}\n### ${plainHeading}\n${body}`,
    `## ${APP_HEADING}\n\n- On a plain host: run\n  ${body.replaceAll("\n", "\n  ")}`, `## On Orca\n${body}`, `## On herdr\nH\n## On Orca\n${body}`];
  for (const cmd of spellings("kill t --json")) {
    for (const body of multiline(cmd)) {
      expect(hostViolations(`## ${APP_HEADING}\n${body}`), body).toEqual([]);
      for (const doc of scopes(body)) expect(hostViolations(doc), doc).toContainEqual(expect.stringContaining("hc outside the app scope"));
      for (const doc of scopes(body).slice(0, 4)) expect(plainLineFindings(doc), doc).toContainEqual(expect.stringContaining("hc command"));
    }
  }
  // Review round 3 reproductions, by name: bare, indented-code and list-item-fence continuations in universal, plain
  // and nested plain scopes (the indented and list-item headings of that round are non-canonical; see below).
  const reviewerBodies = { bare: "hc \\\n  kill t --json", indented: "\n    hc \\\n      kill t --json", listFence: "- ```bash\n  hc \\\n    kill t --json\n  ```" };
  for (const [form, body] of Object.entries(reviewerBodies)) {
    for (const header of ["## Universal\n", `## ${plainHeading}\n`, `## ${APP_HEADING}\n### ${plainHeading}\n`]) {
      expect(hostViolations(header + body), `${form} ${header}`).toContainEqual(expect.stringMatching(/hc outside the app scope: .*hc .*kill t --json/));
      expect(plainLineFindings(header + body), `${form} ${header}`).toContainEqual(expect.stringMatching(/^hc command: .*hc .*kill t --json/));
    }
    expect(hostViolations(`## ${APP_HEADING}\n${body}`), form).toEqual([]);
    expect(plainLineFindings(`## ${APP_HEADING}\n${body}`), form).toEqual([]);
  }
  // Park 1697: a WHITELIST that fails closed. Only a column-0 ATX heading sets a host scope; any other heading that
  // names a host (indented any amount, after a list marker, inside a list item, setext) is never a scope and reports
  // "non-canonical host heading" through both guards. Every heading reproduction from both review rounds, by name,
  // with abbreviated and full host labels:
  for (const [app, plain] of [["On the Herdr app", "On a plain host"], [APP_HEADING, plainHeading]] as const) {
    const reviewRounds: [string, string, number][] = [
      ["indented plain heading under an app heading", `## ${app}\n  ### ${plain}\nhc kill t --json`, 2],
      ["plain heading inside an app list item", `- ${app}: setup\n\n  ### ${plain}\n\n  hc kill t --json`, 3],
      ["plain heading on a list marker", `## ${app}\n\n- ### ${plain}\n\n  hc kill t --json`, 3],
      ["indented app heading inside a universal list", `## Universal\n\n- setup\n\n  ### ${app}\n\n  app guidance\n\nhc kill t --json`, 5],
    ];
    for (const [why, doc, line] of reviewRounds) {
      expect(hostViolations(doc), why).toContainEqual(expect.stringMatching(new RegExp(`^line ${line}: non-canonical host heading: `)));
      expect(plainLineFindings(doc), why).toContainEqual(expect.stringMatching(/^non-canonical host heading: /));
    }
    // The indented app heading never opened a scope: the universal command after the list fails both guards.
    expect(hostViolations(reviewRounds[3]![1])).toContainEqual("line 9: hc outside the app scope: hc kill t --json");
    expect(plainLineFindings(reviewRounds[3]![1])).toContainEqual("hc command: hc kill t --json");
    // Controls: a column-0 app scope with hc, a neutral column-0 heading inside it, and a neutral indented heading
    // inside an app bullet all keep the app scope and report nothing.
    for (const doc of [`## ${app}\n\nhc kill t --json`, `## ${app}\n\n### Details\n\nhc kill t --json`,
      `## Universal\n\n- ${app}: setup\n\n  ### Details\n\n  hc kill t --json`]) {
      expect(hostViolations(doc), doc).toEqual([]);
      expect(plainLineFindings(doc), doc).toEqual([]);
      expect(skillReading(doc, "app"), doc).toContain("hc kill t --json");
      expect(skillReading(doc, "plain"), doc).not.toContain("hc kill t --json");
    }
  }
  // Bounded generalisation over non-canonical heading forms: every host label, abbreviated or full, as ATX indented
  // 1-8 columns or by a tab, after one or nested list markers or a blockquote marker, inside a list item, or setext
  // (=== / ---, list item included), in every enclosing scope, fails both guards and never opens a scope — so a
  // column-0 hc after it fails outside the app heading and passes inside it, whatever the label names.
  const labels = ["On the Herdr app", APP_HEADING, "On a plain host", plainHeading, "On herdr", "On herdr (`HERDR_ENV=1`)", "On Orca", "**On Orca**"];
  const offForms = (label: string) => [
    ...[1, 2, 3, 4, 8].map((n) => `${" ".repeat(n)}### ${label}`), `\t## ${label}`, `- ### ${label}`, `1. ## ${label}`,
    `- - #### ${label}`, `> ### ${label}`, `- setup\n\n  ### ${label}`, `${label}\n---`, `${label}\n===`, `- ${label}\n  ---`,
  ];
  let offCells = 0;
  for (const label of labels) {
    for (const form of offForms(label)) {
      for (const header of ["## Universal", `## ${plainHeading}`, `## ${APP_HEADING}`]) {
        const doc = `${header}\n\n${form}\n\nhc kill t --json`;
        expect(hostViolations(doc), doc).toContainEqual(expect.stringContaining(`non-canonical host heading: ${form.split("\n").find((l) => l.includes(label))!.trim()}`));
        expect(plainLineFindings(doc), doc).toContainEqual(expect.stringMatching(/^non-canonical host heading: /));
        expect(hostViolations(doc).some((v) => v.includes("hc outside the app scope")), doc).toBe(header !== `## ${APP_HEADING}`);
        offCells++;
      }
    }
  }
  expect(offCells).toBe(labels.length * offForms("x").length * 3);
  // Bounded generalisation over the Markdown input class: every spelling, split at every gap, in every continuation
  // or wrap form (backtick, repeated, tilde and list-item fences, bare prose, indented code, wrapped inline code with
  // or without a backslash), under every canonical plain override of an app scope (a column-0 ATX heading, open or
  // closed, and a plain bullet) and the universal/plain/Orca scopes. Every cell fails both guards where the host reads
  // it, and the app reading never holds it; the same body in the app scope reports nothing.
  const indentBy = (body: string, n: number) => body.split("\n").map((line) => line && " ".repeat(n) + line).join("\n");
  const forms = (head: string, tail: string) => [
    fenced(`${head} \\\n  ${tail}`), fenced(`${head} \\\n\\\n  ${tail}`), `~~~sh\n${head} \\\n  ${tail}\n~~~`,
    `- \`\`\`bash\n  ${head} \\\n    ${tail}\n  \`\`\``, `${head} \\\n  ${tail}`, `\n    ${head} \\\n      ${tail}`,
    `\`${head}\n${tail}\``, `\`${head} \\\n  ${tail}\``,
  ];
  const overrides = (body: string) => [
    `## ${APP_HEADING}\n### ${plainHeading}\n${body}`, `## ${APP_HEADING}\n### ${plainHeading} ###\n${body}`,
    `## ${APP_HEADING}\n\n- On a plain host: run\n${indentBy(body, 2)}`,
  ];
  let cells = 0;
  for (const cmd of spellings("kill t --json")) {
    for (const [head, tail] of splits(cmd)) {
      for (const body of forms(head, tail)) {
        for (const app of [`## ${APP_HEADING}\n${body}`, `## ${APP_HEADING}\n\n- app: run\n${indentBy(body, 2)}`]) {
          expect(hostViolations(app), app).toEqual([]);
          expect(plainLineFindings(app), app).toEqual([]);
        }
        for (const doc of [`## Universal\n${body}`, `## ${plainHeading}\n${body}`, ...overrides(body)]) {
          expect(hostViolations(doc), doc).toContainEqual(expect.stringContaining("hc outside the app scope"));
          expect(plainLineFindings(doc), doc).toContainEqual(expect.stringContaining("hc command"));
          if (doc.startsWith(`## ${APP_HEADING}`)) expect(skillReading(doc, "app"), doc).not.toContain(tail);
          cells++;
        }
        expect(hostViolations(`## On Orca\n${body}`), body).toContainEqual(expect.stringContaining("hc outside the app scope"));
      }
    }
  }
  expect(cells).toBeGreaterThan(1000);
  // The review after park 1697: its six reproductions, by name: list content columns, implicit fence ends and blockquote
  // prefixes. Each returned [] through both guards before the fail-closed list walk.
  const quotedFence = "## Universal\n> ```sh\n> hc \\\n>   kill t --json\n> ```";
  const round4: [string, string, string, string][] = [
    ["unordered item left by a one-column line after a blank", "## Universal\n\n- On the Herdr app: setup\n\n hc kill t --json", "line 5: hc outside the app scope: hc kill t --json", "hc command: hc kill t --json"],
    ["ordered item left by a two-column line after a blank", "## Universal\n\n10. On the Herdr app: setup\n\n  hc kill t --json", "line 5: hc outside the app scope: hc kill t --json", "hc command: hc kill t --json"],
    ["blockquoted setext plain heading under an app heading", "## On the Herdr app\n\n> On a plain host\n> ---\n> hc kill t --json", "line 3: non-canonical host heading: > On a plain host", "non-canonical host heading: > On a plain host"],
    ["app item fence ended by a dedented line", "## Universal\n\n- On the Herdr app: setup\n\n  ```sh\n  hc read t\n\nhc kill t --json", "line 8: hc outside the app scope: hc kill t --json", "hc command: hc kill t --json"],
    ["blockquoted inline span wrapped between hc and kill", "## Universal\n> `hc\n> kill t --json`", "line 2: hc outside the app scope: `hc kill t --json`", "hc command: `hc kill t --json`"],
    ["blockquoted fenced backslash continuation", quotedFence, "line 3: hc outside the app scope: hc  kill t --json", "hc command: hc  kill t --json"],
  ];
  for (const [why, doc, host, plain] of round4) {
    expect(hostViolations(doc), why).toContainEqual(host);
    expect(plainLineFindings(doc), why).toContainEqual(plain);
  }
  // Controls: the same shapes inside the app scope report nothing.
  for (const doc of ["## Universal\n\n- On the Herdr app: setup\n\n  hc kill t --json", "## Universal\n\n10. On the Herdr app: setup\n\n    hc kill t --json",
    "## Universal\n\n- On the Herdr app: setup\n\n  ```sh\n  hc read t\n\n  hc kill t --json\n  ```", "## On the Herdr app\n> `hc\n> kill t --json`",
    quotedFence.replace("Universal", "On the Herdr app"), "## On the Herdr app\n\n- setup\n  > note\nhc kill t --json"]) {
    expect(hostViolations(doc), doc).toEqual([]);
    expect(plainLineFindings(doc), doc).toEqual([]);
  }
  // A lazy continuation stays in its item (CommonMark): universal text under an app bullet reads as app, and an hc line
  // lazily continuing a plain bullet under an app heading fails — it was read as app before.
  expect(hostViolations("## Universal\n\n- On the Herdr app: setup\nhc kill t --json")).toEqual([]);
  expect(hostViolations(`## ${APP_HEADING}\n\n- On a plain host: setup\nhc kill t --json`)).toEqual(["line 4: hc outside the app scope: hc kill t --json"]);
  // Fail closed on every other container shape: a host named behind a blockquote, a second list marker, five spaces or
  // a code indent is never a scope; a raw HTML block (which swallows the headings after it) and a heading outside every
  // list item that is not a column-0 ATX heading are reported through both guards.
  const rejected: [string, string][] = [
    ["> - On a plain host: x", "non-canonical host scope"], ["- - On a plain host: x", "non-canonical host scope"],
    ["-      On a plain host: x", "non-canonical host scope"], ["- setup\n\n      - On a plain host: x", "non-canonical host scope"],
    ["<div>\n## On the Herdr app\nhc kill t --json", "raw HTML block"], ["<!-- note -->", "raw HTML block"],
    ["  ## Details", "non-canonical heading"], ["Details\n-------", "non-canonical heading"], ["===\n-", "non-canonical heading"],
  ];
  for (const [form, finding] of rejected) {
    const doc = `## ${APP_HEADING}\n\n${form}`;
    expect(hostViolations(doc), form).toContainEqual(expect.stringContaining(finding));
    expect(plainLineFindings(doc), form).toContainEqual(expect.stringContaining(finding));
  }
  // Bounded generalisation over list containers, every outcome checked against CommonMark (pandoc) while authoring:
  // every marker, one to four spaces after it, a following hc line at every column up to one past the content column,
  // after a blank line, lazily or after a fence the item holds. After a blank, the line is inside the item exactly when
  // it reaches the content column; a lazy line is always inside. An app item under a universal heading must fail the
  // outside cells, a plain item under an app heading the inside cells, through both guards.
  let listCells = 0;
  for (const marker of ["-", "*", "+", "1.", "10.", "1)"]) {
    for (const spaces of [1, 2, 3, 4]) {
      const content = marker.length + spaces, pad = " ".repeat(content);
      for (let column = 0; column <= content + 1; column++) {
        const tail = `${" ".repeat(column)}hc kill t --json`;
        for (const [form, body] of [["blank", `\n\n${tail}`], ["lazy", `\n${tail}`], ["fence", `\n\n${pad}\`\`\`sh\n${pad}echo\n\n${tail}`]] as const) {
          const inside = form === "lazy" || column >= content;
          for (const [header, label, fails] of [["## Universal", "On the Herdr app", !inside], [`## ${APP_HEADING}`, "On a plain host", inside]] as const) {
            const doc = `${header}\n\n${marker}${" ".repeat(spaces)}${label}: setup${body}`;
            const kill = (findings: string[]) => findings.some((finding) => finding.includes("kill t --json"));
            expect(kill(hostViolations(doc)), doc).toBe(fails);
            expect(kill(plainLineFindings(doc)), doc).toBe(fails);
            listCells++;
          }
        }
      }
    }
  }
  expect(listCells).toBe(888);
  // The walk found five universal lines in the shipped overseer that CommonMark rendered inside a host bullet (lazy
  // continuations); each now stands after a blank line and reads on every host.
  for (const host of ["herdr", "orca", "app"] as const) {
    const reading = flat(skillReading(read("overseer"), host));
    for (const line of ["**An adopted seat ANNOUNCES itself, in the same act as re-arming:**", "Require the orchestrator to use the host-owned daemon",
      "The brief MUST contain: **Seat hygiene", "For Leg-2 (both hosts), a Codex reviewer", "**A codex seat inside a git WORKTREE cannot commit"]) {
      expect(reading, `${host}: ${line}`).toContain(line);
    }
  }
  // Classic herdr commands read the same logical way, and the shipped skills report nothing through either guard.
  expect(hostViolations(`## Universal\n${fenced("herdr \\\n  pane run p x")}`)).not.toEqual([]);
  expect(plainLineFindings(`## Universal\n\`herdr\npane run p x\``)).not.toEqual([]);
  for (const name of SKILLS) {
    const dir = join(ROOT, `skills/tickmarkr-${name}`);
    for (const file of ["SKILL.md", ...(existsSync(join(dir, "references")) ? readdirSync(join(dir, "references")).filter((f) => f.endsWith(".md")).map((f) => `references/${f}`) : [])]) {
      expect(plainLineFindings(readFileSync(join(dir, file), "utf8")), `${name}/${file}`).toEqual([]);
    }
  }
  // Not the executable: a suffix or prefix glued to the name, or a non-hc subcommand.
  for (const prose of ["watch-hc run", "x.hc kill", "$hc kill", "myhc kill", "hc terminal", "`hc` terminal", "the HC pair"]) expect(hcOnly.test(prose), prose).toBe(false);
  for (const classic of ["herdr pane run p x", "herdr agent start a", "herdr tab create", "watch-journal.sh", "TKR_ARMING_SEAT"]) {
    expect(hostViolations(`## ${APP_HEADING}\n${classic}`), classic).not.toEqual([]);
  }
  // Prose that merely names hc, a herdr.space label or HC variables is not a command.
  expect(hcOnly.test("each an interactive TUI in its own visible `hc` terminal")).toBe(false);
  expect(hostViolations("## Universal\nthe `herdr.space` label and `HC_TERMINAL_ID`")).toEqual([]);
  // The reading routes: app reads universal plus app scopes only.
  const doc = `# T\nuniversal\n## On herdr\nH\n## On Orca\nO\n## ${APP_HEADING}\nA\n## On a plain host (neither herdr nor Orca)\nP\n`;
  expect(skillReading(doc, "app").split("\n").filter(Boolean)).toEqual(["# T", "universal", `## ${APP_HEADING}`, "A"]);
  expect(skillReading(doc, "herdr")).not.toContain("\nA");
  expect(skillReading(doc, "plain")).not.toContain("\nA");
  for (const name of SKILLS) expect(skillDirViolations(join(ROOT, `skills/tickmarkr-${name}`)), name).toEqual([]);
  // The installed twins are private: the public export excludes .claude, so this leg is skipped on the exported
  // tree where it is absent. Here each twin stays a tracked symlink to its canonical file with identical bytes.
  if (existsSync(installedRoot)) {
    for (const name of SKILLS) {
      const installed = join(installedRoot, `tickmarkr-${name}`, "SKILL.md");
      expect(lstatSync(installed).isSymbolicLink(), name).toBe(true);
      expect(readlinkSync(installed), name).toBe(`../../../skills/tickmarkr-${name}/SKILL.md`);
      expect(readFileSync(installed).equals(readFileSync(join(ROOT, `skills/tickmarkr-${name}/SKILL.md`))), name).toBe(true);
      expect(execFileSync("git", ["ls-files", "-s", relative(ROOT, installed)], { cwd: ROOT, encoding: "utf8" }), name).toMatch(/^120000 /);
    }
  }
});

type Tree = Record<string, Record<string, string>>;
const decode = (data: Pick<typeof provenance, "SHIPPED_DIGESTS" | "SHIPPED_SNAPSHOTS">, refs: Readonly<Record<string, number>>): Tree =>
  Object.fromEntries(Object.entries(refs).map(([skill, index]) => [skill,
    Object.fromEntries(Object.entries(data.SHIPPED_SNAPSHOTS[skill]![index]!).map(([path, i]) => [path, data.SHIPPED_DIGESTS[i]!]))]));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function walk(dir: string, prefix = ""): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((entry): [string, string][] => {
    if (entry.isDirectory()) return Object.entries(walk(join(dir, entry.name), `${prefix}${entry.name}/`));
    return entry.isFile() ? [[`${prefix}${entry.name}`, sha(readFileSync(join(dir, entry.name)))]] : [];
  }));
}
const sorted = (tree: Record<string, string>) => JSON.stringify(Object.entries(tree).sort(([a], [b]) => a.localeCompare(b)));

test("regenerated current skill provenance matches the changed tree while every recorded released snapshot remains unchanged", async () => {
  const check = await generateShippedSkillFiles(ROOT, true);
  expect(check.status, check.lines.join("\n")).toBe(0);
  const current = decode(provenance, provenance.CURRENT_SNAPSHOT);
  for (const name of SKILLS) {
    const skill = `tickmarkr-${name}`;
    expect(sorted(current[skill]!), skill).toBe(sorted(walk(join(ROOT, "skills", skill))));
    expect(current[skill]!["SKILL.md"]).toBe(sha(readFileSync(join(ROOT, "skills", skill, "SKILL.md"))));
  }
  // Every release recorded by the newest present tag's module decodes to the same snapshot here.
  const tags = execFileSync("git", ["tag", "--list", "v*", "--sort=-v:refname"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  if (tags.length === 0) return; // a tagless public clone: history is advisory, as the generator's check reports
  const source = execFileSync("git", ["show", `${tags[0]}:src/cli/shipped-skill-files.ts`], { cwd: ROOT, encoding: "utf8" });
  const field = (name: string) => JSON.parse(new RegExp(`^export const ${name}[^=\\n]*= ([\\s\\S]*?);$`, "m").exec(source)![1]!);
  const released = { SHIPPED_DIGESTS: field("SHIPPED_DIGESTS"), SHIPPED_SNAPSHOTS: field("SHIPPED_SNAPSHOTS") };
  const releases = field("SHIPPED_RELEASES") as Record<string, Record<string, number>>;
  expect(Object.keys(releases).length).toBeGreaterThan(0);
  for (const [version, refs] of Object.entries(releases)) {
    expect(provenance.SHIPPED_RELEASES[version], version).toBeDefined();
    const before = decode(released, refs), after = decode(provenance, provenance.SHIPPED_RELEASES[version]!);
    expect(Object.keys(after).sort(), version).toEqual(Object.keys(before).sort());
    for (const skill of Object.keys(before)) expect(sorted(after[skill]!), `${version}/${skill}`).toBe(sorted(before[skill]!));
  }
});
