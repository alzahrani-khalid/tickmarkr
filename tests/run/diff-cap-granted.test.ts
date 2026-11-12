// Queue row 411 (D-2187 add.65, add.70): a diff-cap park on a task holding an approved grant names only the
// executable remedy (a granted task cannot be split), while an ungranted diff-cap park keeps the gate text.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { approve } from "../../src/cli/commands/approve.js";
import { runDaemon } from "../../src/run/daemon.js";
import { Journal } from "../../src/run/journal.js";
import { COMMIT, setupRepo, T } from "../helpers/tmprepo.js";

const big = { shell: `head -c 3000 /dev/zero | tr '\\0' 'x' > t1.txt && ${COMMIT} big`, result: { ok: true, summary: "big" } };
const refuse = { shell: "true", result: { ok: false, summary: "Cannot edit needed.txt outside files[] allowlist" } };
const capPark = (repo: string, id: string) =>
  Journal.open(repo, id).read().filter((e) => e.event === "task-human" && e.taskId === "T1").at(-1)!;

test("a diff cap park on a granted task names only the raise and the recheck while an ungranted task keeps the base text", async () => {
  // granted: T1 parks a scope request, approve --files grants it, the resumed worker trips the cap.
  {
    const { repo, fake } = setupRepo([T("T1", { files: ["t1.txt"] })], { tasks: { T1: [refuse, big] } }, "gates: { diffCap: 500 }\n");
    writeFileSync(join(repo, "needed.txt"), "needs repair\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "--no-gpg-sign", "-m", "seed requested path"], { cwd: repo });
    await runDaemon(repo, { adapters: [fake], runId: "run-cap-granted", approvalWindowMs: 1 });
    expect(capPark(repo, "run-cap-granted").data.kind).toBe("scope-request");
    await approve(["run-cap-granted", "T1", "--files", "needed.txt"], repo);
    await runDaemon(repo, { adapters: [fake], runId: "run-cap-granted", resume: true, approvalWindowMs: 1 });
    const park = capPark(repo, "run-cap-granted");
    expect(park.data.kind).toBe("diff-cap");
    expect(String(park.data.reason)).toMatch(/diff exceeds verifiable cap \(\d+ > 500\) — raise gates\.diffCap, then approve --recheck$/);
    expect(String(park.data.reason)).not.toContain("split the task");
  }
  // control: an ungranted diff-cap park keeps the gate's base remedy text.
  {
    const { repo, fake } = setupRepo([T("T1", { files: ["t1.txt"] })], { tasks: { T1: [big] } }, "gates: { diffCap: 500 }\n");
    await runDaemon(repo, { adapters: [fake], runId: "run-cap-plain", approvalWindowMs: 1 });
    const park = capPark(repo, "run-cap-plain");
    expect(park.data.kind).toBe("diff-cap");
    expect(String(park.data.reason)).toMatch(/diff exceeds verifiable cap \(\d+ > 500\) — split the task, or raise gates\.diffCap$/);
  }
});
