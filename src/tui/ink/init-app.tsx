import { Box, render, Text, useApp, useInput } from "ink";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import type { InitConfigOverlay } from "../../config/config.js";
import { ToggleMark } from "./components.js";
import { clip, INK, inkInput, inkOutput, KeyBar, padCell, Pointer } from "./frame.js";

// The enum unions are derived from the config overlay type (src/config/config.ts) so the
// wizard cannot drift from the schema; only the cycle ORDER is stated here, and tsc rejects
// any value the schema does not know.
type Driver = NonNullable<InitConfigOverlay["driver"]>;
type VisibilityLlm = NonNullable<NonNullable<InitConfigOverlay["visibility"]>["llm"]>;
const DRIVERS: readonly Driver[] = ["auto", "herdr", "subprocess", "orca"];

// One line per driver, shown for the value currently selected: four environments no longer fit on
// a single description row at 80 columns (the shipped three already clipped), and orca is an
// EXPLICIT choice — `auto` still means herdr-else-subprocess and never reaches for it.
const DRIVER_DESC: Record<Driver, string> = {
  auto: "auto: herdr when HERDR_ENV=1, else subprocess — never orca",
  herdr: "herdr: every worker runs in a visible pane you can watch and unblock",
  subprocess: "subprocess: headless child processes — no cockpit, same fail-closed gates",
  orca: "orca: visible terminals in the Orca app — an explicit choice, never auto's",
};
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

type Section = "Run" | "Skills";
type Row = { id: "driver" | "concurrency" | "visibility" | "skills" | "docs" | "continue"; section?: Section; label: string; desc: string };

// Three fields, one toggle, one action — a descriptor array, deliberately not a forms framework.
function buildRows(offerSkills: boolean, driver: Driver): Row[] {
  const rows: Row[] = [
    { id: "driver", section: "Run", label: "Driver", desc: DRIVER_DESC[driver] },
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

export function InitWizardApp({ fields, frameColumns = 74 }: { fields: InitWizardFields; frameColumns?: number }) {
  const { exit } = useApp();
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
  // Built per render so the description row follows the driver the cursor last cycled to.
  const rows = buildRows(fields.offerSkills, driverRef.current);
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

  const width = Math.max(58, Math.min(frameColumns, 100));
  const rendered: ReactNode[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.section && rows[index - 1]?.section !== row.section) {
      if (index > 0) rendered.push(<Text key={`${row.section}-gap`}> </Text>);
      rendered.push(<Text key={row.section} dimColor>{row.section}</Text>);
    }
    if (row.id === "continue") rendered.push(<Text key="continue-gap"> </Text>);
    rendered.push(
      <Text key={row.id}>
        <Pointer on={index === cursor} />
        <Text bold={index === cursor}>{row.id === "continue" ? row.label : padCell(row.label, 26)}</Text>
        <Text color={index === cursor ? INK.brand : undefined}>{valueOf(row)}</Text>
      </Text>,
    );
  }

  return (
    <Box flexDirection="column" width={width}>
      <Text>
        <Text bold color={INK.brand}>{" tickmarkr init"}</Text>
        <Text dimColor>{" · act 1 of 3"}</Text>
      </Text>
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        {/* The journey row: only Preferences is live in this act — Discovery and Fleet render dim
            so the operator sees what follows the Continue action. */}
        <Text>
          <Text bold color={INK.brand}>Preferences</Text>
          <Text dimColor>{" › Discovery › Fleet"}</Text>
        </Text>
        <Text> </Text>
        {rendered}
      </Box>
      <Text dimColor>{` ${clip(rows[cursor].desc, width - 2)}`}</Text>
      <KeyBar
        binds={[
          { key: "Enter/Space", label: "change" },
          { key: "Tab", label: "section" },
          { key: "↑↓", label: "move" },
          { key: "Esc", label: "quit" },
        ]}
      />
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
  // OBS-527: geometry is a live input — rebuild the element on resize (same pattern as fleet-app)
  const wizardElement = () => <InitWizardApp fields={opts.fields} frameColumns={opts.output.columns ?? 74} />;
  const app = render(wizardElement(), {
    stdin: bridgedInput.stream,
    stdout: inkOutput(opts.output),
    exitOnCtrlC: false,
    patchConsole: false,
    // Injected test outputs collect one complete frame per keypress (same rationale as
    // fleet-app.tsx): disable Ink's render throttling only for that facade.
    debug: legacyOutput,
  });
  const onResize = () => app.rerender(wizardElement());
  if (!legacyOutput) opts.output.on("resize", onResize);
  try {
    return await app.waitUntilExit() as InitWizardResult;
  } finally {
    if (!legacyOutput) opts.output.off("resize", onResize);
    app.unmount();
    bridgedInput.stop();
  }
}
