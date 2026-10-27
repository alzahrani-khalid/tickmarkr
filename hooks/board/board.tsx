import type { ClientModule, ClientSurface, JsonValue } from "claude-code";
import { badgeWidth, copyAllowed, countdownText, durationText, etaText, headline, needsYou, triesText, visible } from "./model";
import type { BoardState, Gate, Task } from "./state";

export type BoardProps = { state: BoardState; now: number; fit?: number };
type Frame = { ticks: number; seen: number; live: boolean };
const CARD_MIN = 60;
const mark = (gate: Gate): [string, string] => gate === "passed" ? ["✔", "success"] : gate === "failed" ? ["✖", "error"]
  : gate === "running" ? ["●", "warning"] : gate === "queued" ? ["◎", "suggestion"] : ["○", "subtle"];
const statusOf = (task: Task) => task.state === "human" ? "PARKED" : visible(task.state.toUpperCase());
const colorOf = (task: Task) => task.state === "merged" ? "success"
  : ["human", "failed", "blocked", "unknown"].includes(task.state) ? "error" : task.state === "pending" ? "subtle" : "warning";

/** The dev board's responsive cards, badge column, gate marks, seats and live clock, fed solely by the snapshot. */
const Board: ClientModule<JsonValue, Frame> = (raw, surface: ClientSurface<Frame>) => {
  const { Box, Text, Button } = surface.elements;
  const { state, now: readAt, fit = 1 } = raw as unknown as BoardProps;
  const live = "snapshot" in state && state.snapshot.lifecycle === "RUNNING";
  let frame = surface.state;
  if (frame === undefined) {
    surface.every(1000, () => {
      const current = surface.state;
      if (current?.live) surface.setState({ ...current, ticks: current.ticks + 1 });
    });
    frame = { ticks: 0, seen: readAt, live };
    surface.setState(frame);
  } else if (frame.seen !== readAt || frame.live !== live) {
    frame = { ticks: 0, seen: readAt, live };
    surface.setState(frame);
  }
  const now = readAt + frame.ticks * 1000;
  const life = headline(state);
  if ("error" in state) return <Box key="dash" paddingX={1}><Box key="headline"><Text color={life.color} bold>{life.word}</Text></Box></Box>;

  const s = state.snapshot;
  const width = Math.max(30, (surface.columns || 110) - 2);
  const cardWidth = width >= 2 * CARD_MIN + 1 ? Math.floor((width - 1) / 2) : width;
  const badge = badgeWidth(s.tasks.map(task => visible(task.id)), fit);
  const parks = needsYou(state);
  const countdown = countdownText(state, now);
  const eta = etaText(state, now);
  const card = (task: Task) => {
    const color = colorOf(task);
    const park = s.parks.find(park => park.taskId === task.id);
    const checks = [task.gates.build, task.gates.lint, task.gates.evidence, task.gates.scope];
    const build = checks.find(gate => gate === "failed") ?? checks.find(gate => gate === "running")
      ?? checks.find(gate => gate === "queued") ?? (checks.every(gate => gate === "passed" || gate === "disabled") ? "passed" : "unknown");
    const gates = [["Build", build], ["Accept", task.gates.acceptance], ["Review", task.gates.review], ["Test", task.gates.test]] as const;
    const started = task.startedAt === null ? null : Date.parse(task.startedAt);
    const ended = task.endedAt === null ? now : Date.parse(task.endedAt);
    return (
      <Box key={`card-${task.id}`} flexDirection="column" width={cardWidth} flexShrink={0} paddingX={1} borderStyle="round" borderColor={color}>
        <Box key={`card-top-${task.id}`} flexDirection="row">
          <Box key={`badge-${task.id}`} width={badge} flexShrink={0} justifyContent="center" flexDirection="column">
            <Text size="title" weight="bold" color={color}>{visible(task.id)}</Text>
          </Box>
          <Box key={`head-${task.id}`} flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Box key={`title-${task.id}`} flexDirection="row" columnGap={2}>
              <Box flexGrow={1} flexShrink={1} minWidth={0}><Text bold wrap="truncate-end">{visible(task.title)}</Text></Box>
              <Text color={color} bold>{statusOf(task)}</Text>
            </Box>
            <Box key={`gates-${task.id}`} flexDirection="row" flexWrap="wrap" columnGap={2}>
              <Box key={`tries-${task.id}`} flexDirection="row"><Text color="subtle">tries </Text><Text>{triesText(task)}</Text></Box>
              {gates.map(([name, gate]) => {
                const [glyph, tone] = mark(gate);
                return <Box key={`gate-${task.id}-${name}`} flexDirection="row"><Text color="subtle">{name} </Text><Text color={tone}>{glyph}</Text></Box>;
              })}
            </Box>
          </Box>
        </Box>
        <Box key={`card-body-${task.id}`} flexDirection="row">
          <Box width={badge} flexShrink={0} />
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color="subtle" wrap="wrap">{visible(Object.entries(task.seats).filter(([, seat]) => seat !== null).map(([name, seat]) => `${name} ${seat}`).join(" · ") || "no model yet")}</Text>
            <Text color="subtle" wrap="wrap">{started === null ? "not started" : visible(`started ${task.startedAt} · ${durationText(ended - started)} ${task.endedAt ? "to merge" : "elapsed"}`)}</Text>
            <Text color={color} wrap="wrap">{visible([task.now.phase, task.now.blocker, task.now.since ? `${durationText(now - Date.parse(task.now.since))} in phase` : null].filter(Boolean).join(" · ")) || statusOf(task)}</Text>
            {task.now.nextAction ? <Text wrap="wrap">{visible(task.now.nextAction)}</Text> : null}
            {park?.noDecision ? <Text color="error" wrap="wrap">{visible(park.noDecision)}</Text> : null}
          </Box>
        </Box>
      </Box>
    );
  };
  return (
    <Box key="dash" flexDirection="column" gap={1} paddingX={1}>
      <Box key="head" flexDirection="column">
        <Box flexDirection="row" gap={2} flexWrap="wrap"><Text bold>TICKMARKR {visible(s.runId)}</Text><Box key="headline"><Text color={life.color} bold>● {life.word}</Text></Box></Box>
        <Box flexDirection="row" gap={2} flexWrap="wrap"><Text bold>{s.tasks.filter(task => task.state === "merged").length} of {s.tasks.length} merged</Text>{eta ? <Text color="subtle">{eta}</Text> : null}</Box>
      </Box>
      {parks.length || countdown ? (
        <Box key="needs" flexDirection="column" borderStyle="round" borderColor="error" paddingX={1}>
          <Text color="error" bold>NEEDS YOU</Text>
          {countdown ? <Text color="warning" bold>{countdown}</Text> : null}
          {parks.map((park, at) => (
            <Box key={`park-${park.task}`} flexDirection="column">
              <Text color="error" wrap="wrap">{[park.task, park.kind, park.reason].filter(Boolean).join(" · ")}</Text>
              {park.commands.map(({ verb, command }, index) => (
                <Box key={`command-${park.task}-${index}`} flexDirection="row" columnGap={1}>
                  {copyAllowed(state, command) ? <Button key={`copy-${park.task}-${index}`} label="Copy" variant="primary" onPress={() => surface.post({ copy: command })} /> : null}
                  <Box flexShrink={1} minWidth={0}><Text wrap="wrap">{visible(`${verb}: ${command}`)}</Text></Box>
                </Box>
              ))}
              {s.parks[at]?.noDecision ? <Text color="error" wrap="wrap">{visible(s.parks[at]!.noDecision)}</Text> : null}
            </Box>
          ))}
        </Box>
      ) : null}
      <Box key="tasks" flexDirection="row" flexWrap="wrap" columnGap={1}>{s.tasks.map(card)}</Box>
    </Box>
  );
};

export default Board;
