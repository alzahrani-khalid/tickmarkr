import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, useApp, useInput } from "ink";
import { createElement, useMemo, useState } from "react";
import { resolveCockpitLayout } from "./layout.js";
import {
  deriveRunCockpitData,
  RunCockpitFrame,
} from "./run-cockpit.js";
import {
  deriveSetupCockpitData,
  SetupCockpitFrame,
} from "./setup-cockpit.js";

const CAPTURE_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/cockpit/sources",
);

const CAPTURE_FILE_NAMES = [
  "run-20260724-194619.journal.jsonl",
  "run-20260724-231138.journal.jsonl",
  "run-20260725-025004.interrupted.journal.jsonl",
  "doctor.json",
  "config.global.yaml",
  "config.repo.yaml",
] as const;

export const DEMO_KEYS = {
  surface: "v",
  capture: "c",
  quit: "q",
} as const;

export type CaptureEvent = {
  readonly ts: string;
  readonly event: string;
  readonly taskId?: string;
  readonly data: Record<string, unknown>;
};

export type DemoFileCapture = {
  readonly fileName: string;
  readonly raw: string;
};

export type DemoJournalCapture = DemoFileCapture & {
  readonly events: readonly CaptureEvent[];
};

export type DemoJsonCapture = DemoFileCapture & {
  readonly data: Record<string, unknown>;
};

export type DemoCaptures = {
  readonly files: readonly DemoFileCapture[];
  readonly journals: readonly DemoJournalCapture[];
  readonly doctor: DemoJsonCapture;
  readonly config: {
    readonly global: DemoFileCapture;
    readonly repo: DemoFileCapture;
  };
};

function parseEvents(raw: string): CaptureEvent[] {
  return raw.split("\n").flatMap((line) => {
    if (line.trim().length === 0) return [];
    return [JSON.parse(line) as CaptureEvent];
  });
}

/**
 * The only capture boundary for both cockpit demos. It returns the event
 * captures, detection cache and both configuration layers in one immutable set.
 */
export function loadDemoCaptures(directory = CAPTURE_DIRECTORY): DemoCaptures {
  const files = CAPTURE_FILE_NAMES.map((fileName) => ({
    fileName,
    raw: readFileSync(join(directory, fileName), "utf8"),
  }));
  const byName = new Map(files.map((capture) => [capture.fileName, capture]));
  const required = (fileName: (typeof CAPTURE_FILE_NAMES)[number]): DemoFileCapture => {
    const capture = byName.get(fileName);
    if (!capture) throw new Error(`missing cockpit capture: ${fileName}`);
    return capture;
  };
  const journal = (
    fileName: Extract<(typeof CAPTURE_FILE_NAMES)[number], `${string}.jsonl`>,
  ): DemoJournalCapture => {
    const capture = required(fileName);
    return { ...capture, events: parseEvents(capture.raw) };
  };
  const doctor = required("doctor.json");

  return {
    files,
    journals: [
      journal("run-20260724-194619.journal.jsonl"),
      journal("run-20260724-231138.journal.jsonl"),
      journal("run-20260725-025004.interrupted.journal.jsonl"),
    ],
    doctor: {
      ...doctor,
      data: JSON.parse(doctor.raw) as Record<string, unknown>,
    },
    config: {
      global: required("config.global.yaml"),
      repo: required("config.repo.yaml"),
    },
  };
}

function DemoApp({
  binaryVersion,
  columns,
  rows,
}: {
  binaryVersion: string;
  columns: number;
  rows: number;
}) {
  const { exit } = useApp();
  const captures = useMemo(() => loadDemoCaptures(), []);
  const [surface, setSurface] = useState<"run" | "setup">("run");
  const [captureIndex, setCaptureIndex] = useState(() => {
    const eventful = captures.journals.findIndex(
      (capture) =>
        capture.fileName === "run-20260724-231138.journal.jsonl",
    );
    if (eventful < 0) throw new Error("eventful cockpit capture is missing");
    return eventful;
  });
  useInput((input, key) => {
    if (input === DEMO_KEYS.quit || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (input === DEMO_KEYS.surface) {
      setSurface((current) => current === "run" ? "setup" : "run");
      return;
    }
    if (input === DEMO_KEYS.capture) {
      setCaptureIndex((current) => (current + 1) % captures.journals.length);
    }
  });

  let frame;
  if (surface === "setup") {
    const data = deriveSetupCockpitData(captures, binaryVersion);
    frame = createElement(SetupCockpitFrame, {
      data,
      columns,
      rows,
    });
  } else {
    const data = deriveRunCockpitData(
      captures.journals[captureIndex]!,
      binaryVersion,
      { isDaemonAlive: () => false },
    );
    frame = createElement(RunCockpitFrame, {
      data,
      columns,
      rows,
    });
  }

  return frame;
}

export async function runCockpitDemo({
  input,
  output,
  binaryVersion,
  debug = false,
}: {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  binaryVersion: string;
  debug?: boolean;
}): Promise<void> {
  const columns = output.columns ?? 80;
  const rows = output.rows ?? 24;
  const layout = resolveCockpitLayout(columns, rows);
  if (layout.renderer === "plain") {
    const { captureCockpitOutput } = await import("./capture.js");
    await captureCockpitOutput({
      cockpit: "run",
      output,
      binaryVersion,
      columns,
      rows,
      interactive: output.isTTY === true,
      ci: process.env.CI === "true",
    });
    return;
  }

  const app = render(createElement(DemoApp, {
    binaryVersion,
    columns,
    rows,
  }), {
    stdin: input,
    stdout: output,
    exitOnCtrlC: false,
    patchConsole: false,
    debug,
  });
  try {
    await app.waitUntilExit();
  } finally {
    app.unmount();
  }
}
