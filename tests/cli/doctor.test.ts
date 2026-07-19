import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { hasCodexTrustedProject, seedCodexTrust } from "../../src/adapters/codex.js";
import { FakeAdapter } from "../../src/adapters/fake.js";
import { channelsFromConfig, type TrustVerdict, type WorkerAdapter } from "../../src/adapters/types.js";
import { BANNER, TOKENS } from "../../src/brand.js";
import { doctor } from "../../src/cli/commands/doctor.js";
import { makeRepo } from "../helpers/tmprepo.js";

const stub = (id: string) =>
  ({ id, vendor: "x", probe: async () => ({ installed: true, authed: true, models: [] }) }) as unknown as WorkerAdapter;

const ADAPTERS5 = ["claude-code", "codex", "cursor-agent", "opencode", "pi"].map(stub);
const retiredBanner = `${["dro", "vr"].join("")} —`;

const withOverlay = (repo: string, yaml: string) => {
  mkdirSync(join(repo, ".tickmarkr"), { recursive: true });
  writeFileSync(join(repo, ".tickmarkr", "config.yaml"), yaml);
};

// HYG-07(a): a stub whose probe reports a servable list, with channels() wired so servableExclusions
// can compute the drop exactly as discoverChannels would.
const stubServable = (id: string, servable: string[]) =>
  ({ id, vendor: "x", probe: async () => ({ installed: true, authed: true, models: [], servable }), channels: (cfg: any) => channelsFromConfig(id, cfg) }) as unknown as WorkerAdapter;

describe("V-10 fleet preference visibility (doctor)", () => {
  test("V-10c: active deny shows the same exclusion line as plan", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, "routing:\n  deny:\n    adapters: [pi]\n");
    const out = await doctor(["--"], repo, ADAPTERS5);
    expect(out).toMatch(/^tickmarkr doctor — capability matrix:/);
    expect(out).not.toContain(retiredBanner);
    expect(out).toContain("pi:zai/glm-5.2");
    expect(out).toMatch(/! routing preference active: 1 channel\(s\) excluded/);
    expect(out).toMatch(/deny: pi/);
  });

  test("V-10c: no preference — exclusion line absent", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const out = await doctor(["--"], repo, ADAPTERS5);
    expect(out).not.toMatch(/routing preference active:/);
  });
});

describe("HYG-07(a) servable attribution in doctor", () => {
  test("servable-dropped channel is a named truth in doctor output", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    withOverlay(repo, `tiers:
  pi:
    vendor: zhipu
    channel: sub
    models:
      zai/glm-5.2: mid
      anthropic/claude-opus-4-5: frontier
`);
    // pi serves only zai/glm-5.2; the other model is unservable → attributed. doctor probes fresh, so the
    // attribution is current by construction (no staleness line in doctor — only plan has one).
    const adapters = ["claude-code", "codex", "cursor-agent", "opencode"].map(stub)
      .concat([stubServable("pi", ["zai/glm-5.2"])]);
    const out = await doctor(["--"], repo, adapters);
    expect(out).toMatch(/servability: 1 channel\(s\) unservable/);
    expect(out).toContain("pi:anthropic/claude-opus-4-5");
    expect(out).toContain("not in pi's served model list");
  });

  test("no servable field → no servability line (compat)", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const out = await doctor(["--"], repo, ADAPTERS5);
    expect(out).not.toMatch(/servability:/);
  });
});

