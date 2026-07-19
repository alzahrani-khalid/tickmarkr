import { existsSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const { mockQuestion, mockCreateInterface } = vi.hoisted(() => {
  const mockQuestion = vi.fn();
  const mockCreateInterface = vi.fn(() => ({ question: mockQuestion, close: vi.fn() }));
  return { mockQuestion, mockCreateInterface };
});

vi.mock("node:readline/promises", () => ({ createInterface: mockCreateInterface }));

import * as registry from "../../src/adapters/registry.js";
import { BANNER, legend, rule, statusRow, title } from "../../src/brand.js";
import { init } from "../../src/cli/commands/init.js";
import { configTemplate, loadConfig } from "../../src/config/config.js";
import { tickmarkrDir, stateDirName } from "../../src/graph/graph.js";
import { Journal } from "../../src/run/journal.js";
import { makeRepo } from "../helpers/tmprepo.js";

const ROOT = join(import.meta.dirname, "../..");
const skill = (name: string) => readFileSync(join(ROOT, "skills", name, "SKILL.md"));
const runInit = (repo: string, ...args: string[]) =>
  init(["--global-dir", mkdtempSync(join(tmpdir(), "tickmarkr-init-global-")), ...args], repo);

const stampDoctor = (repo: string, ageMs: number) => {
  registry.writeDoctor(repo, { fake: { installed: true, authed: true, models: [] } });
  const when = new Date(Date.now() - ageMs);
  utimesSync(join(tickmarkrDir(repo), "doctor.json"), when, when);
};

afterEach(() => vi.restoreAllMocks());

const withTTY = async (fn: () => Promise<void>) => {
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const noColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    await fn();
  } finally {
    if (noColor !== undefined) process.env.NO_COLOR = noColor;
    else delete process.env.NO_COLOR;
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
};

const withoutTTY = async (fn: () => Promise<void>) => {
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  try {
    await fn();
  } finally {
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
};

const mockWizardAnswers = (...answers: string[]) => {
  mockQuestion.mockReset();
  for (const a of answers) mockQuestion.mockResolvedValueOnce(a);
  return mockQuestion;
};

describe("tickmarkr init doctor.json reuse (T1)", () => {
  test("reuses a doctor.json stamped 5 minutes ago and skips model probes", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const probeModelsSpy = vi.spyOn(registry, "probeModels").mockResolvedValue();
    const probeAllSpy = vi.spyOn(registry, "probeAll");
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);

    const out = await runInit(repo);

    expect(probeModelsSpy).not.toHaveBeenCalled();
    expect(probeAllSpy).not.toHaveBeenCalled();
    expect(out).toMatch(/using probe results from 5m ago — run tickmarkr doctor to refresh \(or init --fresh\)/);
    expect(out).toContain("tickmarkr doctor — capability matrix:");
    // fresh repo ⇒ active state dir is .tickmarkr; doctor output must never name the legacy state dir
    expect(out).toContain(".tickmarkr");
    expect(out).not.toContain(`.${["dro", "vr"].join("")}`);
  });

  test("init --fresh probes even with a fresh doctor.json", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const probeModelsSpy = vi.spyOn(registry, "probeModels").mockResolvedValue();
    vi.spyOn(registry, "probeAll").mockResolvedValue({});
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);

    await runInit(repo, "--fresh");

    expect(probeModelsSpy).toHaveBeenCalled();
  });

  test("init with doctor.json older than 60 minutes re-probes", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const probeModelsSpy = vi.spyOn(registry, "probeModels").mockResolvedValue();
    vi.spyOn(registry, "probeAll").mockResolvedValue({});
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 70 * 60 * 1000);

    await runInit(repo);

    expect(probeModelsSpy).toHaveBeenCalled();
  });
});

describe("tickmarkr init", () => {
  test("writes tickmarkr.spec.md when only a legacy spec filename exists", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const legacySpec = `${["dro", "vr"].join("")}.spec.md`;
    const legacy = "<!-- tickmarkr:spec -->\n## T1: kept\n- acceptance:\n  - kept\n";
    const repo = makeRepo({ [legacySpec]: legacy });

    const out = await runInit(repo);

    expect(existsSync(join(repo, "tickmarkr.spec.md"))).toBe(true);
    expect(readFileSync(join(repo, "tickmarkr.spec.md"), "utf8")).toMatch(/^<!-- tickmarkr:spec -->/);
    expect(readFileSync(join(repo, legacySpec), "utf8")).toBe(legacy);
    expect(out).toContain(`wrote ${join(repo, "tickmarkr.spec.md")}`);
  });
});

