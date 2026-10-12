import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parse } from "yaml";

import { FakeAdapter } from "../../src/adapters/fake.js";
import * as registry from "../../src/adapters/registry.js";
import { assembleFleetEditor, fleet, type FleetIO } from "../../src/cli/commands/fleet.js";
import { loadConfig, loadConfigWithMode } from "../../src/config/config.js";
import { tickmarkrDir } from "../../src/graph/graph.js";
import { makeRepo } from "../helpers/tmprepo.js";

const TIERS = `tiers:
  fake:
    vendor: fake
    channel: sub
    models:
      fake-1: mid
      fake-2: mid
`;

const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const ENTER = "\r";
const OPEN_STEER = LEFT + DOWN + DOWN + ENTER;
const MODE_STAFF = "m" + DOWN + ENTER + "w";
const JUDGE_FAKE1 = OPEN_STEER + DOWN + DOWN + "f" + DOWN + ENTER + "w";

type Editor = Exclude<Awaited<ReturnType<typeof assembleFleetEditor>>, { unavailable: string }>;
type ReviewState = Parameters<Editor["props"]["reviewOverlay"]>[0];

const repoFile = (repo: string) => join(repo, ".tickmarkr", "config.yaml");
const userFile = (globalDir: string) => join(globalDir, "config.yaml");
const lineOf = (text: string, needle: string) => text.split("\n").findIndex((line) => line.includes(needle)) + 1;

function globalWith(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tickmarkr-steer-"));
  writeFileSync(userFile(dir), yaml);
  return dir;
}

function stamp(repo: string): FakeAdapter {
  registry.writeDoctor(repo, {
    fake: {
      installed: true,
      authed: true,
      version: "fake",
      models: ["fake-1", "fake-2"],
      modelsDetectedAt: "2026-07-16T12:00:00.000Z",
      modelAuth: {
        "fake-1": { authed: true, probedAt: "2026-07-16T00:00:00.000Z" },
        "fake-2": { authed: true, probedAt: "2026-07-16T00:00:00.000Z" },
      },
    },
  });
  const when = new Date(Date.now() - 5 * 60_000);
  utimesSync(join(tickmarkrDir(repo), "doctor.json"), when, when);
  const script = join(repo, "fake.json");
  writeFileSync(script, JSON.stringify({ tasks: {} }));
  return new FakeAdapter(script);
}

function writeRepo(repo: string, yaml: string): void {
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(repoFile(repo), yaml);
}

async function openEditor(repo: string, globalDir: string, adapter: FakeAdapter): Promise<Editor> {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void };
  input.isTTY = true;
  input.setRawMode = () => {};
  const assembled = await assembleFleetEditor(repo, [adapter], {
    input,
    output: { isTTY: true, write: () => true },
    debug: true,
  }, { globalDir });
  if ("unavailable" in assembled) throw new Error(assembled.unavailable);
  return assembled;
}

function review(props: Editor["props"], over: Partial<ReviewState> = {}) {
  return props.reviewOverlay({
    denyAdapters: props.initialDenyAdapters ?? [],
    denyModels: props.initialDenyModels ?? [],
    denyWorkersAdapters: props.initialDenyWorkersAdapters ?? [],
    denyWorkersModels: props.initialDenyWorkersModels ?? [],
    classifications: [],
    selectedMode: props.initialMode,
    map: props.initialMap,
    steering: props.initialSteering,
    ...over,
  });
}

function commitDiff(editor: Editor, staged: ReturnType<Editor["props"]["reviewOverlay"]>): string {
  if (staged.kind !== "diff") throw new Error(`expected a diff, got ${staged.kind}`);
  return editor.commit({ kind: "write", review: staged });
}

type TestInput = PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void };

