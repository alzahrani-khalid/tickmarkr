import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const workflowPaths = [".github/workflows/ci.yml", ".github/workflows/ci.public.yml"];
const gateCommands = ["npm run build", "npm run lint", "npm run test:coverage"];

type Workflow = {
  jobs?: Record<string, { "runs-on"?: string; steps?: Array<{ run?: string }> }>;
};

function jobsFor(path: string): Record<string, { "runs-on"?: string; steps?: Array<{ run?: string }> }> {
  return (parse(readFileSync(join(repoRoot, path), "utf8")) as Workflow).jobs ?? {};
}

function runCommands(job: { steps?: Array<{ run?: string }> }): string[] {
  return (job.steps ?? []).flatMap((step) => (step.run ? [step.run] : []));
}

describe("CI platform lanes", () => {
  test("test: both workflow definitions carry a lane for the second supported operating system running build and the full suite", () => {
    for (const path of workflowPaths) {
      const jobs = jobsFor(path);
      const macLane = Object.values(jobs).find((job) => job["runs-on"] === "macos-latest");
      expect(macLane, `${path} needs a macOS lane`).toBeDefined();
      expect(runCommands(macLane!)).toEqual(expect.arrayContaining(gateCommands));
    }
  });

  test("the added lane runs the same gate commands as the existing lane rather than a reduced subset", () => {
    for (const path of workflowPaths) {
      const jobs = jobsFor(path);
      const existing = jobs.test;
      const macLane = Object.values(jobs).find((job) => job["runs-on"] === "macos-latest");
      expect(existing, `${path} needs its existing test lane`).toBeDefined();
      expect(macLane, `${path} needs a macOS lane`).toBeDefined();
      expect(runCommands(macLane!)).toEqual(runCommands(existing!));
    }
  });
});
