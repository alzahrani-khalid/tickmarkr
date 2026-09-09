import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { opencode } from "../../src/adapters/opencode.js";
import { SettledTrailerTracker } from "../../src/adapters/types.js";
import { trailerPattern } from "../../src/adapters/prompt.js";

test("test: the verbatim opencode capture under tests fixtures opencode concludes nothing at its trailer frame because the declared busy markers are painted, and the same pane with the TODO block, tool line and spinner cleared across two consecutive samples concludes finished, so a harvest that accepts the first trailer match on a busy frame fails", () => {
  const capture = readFileSync(new URL("../fixtures/opencode/premature-idle-T4-a0.out", import.meta.url), "utf8");
  const markers = opencode.busyFrameMarkers!;
  expect(markers.filter((marker) => marker.match(capture)).map((marker) => marker.name)).toEqual(["unchecked TODO", "in-flight tool", "spinner"]);
  const tracker = new SettledTrailerTracker(markers);
  const sample = (text: string) => tracker.sample(text, new RegExp(trailerPattern("af7c190b")).test(text));
  expect(sample(capture)).toBe(false);
  expect(sample(capture)).toBe(false);
  // Clear only painted activity rows, preserving the captured trailer verbatim.
  const idle = capture.split("\n").filter((line) => !line.includes("☐") && !line.includes("⎋ Search") && !line.includes("⠏")).join("\n");
  expect(markers.some((marker) => marker.match(idle))).toBe(false);
  expect(sample(idle)).toBe(false);
  expect(sample(capture)).toBe(false); // a busy repaint breaks consecutive-idle evidence
  expect(sample(idle)).toBe(false);
  expect(sample(idle)).toBe(true);
  for (const marker of markers) {
    const row = capture.split("\n").find((line) => marker.match(line))!;
    const isolated = new SettledTrailerTracker(markers);
    expect(isolated.sample(`${idle}\n${row}`, true), marker.name).toBe(false);
    expect(isolated.sample(`${idle}\n${row}`, true), marker.name).toBe(false);
  }
});
