import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement, type ReactNode } from "react";
import { describe, expect, test } from "vitest";
import {
  BANNER,
  GLYPHS,
  PLAIN_BANNER,
} from "../../src/brand.js";
import {
  loadConfigWithMode,
  unifiedYamlDiff,
} from "../../src/config/config.js";
import { JournalRowPanel } from "../../src/tui/cockpit/components.js";
import {
  deriveSetupCockpitData,
  SetupCockpitFrame,
} from "../../src/tui/cockpit/setup-cockpit.js";
import { loadDemoCaptures } from "../../src/tui/cockpit/demo.js";

const SOURCES = join(import.meta.dirname, "../fixtures/cockpit/sources");
const CAPTURE_FILES = readdirSync(SOURCES)
  .filter((name) => name !== "README.md")
  .sort();
const stripAnsi = (value: string) =>
  value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

async function renderComponent(node: ReactNode, columns = 150): Promise<string> {
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  output.isTTY = true;
  output.columns = columns;
  output.rows = 60;
  const writes: string[] = [];
  const write = output.write.bind(output);
  output.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as typeof output.write;

  let painted!: () => void;
  const firstPaint = new Promise<void>((resolve) => {
    painted = resolve;
  });
  const app = render(node, {
    stdout: output as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    onRender: painted,
  });
  await firstPaint;
  const frame = stripAnsi(writes.at(-1) ?? "").trimEnd();
  app.unmount();
  return frame;
}

async function loadFrame(binaryVersion = "9.8.7") {
  const captures = loadDemoCaptures();
  const data = deriveSetupCockpitData(captures, binaryVersion);
  const frame = await renderComponent(createElement(SetupCockpitFrame, {
    data,
    columns: 150,
  }));
  return { captures, data, frame };
}

function independentlyResolvedConfig() {
  const root = mkdtempSync(join(tmpdir(), "tickmarkr-setup-cockpit-"));
  const globalDir = join(root, "global");
  const repoRoot = join(root, "repo");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(join(repoRoot, ".tickmarkr"), { recursive: true });
  writeFileSync(
    join(globalDir, "config.yaml"),
    readFileSync(join(SOURCES, "config.global.yaml"), "utf8"),
  );
  writeFileSync(
    join(repoRoot, ".tickmarkr", "config.yaml"),
    readFileSync(join(SOURCES, "config.repo.yaml"), "utf8"),
  );
  return loadConfigWithMode(repoRoot, { globalDir }).cfg;
}

function independentlyCountedDoctor() {
  const doctor = JSON.parse(
    readFileSync(join(SOURCES, "doctor.json"), "utf8"),
  ) as Record<string, {
    installed?: boolean;
    authed?: boolean;
    modelAuth?: Record<string, { authed?: boolean }>;
  }>;
  const harnesses = Object.entries(doctor).filter(([id]) => id !== "autoPrefer");
  return {
    found: harnesses.length,
    authenticated: harnesses.filter(([, health]) =>
      health.installed === true && health.authed === true
    ).length,
    routable: harnesses.filter(([, health]) =>
      health.installed === true
      && health.authed === true
      && Object.values(health.modelAuth ?? {}).some((model) => model.authed === true)
    ).length,
  };
}