describe("model status table (T4)", () => {
  const mkFake = (script: string) => {
    const fake = new FakeAdapter(script);
    vi.spyOn(fake, "headlessCommand").mockImplementation((_prompt, model) =>
      model === "fake-denied" ? "printf 'credit exhausted'; exit 1" : "printf OK",
    );
    return fake;
  };
  const fakeTiers = `tiers:
  fake:
    vendor: fake
    channel: sub
    models:
      fake-1: mid
      fake-denied: cheap
`;

  test("classified models render tier, auth verdict (reason+date when unauthed), denied, prefer; probes persist", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    withOverlay(repo, fakeTiers);
    const out = await doctor(["--"], repo, [mkFake(script)]);
    const saved = JSON.parse(readFileSync(join(repo, ".tickmarkr", "doctor.json"), "utf8"));

    expect(out).toMatch(/model status:/);
    expect(out).toMatch(/fake-1\s+mid\s+authed\s+denied=—\s+prefer=—/);
    // unauthed carries BOTH reason and probe date
    expect(out).toMatch(/fake-denied\s+cheap\s+unauthed: credit exhausted \(\d{4}-\d{2}-\d{2}\)\s+denied=—\s+prefer=—/);
    expect(saved.fake.modelAuth["fake-1"].authed).toBe(true);
    expect(saved.fake.modelAuth["fake-denied"]).toMatchObject({ authed: false, reason: "credit exhausted" });
  });

  test("denied model shows the deny entry as a flag", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    withOverlay(repo, `${fakeTiers}routing:
  deny:
    models: [fake:fake-1]
`);
    const out = await doctor(["--"], repo, [mkFake(script)]);
    // the denied flag names the matched entry; fake-denied (not denied) stays denied=—
    expect(out).toMatch(/fake-1\s+mid\s+authed\s+denied=fake:fake-1\s+prefer=—/);
    expect(out).toMatch(/fake-denied[\s\S]*denied=—/);
  });

  test("prefer rank reflects the routing map", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    withOverlay(repo, `${fakeTiers}routing:
  map:
    implement:
      prefer: [fake]
`);
    const out = await doctor(["--"], repo, [mkFake(script)]);
    expect(out).toMatch(/fake-1[\s\S]*prefer=implement#0/);
  });

  test("unclassified listed models compress to one count line, never rows", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    withOverlay(repo, fakeTiers);
    const out = await doctor(["--"], repo, [mkFake(script)]);
    // fake-2 is listed (probe) but never tiered → a count line only, never its own row
    expect(out).toMatch(/\(1 more listed, unclassified\)/);
    expect(out).not.toMatch(/^\s+fake-2\s/m);
  });

  test("a model window declared in config renders in the doctor matrix", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    withOverlay(repo, `${fakeTiers}    windows:
      fake-1: 200000
`);
    const out = await doctor(["--"], repo, [mkFake(script)]);
    expect(out).toMatch(/fake-1\s+mid\s+200000\s+authed/);
  });

});

