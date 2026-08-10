/**
 * Generated artifacts are not inferred from their directory or extension. A
 * path receives capture accounting only when its manifest row names a
 * registered producer and repeats that producer's current provenance exactly.
 */

export type CaptureProducerProvenance = {
  readonly source: string;
  readonly entrypoint: string;
  readonly revision: string;
};

export type CaptureProducerRegistration = {
  readonly id: string;
  readonly provenance: CaptureProducerProvenance;
};

export type CaptureArtifactManifestEntry = {
  readonly path: string;
  readonly producer: string;
  readonly provenance: CaptureProducerProvenance;
};

export type CaptureArtifactManifest = {
  readonly version: 1;
  readonly producers: readonly CaptureProducerRegistration[];
  readonly artifacts: readonly CaptureArtifactManifestEntry[];
};

const GOLDEN_PROVENANCE = {
  source: "src/tui/cockpit/capture.ts",
  entrypoint: "regenerateGoldenFrames",
  revision: "golden-frame-v1",
} as const satisfies CaptureProducerProvenance;

const COLOUR_PROVENANCE = {
  source: "src/tui/cockpit/capture.ts",
  entrypoint: "regenerateColourFrames",
  revision: "colour-frame-v1",
} as const satisfies CaptureProducerProvenance;

export const CAPTURE_PRODUCERS = [
  { id: "cockpit-golden-frames", provenance: GOLDEN_PROVENANCE },
  { id: "cockpit-colour-frames", provenance: COLOUR_PROVENANCE },
] as const satisfies readonly CaptureProducerRegistration[];

const goldenFrameNames = [
  "run.width-stacked.80x24.txt",
  "run.width-folded-keys.100x24.txt",
  "run.width-three-column.140x24.txt",
  "run.height-14.140x14.txt",
  "run.height-18.140x18.txt",
  "run.height-24.140x24.txt",
  "run.height-40.140x40.txt",
  "run.no-colour.140x24.txt",
  "run.non-tty.140x24.txt",
  "run.ci.140x24.txt",
  "setup.width-stacked.80x24.txt",
  "setup.width-folded-keys.100x24.txt",
  "setup.width-three-column.140x24.txt",
  "setup.height-14.140x14.txt",
  "setup.height-18.140x18.txt",
  "setup.height-24.140x24.txt",
  "setup.height-40.140x40.txt",
  "setup.no-colour.140x24.txt",
  "setup.non-tty.140x24.txt",
  "setup.ci.140x24.txt",
] as const;

const colourFrameNames = [
  "run-20260718-000943.colour.140x24.txt",
  "run-20260718-000943.no-colour.140x24.txt",
  "run-20260725-025004.interrupted.colour.140x24.txt",
] as const;

const provenanceCopy = (
  provenance: CaptureProducerProvenance,
): CaptureProducerProvenance => ({ ...provenance });

export const CAPTURE_ARTIFACT_MANIFEST = {
  version: 1,
  producers: CAPTURE_PRODUCERS,
  artifacts: [
    ...goldenFrameNames.map((fixture) => ({
      path: `tests/fixtures/cockpit/frames/${fixture}`,
      producer: "cockpit-golden-frames",
      provenance: provenanceCopy(GOLDEN_PROVENANCE),
    })),
    ...colourFrameNames.map((fixture) => ({
      path: `tests/fixtures/cockpit/colour/${fixture}`,
      producer: "cockpit-colour-frames",
      provenance: provenanceCopy(COLOUR_PROVENANCE),
    })),
  ],
} as const satisfies CaptureArtifactManifest;

/** Compatibility name for the pre-manifest gate API; now derived from one manifest. */
export const REGENERABLE_CAPTURE_PATHS: readonly string[] =
  CAPTURE_ARTIFACT_MANIFEST.artifacts
    .map((artifact) => artifact.path);

export const PROTECTED_EVIDENCE_PREFIXES = [
  "tests/fixtures/cockpit/anchors/",
  "tests/fixtures/cockpit/sources/",
  "tests/fixtures/cockpit/colour/sources/",
] as const;

