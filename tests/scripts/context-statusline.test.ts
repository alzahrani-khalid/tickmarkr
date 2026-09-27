import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const SCRIPT = join(ROOT, "skills/tickmarkr-overseer/scripts/context-statusline.sh");
const TWIN = join(ROOT, ".claude/skills/tickmarkr-overseer/scripts/context-statusline.sh");
// the installed twin is private: on the exported tree .claude is absent, so it joins only when present
const COPIES = [SCRIPT];
if (existsSync(TWIN)) COPIES.push(TWIN);
const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = (script: string, args: string[], input: string, seat?: string, cwd?: string, root: string | null = cwd ?? null) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TKR_CONTEXT_SEAT;
  delete env.TKR_CONTEXT_ROOT;
  if (seat !== undefined) env.TKR_CONTEXT_SEAT = seat;
  if (root !== null) env.TKR_CONTEXT_ROOT = root;
  const r = spawnSync("bash", [script, ...args], { input, env, cwd, encoding: "utf8" });
  return { stdout: r.stdout, status: r.status };
};

test("test: the installed context collector chains an existing status command and atomically attributes a fresh Claude percentage to its seat versus payloads older than 120 seconds or absent or malformed reading unknown, so replacing operator output or showing zero fails", () => {
  for (const script of COPIES) {
    const project = mkdtempSync(join(tmpdir(), "tkr-context-"));
    cleanup.push(project);
    const ctx = join(project, ".tickmarkr/overseer/context");
    const record = join(ctx, "orch.json");
    // the payload's own directory is a decoy: the destination is the launch-supplied root, never the payload
    const payload = (pct: unknown) =>
      JSON.stringify({ session_id: "s1", workspace: { project_dir: "/nowhere" }, cwd: "/nowhere", context_window: { used_percentage: pct } });
    const read = (seat: string) => run(script, ["--read", seat, project], "").stdout;
    const collect = (args: string[], input: string, seat?: string) => run(script, args, input, seat, project);
    const operator = `cat > '${join(project, "operator-stdin")}'; printf 'operator line\\n'; exit 7`;

    // chaining: the operator's command sees the same payload and keeps its own stdout and status
    // — byte-for-byte, trailing newline included (a line-oriented `read` would fail without it)
    const lined = `${payload(42)}\n`;
    const first = collect([operator], lined, "orch");
    expect(first, script).toEqual({ stdout: "operator line\n", status: 7 });
    expect(readFileSync(join(project, "operator-stdin"), "utf8")).toBe(lined);
    expect(collect(["cat"], lined, "orch")).toEqual({ stdout: lined, status: 0 });
    expect(collect(['read -r line && printf "%s" "$line"'], lined, "orch")).toEqual({ stdout: payload(42), status: 0 });
    expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({ seat: "orch", pct: 42 });
    expect(read("orch")).toBe("42\n");

    // atomic: the update replaces the directory entry — an old inode pinned by a hard link keeps its
    // bytes (an in-place rewrite would change them) and no temp file is left beside the record
    const pin = join(project, "pin");
    linkSync(record, pin);
    const before = readFileSync(pin, "utf8");
    expect(collect([operator], payload(64), "orch").stdout).toBe("operator line\n");
    expect(readFileSync(pin, "utf8")).toBe(before);
    expect(readdirSync(ctx)).toEqual(["orch.json"]);
    expect(read("orch")).toBe("64\n");

    // attribution: a record under another seat's name, or a name that is not a safe basename, reads unknown
    writeFileSync(join(ctx, "ops.json"), readFileSync(record));
    expect(read("ops")).toBe("unknown\n");
    expect(collect([], payload(10), "../escape")).toEqual({ stdout: "", status: 0 });
    expect(existsSync(join(project, ".tickmarkr/overseer/escape.json"))).toBe(false);
    expect(read("../context/orch")).toBe("unknown\n");

    // freshness: 100 s old is still the seat's number; 121 s old reads unknown, never zero
    const aged = (ageS: number) =>
      writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, "utf8")), ts: Date.now() / 1000 - ageS }));
    aged(100);
    expect(read("orch")).toBe("64\n");
    aged(121);
    expect(read("orch")).toBe("unknown\n");

    // absent and malformed read unknown; a payload with no percentage records unknown, not 0 %
    expect(read("absent")).toBe("unknown\n");
    writeFileSync(record, "{");
    expect(read("orch")).toBe("unknown\n");
    // valid → malformed: the malformed payload invalidates the seat's last number instead of leaving it
    expect(collect([], payload(42), "orch").status).toBe(0);
    expect(read("orch")).toBe("42\n");
    expect(collect([operator], "not json", "orch")).toEqual({ stdout: "operator line\n", status: 7 });
    expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({ seat: "orch", pct: null });
    expect(read("orch")).toBe("unknown\n");
    expect(collect([], payload(42), "orch").status).toBe(0);
    expect(collect([], "[1, 2]\n", "orch").status).toBe(0);
    expect(read("orch")).toBe("unknown\n");
    expect(collect([], payload(null), "orch")).toEqual({ stdout: "", status: 0 });
    expect(read("orch")).toBe("unknown\n");
    expect(collect([], payload(0), "orch").status).toBe(0);
    expect(read("orch")).toBe("0\n"); // control: a real 0 still reads 0, so unknown is not a zero in disguise

    // valid → malformed with the seat's cwd elsewhere: the invalidation still lands on the seat's record
    const elsewhere = mkdtempSync(join(tmpdir(), "tkr-elsewhere-"));
    cleanup.push(elsewhere);
    expect(run(script, [], payload(42), "orch", elsewhere, project).status).toBe(0);
    expect(read("orch")).toBe("42\n");
    expect(run(script, [operator], "not json", "orch", elsewhere, project)).toEqual({ stdout: "operator line\n", status: 7 });
    expect(read("orch")).toBe("unknown\n");
    expect(existsSync(join(elsewhere, ".tickmarkr"))).toBe(false);
    // a relative or absent root writes nothing, exactly like an unsafe seat
    expect(run(script, [], payload(42), "orch", project, "rel/root").status).toBe(0);
    expect(run(script, [], payload(42), "orch", project, null).status).toBe(0);
    expect(read("orch")).toBe("unknown\n");
    expect(existsSync(join(project, "rel"))).toBe(false);

    // a seat launched without the recipe's seat name collects nothing but still chains
    rmSync(ctx, { recursive: true });
    expect(collect([operator], payload(42))).toEqual({ stdout: "operator line\n", status: 7 });
    expect(existsSync(ctx)).toBe(false);
  }
});