describe("setup cockpit capture-backed surface", () => {
  test("test: every section the contract names for the setup surface renders, and the guided step indicator states the current position within the traversal", async () => {
    const { frame } = await loadFrame();

    for (const section of [
      "HARNESSES",
      "DETECTED",
      "OVERLAY DIFF",
      "FLEET",
      "GATES",
      "CONSULTS",
      "REVIEWERS",
      "REVIEW",
    ]) {
      expect(frame).toContain(section);
    }
    expect(frame).toMatch(/\bsetup · step 2\/6\b/);
  });

  test("test: the setup surface heads itself with the full four-line mark taken from the brand module, matching that module's constant for the colour mode in force rather than the compact lockup or art drawn in the surface", async () => {
    const { frame } = await loadFrame();
    const fullMark = stripAnsi(BANNER).trimEnd();

    expect(fullMark).toBe(PLAIN_BANNER.trimEnd());
    expect(fullMark.split("\n")).toHaveLength(4);
    for (const line of fullMark.split("\n")) expect(frame).toContain(line);
  });

  test("test: each detected harness renders its state as a glyph together with a word, and a denied channel renders its reason inline", async () => {
    const { data, frame } = await loadFrame();

    for (const harness of data.harnesses) {
      const glyph = harness.state === "pass" ? GLYPHS.pass
        : harness.state === "fail" ? GLYPHS.fail
          : GLYPHS.toggleInactive;
      expect(frame).toContain(harness.id);
      expect(frame).toMatch(new RegExp(`${glyph}\\s+${harness.stateWord}`));
    }
    expect(data.deniedChannels.length).toBeGreaterThan(0);
    for (const denied of data.deniedChannels) {
      expect(frame).toContain(`${GLYPHS.fail} denied`);
      expect(frame).toContain(denied.channel);
      expect(frame).toContain(denied.reason);
    }
  });

  test("test: the found, authenticated and routable tiles each equal the count independently derived from the captured detection cache", async () => {
    const { data, frame } = await loadFrame();
    const expected = independentlyCountedDoctor();

    expect(data.counts).toEqual(expected);
    expect(frame).toMatch(new RegExp(`FOUND[\\s\\S]*?${expected.found}`));
    expect(frame).toMatch(new RegExp(`AUTHENTICATED[\\s\\S]*?${expected.authenticated}`));
    expect(frame).toMatch(new RegExp(`ROUTABLE[\\s\\S]*?${expected.routable}`));
  });

  test("test: the fleet, gates, consults and reviewers sections show the values the captured configuration pair actually resolves to rather than built-in defaults", async () => {
    const { data, frame } = await loadFrame();
    const expected = independentlyResolvedConfig();

    expect(data.config).toEqual(expected);
    expect(frame).toContain(`mode ${expected.routing.mode}`);
    expect(frame).toContain(`implement:${expected.routing.floors.implement}`);
    expect(frame).toContain(`test ${expected.gates.test}`);
    expect(frame).toContain(`diff cap ${expected.gates.diffCap}`);
    expect(frame).toContain(`seat ${expected.consult.adapter}:${expected.consult.model}`);
    for (const seat of expected.consult.prefer ?? []) expect(frame).toContain(seat);
    expect(frame).toContain(`required ${String(expected.review.required)}`);
    for (const reviewer of expected.review.prefer ?? []) expect(frame).toContain(reviewer);
  });

  test("test: the overlay difference is produced by the product's existing configuration diff renderer over the captured pair rather than by a second differ written for the surface", async () => {
    const { captures, data, frame } = await loadFrame();
    const expected = unifiedYamlDiff(
      captures.config.global.raw,
      captures.config.repo.raw,
      captures.config.repo.fileName,
    );

    expect(data.overlayDiff).toBe(expected);
    expect(frame).toContain(`--- ${captures.config.repo.fileName} (current)`);
    expect(frame).toContain(`+++ ${captures.config.repo.fileName} (proposed)`);
    expect(frame).toContain("+gates:");
  });

  test("test: the status strip names the overlay target, states that the base is untouched, and reports an unsaved count equal to the number of staged changes", async () => {
    const { captures, data, frame } = await loadFrame();

    expect(data.stagedChanges.length).toBeGreaterThan(0);
    expect(frame).toContain(`overlay ${captures.config.repo.fileName}`);
    expect(frame).toContain("base untouched");
    expect(frame).toContain(`${data.stagedChanges.length} changes unsaved`);
  });

  test("test: the review section renders through the same journal row panel component the run cockpit uses", async () => {
    const { data, frame } = await loadFrame();
    const journal = await renderComponent(createElement(JournalRowPanel, {
      rows: data.reviewRows,
      title: "REVIEW",
      width: 70,
    }), 70);

    expect(data.reviewRows.length).toBeGreaterThan(0);
    for (const row of data.reviewRows) {
      expect(frame).toContain(row.text);
      expect(journal).toContain(row.text);
    }
  });

  test("test: the nav column lists its contracted section entries and marks the current one, which is a separate signal from the guided step indicator in the header", async () => {
    const { frame } = await loadFrame();

    for (const entry of [
      "Detect",
      "Harnesses",
      "Fleet",
      "Gates",
      "Consults",
      "Reviewers",
      "Review",
    ]) {
      expect(frame).toContain(entry);
    }
    expect(frame).toMatch(/❯\s+Harnesses/);
    expect(frame).toMatch(/\bsetup · step 2\/6\b/);
  });

  test("the setup surface writes no configuration and re-probes nothing", async () => {
    const before = Object.fromEntries(CAPTURE_FILES.map((fileName) => [
      fileName,
      readFileSync(join(SOURCES, fileName), "utf8"),
    ]));
    const source = readFileSync(
      join(import.meta.dirname, "../../src/tui/cockpit/setup-cockpit.tsx"),
      "utf8",
    );

    await loadFrame();

    const after = Object.fromEntries(CAPTURE_FILES.map((fileName) => [
      fileName,
      readFileSync(join(SOURCES, fileName), "utf8"),
    ]));
    expect(after).toEqual(before);
    expect(source).not.toMatch(
      /\b(writeFile|rename|confirmSave|buildSaveProposal|readDoctor|probeAll|allAdapters)\b/,
    );
  });

  test("the review section reuses the run cockpit's journal panel rather than carrying a second implementation of one", () => {
    const source = readFileSync(
      join(import.meta.dirname, "../../src/tui/cockpit/setup-cockpit.tsx"),
      "utf8",
    );

    expect(source).toContain("JournalRowPanel");
    expect(source.match(/JournalRowPanel/g)?.length).toBe(2);
    expect(source).not.toMatch(/function\s+\w*Journal\w*Panel/);
  });
});