describe("tickmarkr init --agent", () => {
  test("installs both shipped skills byte-for-byte and appends marked CLAUDE.md docs with --docs", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const original = "# Consumer instructions\n\nKeep this text exactly.\n";
    const repo = makeRepo({ "CLAUDE.md": original });

    const out = await runInit(repo, "--agent", "--docs");

    expect(readFileSync(join(repo, ".agents/skills/tickmarkr-loop/SKILL.md"))).toEqual(skill("tickmarkr-loop"));
    expect(readFileSync(join(repo, ".agents/skills/tickmarkr-auto/SKILL.md"))).toEqual(skill("tickmarkr-auto"));
    const docs = readFileSync(join(repo, "CLAUDE.md"), "utf8");
    expect(docs.startsWith(original)).toBe(true);
    expect(docs).toContain("<!-- tickmarkr:agent-docs begin -->");
    expect(docs).toContain("<!-- tickmarkr:agent-docs end -->");
    expect(docs).toMatch(/tickmarkr compile.*tickmarkr plan.*tickmarkr run.*tickmarkr report/s);
    expect(docs).toMatch(/Never run two tickmarkr runs/);
    expect(docs).toMatch(/never trust a worker's completion claim/i);
    expect(out).toContain("appended tickmarkr agent docs");
  });

  test("non-TTY keeps an existing skill and docs, installs the missing skill, and names opt-in flags", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({
      ".claude/skills/tickmarkr-loop/SKILL.md": "consumer-owned skill\n",
      "CLAUDE.md": "consumer-owned docs\n",
    });

    let out: string;
    await withoutTTY(async () => {
      out = await runInit(repo, "--agent");
    });

    expect(readFileSync(join(repo, ".claude/skills/tickmarkr-loop/SKILL.md"), "utf8")).toBe("consumer-owned skill\n");
    expect(readFileSync(join(repo, ".claude/skills/tickmarkr-auto/SKILL.md"))).toEqual(skill("tickmarkr-auto"));
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe("consumer-owned docs\n");
    expect(out!).toMatch(/skipped existing .*tickmarkr-loop\/SKILL\.md.*--force/);
    expect(out!).toMatch(/skipped agent docs .*CLAUDE\.md.*--docs/);
    expect(out!).toContain("tickmarkr doctor");
  });

  test("--force replaces existing skill files and --docs writes each host's paired guidance file", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const original = "# Agent instructions\n\nKeep this text exactly.\n";
    const repo = makeRepo({
      ".claude/skills/tickmarkr-auto/SKILL.md": "old skill\n",
      "AGENTS.md": original,
    });

    await runInit(repo, "--agent", "--force", "--docs");

    expect(readFileSync(join(repo, ".claude/skills/tickmarkr-loop/SKILL.md"))).toEqual(skill("tickmarkr-loop"));
    expect(readFileSync(join(repo, ".claude/skills/tickmarkr-auto/SKILL.md"))).toEqual(skill("tickmarkr-auto"));
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toMatch(/^# Agent instructions\n\nKeep this text exactly\.\n[\s\S]*tickmarkr:agent-docs begin/);
    // the claude host location was written, so its paired CLAUDE.md gets the guidance block too
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toContain("<!-- tickmarkr:agent-docs begin -->");
  });
});

