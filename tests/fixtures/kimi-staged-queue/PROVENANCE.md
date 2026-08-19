# Captured negative control — kimi staged-queue false receipt (OBS-552 addendum)

`visible.txt` is the rendered `herdr agent read --source visible` shape of a **kimi seat that has
staged a directive instead of running it**, from the live P99R implementation seat in the Intl-Dossier
trial workspace on 2026-08-19. The frozen trial target was observed read-only and never patched.

**What is VERBATIM and what is RECONSTRUCTED — read this before trusting the file.** The staged line's
form, including the affordance `↑ to edit · ctrl-s to steer immediately`, is verbatim: it is quoted
twice in that workspace's own record (`.tickmarkr/overseer/P99R-IMPL-STATE-01.md`, "Adapter defect —
kimi TUI message queue") and again in the residual report. The **surrounding frame is reconstructed**
to reproduce the measured discriminator outcome — the ordinary `❯` box rendering EMPTY and FIRST, which
is what `head -1` selects and what made the receipt read "clear of our text". Raw screen bytes were not
captured before the seat was TERM'd and restarted, so this file is a faithful reproduction of the
recorded BEHAVIOUR, not a byte capture, and it is labelled that way rather than borrowing the authority
of one. The test's red-capability control is what actually pins the defect: the pre-fix receipt must
print `DELIVERED_SUBMITTED` against this input, and the fixed one must not.

`seat-send-v1.96.sh` is a verbatim copy of
`961a855a~1:skills/tickmarkr-overseer/scripts/seat-send.sh` from the private development history:
the exact receipt shipped in npm 1.96.0. It is vendored because the public repository is a one-commit
squashed export and cannot resolve that private object id; the red control must remain runnable there.

**Why this shape is the whole defect.** Two `❯` regions render at once: the ordinary input box, which
kimi **empties** when it queues, and the staged entry carrying kimi's own affordance
`↑ to edit · ctrl-s to steer immediately`. `seat-send.sh`'s receipt read the first `❯` line, found it
empty, and reported `DELIVERED_SUBMITTED` — while the directive sat in the queue and the pane revision
never moved off 3 across six input attempts.

**What the capture must keep verbatim** (a paraphrase would not falsify the receipt):

- the empty ordinary `❯` box rendering BEFORE the staged line, which is what `head -1` selects;
- the staged `❯` line with the affordance suffix intact;
- the affordance's exact words `↑ to edit` and `steer`, which are what the discriminator matches — it
  keys on the affordance, never on a vendor name, so any TUI that grows this queue is covered.

**Measured against that state, every input path failed** (from the recorded table): `seat-send.sh`
false-positive `DELIVERED_SUBMITTED`; bare `enter` on the empty box no-op; `ctrl-s` unavailable because
`herdr agent send-keys` supports no ctrl chords; `herdr agent prompt` twice → `agent_prompt_stalled`,
text staged; `up` then `enter` moved the entry to the box and put it **back** in the queue;
`herdr pane run` no effect (a shell-pane path). Recovery was provenance capture (pid 51611, ppid 51415,
pgid 51611, lstart `Wed Aug 19 15:09:25 2026`), TERM, then `herdr agent start … -- --auto -c -m
kimi-code/k3` in the same pane; session continuation preserved 136k of context and the queue drained.

That is why the fixed receipt fails closed as `SEND_UNVERIFIED` and offers no delivery remedy: there is
none to offer, and a retry would run the directive twice the moment the queue drains.
