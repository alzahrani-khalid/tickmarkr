import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { Box, render, Text, useApp, useInput } from "ink";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { GLYPHS } from "../../brand.js";
import type { InitConfigOverlay } from "../../config/config.js";
import { ToggleMark } from "./components.js";

// The enum unions are derived from the config overlay type (src/config/config.ts) so the
// wizard cannot drift from the schema; only the cycle ORDER is stated here, and tsc rejects
// any value the schema does not know.
type Driver = NonNullable<InitConfigOverlay["driver"]>;
type VisibilityLlm = NonNullable<NonNullable<InitConfigOverlay["visibility"]>["llm"]>;
const DRIVERS: readonly Driver[] = ["auto", "herdr", "subprocess"];
const VISIBILITY: readonly VisibilityLlm[] = ["pane", "headless"];

export type InitWizardFields = {
  driver: Driver;
  concurrency: number;
  visibilityLlm: VisibilityLlm;
  offerSkills: boolean;
  skillsDefault: boolean;
};

export type InitWizardResult =
  | {
    kind: "continue";
    overlay: { driver: Driver; concurrency: number; visibility: { llm: VisibilityLlm } };
    installSkills: boolean;
    installDocs: boolean;
  }
  | { kind: "quit" };

// inkOutput/inkInput replicate the compatibility bridges in fleet-app.tsx — they are
// not exported there and a sibling change owns that file, so importing was not an option when
// this act landed. If a third Ink act appears, hoist the pair into a shared module.
const escape = String.fromCharCode(27);
const inkBookkeepingWrites: Record<string, true> = {
  "": true,
  [`${escape}[?25l`]: true,
  [`${escape}[?25h`]: true,
  [`${escape}[?2026h`]: true,
  [`${escape}[?2026l`]: true,
};

function inkOutput(output: NodeJS.WriteStream): NodeJS.WriteStream {
  if (typeof output.on === "function" && typeof output.off === "function") return output;
  const facade = Object.create(output) as NodeJS.WriteStream;
  const write = output.write.bind(output);
  facade.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (inkBookkeepingWrites[text] === true) return true;
    return Reflect.apply(write, output, [chunk, ...args]) as boolean;
  }) as NodeJS.WriteStream["write"];
  facade.on = () => facade;
  facade.off = () => facade;
  return facade;
}

function inkInput(input: NodeJS.ReadStream, initialInput: string[]) {
  const productionInput = typeof input.ref === "function" && typeof input.unref === "function";
  // Isolate Ink's listeners on a bridge so every editor exit can detach the one listener it
  // owns from the operator's terminal (see fleet-app.tsx for the full provenance).
  const stream = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => unknown;
    ref: () => NodeJS.ReadStream;
    unref: () => NodeJS.ReadStream;
  };
  stream.isTTY = input.isTTY;
  stream.setRawMode = input.setRawMode?.bind(input);
  stream.ref = () => {
    if (productionInput) input.ref();
    return stream as unknown as NodeJS.ReadStream;
  };
  stream.unref = () => {
    if (productionInput) input.unref();
    return stream as unknown as NodeJS.ReadStream;
  };

  const queued = [...initialInput];
  let active = true;
  let scheduled: NodeJS.Timeout | undefined;
  const pump = () => {
    scheduled = undefined;
    if (!active) return;
    const next = queued.shift();
    if (next === undefined) return;
    stream.write(next);
    scheduled = setTimeout(pump, 0);
  };
  const onData = (chunk: string | Buffer) => {
    queued.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    scheduled ??= setTimeout(pump, 0);
  };
  const onKeypress = (sequence: string | undefined, key: { sequence?: string } | undefined) => {
    const token = key?.sequence ?? sequence;
    if (token === undefined) return;
    queued.push(token);
    scheduled ??= setTimeout(pump, 0);
  };
  if (productionInput) {
    input.on("data", onData);
  } else {
    emitKeypressEvents(input);
    input.on("keypress", onKeypress);
  }
  input.resume();
  if (queued.length > 0) scheduled = setTimeout(pump, 0);

  return {
    stream: stream as unknown as NodeJS.ReadStream,
    stop() {
      active = false;
      clearTimeout(scheduled);
      if (productionInput) input.off("data", onData);
      else input.off("keypress", onKeypress);
      input.pause();
      stream.end();
    },
  };
}

