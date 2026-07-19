# resume-replay — vendored incident fixture (Phase 46 D-01, OBS-01)

`incident-P43-03.jsonl` is a VERBATIM line subset of
`.tickmarkr/runs/run-20260711-185020/journal.jsonl` (journal lines 1, 24, 27, 28, 31, 32, 41, 44,
45, 46 — sha1 of this file at vendoring: 0dedc68d98871dcc9397a5870dd6b06836bafcee), vendored at
Phase 46 plan time (2026-07-12). It captures the P43-03 state at kill time:

- 4 `task-dispatch` events on `pi:zai/glm-5.2` (attempts 0–3), two interleaved `retry`
  consult verdicts (do NOT ban),
- the `reroute` consult verdict banning glm-5.2 ("Do not retry glm-5.2 a fourth time…"),
- the `failover-deviation` naming the reroute, and
- the attempt-4 `task-dispatch` on `cursor-agent:composer-2.5` (the last pre-kill dispatch).

Deliberately EXCLUDED: line 55 (attempt-5 claude-code:sonnet dispatch) — the fixture pins the
canonical incident shape where the consult-chosen assignment is the last dispatch; and lines
57–58 (run-resume + the attempt-0 re-dispatch), which are the DEFECT's output, not input state.

Expected `replayResumeState()` derivation for P43-03 from this fixture:
attempts = 5 (count of task-dispatch events), tried = ["pi:zai/glm-5.2",
"cursor-agent:composer-2.5"] (ordered dedup of dispatched channelKeys), lastAssignment =
cursor-agent:composer-2.5.