export function isProtectedEvidence(path: string): boolean {
  return PROTECTED_EVIDENCE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export type ArtifactPathClassification = {
  readonly path: string;
  readonly kind: "logic";
  readonly reason:
    | "protected-evidence"
    | "unmanifested"
    | "malformed-manifest"
    | "missing-producer"
    | "stale-provenance";
  readonly error?: string;
} | {
  readonly path: string;
  readonly kind: "capture";
  readonly reason: "manifest-provenance";
  readonly producer: string;
  readonly provenance: CaptureProducerProvenance;
};

type ManifestIndex = {
  readonly producers: ReadonlyMap<string, CaptureProducerRegistration>;
  readonly artifacts: ReadonlyMap<string, CaptureArtifactManifestEntry>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isCanonicalRepoPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function parseProvenance(value: unknown): CaptureProducerProvenance | null {
  if (!isRecord(value)) return null;
  const { source, entrypoint, revision } = value;
  if (!isCanonicalRepoPath(source)) return null;
  if (typeof entrypoint !== "string" || !/^[A-Za-z_$][\w$]*$/.test(entrypoint)) return null;
  if (typeof revision !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(revision)) return null;
  return { source, entrypoint, revision };
}

const sameProvenance = (
  left: CaptureProducerProvenance,
  right: CaptureProducerProvenance,
): boolean =>
  left.source === right.source
  && left.entrypoint === right.entrypoint
  && left.revision === right.revision;

function indexManifest(manifest: unknown): ManifestIndex | string {
  if (!isRecord(manifest) || manifest.version !== 1) {
    return "artifact manifest version must be 1";
  }
  if (!Array.isArray(manifest.producers) || !Array.isArray(manifest.artifacts)) {
    return "artifact manifest producers and artifacts must be arrays";
  }

  const producers = new Map<string, CaptureProducerRegistration>();
  for (const [index, raw] of manifest.producers.entries()) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.trim()) {
      return `artifact manifest producer ${index} is malformed`;
    }
    const provenance = parseProvenance(raw.provenance);
    if (!provenance) return `artifact manifest producer ${raw.id} has malformed provenance`;
    if (producers.has(raw.id)) return `artifact manifest producer ${raw.id} is duplicated`;
    producers.set(raw.id, { id: raw.id, provenance });
  }

  const artifacts = new Map<string, CaptureArtifactManifestEntry>();
  for (const [index, raw] of manifest.artifacts.entries()) {
    if (!isRecord(raw) || !isCanonicalRepoPath(raw.path)
      || typeof raw.producer !== "string" || !raw.producer.trim()) {
      return `artifact manifest entry ${index} is malformed`;
    }
    const provenance = parseProvenance(raw.provenance);
    if (!provenance) return `artifact manifest entry ${raw.path} has malformed provenance`;
    if (artifacts.has(raw.path)) return `artifact manifest path ${raw.path} is duplicated`;
    artifacts.set(raw.path, { path: raw.path, producer: raw.producer, provenance });
  }

  return { producers, artifacts };
}

export function classifyArtifactPath(
  path: string,
  manifest: unknown = CAPTURE_ARTIFACT_MANIFEST,
): ArtifactPathClassification {
  // Protected evidence wins even over a forged manifest row.
  if (isProtectedEvidence(path)) {
    return { path, kind: "logic", reason: "protected-evidence" };
  }

  const indexed = indexManifest(manifest);
  if (typeof indexed === "string") {
    return { path, kind: "logic", reason: "malformed-manifest", error: indexed };
  }
  const artifact = indexed.artifacts.get(path);
  if (!artifact) return { path, kind: "logic", reason: "unmanifested" };
  const producer = indexed.producers.get(artifact.producer);
  if (!producer) {
    return {
      path,
      kind: "logic",
      reason: "missing-producer",
      error: `capture producer ${artifact.producer} is not registered`,
    };
  }
  if (!sameProvenance(artifact.provenance, producer.provenance)) {
    return {
      path,
      kind: "logic",
      reason: "stale-provenance",
      error: `capture provenance for ${path} does not match producer ${producer.id}`,
    };
  }
  return {
    path,
    kind: "capture",
    reason: "manifest-provenance",
    producer: producer.id,
    provenance: producer.provenance,
  };
}

const SET_ASIDE_RECEIPT = /^set aside: regenerable capture (.+?) — \d+ bytes withheld\b/m;

/** The path named by a citable capture receipt, or null when there is none. */
export function setAsideReceiptPath(section: string): string | null {
  return SET_ASIDE_RECEIPT.exec(section)?.[1] ?? null;
}