function makeIO() {
  const input = new PassThrough() as TestInput;
  input.isTTY = true;
  input.setRawMode = () => {};
  const directWrite = input.write.bind(input);
  const pendingWrites: string[] = [];
  let pumping = false;
  const pump = () => {
    const chunk = pendingWrites.shift();
    if (chunk === undefined) {
      pumping = false;
      return;
    }
    directWrite(chunk);
    setImmediate(pump);
  };
  input.write = ((chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    pendingWrites.push(...(text.match(/\x1b\[[0-9;]*[A-Za-z~]|[\s\S]/g) ?? []));
    if (!pumping) {
      pumping = true;
      setImmediate(pump);
    }
    return true;
  }) as typeof input.write;
  const output = { isTTY: true, columns: 120, rows: 60, write: () => true };
  const io: FleetIO = { input, output, debug: true };
  return io;
}

function drive(repo: string, adapter: FakeAdapter, globalDir: string, bytes: string) {
  const io = makeIO();
  const pending = fleet(["--global-dir", globalDir], repo, [adapter], io);
  io.input!.write(bytes + "y");
  return pending;
}

let stdoutTTY: PropertyDescriptor | undefined;
let noColor: string | undefined;
let forceColor: string | undefined;

beforeEach(() => {
  stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  noColor = process.env.NO_COLOR;
  forceColor = process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = "3";
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
});

afterEach(() => {
  if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  if (noColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = noColor;
  if (forceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = forceColor;
});

describe("fleet control edits follow the overlay that holds the key", () => {
  test("through the fleet command a judge or routing.mode pick in a repository whose overlay holds that key writes that overlay keeping its comment and leaves the user overlay byte-identical so the loader resolves the pick here versus the same pick where no repository overlay holds it landing in the user overlay that a second repository inherits", async () => {
    const modeHeldDir = globalWith(TIERS);
    const modeHeldUser = readFileSync(userFile(modeHeldDir), "utf8");
    const modeHeld = makeRepo({ "keep.txt": "x" });
    const modeHeldText = "routing:\n  mode: risk-based  # repository mode\n";
    writeRepo(modeHeld, modeHeldText);
    const modeHeldAdapter = stamp(modeHeld);
    const modeHeldOut = await drive(modeHeld, modeHeldAdapter, modeHeldDir, MODE_STAFF);
    expect(modeHeldOut).toBe(`fleet: wrote ${repoFile(modeHeld)}`);
    const modeHeldRepo = readFileSync(repoFile(modeHeld), "utf8");
    expect(modeHeldRepo).toContain("staff-led");
    expect(modeHeldRepo).toContain("# repository mode");
    expect(readFileSync(userFile(modeHeldDir), "utf8")).toBe(modeHeldUser);
    expect(loadConfigWithMode(modeHeld, { globalDir: modeHeldDir }).mode.mode).toBe("staff-led");
    expect(loadConfigWithMode(makeRepo({ "keep.txt": "y" }), { globalDir: modeHeldDir }).mode.mode).toBe("risk-based");

    const modeOpenDir = globalWith(TIERS);
    const modeOpen = makeRepo({ "keep.txt": "x" });
    writeRepo(modeOpen, "concurrency: 1\n");
    const modeOpenBefore = readFileSync(repoFile(modeOpen), "utf8");
    const modeOpenOut = await drive(modeOpen, stamp(modeOpen), modeOpenDir, MODE_STAFF);
    expect(modeOpenOut).toBe(`fleet: wrote ${userFile(modeOpenDir)}`);
    expect(readFileSync(userFile(modeOpenDir), "utf8")).toContain("mode: staff-led");
    expect(readFileSync(repoFile(modeOpen), "utf8")).toBe(modeOpenBefore);
    const modeHeir = makeRepo({ "keep.txt": "z" });
    expect(existsSync(repoFile(modeHeir))).toBe(false);
    expect(loadConfigWithMode(modeHeir, { globalDir: modeOpenDir }).mode.mode).toBe("staff-led");

    const judgeHeldDir = globalWith(TIERS);
    const judgeHeldUser = readFileSync(userFile(judgeHeldDir), "utf8");
    const judgeHeld = makeRepo({ "keep.txt": "x" });
    writeRepo(judgeHeld, "judge:\n  adapter: claude-code  # repository judge\n  model: fable\n");
    const judgeHeldOut = await drive(judgeHeld, stamp(judgeHeld), judgeHeldDir, JUDGE_FAKE1);
    expect(judgeHeldOut).toBe(`fleet: wrote ${repoFile(judgeHeld)}`);
    const judgeHeldRepo = readFileSync(repoFile(judgeHeld), "utf8");
    expect(judgeHeldRepo).toContain("# repository judge");
    expect(parse(judgeHeldRepo).judge).toEqual({ adapter: "fake", model: "fake-1" });
    expect(readFileSync(userFile(judgeHeldDir), "utf8")).toBe(judgeHeldUser);
    expect(loadConfig(judgeHeld, { globalDir: judgeHeldDir }).judge).toMatchObject({ adapter: "fake", model: "fake-1" });
    expect(loadConfig(makeRepo({ "keep.txt": "y" }), { globalDir: judgeHeldDir }).judge.model).toBe("fable");

    const judgeOpenDir = globalWith(TIERS);
    const judgeOpen = makeRepo({ "keep.txt": "x" });
    writeRepo(judgeOpen, "concurrency: 1\n");
    const judgeOpenRepo = readFileSync(repoFile(judgeOpen), "utf8");
    const judgeOpenOut = await drive(judgeOpen, stamp(judgeOpen), judgeOpenDir, JUDGE_FAKE1);
    expect(judgeOpenOut).toBe(`fleet: wrote ${userFile(judgeOpenDir)}`);
    expect(parse(readFileSync(userFile(judgeOpenDir), "utf8")).judge).toEqual({ adapter: "fake", model: "fake-1" });
    expect(readFileSync(repoFile(judgeOpen), "utf8")).toBe(judgeOpenRepo);
    expect(loadConfig(makeRepo({ "keep.txt": "z" }), { globalDir: judgeOpenDir }).judge).toMatchObject({ adapter: "fake", model: "fake-1" });
  }, 60_000);

  test("through the fleet review a review.prefer edit lands in the repository overlay that holds review.prefer and a consult.prefer edit lands in the user overlay when only review.prefer is held so a batch staging both is refused as mixed destinations naming each side and writes nothing", async () => {
    const userText = `${TIERS}review:\n  prefer: [fake]\nconsult:\n  prefer: [fake:fake-2]\n`;
    const globalDir = globalWith(userText);
    const repo = makeRepo({ "keep.txt": "x" });
    const held = "review:\n  prefer: [codex]  # repository reviewers\n";
    writeRepo(repo, held);
    const adapter = stamp(repo);
    const editor = await openEditor(repo, globalDir, adapter);
    const both = review(editor.props, {
      steering: { ...editor.props.initialSteering, review: ["fake"], consult: ["fake:fake-1"] },
    });
    expect(both.kind).toBe("refused");
    if (both.kind === "refused") {
      expect(both.reason).toContain("mixed destinations");
      expect(both.reason).toContain("review.prefer");
      expect(both.reason).toContain("consult.prefer");
      expect(both.reason).toContain(repoFile(repo));
      expect(both.reason).toContain(userFile(globalDir));
    }
    expect(readFileSync(repoFile(repo), "utf8")).toBe(held);
    expect(readFileSync(userFile(globalDir), "utf8")).toBe(userText);
    expect(existsSync(`${repoFile(repo)}.tmp`)).toBe(false);
    expect(existsSync(`${userFile(globalDir)}.tmp`)).toBe(false);

    const reviewOnly = review(editor.props, {
      steering: { ...editor.props.initialSteering, review: ["fake"] },
    });
    expect(reviewOnly.kind).toBe("diff");
    if (reviewOnly.kind === "diff") expect(reviewOnly.path).toBe(repoFile(repo));
    expect(commitDiff(editor, reviewOnly)).toBe(`fleet: wrote ${repoFile(repo)}`);
    expect(parse(readFileSync(repoFile(repo), "utf8")).review.prefer).toEqual(["fake"]);
    expect(readFileSync(repoFile(repo), "utf8")).toContain("# repository reviewers");
    expect(readFileSync(userFile(globalDir), "utf8")).toBe(userText);

    const afterReview = readFileSync(repoFile(repo), "utf8");
    const consultEditor = await openEditor(repo, globalDir, adapter);
    const consultOnly = review(consultEditor.props, {
      steering: { ...consultEditor.props.initialSteering, consult: ["fake:fake-1"] },
    });
    expect(consultOnly.kind).toBe("diff");
    if (consultOnly.kind === "diff") expect(consultOnly.path).toBe(userFile(globalDir));
    expect(commitDiff(consultEditor, consultOnly)).toBe(`fleet: wrote ${userFile(globalDir)}`);
    expect(parse(readFileSync(userFile(globalDir), "utf8")).consult.prefer).toEqual(["fake:fake-1"]);
    expect(readFileSync(repoFile(repo), "utf8")).toBe(afterReview);
  });

  test("through the fleet review clearing a repository-held review.prefer or consult.prefer beside a user preference writes an empty sequence there so the loader and a reopened fleet show no preference versus clearing a user-held or unheld chain behaving exactly as at base", async () => {
    const userText = `${TIERS}review:\n  prefer: [fake]\nconsult:\n  prefer: [fake:fake-2]\n`;
    const globalDir = globalWith(userText);
    const repo = makeRepo({ "keep.txt": "x" });
    writeRepo(repo, "review:\n  prefer: [codex]\nconsult:\n  prefer: [fake:fake-1]\n");
    const adapter = stamp(repo);
    const editor = await openEditor(repo, globalDir, adapter);
    const cleared = review(editor.props, { steering: { review: undefined, consult: undefined } });
    expect(commitDiff(editor, cleared)).toBe(`fleet: wrote ${repoFile(repo)}`);
    const repoAfter = readFileSync(repoFile(repo), "utf8");
    expect(parse(repoAfter).review.prefer).toEqual([]);
    expect(parse(repoAfter).consult.prefer).toEqual([]);
    expect(readFileSync(userFile(globalDir), "utf8")).toBe(userText);
    const loaded = loadConfig(repo, { globalDir });
    expect(loaded.review.prefer ?? []).toEqual([]);
    expect(loaded.consult.prefer ?? []).toEqual([]);
    const reopened = await openEditor(repo, globalDir, adapter);
    expect(reopened.props.initialSteering.review ?? []).toEqual([]);
    expect(reopened.props.initialSteering.consult ?? []).toEqual([]);
    const printed = await fleet(["--print", "--global-dir", globalDir], repo, [adapter]);
    expect(typeof printed).toBe("string");
    expect(String(printed)).not.toContain("fake:fake-2");
    expect(String(printed)).not.toContain('prefer: ["fake"]');

    const userHeldText = `${TIERS}review:\n  policy: full\n  prefer: [fake]\nconsult:\n  stallMinutes: 20\n  prefer: [fake:fake-1]\n`;
    const userHeldDir = globalWith(userHeldText);
    const userHeld = makeRepo({ "keep.txt": "x" });
    writeRepo(userHeld, "concurrency: 2\n");
    const userHeldRepo = readFileSync(repoFile(userHeld), "utf8");
    const userHeldEditor = await openEditor(userHeld, userHeldDir, stamp(userHeld));
    const userClear = review(userHeldEditor.props, { steering: { review: undefined, consult: undefined } });
    expect(userClear.kind).toBe("diff");
    if (userClear.kind === "diff") expect(userClear.path).toBe(userFile(userHeldDir));
    expect(commitDiff(userHeldEditor, userClear)).toBe(`fleet: wrote ${userFile(userHeldDir)}`);
    const userCleared = readFileSync(userFile(userHeldDir), "utf8");
    const userParsed = parse(userCleared) as { review: { policy?: string; prefer?: string[] }; consult: { stallMinutes?: number; prefer?: string[] } };
    expect(userParsed.review.policy).toBe("full");
    expect(userParsed.review.prefer).toBeUndefined();
    expect(userParsed.consult.stallMinutes).toBe(20);
    expect(userParsed.consult.prefer).toBeUndefined();
    expect(userCleared).not.toMatch(/prefer:\s*\[\]/);
    expect(readFileSync(repoFile(userHeld), "utf8")).toBe(userHeldRepo);

    const unheldText = `${TIERS}review:\n  policy: full\nconsult:\n  stallMinutes: 20\n`;
    const unheldDir = globalWith(unheldText);
    const unheld = makeRepo({ "keep.txt": "x" });
    writeRepo(unheld, "concurrency: 2\n");
    const unheldEditor = await openEditor(unheld, unheldDir, stamp(unheld));
    const unheldClear = review(unheldEditor.props, { steering: { review: undefined, consult: undefined } });
    expect(unheldClear.kind).toBe("empty");
    expect(readFileSync(userFile(unheldDir), "utf8")).toBe(unheldText);
    expect(readFileSync(repoFile(unheld), "utf8")).toBe("concurrency: 2\n");
    expect(unheldText).not.toMatch(/prefer:\s*\[\]/);
  });

  test("through the fleet review a repository YAML merge key supplying only unrelated review siblings leaves a review.prefer edit user-destined versus a merge key supplying review.prefer refusing the edit with its merge line named and nothing written", async () => {
    const unrelated = "%YAML 1.1\n---\nbase: &siblings\n  policy: full\nreview:\n  <<: *siblings\n";
    const userText = TIERS;
    const openDir = globalWith(userText);
    const openRepo = makeRepo({ "keep.txt": "x" });
    writeRepo(openRepo, unrelated);
    const openEditorSession = await openEditor(openRepo, openDir, stamp(openRepo));
    const openEdit = review(openEditorSession.props, {
      steering: { ...openEditorSession.props.initialSteering, review: ["fake"] },
    });
    expect(openEdit.kind).toBe("diff");
    if (openEdit.kind === "diff") expect(openEdit.path).toBe(userFile(openDir));
    expect(commitDiff(openEditorSession, openEdit)).toBe(`fleet: wrote ${userFile(openDir)}`);
    expect(parse(readFileSync(userFile(openDir), "utf8")).review.prefer).toEqual(["fake"]);
    expect(readFileSync(repoFile(openRepo), "utf8")).toBe(unrelated);

    const supplying = "%YAML 1.1\n---\nbase: &seat\n  prefer: [codex]\nreview:\n  <<: *seat\n";
    const heldDir = globalWith(TIERS);
    const heldRepo = makeRepo({ "keep.txt": "x" });
    writeRepo(heldRepo, supplying);
    const heldUser = readFileSync(userFile(heldDir), "utf8");
    const heldEditor = await openEditor(heldRepo, heldDir, stamp(heldRepo));
    const heldEdit = review(heldEditor.props, {
      steering: { ...heldEditor.props.initialSteering, review: ["fake"] },
    });
    expect(heldEdit.kind).toBe("refused");
    if (heldEdit.kind === "refused") {
      expect(heldEdit.reason).toContain("<<: *seat");
      expect(heldEdit.reason).toContain(`.tickmarkr/config.yaml:${lineOf(supplying, "<<:")}`);
    }
    expect(readFileSync(repoFile(heldRepo), "utf8")).toBe(supplying);
    expect(readFileSync(userFile(heldDir), "utf8")).toBe(heldUser);
    expect(existsSync(`${repoFile(heldRepo)}.tmp`)).toBe(false);
    expect(existsSync(`${userFile(heldDir)}.tmp`)).toBe(false);
  });

  test("the review of a repository-destined control edit names each held key with its repository overlay path and line and says the file is tracked versus the membership-only destination note", async () => {
    const controlText = "routing:\n  mode: risk-based  # repository mode\njudge:\n  adapter: claude-code  # repository judge\n  model: fable\n";
    const controlDir = globalWith(TIERS);
    const controlRepo = makeRepo({ "keep.txt": "x" });
    writeRepo(controlRepo, controlText);
    const controlEditor = await openEditor(controlRepo, controlDir, stamp(controlRepo));
    const control = review(controlEditor.props, {
      selectedMode: "staff-led",
      judgeSeat: { adapter: "fake", model: "fake-1" },
    });
    expect(control.kind).toBe("diff");
    if (control.kind !== "diff") return;
    const controlNotes = control.notes?.join("\n") ?? "";
    expect(controlNotes).toContain(`routing.mode at .tickmarkr/config.yaml:${lineOf(controlText, "mode:")}`);
    expect(controlNotes).toContain(`judge at .tickmarkr/config.yaml:${lineOf(controlText, "judge:")}`);
    expect(controlNotes).toContain("the file is tracked");
    expect(controlNotes).toContain("Fleet never commits");
    expect(controlNotes).not.toContain("routing.allow/deny membership");

    const memberDir = globalWith(`${TIERS}routing:\n  deny:\n    models: [fake:fake-1]\n`);
    const memberRepo = makeRepo({ "keep.txt": "x" });
    writeRepo(memberRepo, "routing:\n  deny:\n    models: [fake:fake-2]\n");
    const memberEditor = await openEditor(memberRepo, memberDir, stamp(memberRepo));
    const member = review(memberEditor.props, { denyModels: ["fake:fake-2", "fake:fake-3"] });
    expect(member.kind).toBe("diff");
    if (member.kind !== "diff") return;
    const memberNotes = member.notes?.join("\n") ?? "";
    expect(member.path).toBe(repoFile(memberRepo));
    expect(memberNotes).toContain("routing.allow/deny membership");
    expect(memberNotes).toContain("the file is tracked");
    expect(memberNotes).not.toContain("routing.mode at");
    expect(memberNotes).not.toContain("judge at");

    const mixedText = [
      "routing:",
      "  mode: risk-based",
      "  deny:",
      "    models: [fake:fake-2]",
      "review:",
      "  prefer: [codex]",
      "consult:",
      "  prefer: [fake:fake-2]",
      "judge:",
      "  adapter: claude-code",
      "  model: fable",
      "",
    ].join("\n");
    const mixedDir = globalWith(`${TIERS}routing:\n  deny:\n    models: [fake:fake-1]\n`);
    const mixedRepo = makeRepo({ "keep.txt": "x" });
    writeRepo(mixedRepo, mixedText);
    const mixedLines = mixedText.split("\n");
    const lineNo = (needle: string, from = 0) => mixedLines.findIndex((line, index) => index >= from && line.includes(needle)) + 1;
    const modeLine = lineNo("mode:");
    const reviewPreferLine = lineNo("prefer:");
    const consultPreferLine = lineNo("prefer:", reviewPreferLine);
    const judgeLine = lineNo("judge:");
    const mixedEditor = await openEditor(mixedRepo, mixedDir, stamp(mixedRepo));
    const mixed = review(mixedEditor.props, {
      selectedMode: "staff-led",
      denyModels: ["fake:fake-2", "fake:fake-3"],
      steering: { review: ["fake"], consult: ["fake:fake-1"] },
      judgeSeat: { adapter: "fake", model: "fake-1" },
    });
    expect(mixed.kind).toBe("diff");
    if (mixed.kind !== "diff") return;
    const mixedNotes = mixed.notes?.join("\n") ?? "";
    expect(mixed.path).toBe(repoFile(mixedRepo));
    expect(mixedNotes).toContain("routing.allow/deny membership");
    expect(mixedNotes).toContain(`routing.mode at .tickmarkr/config.yaml:${modeLine}`);
    expect(mixedNotes).toContain(`review.prefer at .tickmarkr/config.yaml:${reviewPreferLine}`);
    expect(mixedNotes).toContain(`consult.prefer at .tickmarkr/config.yaml:${consultPreferLine}`);
    expect(mixedNotes).toContain(`judge at .tickmarkr/config.yaml:${judgeLine}`);
    expect(mixedNotes).toContain("the file is tracked");
  });

  test("a repository control beneath an alias parent is refused at that line without replacing sibling settings", async () => {
    const cases: Array<{
      name: string;
      repoYaml: string;
      userYaml: string;
      over: (props: Editor["props"]) => Partial<ReviewState>;
    }> = [
      {
        name: "routing.mode",
        repoYaml: "routingKey: &routingKey routing\n*routingKey :\n  mode: risk-based\n  deny:\n    models: [fake:fake-2]\n",
        userYaml: TIERS,
        over: () => ({ selectedMode: "staff-led" }),
      },
      {
        name: "review.prefer",
        repoYaml: "reviewKey: &reviewKey review\n*reviewKey :\n  policy: full\n  prefer: [codex]\n",
        userYaml: TIERS,
        over: (props) => ({ steering: { ...props.initialSteering, review: ["fake"] } }),
      },
      {
        name: "review.prefer clear",
        repoYaml: "reviewKey: &reviewKey review\n*reviewKey :\n  policy: full\n  prefer: [codex]\n",
        userYaml: `${TIERS}review:\n  prefer: [fake]\n`,
        over: (props) => ({ steering: { ...props.initialSteering, review: undefined } }),
      },
      {
        name: "consult.prefer",
        repoYaml: "consultKey: &consultKey consult\n*consultKey :\n  stallMinutes: 20\n  prefer: [fake:fake-2]\n",
        userYaml: TIERS,
        over: (props) => ({ steering: { ...props.initialSteering, consult: ["fake:fake-1"] } }),
      },
    ];
    for (const row of cases) {
      const globalDir = globalWith(row.userYaml);
      const repo = makeRepo({ "keep.txt": "x" });
      writeRepo(repo, row.repoYaml);
      const before = loadConfigWithMode(repo, { globalDir });
      const editor = await openEditor(repo, globalDir, stamp(repo));
      const staged = review(editor.props, row.over(editor.props));
      expect(staged.kind, row.name).toBe("refused");
      if (staged.kind === "refused") {
        expect(staged.reason, row.name).toContain("YAML alias parent key");
        expect(staged.reason, row.name).toContain(`.tickmarkr/config.yaml:2`);
      }
      expect(readFileSync(repoFile(repo), "utf8"), row.name).toBe(row.repoYaml);
      expect(readFileSync(userFile(globalDir), "utf8"), row.name).toBe(row.userYaml);
      expect(loadConfigWithMode(repo, { globalDir }), row.name).toEqual(before);
      expect(existsSync(`${repoFile(repo)}.tmp`), row.name).toBe(false);
      expect(existsSync(`${userFile(globalDir)}.tmp`), row.name).toBe(false);
    }
  });

  test("a scalar alias key is the control it resolves to, at the alias line, and a merge sequence keeps the first source's parent mapping", async () => {
    const aliasCase = async (repoYaml: string, aliasNeedle: string, over: Partial<ReviewState>, resolved: (repo: string, globalDir: string) => unknown) => {
      const globalDir = globalWith(TIERS);
      const userBefore = readFileSync(userFile(globalDir), "utf8");
      const repo = makeRepo({ "keep.txt": "x" });
      writeRepo(repo, repoYaml);
      const editor = await openEditor(repo, globalDir, stamp(repo));
      const staged = review(editor.props, over);
      expect(staged.kind).toBe("diff");
      if (staged.kind !== "diff") return;
      expect(staged.path).toBe(repoFile(repo));
      const notes = staged.notes?.join("\n") ?? "";
      expect(notes).toContain(`.tickmarkr/config.yaml:${lineOf(repoYaml, aliasNeedle)}`);
      expect(notes).not.toContain(`.tickmarkr/config.yaml:${lineOf(repoYaml, `${aliasNeedle.slice(1)}:`)}`);
      expect(commitDiff(editor, staged)).toBe(`fleet: wrote ${repoFile(repo)}`);
      expect(readFileSync(userFile(globalDir), "utf8")).toBe(userBefore);
      expect(readFileSync(repoFile(repo), "utf8")).toContain(aliasNeedle);
      expect(resolved(repo, globalDir)).toEqual(expect.anything());
      return { repo, globalDir, userBefore };
    };

    const mode = await aliasCase(
      "modeKey: &modeKey mode\nrouting:\n  *modeKey : risk-based  # repository mode\n",
      "*modeKey",
      { selectedMode: "staff-led" },
      (repo, globalDir) => loadConfigWithMode(repo, { globalDir }).mode.mode,
    );
    expect(mode && loadConfigWithMode(mode.repo, { globalDir: mode.globalDir }).mode.mode).toBe("staff-led");
    expect(mode && loadConfigWithMode(makeRepo({ "keep.txt": "y" }), { globalDir: mode.globalDir }).mode.mode).toBe("risk-based");
    expect(mode && readFileSync(repoFile(mode.repo), "utf8")).toContain("# repository mode");

    const reviewPick = await aliasCase(
      "preferKey: &preferKey prefer\nreview:\n  *preferKey : [codex]  # repository reviewers\n",
      "*preferKey",
      { steering: { review: ["fake"], consult: undefined } },
      (repo, globalDir) => loadConfig(repo, { globalDir }).review.prefer,
    );
    expect(reviewPick && loadConfig(reviewPick.repo, { globalDir: reviewPick.globalDir }).review.prefer).toEqual(["fake"]);
    expect(reviewPick && readFileSync(userFile(reviewPick.globalDir), "utf8")).toBe(reviewPick.userBefore);

    const consultPick = await aliasCase(
      "preferKey: &preferKey prefer\nconsult:\n  *preferKey : [fake:fake-2]\n",
      "*preferKey",
      { steering: { review: undefined, consult: ["fake:fake-1"] } },
      (repo, globalDir) => loadConfig(repo, { globalDir }).consult.prefer,
    );
    expect(consultPick && loadConfig(consultPick.repo, { globalDir: consultPick.globalDir }).consult.prefer).toEqual(["fake:fake-1"]);

    const judgePick = await aliasCase(
      "judgeKey: &judgeKey judge\n*judgeKey :\n  adapter: claude-code  # repository judge\n  model: fable\n",
      "*judgeKey",
      { judgeSeat: { adapter: "fake", model: "fake-1" } },
      (repo, globalDir) => loadConfig(repo, { globalDir }).judge,
    );
    expect(judgePick && loadConfig(judgePick.repo, { globalDir: judgePick.globalDir }).judge).toMatchObject({ adapter: "fake", model: "fake-1" });
    expect(judgePick && loadConfig(makeRepo({ "keep.txt": "z" }), { globalDir: judgePick.globalDir }).judge.model).toBe("fable");
    expect(judgePick && readFileSync(repoFile(judgePick.repo), "utf8")).toContain("# repository judge");

    const shadowed = [
      "%YAML 1.1",
      "---",
      "siblings: &siblings",
      "  review:",
      "    policy: full",
      "  consult:",
      "    stallMinutes: 20",
      "  routing:",
      "    deny:",
      "      models: []",
      "seat: &seat",
      "  review:",
      "    prefer: [codex]",
      "  consult:",
      "    prefer: [fake:fake-2]",
      "  routing:",
      "    mode: risk-based",
      "<<: [*siblings, *seat]",
      "",
    ].join("\n");
    const shadowDir = globalWith(TIERS);
    const shadowRepo = makeRepo({ "keep.txt": "x" });
    writeRepo(shadowRepo, shadowed);
    const shadowEditor = await openEditor(shadowRepo, shadowDir, stamp(shadowRepo));
    for (const over of [
      { steering: { ...shadowEditor.props.initialSteering, review: ["fake"] } },
      { steering: { ...shadowEditor.props.initialSteering, consult: ["fake:fake-1"] } },
      { selectedMode: "staff-led" as const },
    ]) {
      const staged = review(shadowEditor.props, over);
      expect(staged.kind).toBe("diff");
      if (staged.kind === "diff") expect(staged.path).toBe(userFile(shadowDir));
    }
    const shadowReview = review(shadowEditor.props, {
      steering: { ...shadowEditor.props.initialSteering, review: ["fake"] },
    });
    expect(commitDiff(shadowEditor, shadowReview)).toBe(`fleet: wrote ${userFile(shadowDir)}`);
    expect(readFileSync(repoFile(shadowRepo), "utf8")).toBe(shadowed);
    expect(parse(readFileSync(userFile(shadowDir), "utf8")).review.prefer).toEqual(["fake"]);

    const firstWins = [
      "%YAML 1.1",
      "---",
      "siblings: &siblings",
      "  review:",
      "    policy: full",
      "seat: &seat",
      "  review:",
      "    prefer: [codex]",
      "<<: [*seat, *siblings]",
      "",
    ].join("\n");
    const firstDir = globalWith(TIERS);
    const firstUser = readFileSync(userFile(firstDir), "utf8");
    const firstRepo = makeRepo({ "keep.txt": "x" });
    writeRepo(firstRepo, firstWins);
    const firstEditor = await openEditor(firstRepo, firstDir, stamp(firstRepo));
    const firstEdit = review(firstEditor.props, {
      steering: { ...firstEditor.props.initialSteering, review: ["fake"] },
    });
    expect(firstEdit.kind).toBe("refused");
    if (firstEdit.kind === "refused") {
      expect(firstEdit.reason).toContain("<<: [*seat, *siblings]");
      expect(firstEdit.reason).toContain(`.tickmarkr/config.yaml:${lineOf(firstWins, "<<:")}`);
    }
    expect(readFileSync(repoFile(firstRepo), "utf8")).toBe(firstWins);
    expect(readFileSync(userFile(firstDir), "utf8")).toBe(firstUser);
  }, 60_000);
});