describe("tickmarkr init wizard (T4)", () => {
  test("wizard answers land as uncommented keys in the repo overlay and loadConfig resolves them", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);
    const question = mockWizardAnswers("herdr", "5", "pane", "n");

    await withTTY(async () => {
      await runInit(repo);
    });

    const cfgText = readFileSync(join(tickmarkrDir(repo), "config.yaml"), "utf8");
    expect(cfgText).toMatch(/^concurrency: 5$/m);
    expect(cfgText).toMatch(/^driver: herdr$/m);
    expect(cfgText).toMatch(/^  llm: pane$/m);
    expect(loadConfig(repo)).toMatchObject({ concurrency: 5, driver: "herdr", visibility: { llm: "pane" } });
    expect(question).toHaveBeenCalledTimes(4);
  });

  test("a yes to the skills question installs skills exactly as init --agent does; a no leaves the repo untouched", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const yesRepo = makeRepo({ "keep.txt": "x" });
    const noRepo = makeRepo({ "keep.txt": "x" });
    stampDoctor(yesRepo, 5 * 60 * 1000);
    stampDoctor(noRepo, 5 * 60 * 1000);
    mockWizardAnswers("", "", "", "yes", "n");
    await withTTY(async () => {
      await runInit(yesRepo);
    });
    expect(readFileSync(join(yesRepo, ".agents/skills/tickmarkr-loop/SKILL.md"))).toEqual(skill("tickmarkr-loop"));
    expect(readFileSync(join(yesRepo, ".agents/skills/tickmarkr-auto/SKILL.md"))).toEqual(skill("tickmarkr-auto"));

    mockWizardAnswers("", "", "", "no");
    await withTTY(async () => {
      await runInit(noRepo);
    });
    expect(existsSync(join(noRepo, ".claude"))).toBe(false);
  });

  test("the skills question is not asked when the skills already exist at every applicable location", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo(Object.fromEntries(
      ["tickmarkr-loop", "tickmarkr-auto", "tickmarkr-overseer"].flatMap((s) => [
        [`.agents/skills/${s}/SKILL.md`, "installed\n"],
        [`.claude/skills/${s}/SKILL.md`, "installed\n"],
      ]),
    ));
    stampDoctor(repo, 5 * 60 * 1000);
    const question = mockWizardAnswers("", "", "");

    await withTTY(async () => {
      await runInit(repo);
    });

    expect(question).toHaveBeenCalledTimes(3);
    expect(question.mock.calls.every((c) => !String(c[0]).includes("skills"))).toBe(true);
  });

  test("non-TTY init writes the plain template, asks nothing, installs no skills (CI-safe)", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);
    mockCreateInterface.mockClear();

    await withoutTTY(async () => {
      await runInit(repo);
    });

    expect(readFileSync(join(tickmarkrDir(repo), "config.yaml"), "utf8")).toBe(configTemplate());
    expect(mockCreateInterface).not.toHaveBeenCalled();
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    // no pre-existing state dir ⇒ init scaffolds .tickmarkr, never .tickmarkr
    expect(stateDirName(repo)).toBe(".tickmarkr");
    expect(existsSync(join(repo, ".tickmarkr", "config.yaml"))).toBe(true);
  });

  test("init on a repo with an existing .tickmarkr/config.yaml keeps it byte-identical", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const overlay = "concurrency: 9\ndriver: subprocess\n";
    const repo = makeRepo({ ".tickmarkr/config.yaml": overlay });
    stampDoctor(repo, 5 * 60 * 1000);
    const question = mockWizardAnswers("herdr", "5", "pane", "yes");

    await withTTY(async () => {
      await runInit(repo);
    });

    expect(readFileSync(join(repo, ".tickmarkr/config.yaml"), "utf8")).toBe(overlay);
    expect(question).not.toHaveBeenCalled();
  });

  test("pressing Enter through every default writes uncommented defaults", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);
    const herdr = process.env.HERDR_ENV;
    delete process.env.HERDR_ENV;
    mockWizardAnswers("", "", "", "");

    try {
      await withTTY(async () => {
        await runInit(repo);
      });
      const cfg = loadConfig(repo);
      expect(cfg.concurrency).toBe(3);
      expect(cfg.driver).toBe("auto");
      expect(cfg.visibility.llm).toBe("headless");
    } finally {
      if (herdr !== undefined) process.env.HERDR_ENV = herdr;
    }
  });
});

// Acceptance criterion titles must match the graph oracle filters EXACTLY (vitest -t is a regex;
// do not put glob/regex metacharacters like specs/*.spec.md into the title).
describe("T4 init closing block", () => {
  test("init names the spec file it actually wrote or kept in its closing block", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const wroteRepo = makeRepo({ "keep.txt": "x" });
    stampDoctor(wroteRepo, 5 * 60 * 1000);
    const wroteOut = await runInit(wroteRepo);
    expect(wroteOut).toMatch(/next: edit tickmarkr\.spec\.md, then tickmarkr compile tickmarkr\.spec\.md/);
    expect(wroteOut).toContain(`wrote ${join(wroteRepo, "tickmarkr.spec.md")}`);

    const keptRepo = makeRepo({
      "tickmarkr.spec.md": "<!-- tickmarkr:spec -->\n## T1: kept\n- acceptance:\n  - kept\n",
    });
    stampDoctor(keptRepo, 5 * 60 * 1000);
    const keptOut = await runInit(keptRepo);
    expect(keptOut).toMatch(/next: edit tickmarkr\.spec\.md, then tickmarkr compile tickmarkr\.spec\.md/);
    expect(keptOut).toContain(`kept existing ${join(keptRepo, "tickmarkr.spec.md")}`);
  });

  test("init points at existing specs when spec files already exist", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({
      "specs/v1.0-feature.spec.md": "<!-- tickmarkr:spec -->\n## T1: x\n- acceptance:\n  - x\n",
      "specs/v1.1-other.spec.md": "<!-- tickmarkr:spec -->\n## T1: y\n- acceptance:\n  - y\n",
    });
    stampDoctor(repo, 5 * 60 * 1000);

    const out = await runInit(repo);

    expect(out).toMatch(/next: existing specs under specs\//);
    expect(out).toContain("specs/v1.0-feature.spec.md");
    expect(out).toContain("specs/v1.1-other.spec.md");
    expect(out).toMatch(/tickmarkr compile <spec>/);
    expect(out).not.toMatch(/next: edit tickmarkr\.spec\.md/);
  });

  test("init with an active run prints the run id with a status suggestion and no compile suggestion", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);
    const runId = "run-20260717-120000";
    Journal.create(repo, runId).append("run-start", undefined, { pid: process.pid });

    const out = await runInit(repo);

    expect(out).toContain(`run ${runId} active — tickmarkr status`);
    expect(out).not.toMatch(/next:.*compile/);
    expect(out).not.toContain("tickmarkr compile");
  });

  test("the closing block prints the three-row environments footer", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);

    const out = await runInit(repo);

    expect(out).toContain("environments:");
    expect(out).toMatch(/herdr\s+—/);
    expect(out).toMatch(/claude code\s+—/);
    expect(out).toMatch(/anywhere\s+—/);
    expect(out).toContain(
      "the full cockpit — every worker, judge, and consult is a visible pane you can watch and unblock · https://herdr.dev",
    );
    expect(out).toContain(
      "tickmarkr init --agent installs the /tkr skills + AGENTS.md so Claude Code (or any agent CLI) drives the loop natively",
    );
    expect(out).toContain("no herdr? same fail-closed gates, headless subprocess driver");
  });

  test("the herdr footer row contains no npm install line", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);

    const out = await runInit(repo);
    const herdrLine = out.split("\n").find((l) => /^\s*herdr\s+—/.test(l)) ?? "";

    expect(herdrLine).toBeTruthy();
    expect(herdrLine).not.toMatch(/npm\s+i(?:nstall)?/i);
    expect(out).not.toMatch(/npm\s+i(?:nstall)?\s+[-g\s]*herdr/i);
  });
});