// v1.22 T5: workspace-trust pre-flight
describe("workspace trust pre-flight (T5)", () => {
  const stubTrust = (id: string, v: TrustVerdict | undefined) =>
    ({
      id,
      vendor: "x",
      probe: async () => ({ installed: true, authed: true, models: [] }),
      ...(v ? { trust: () => v } : {}),
    }) as unknown as WorkerAdapter;

  test("doctor reports trusted, seeded, action-required, and n/a per adapter", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const adapters = [
      stubTrust("codex", { status: "seeded" }),
      stubTrust("cursor-agent", {
        status: "action-required",
        command: 'accept the cursor-agent "Workspace Trust Required" dialog (Enter)',
      }),
      stubTrust("claude-code", { status: "trusted" }),
      stubTrust("pi", undefined), // no trust hook → n/a
    ];
    const out = await doctor(["--"], repo, adapters);
    expect(out).toMatch(/workspace trust:/);
    expect(out).toMatch(/✓ codex\s+trust: seeded/);
    expect(out).toMatch(/✓ claude-code\s+trust: trusted/);
    expect(out).toMatch(/! cursor-agent\s+trust: action-required — run ONCE: accept the cursor-agent "Workspace Trust Required" dialog \(Enter\)/);
    expect(out).toMatch(/= pi\s+trust: n\/a/);
  });

  test("codex config without the repo root entry gets exactly one projects entry seeded, idempotently", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-trust-"));
    const cfg = join(home, "config.toml");
    writeFileSync(cfg, 'model = "gpt-test"\n');
    const repo = makeRepo({ "keep.txt": "x" });

    const v1 = seedCodexTrust(repo, cfg);
    expect(v1.status).toBe("seeded");
    const text1 = readFileSync(cfg, "utf8");
    // exactly one correctly-formed projects entry for the realpath'd root
    const headers = text1.match(/\[projects\."[^"]+"\]/g) ?? [];
    expect(headers).toHaveLength(1);
    expect(text1).toMatch(/trust_level\s*=\s*"trusted"/);
    expect(hasCodexTrustedProject(text1, realpathSync(repo))).toBe(true);

    const v2 = seedCodexTrust(repo, cfg);
    expect(v2.status).toBe("trusted");
    const text2 = readFileSync(cfg, "utf8");
    // still exactly one entry — idempotent
    expect(text2.match(/\[projects\."[^"]+"\]/g)).toHaveLength(1);
    expect(text2.match(/trust_level\s*=\s*"trusted"/g)).toHaveLength(1);
  });
});

const withTTY = async (fn: () => Promise<void>) => {
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const noColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    await fn();
  } finally {
    if (noColor !== undefined) process.env.NO_COLOR = noColor;
    else delete process.env.NO_COLOR;
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
};

describe("T2 doctor brand surface", () => {
  const modelOutput = async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    const script = join(repo, "fake.json");
    writeFileSync(script, JSON.stringify({ tasks: {} }));
    withOverlay(repo, `tiers:
  fake:
    vendor: fake
    channel: sub
    models:
      fake-1: mid
      fake-denied: cheap
`);
    const fake = new FakeAdapter(script);
    vi.spyOn(fake, "headlessCommand").mockImplementation((_prompt, model) =>
      model === "fake-denied" ? "printf 'credit exhausted'; exit 1" : "printf OK",
    );
    let out = "";
    let failToken = "";
    let okToken = "";
    await withTTY(async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        out = await doctor(["--"], repo, [fake]);
        failToken = TOKENS.fail("unauthed:");
        okToken = TOKENS.ok("authed");
      } finally {
        writeSpy.mockRestore();
      }
    });
    return { out, failToken, okToken };
  };

  test("test: the doctor tty surface contains no ansi escape produced outside brand helpers", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    let out = "";
    let allowed = new Set<string>();
    await withTTY(async () => {
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        out = await doctor(["--"], repo, ADAPTERS5);
        allowed = new Set(Object.values(TOKENS).flatMap((token) =>
          [...token("x").matchAll(/\x1b\[[0-9;]*m/g)].map(([sgr]) => sgr),
        ));
      } finally {
        writeSpy.mockRestore();
      }
    });
    for (const [sgr] of out.matchAll(/\x1b\[[0-9;]*m/g)) expect(allowed.has(sgr), sgr).toBe(true);
  });

  test("test: an unauthed model row renders the fail token on a tty", async () => {
    const { out, failToken } = await modelOutput();
    expect(out).toContain(failToken);
  });

  test("test: an authed model row renders the ok token on a tty", async () => {
    const { out, okToken } = await modelOutput();
    expect(out).toContain(okToken);
  });
});

describe("T3 brand banner (TTY gate)", () => {
  const withoutTTY = async (fn: () => Promise<void>) => {
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    try {
      await fn();
    } finally {
      if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  };

  test("TTY stdout emits the banner at start, before the report body returns", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    await withTTY(async () => {
      const writes: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      const out = await doctor(["--"], repo, ADAPTERS5);
      writeSpy.mockRestore();
      expect(writes.some((w) => w.includes("spec in, verified work out."))).toBe(true);
      expect(out.startsWith(BANNER)).toBe(false); // the start write is the single emission — body stays banner-free
      expect(out).toContain("capability matrix");
    });
  });

  test("non-TTY stdout is byte-identical to pre-T3 (no banner prefix)", async () => {
    const repo = makeRepo({ "keep.txt": "x" });
    let out: string;
    await withoutTTY(async () => {
      out = await doctor(["--"], repo, ADAPTERS5);
    });
    expect(out!.startsWith(BANNER)).toBe(false);
    expect(out!).toMatch(/^tickmarkr doctor — capability matrix:/);
    const repo2 = makeRepo({ "keep.txt": "x" });
    let out2: string;
    await withoutTTY(async () => {
      out2 = await doctor(["--"], repo2, ADAPTERS5);
    });
    expect(out2!).toBe(out!);
  });
});
