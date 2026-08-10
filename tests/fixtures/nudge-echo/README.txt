nudge-echo — the daemon's own bytes on a worker pane (T22)

pane-<cols>-before.txt     a 999-row read of the pane immediately BEFORE the nudge was typed
pane-<cols>-after.txt      a 1000-row read of the same pane immediately after typing, echo included
pane-<cols>-submitted.txt  a 1000-row read after ENTER — the message submitted and answered

Provenance — recorded, not written
  Captured from a live terminal, twice, at two widths:

    tmux new-session -d -s nudgecap<cols> -x <cols> -y 40 "bash --norc --noprofile -i"
    tmux set-option -t nudgecap<cols> history-limit 5000
    tmux send-keys  -t nudgecap<cols> "PS1='> '" Enter
    tmux send-keys  -t nudgecap<cols> "seq 1 1400" Enter                           # narrow bulk
    tmux send-keys  -t nudgecap<cols> "git --no-pager log --format=%s -n 5" Enter  # long rows
    tmux capture-pane -p -t nudgecap<cols> -S -3000 | tail -n 999   > pane-<cols>-before.txt
    tmux send-keys  -t nudgecap<cols> -l "<WORKER_NUDGE_MESSAGE verbatim>"         # the daemon typing
    tmux capture-pane -p -t nudgecap<cols> -S -3000 | tail -n 1000  > pane-<cols>-after.txt
    tmux send-keys  -t nudgecap<cols> Enter                                        # the daemon submitting
    tmux capture-pane -p -t nudgecap<cols> -S -3000 | tail -n 1000  > pane-<cols>-submitted.txt

  Every line break here was made by the terminal, not by a person and not by a test: the echo is the
  shipped WORKER_NUDGE_MESSAGE (src/run/daemon.ts) typed into the input line and wrapped where the
  right margin fell. The bounded `tail` is the capture of a bounded read — what `driver.read(slot,
  N)` performs — so `before` is a read one raw row below PANE_READ_ROWS and `after` is the same
  pane, full, after the daemon wrote into it. Only the trailing newline `tail` adds was removed;
  nothing was re-wrapped, tiled, concatenated or padded, then or since.

  The reads differ the way a real bounded read differs: `after` gained the echo's rows and lost as
  many off the top. Tests therefore never slice an "echo" out of these files — they hand the
  captures to the tracker exactly as the daemon does. No test knows what the daemon's bytes are.

  Why the third capture (review finding, material)
  `HerdrDriver.nudge` types WITHOUT Enter, verifies the read-back, and only then presses Enter and
  lets the message be answered — several render phases inside ONE `driver.nudge` call. A capture
  that stops after typing is the intermediate frame, not the delivery; a bracket tested only against
  it froze ownership there. So Enter is pressed and the pane captured again: the typed rows are
  still resident, carried up by the scroll the answer pushed in (45 rows at 40 columns, 24 at 100),
  which is exactly what a bracket closing at the typed frame mis-read as a full-window scroll of
  worker output and latched saturation on. The answer here is the shipped `tickmarkr` CLI's own
  usage text, because the shell ran the submitted line — recorded output, not a written one.

Why this transcript
  The bulk is a plain counter: 1400 rows of one to four characters, unique so the tracker's
  structural anchors have something to match, and narrow so a 999-row window costs ~5 kB instead of
  ~50 kB — a corpus this task can carry inside gates.diffCap with none of it set aside unread. The
  tail of five commit subjects is what carries the widths apart: those rows fold at 40 columns and
  stand as single rows at 100, so the two `before` captures are different renderings of the same
  terminal session rather than one file twice.

Why these two widths
  The message plus the input line's "> " prefix is 202 columns of text: at 40 columns that is 5 full
  rows + 2 characters, at 100, 2 full rows + 2. Both leave a FINAL ECHO ROW OF TWO CHARACTERS
  ("g."), which is what makes a "blank any row shorter than N" removal provably wrong — it would
  drop genuine two-character worker rows at exactly the same rate. Any re-capture must keep that
  property; at a width where the message divides evenly the length trap is invisible.