describe("T3 brand banner (TTY gate)", () => {
  test("TTY stdout emits the banner before the first prompt (wizard path)", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    mockWizardAnswers("", "", "", "n");

    await withTTY(async () => {
      await runInit(repo);
    });

    const bannerIdx = writes.findIndex((w) => w.includes("tickmarkr") && w.includes("spec in, verified work out."));
    expect(bannerIdx).toBeGreaterThanOrEqual(0);
    expect(writeSpy.mock.invocationCallOrder[bannerIdx]!).toBeLessThan(mockQuestion.mock.invocationCallOrder[0]!);
    writeSpy.mockRestore();
  });

  test("TTY stdout emits the banner at start when the wizard is skipped", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const overlay = "concurrency: 9\ndriver: subprocess\n";
    const repo = makeRepo({ ".tickmarkr/config.yaml": overlay });
    stampDoctor(repo, 5 * 60 * 1000);

    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    let out: string;
    await withTTY(async () => {
      out = await runInit(repo);
    });
    writeSpy.mockRestore();

    expect(writes.some((w) => w.includes("spec in, verified work out."))).toBe(true);
    expect(out!.startsWith(BANNER)).toBe(false); // the start write is the single emission — body stays banner-free
    expect(out!).toContain("wrote");
  });

  test("doctor and init read as the same visual system as the fleet editor with chrome dim and verdicts emphasized", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ ".tickmarkr/config.yaml": "concurrency: 3\n" });
    stampDoctor(repo, 5 * 60 * 1000);
    let out = "";
    let shared = { initTitle: "", notesLegend: "", frameRule: "", note: "", nextTitle: "" };

    await withTTY(async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        out = await runInit(repo);
        shared = {
          initTitle: title("tickmarkr init"),
          notesLegend: legend("· setup notes"),
          frameRule: rule(),
          note: statusRow("pass", `wrote ${join(repo, "tickmarkr.spec.md")}`),
          nextTitle: title("next steps"),
        };
      } finally {
        writeSpy.mockRestore();
      }
    });

    expect(out.startsWith(`${shared.initTitle}\n${shared.notesLegend}\n${shared.frameRule}`)).toBe(true);
    expect(out).toContain(shared.note);
    expect(out).toContain(`${shared.nextTitle}\n`);
    expect(out.split(shared.frameRule)).toHaveLength(3);
    expect(out).toContain("the full cockpit — every worker, judge, and consult is a visible pane you can watch and unblock · https://herdr.dev");
  });

  test("test: init non-tty output is byte-identical to before this change", async () => {
    vi.spyOn(registry, "allAdapters").mockReturnValue([]);
    const repo = makeRepo({ "keep.txt": "x" });
    stampDoctor(repo, 5 * 60 * 1000);

    let out: string;
    await withoutTTY(async () => {
      out = await runInit(repo);
    });

    expect(out!.startsWith(BANNER)).toBe(false);
    expect(out!).toMatch(/^wrote /);
    expect(out!).toContain("tickmarkr doctor — capability matrix:");
    expect(out!).not.toMatch(/\x1b\[/);
  });
});
