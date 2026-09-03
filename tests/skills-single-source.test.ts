import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const canonicalRoot = resolve("skills/tickmarkr-overseer");
const installedRoot = resolve(".claude/skills/tickmarkr-overseer");
const trackedFiles = [
  "SKILL.md",
  "scripts/seat-send.sh",
  "scripts/watch-pending-input.sh",
  "scripts/watch-artifacts.sh",
  "scripts/watch-contamination.sh",
  "scripts/watch-context.sh",
];

// The installed `.claude/skills` copy is private — the public export excludes `.claude/` — so the
// twin-bytes check skips there BY NAME, exactly as tests/repo/skills-single-source.test.ts does; the
// canonical `skills/` copy ships and its law text is asserted in every context (OBS-878).
test.skipIf(!existsSync(installedRoot))("the overseer skill's tracked copies are byte-identical (skipped on the exported tree: .claude/skills is absent)", () => {
  for (const file of trackedFiles) {
    const canonical = resolve(canonicalRoot, file);
    const installed = resolve(installedRoot, file);
    expect(readFileSync(installed), `${file} tracked-copy bytes`).toEqual(readFileSync(canonical));
    if (lstatSync(installed).isSymbolicLink()) {
      expect(realpathSync(installed), `${file} symlink identity`).toBe(realpathSync(canonical));
    }
  }
});

test("the overseer skill states in both tracked copies that a seat retires only watchers it armed by recorded pid never by pattern that a same-process clear keeps every background task alive so the re-arm is kill-by-pid then arm verified by two process-table reads that a fire-and-exit watcher's re-arm is the same act as handling its wake with the new pid named that a stand-down order lists the partner's watchers armed on the ordering seat that must survive it that the duplicate-id check prints nothing new against a committed baseline and carries the five method laws cite-is-not-read executing-form probe resume-aware contamination the queue-inheritance diff and re-run a premise as the diff shows in the changed skill lines", () => {
  const skill = readFileSync(resolve(canonicalRoot, "SKILL.md"), "utf8");
  expect(skill).toMatch(/A seat retires only watchers it armed,[\s\S]*exact recorded pids; it never uses `pkill -f`, `pgrep -f`, or[\s\S]*pattern/);
  expect(skill).toMatch(/same-process `?\/clear`?[\s\S]{0,80}keeps every background task alive/);
  expect(skill).toMatch(/kill-by-pid, arm the replacement,[\s\S]{0,120}two process-table reads/);
  expect(skill).toMatch(/fire-and-exit watcher's wake and re-arming it are the same act[\s\S]{0,160}new recorded pid/);
  expect(skill).toMatch(/stand-down order[\s\S]{0,220}partner's watchers armed on the ordering seat[\s\S]{0,80}must survive it/);
  expect(skill).toMatch(/duplicate-id check against the committed historical baseline[\s\S]{0,120}print nothing NEW/);
  expect(skill).toContain("comm -13");
  for (const id of [
    "OBS-12", "OBS-24", "OBS-26", "OBS-29", "OBS-35", "OBS-36", "OBS-40", "OBS-41",
    "OBS-106", "OBS-129", "OBS-148", "OBS-415", "OBS-459", "OBS-463", "OBS-466", "OBS-470",
    "OBS-472", "OBS-542", "OBS-548", "OBS-552", "OBS-562", "OBS-563", "OBS-564", "OBS-592",
    "OBS-785", "OBS-791",
  ]) expect(skill, `${id} committed duplicate baseline`).toContain(id);
  for (const law of [
    "CITE-IS-NOT-READ",
    "EXECUTING-FORM PROBE",
    "RESUME-AWARE CONTAMINATION",
    "THE QUEUE-INHERITANCE DIFF",
    "RE-RUN A PREMISE",
  ]) expect(skill, law).toContain(law);
  expect(skill).toContain("comm -23 <previous-queue-ids> <new-queue-ids>");
  expect(skill).toMatch(/RESUME-AWARE CONTAMINATION[\s\S]{0,300}continue across `run-resume`/);
  expect(skill).toMatch(/RE-RUN A PREMISE[\s\S]{0,400}call-site premise[\s\S]{0,160}rejected alternatives/);
});