type Section = "Run" | "Skills";
type Row = { id: "driver" | "concurrency" | "visibility" | "skills" | "docs" | "continue"; section?: Section; label: string; desc: string };

// Three fields, one toggle, one action — a descriptor array, deliberately not a forms framework.
function buildRows(offerSkills: boolean): Row[] {
  const rows: Row[] = [
    { id: "driver", section: "Run", label: "Driver", desc: "auto: herdr when HERDR_ENV=1, else subprocess · herdr: visible panes · subprocess: headless child processes" },
    { id: "concurrency", section: "Run", label: "Concurrency", desc: "parallel task batteries per run — min 1; an empty or zero entry reverts on leave" },
    {
      id: "visibility",
      section: "Run",
      label: "Visibility (gate LLMs)",
      desc: "headless: judge/review/consult run silently · pane: visible agents",
    },
  ];
  if (offerSkills) {
    rows.push({
      id: "skills",
      section: "Skills",
      label: "Install agent skills",
      desc: "copy the packaged /tkr skills + AGENTS.md guidance into this repo",
    });
    rows.push({
      id: "docs",
      section: "Skills",
      label: "Append agent docs",
      desc: "append the marked tickmarkr guidance block to AGENTS.md (and CLAUDE.md where applicable)",
    });
  }
  rows.push({ id: "continue", label: "Continue →", desc: "save these preferences and continue to discovery" });
  return rows;
}

const HINT_BAR = "Enter/Space to change · Tab to jump sections · ↑/↓ to move · Enter on Continue · Esc to quit";

