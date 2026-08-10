import { expect, test } from "vitest";
import {
  CAPTURE_ARTIFACT_MANIFEST,
  classifyArtifactPath,
  measureArtifactDiff,
  type CaptureArtifactManifest,
} from "../../src/gates/artifact-manifest.js";

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

test("the shipped manifest contains only captures backed by byte-identity oracles", () => {
  const producerIds = new Set(CAPTURE_ARTIFACT_MANIFEST.producers.map((producer) => producer.id));
  expect(producerIds).toEqual(new Set([
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
