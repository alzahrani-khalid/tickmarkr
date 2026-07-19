import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CompileError, inferShape } from "../../src/compile/common.js";
import { compileSpecKit } from "../../src/compile/speckit.js";

describe("inferShape", () => {
  test("keyword mapping with implement default", () => {
    expect(inferShape("Write integration tests for auth")).toBe("tests");
    expect(inferShape("Update docs for CLI")).toBe("docs");
    expect(inferShape("Add users table migration")).toBe("migration");
    expect(inferShape("Implement session refresh")).toBe("implement");
  });
});

describe("compileSpecKit", () => {
  test("parses the fixture: ids, deps from [P] groups, sub-bullets, hash", () => {
    const g = compileSpecKit("fixtures/speckit-sample");
    expect(g.spec.source).toBe("speckit");
    expect(g.spec.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(g.tasks.map((t) => t.id)).toEqual(["T001", "T002", "T003", "T004"]);
    const [t1, t2, t3, t4] = g.tasks;
    expect(t1.deps).toEqual([]);            // first barrier
    expect(t2.deps).toEqual(["T001"]);      // [P] → barrier only
    expect(t3.deps).toEqual(["T001"]);      // [P] sibling — parallel with T002
    expect(t4.deps).toEqual(["T002", "T003"]); // sequential → whole parallel group
    expect(t1.shape).toBe("chore");         // explicit beats inference
    expect(t2.complexity).toBe(7);
    expect(t2.acceptance).toHaveLength(2);
    expect(t3.files).toEqual(["src/auth/**"]);
    expect(t4.shape).toBe("tests");         // inferred
    expect(t4.goal).toBe("Write integration tests for auth flow"); // goal defaults to title
  });

  test("missing acceptance fails loudly, listing every offender", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-sk-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "tasks.md"),
      "- [ ] T001 First thing\n- [ ] T002 Second thing\n  - acceptance: fine\n- [ ] T003 Third thing\n",
    );
    try {
      compileSpecKit(dir);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CompileError);
      expect((e as Error).message).toContain("T001");
      expect((e as Error).message).toContain("T003");
      expect((e as Error).message).not.toContain("T002 ");
      expect((e as Error).message).toMatch(/acceptance/);
    }
  });

  test("no tasks.md → clear error; [x] imports as done", () => {
    const dir = mkdtempSync(join(tmpdir(), "tickmarkr-sk2-"));
    expect(() => compileSpecKit(dir)).toThrow(/tasks\.md/);
    writeFileSync(join(dir, "tasks.md"), "- [x] T001 Already finished\n  - acceptance: was verified\n");
    expect(compileSpecKit(dir).tasks[0].status).toBe("done");
  });
});