export function InitWizardApp({ fields }: { fields: InitWizardFields }) {
  const { exit } = useApp();
  const rows = buildRows(fields.offerSkills);
  const sections: Section[] = fields.offerSkills ? ["Run", "Skills"] : ["Run"];
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  const driverRef = useRef(fields.driver);
  const visibilityRef = useRef(fields.visibilityLlm);
  const skillsRef = useRef(fields.skillsDefault);
  const docsRef = useRef(false);
  const concurrencyTextRef = useRef(String(fields.concurrency));
  const lastValidConcurrencyRef = useRef(fields.concurrency);
  const typedRef = useRef(false);
  const doneRef = useRef(false);
  const [, setRevision] = useState(0);
  const bump = () => setRevision((n) => n + 1);

  // Leaving the row (or pressing Enter on it) is the commit point: a parse ≥ 1 becomes the new
  // value, anything else — empty buffer, "0" — snaps back to the last valid integer, so the
  // wizard can never emit a concurrency the config schema (positive int) would reject.
  const commitConcurrency = () => {
    typedRef.current = false;
    const parsed = Number.parseInt(concurrencyTextRef.current, 10);
    if (Number.isInteger(parsed) && parsed >= 1) lastValidConcurrencyRef.current = parsed;
    concurrencyTextRef.current = String(lastValidConcurrencyRef.current);
  };

  const finish = (result: InitWizardResult) => {
    if (doneRef.current) return;
    doneRef.current = true;
    exit(result);
  };

  useInput((input, key) => {
    if (doneRef.current) return;
    if (key.escape || (key.ctrl && input === "c")) {
      finish({ kind: "quit" });
      return;
    }
    const moveTo = (next: number) => {
      commitConcurrency();
      cursorRef.current = next;
      setCursor(next);
    };
    if (key.downArrow) {
      moveTo(Math.min(cursorRef.current + 1, rows.length - 1));
      return;
    }
    if (key.upArrow) {
      moveTo(Math.max(cursorRef.current - 1, 0));
      return;
    }
    if (key.tab) {
      // Jump to the first row of the next section, wrapping — with a single section this lands home.
      const starts = rows.flatMap((row, index) =>
        row.section && rows[index - 1]?.section !== row.section ? [index] : []);
      moveTo(starts.find((start) => start > cursorRef.current) ?? starts[0] ?? 0);
      return;
    }
    const row = rows[cursorRef.current];
    if (row.id === "concurrency") {
      if (!key.ctrl && !key.meta && /^[0-9]$/.test(input)) {
        // First digit replaces the seeded value, later digits append — inline integer entry.
        concurrencyTextRef.current = typedRef.current ? concurrencyTextRef.current + input : input;
        typedRef.current = true;
        bump();
        return;
      }
      if (key.backspace || key.delete) {
        concurrencyTextRef.current = concurrencyTextRef.current.slice(0, -1);
        typedRef.current = true;
        bump();
        return;
      }
    }
    if (key.return && row.id === "continue") {
      commitConcurrency();
      finish({
        kind: "continue",
        overlay: {
          driver: driverRef.current,
          concurrency: lastValidConcurrencyRef.current,
          visibility: { llm: visibilityRef.current },
        },
        installSkills: fields.offerSkills ? skillsRef.current : false,
        installDocs: fields.offerSkills ? docsRef.current : false,
      });
      return;
    }
    if (key.return || input === " ") {
      if (row.id === "driver") driverRef.current = DRIVERS[(DRIVERS.indexOf(driverRef.current) + 1) % DRIVERS.length];
      else if (row.id === "visibility") {
        visibilityRef.current = VISIBILITY[(VISIBILITY.indexOf(visibilityRef.current) + 1) % VISIBILITY.length];
      } else if (row.id === "skills") skillsRef.current = !skillsRef.current;
      else if (row.id === "docs") docsRef.current = !docsRef.current;
      else if (row.id === "concurrency") commitConcurrency();
      bump();
    }
  });

  const valueOf = (row: Row): ReactNode => {
    switch (row.id) {
      case "driver":
        return driverRef.current;
      case "concurrency":
        return concurrencyTextRef.current;
      case "visibility":
        return visibilityRef.current;
      case "skills":
        return <ToggleMark active={skillsRef.current} />;
      case "docs":
        return <ToggleMark active={docsRef.current} />;
      case "continue":
        return "";
    }
  };

  const currentSection = rows.slice(0, cursor + 1).reduce<Section | undefined>(
    (section, row) => row.section ?? section,
    rows[0].section,
  );

  return (
    <Box flexDirection="column">
      <Text bold>tickmarkr init</Text>
      {/* The journey row: only Preferences is live in this act — Discovery and Fleet render dim
          so the operator sees what follows the Continue action. */}
      <Text>
        <Text bold>Preferences</Text>
        <Text dimColor> · Discovery · Fleet</Text>
      </Text>
      <Text dimColor>act 1 of 3 — run preferences for this repo</Text>
      <Box marginTop={1}>
        <Box flexDirection="column" width={10} marginRight={2}>
          {sections.map((section) => (
            <Text key={section} bold={section === currentSection} dimColor={section !== currentSection}>
              {section}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          {rows.map((row, index) => (
            <Text key={row.id} bold={index === cursor}>
              {index === cursor ? `${GLYPHS.pointer} ` : "  "}
              {row.id === "continue" ? row.label : row.label.padEnd(24)}
              {valueOf(row)}
            </Text>
          ))}
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{rows[cursor].desc}</Text>
        <Text dimColor>{HINT_BAR}</Text>
      </Box>
    </Box>
  );
}

export async function runInitWizardApp(opts: {
  fields: InitWizardFields;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  initialInput?: string[];
}): Promise<InitWizardResult> {
  const bridgedInput = inkInput(opts.input, opts.initialInput ?? []);
  const legacyOutput = typeof opts.output.on !== "function" || typeof opts.output.off !== "function";
  const app = render(<InitWizardApp fields={opts.fields} />, {
    stdin: bridgedInput.stream,
    stdout: inkOutput(opts.output),
    exitOnCtrlC: false,
    patchConsole: false,
    // Injected test outputs collect one complete frame per keypress (same rationale as
    // fleet-app.tsx): disable Ink's render throttling only for that facade.
    debug: legacyOutput,
  });
  try {
    return await app.waitUntilExit() as InitWizardResult;
  } finally {
    app.unmount();
    bridgedInput.stop();
  }
}