const DIFF_SECTIONS = /(?=^diff --git )/m;

function deletedPath(section: string): string | null {
  if (!/^deleted file mode /m.test(section)) return null;
  const oldPath = /^--- (.+)$/m.exec(section)?.[1]
    ?? /^Binary files (.+) and \/dev\/null differ$/m.exec(section)?.[1];
  if (!oldPath || oldPath === "/dev/null") return null;
  return unquoteGitPath(oldPath).replace(/^a\//, "");
}

/**
 * Whole-file source deletions retain their operation fact instead of spending
 * the reader cap on bytes that no longer exist. Capture receipts and protected
 * evidence are deliberately exempt from this older reduction.
 */
export function reviewableLogicDiff(diff: string): string {
  return diff.split(DIFF_SECTIONS).map((section) => {
    if (setAsideReceiptPath(section)) return section;
    const path = deletedPath(section);
    if (!path || isProtectedEvidence(path)) return section;
    return `deleted file: ${path}\n`;
  }).join("");
}

function unquoteGitPath(raw: string): string {
  const value = raw.trim();
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}

function diffSidePath(raw: string): string | null {
  const value = unquoteGitPath(raw);
  if (value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
}

function gitHeaderTokens(raw: string): string[] {
  return raw.match(/"(?:\\.|[^"\\])*"|\S+/g) ?? [];
}

type ParsedSection = {
  readonly lines: string[];
  readonly minus: number;
  readonly sides: readonly [string | null, string | null];
  readonly body: string[];
};

function parseContentSection(section: string): ParsedSection | null {
  const lines = section.split("\n");
  const minus = lines.findIndex((line) => line.startsWith("--- "));
  if (minus === -1 || !lines[minus + 1]?.startsWith("+++ ")) return null;
  const body = lines.slice(minus + 2);
  if (!body.some((line) => line.startsWith("@@ "))) return null;
  return {
    lines,
    minus,
    sides: [
      diffSidePath(lines[minus]!.slice(4)),
      diffSidePath(lines[minus + 1]!.slice(4)),
    ],
    body,
  };
}

function sectionPaths(section: string, parsed: ParsedSection | null): string[] {
  if (parsed) return [...new Set(parsed.sides.filter((path): path is string => path !== null))];
  const renamedFrom = /^rename from (.+)$/m.exec(section)?.[1];
  const renamedTo = /^rename to (.+)$/m.exec(section)?.[1];
  if (renamedFrom || renamedTo) {
    return [...new Set([renamedFrom, renamedTo].filter((path): path is string => path !== undefined).map(unquoteGitPath))];
  }
  const header = /^diff --git (.+)$/m.exec(section)?.[1];
  if (!header) return [];
  const tokens = gitHeaderTokens(header);
  if (tokens.length !== 2) return [];
  return [...new Set(tokens.map(diffSidePath).filter((path): path is string => path !== null))];
}

function hunkPayload(body: readonly string[], sign: "+" | "-"): string {
  return body
    .filter((line) => line.startsWith(sign) || line.startsWith("\\"))
    .map((line) => line[0] === sign ? line.slice(1) : line)
    .join("\n");
}

function kindOnlyPaths(sections: readonly string[]): ReadonlySet<string> {
  const removed = new Map<string, string>();
  const added = new Map<string, string>();
  for (const section of sections) {
    const parsed = parseContentSection(section);
    if (!parsed) continue;
    const [before, after] = parsed.sides;
    if (before && !after) removed.set(before, hunkPayload(parsed.body, "-"));
    else if (after && !before) added.set(after, hunkPayload(parsed.body, "+"));
  }
  return new Set(
    [...removed]
      .filter(([path, payload]) => added.get(path) === payload)
      .map(([path]) => path),
  );
}

export type ArtifactDiffSection = {
  readonly paths: readonly string[];
  readonly kind: "capture" | "logic";
  readonly reason: string;
  readonly producer?: string;
  readonly provenance?: CaptureProducerProvenance;
  /** UTF-8 bytes left for a reviewer to read, including any receipt. */
  readonly logicBytes: number;
  /** UTF-8 bytes withheld behind the finite capture bound. */
  readonly captureBytes: number;
};

export type ArtifactDiffMeasurement = {
  readonly rendered: string;
  readonly logicBytes: number;
  readonly captureBytes: number;
  readonly sections: readonly ArtifactDiffSection[];
};

function sameCaptureProducer(
  classifications: readonly ArtifactPathClassification[],
): classifications is readonly Extract<ArtifactPathClassification, { kind: "capture" }>[] {
  if (!classifications.length || classifications.some((row) => row.kind !== "capture")) return false;
  const [first] = classifications as readonly Extract<ArtifactPathClassification, { kind: "capture" }>[];
  return first !== undefined && classifications.every((row) =>
    row.kind === "capture"
    && row.producer === first.producer
    && sameProvenance(row.provenance, first.provenance)
  );
}

/**
 * Classify and compact a Git diff once. Invalid manifest facts remain ordinary
 * logic. Valid capture content is replaced by one citable receipt, while its
 * exact UTF-8 payload remains charged to the separate capture bucket.
 */
export function measureArtifactDiff(
  diff: string,
  manifest: unknown = CAPTURE_ARTIFACT_MANIFEST,
): ArtifactDiffMeasurement {
  if (!diff.includes("diff --git ")) {
    return {
      rendered: diff,
      logicBytes: Buffer.byteLength(diff, "utf8"),
      captureBytes: 0,
      sections: [],
    };
  }

  const rawSections = diff.split(/(?=^diff --git )/m);
  const kindOnly = kindOnlyPaths(rawSections);
  const rendered: string[] = [];
  const measurements: ArtifactDiffSection[] = [];

  for (const section of rawSections) {
    const parsed = parseContentSection(section);
    const paths = sectionPaths(section, parsed);
    const classifications = paths.map((path) => classifyArtifactPath(path, manifest));
    const validCapture = sameCaptureProducer(classifications);
    const producer = validCapture ? classifications[0] : undefined;
    const isKindOnly = paths.some((path) => kindOnly.has(path));

    if (!parsed || !validCapture || !producer || isKindOnly) {
      rendered.push(section);
      measurements.push({
        paths,
        kind: validCapture ? "capture" : "logic",
        reason: validCapture
          ? parsed ? "content-identical-kind-change" : "file-operation-only"
          : classifications.map((row) => row.reason).join(",") || "unparsed-diff-section",
        ...(producer ? { producer: producer.producer, provenance: producer.provenance } : {}),
        logicBytes: Buffer.byteLength(section, "utf8"),
        captureBytes: 0,
      });
      continue;
    }

    const withheld = parsed.lines.slice(parsed.minus).join("\n");
    const captureBytes = Buffer.byteLength(withheld, "utf8");
    const receiptPath = paths.at(-1)!;
    const receipt = `set aside: regenerable capture ${receiptPath} — ${captureBytes} bytes withheld (producer ${producer.producer}; provenance ${producer.provenance.source}#${producer.provenance.entrypoint}@${producer.provenance.revision})`;
    const compact = `${parsed.lines.slice(0, parsed.minus).join("\n")}\n${receipt}\n`;
    rendered.push(compact);
    measurements.push({
      paths,
      kind: "capture",
      reason: "manifest-provenance",
      producer: producer.producer,
      provenance: producer.provenance,
      logicBytes: Buffer.byteLength(compact, "utf8"),
      captureBytes,
    });
  }

  return {
    rendered: rendered.join(""),
    logicBytes: measurements.reduce((sum, row) => sum + row.logicBytes, 0),
    captureBytes: measurements.reduce((sum, row) => sum + row.captureBytes, 0),
    sections: measurements,
  };
}

/** The original API now delegates to the provenance-backed measurement. */
export function setAsideRegenerableCaptures(diff: string): string {
  return measureArtifactDiff(diff).rendered;
}

// The default corpus is about 134 KiB. Capture bytes are bounded, never free;
// the floor avoids making a deliberately lowered logic cap reintroduce Q14.
export const MIN_CAPTURE_DIFF_CAP = 1_000_000;
export const CAPTURE_DIFF_CAP_MULTIPLIER = 4;

export function captureDiffCapFor(logicCap: number): number {
  return Math.max(MIN_CAPTURE_DIFF_CAP, logicCap * CAPTURE_DIFF_CAP_MULTIPLIER);
}
