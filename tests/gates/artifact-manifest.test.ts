import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAPTURE_ARTIFACT_MANIFEST,
  classifyArtifactPath,
  measureArtifactDiff,
  type CaptureArtifactManifest,
} from "../../src/gates/artifact-manifest.js";
import { captureShellOutput } from "../../src/tui/cockpit/capture.js";
import { shellFixture } from "../fixtures/cockpit/final/capture-fixture.js";

const provenance = {
  source: "scripts/capture-example.ts",
  entrypoint: "captureExample",
  revision: "v1",
} as const;

const genericManifest: CaptureArtifactManifest = {
  version: 1,
  producers: [{ id: "example-producer", provenance }],
  artifacts: [{
    path: "tests/fixtures/example/generated.txt",
    producer: "example-producer",
    provenance: { ...provenance },
  }],
};

test("capture classification is producer-neutral and requires exact path plus exact provenance", () => {
  expect(classifyArtifactPath("tests/fixtures/example/generated.txt", genericManifest))
    .toMatchObject({
      kind: "capture",
      reason: "manifest-provenance",
      producer: "example-producer",
    });
  expect(classifyArtifactPath("tests/fixtures/example/neighbour.txt", genericManifest))
    .toMatchObject({ kind: "logic", reason: "unmanifested" });

  const stale: CaptureArtifactManifest = {
    ...genericManifest,
    artifacts: [{
      ...genericManifest.artifacts[0]!,
      provenance: { ...provenance, revision: "v0" },
    }],
  };
  expect(classifyArtifactPath("tests/fixtures/example/generated.txt", stale))
    .toMatchObject({ kind: "logic", reason: "stale-provenance" });

  const path = genericManifest.artifacts[0]!.path;
  const diff = [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-before",
    "+after",
    "",
  ].join("\n");
  const measured = measureArtifactDiff(diff, genericManifest);
  expect(measured.sections).toContainEqual(expect.objectContaining({
    kind: "capture",
    reason: "manifest-provenance",
    producer: "example-producer",
  }));
  expect(measured.captureBytes).toBeGreaterThan(0);
  expect(measured.rendered).toContain("producer example-producer");
});

test("malformed manifests, missing producers, and forged protected rows fail closed to logic", () => {
  const missing: CaptureArtifactManifest = { ...genericManifest, producers: [] };
  expect(classifyArtifactPath("tests/fixtures/example/generated.txt", missing))
    .toMatchObject({ kind: "logic", reason: "missing-producer" });
  expect(classifyArtifactPath("tests/fixtures/example/generated.txt", {
    ...genericManifest,
    version: 2,
  })).toMatchObject({ kind: "logic", reason: "malformed-manifest" });

  const protectedPath = "tests/fixtures/cockpit/anchors/forged.txt";
  const forged: CaptureArtifactManifest = {
    ...genericManifest,
    artifacts: [
      ...genericManifest.artifacts,
      { path: protectedPath, producer: "example-producer", provenance },
    ],
  };
  expect(classifyArtifactPath(protectedPath, forged))
    .toMatchObject({ kind: "logic", reason: "protected-evidence" });
});

test("the shipped manifest contains only captures backed by production frame or measurement oracles", async () => {
  const producerIds = new Set(CAPTURE_ARTIFACT_MANIFEST.producers.map((producer) => producer.id));
  expect(producerIds).toEqual(new Set([
    "screen-soak",
    "screen-soak-archive",
    "cockpit-final-shell",
    "cockpit-golden-frames",
    "cockpit-colour-frames",
  ]));
  for (const artifact of CAPTURE_ARTIFACT_MANIFEST.artifacts) {
    expect(classifyArtifactPath(artifact.path)).toMatchObject({
      kind: "capture",
      producer: artifact.producer,
    });
  }
  expect(classifyArtifactPath("tests/fixtures/codex-mcp-spinner/frame-01.txt"))
    .toMatchObject({ kind: "logic", reason: "unmanifested" });

  const fixture = shellFixture();
  try {
    for (const view of ["home", "run", "evidence"] as const) {
      for (const [columns, rows] of [[120, 40], [80, 24]] as const) {
        const path = `tests/fixtures/cockpit/final/${view}.${columns}x${rows}.txt`;
        const regenerated = await captureShellOutput({ ...fixture, view, columns, rows });
        expect(`${regenerated}\n`, path).toBe(readFileSync(join(process.cwd(), path), "utf8"));
      }
    }
  } finally {
    fixture.close();
  }
});

test("soak captures require the registered measurement producer and exact output paths", () => {
  const path = "tests/fixtures/screen-soak/records/final-static/samples.jsonl";
  expect(classifyArtifactPath(path)).toMatchObject({
    kind: "capture", producer: "screen-soak",
    provenance: { source: "tests/fixtures/screen-soak/soak.mjs", entrypoint: "sample", revision: "C6-four-hour-production-v1" },
  });
  expect(classifyArtifactPath(path.replace("samples.jsonl", "result.json.gz"))).toMatchObject({
    kind: "capture", producer: "screen-soak-archive",
    provenance: { source: "tests/fixtures/screen-soak/archive.mjs", entrypoint: "archiveRecord", revision: "C6-lossless-gzip-v1" },
  });
  for (const file of ["archive.json", "hand-authored.json.gz", "result.json"]) {
    expect(classifyArtifactPath(path.replace("samples.jsonl", file))).toMatchObject({ kind: "logic", reason: "unmanifested" });
  }
  for (const neighbour of ["tests/fixtures/screen-soak/soak.mjs", path.replace("samples.jsonl", "hand-authored.jsonl"), path.replace("final-static", "unknown")]) {
    expect(classifyArtifactPath(neighbour)).toMatchObject({ kind: "logic", reason: "unmanifested" });
  }
  const artifact = CAPTURE_ARTIFACT_MANIFEST.artifacts.find(row => row.path === path)!;
  expect(classifyArtifactPath(path, { ...CAPTURE_ARTIFACT_MANIFEST, artifacts: [{ ...artifact, provenance: { ...artifact.provenance, revision: "unverified" } }] }))
    .toMatchObject({ kind: "logic", reason: "stale-provenance" });
});

test("a malformed manifest never turns changed payload bytes into a zero measurement", () => {
  const path = genericManifest.artifacts[0]!.path;
  const diff = [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-before",
    "+after",
    "",
  ].join("\n");
  const malformed = { ...genericManifest, artifacts: [{ path, producer: "example-producer" }] };
  const measured = measureArtifactDiff(diff, malformed);
  expect(measured.captureBytes).toBe(0);
  expect(measured.logicBytes).toBe(Buffer.byteLength(diff, "utf8"));
  expect(measured.rendered).toBe(diff);
});
