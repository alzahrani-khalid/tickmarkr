#!/bin/bash
# watch-context.sh — wake (or act) when a seat's CONTEXT is running out, and only clear when it is SAFE.
#
# Context is the one resource a seat cannot observe about itself reliably and cannot recover from once
# spent. This project's law is `/clear` plus a fresh brief, NEVER `/compact` — a compaction is a lossy
# summary nobody trusts, while a clean session re-oriented from disk-verifiable state is reliable.
#
# The measurement everyone misses: a seat's context percentage is RENDERED IN ITS OWN STATUSLINE. It does
# not need to be asked, and asking is unreliable — a seat estimating its own usage is guessing.
#
# WHAT MAKES A CLEAR SAFE, and this is the whole point of the script:
#   A clear is safe exactly when NOTHING THE SEAT IS HOLDING EXISTS ONLY IN ITS HEAD.
# Operationally: a handoff artifact exists AND is newer than the seat's last significant action. If the
# handoff is stale, the seat is holding state that a clear would destroy, and the correct move is to wake
# a supervisor — never to clear and hope.
#
# THIS WATCHER IS SUPERVISED, and the tier is PER SEAT: `<role>-context`, one per supervising seat, so a
# live overseer watcher can never make a dead orchestrator one read as covered. Every beat declares the
# seat it watches (`--seat`), because a tier that is armed and seatless reads as coverage, which is worse
# than absent. Four rules the shipped version broke, each of which made the tier lie:
#   1. BEAT ON THE SUPERVISION CADENCE, NOT ON THE POLL. Beats gap by TICK (below), never by POLL, so a
#      poll interval above the supervision beat interval cannot leave the tier stale half of every cycle.
#   2. BEAT AFTER EVERY SUCCESSFUL SCREEN READ. A missing percentage is an explicit UNREADABLE
#      observation: it must keep the live watcher armed but can never reach warn or act. Only a failed
#      screen read withholds the beat, because then the watcher cannot see its seat at all.
#   3. WARN DOES NOT EXIT. Warn precedes act, so exiting at warn meant the act was never reached and the
#      last beat aged into a permanent stale — gradual growth never reached the auto-clear path at all.
#   4. EVERY TERMINAL EXIT STANDS THE TIER DOWN, so a watcher that finished reads DISARMED, not dead.
#      Only a killed watcher reads STALE, which is exactly what STALE means.
#   5. AN UNREADABLE FIELD REPORTS ITSELF (OBS-739/780). Silence, health and a trustworthy percentage
#      are three different states. UNREADABLE stays supervised but never authorises a destructive act.
#
# usage: watch-context.sh <role-slug> <agent|pane> <warn-pct> <act-pct> [handoff-file] [poll-s] [cap-s]
#   <role-slug> is ANY seat role — orchestrator, overseer, surgeon, consult — and names the tier
#   `<role>-context`. It is deliberately NOT a closed set: see OBS-730 at the guard below.
#   TKR_AUTO_CLEAR=1   at act-pct WITH a fresh handoff, auto-clear orchestrator/overseer; other roles wake only.
#   TKR_REBRIEF=<path> the file the re-briefed seat is told to read (defaults to the handoff).
#   TKR_HANDOFF_MAX_AGE_S  how fresh "fresh" is (default 900).
#   TKR_CLEAR_SETTLE_S     seconds allowed for the cleared banner percentage to drop (default 6).
#   TKR_BLIND_ALARM_S      seconds unreadable before CONTEXT_BLIND alarms (default 120).
#   TKR_CONTEXT_WINDOW     context window in tokens. Set it when the banner does not name one;
#                          NEVER guessed — a wrong denominator makes every warn and act line wrong.

set -u
ROLE="${1:?supervising seat role required: orchestrator|overseer}"
TARGET="${2:?agent name or pane id required}"
WARN="${3:-60}"
ACT="${4:-75}"
HANDOFF="${5:-}"
POLL="${6:-120}"
CAP="${7:-28800}"
MAXAGE="${TKR_HANDOFF_MAX_AGE_S:-900}"
REBRIEF="${TKR_REBRIEF:-$HANDOFF}"
SETTLE="${TKR_CLEAR_SETTLE_S:-6}"

# OBS-730: this rejected every role that was not orchestrator|overseer with exit 64 — while the skill
# mandates a context watcher on EVERY spawned seat. The rule and its own instrument disagreed, so the
# rule was unsatisfiable for surgeons, consults and every auxiliary seat, and the gap read as coverage.
# Any role slug names a tier; validate the SHAPE (a tier name reaches a shell) and never the membership.
case "$ROLE" in
  *[!a-zA-Z0-9_-]*|'')
    echo "watch-context.sh: role '$ROLE' must be a non-empty slug of [a-zA-Z0-9_-]" >&2; exit 64 ;;
esac
TIER="${ROLE}-context"

# A shared target does not identify its watcher owner. The arming seat records this exact pid under
# the repository state dir; retirement reads that file and never matches a script/target name pattern.
PID_DIR="${TKR_STATE_DIR:-.tickmarkr}/overseer/pids"
PID_SEAT=$(printf '%s' "${TKR_ARMING_SEAT:-unattributed}" | sed 's/[^A-Za-z0-9_-]/_/g')
PID_FILE="$PID_DIR/${PID_SEAT}-watch-context-$$.pid"
mkdir -p "$PID_DIR" && (umask 077; printf '%s\n' "$$" > "$PID_FILE") || {
  echo "watch-context: cannot record pid under $PID_DIR" >&2; exit 73;
}
clear_pid() { rm -f "$PID_FILE"; }

# The supervision beat interval (SUPERVISION_BEAT_MS = 10s). The loop ticks at the beat cadence or the
# caller's poll, whichever is SHORTER. Every successful screen read beats; its result is either a
# percentage safe to compare or the explicit UNREADABLE state.
BEAT_EVERY=5
TICK=$(( POLL < BEAT_EVERY ? POLL : BEAT_EVERY ))
[ "$TICK" -ge 1 ] 2>/dev/null || TICK=1   # a zero or junk poll would spin, not watch
SEAT="$TARGET"
# ⚠ THE OTHER HALF OF OBS-730 LIVES IN THE PRODUCT, NOT HERE. `tickmarkr beat` enforces its own CLOSED
# tier set (`src/run/supervision.ts:45`), so widening only this script would let an auxiliary seat's
# watcher run while every beat failed SILENTLY — armed-looking, tier nonexistent. That is strictly worse
# than the exit 64 it replaced, and it is the precise failure this whole file exists to prevent.
# So PROBE ONCE and be loud about the answer. Watching still has real value without a tier — the warn,
# act and blind lines all still fire — but it must never be mistaken for registered supervision.

# ⚠ THE OTHER HALF OF OBS-730 LIVES IN THE PRODUCT, NOT HERE. `tickmarkr beat` enforces its own CLOSED
# tier set (`src/run/supervision.ts:45`), so widening only this script would let an auxiliary seat's
# watcher run while every beat failed SILENTLY — armed-looking, tier nonexistent, which is strictly
# WORSE than the exit 64 it replaced and is the precise failure this file exists to prevent.
# The refusal is reported by the FIRST REAL BEAT rather than by a startup probe: a probe that beats
# would emit one before any successful read and break rule 2 outright, and a probe that parses the
# usage banner binds this script to another command's help text. Beating is what we do anyway, so it
# perturbs nothing — and because a beat only ever follows a successful read, rule 2 still holds.
beat_refused=0
beat() {
  tickmarkr beat "$TIER" --seat "$SEAT" >/dev/null 2>&1 && return 0
  if [ "$beat_refused" -eq 0 ]; then
    beat_refused=1
    echo "TIER_UNREGISTERED ${TIER} — the product refused this tier (its set: src/run/supervision.ts:45)"
    echo "  watching CONTINUES and every warn/act/blind line below is real"
    echo "  but \`tickmarkr status\` will NOT show this seat as covered — never read that absence as safe"
  fi
  return 0
}
stand_down() { tickmarkr beat "$TIER" --stand-down --seat "$SEAT" >/dev/null 2>&1; return 0; }
# EVERY terminal exit — act, unsafe-act, cap — leaves through here, so none of them can forget to
# record the hand-off. A killed watcher never runs it, which is the one case that must read STALE.
cleanup() { stand_down; clear_pid; }
trap cleanup EXIT

# ── WHERE THE NUMBER COMES FROM, and this is the whole 2.1.7-series lesson ────────────────────────────
# The shipped version read a TERMINAL RENDERING and nothing else. Every context-measurement failure of
# that series is downstream of that one choice: a rendering can be truncated by pane width, can push the
# real field out of the visible window, and can leave a stale N% in scrollback for a bare numeric search
# to borrow (OBS-780). **The value is not on the screen. It is in the session JSONL**, which is exact,
# append-only, and indifferent to how wide the pane is.
#
# ⚠ NAME THE QUANTITY, because two numbers live in that file and they differ by two orders of magnitude:
#   * CONTEXT FILL  = the LAST usage-bearing record's input_tokens + cache_creation + cache_read.
#     This is what is in the window right now. **This is the only one a clear threshold may use.**
#   * CUMULATIVE CONSUMPTION = the same sum added up over every record, plus output.
#     Measured 2026-08-31 on two live sessions in this workspace: **118.5x the fill over 175
#     usage records, and 28.4x over 35.**
#     ⛔ **THE FACTOR IS NOT A CONSTANT — IT GROWS WITH SESSION LENGTH**, because cumulative adds a
#     term per request while fill is what ONE request holds. The two numbers above are two points on
#     that curve, NOT a range and NOT a property of the quantity. **Never quote a single figure as
#     "the" ratio**, and never average two: a longer session yields a larger one, without limit.
#     The banner shows this one too, as `sum N tok`, right beside the fill percentage.
#   **Quoting fill as consumption, or consumption as fill, is wrong by that factor. Say which you mean.**
#
# ⛔ AND THE DENOMINATOR IS NOT IN THE JSONL. Its `model` field reads `claude-opus-5` with no context-size
# suffix, so a 200k default would have read three live 1M seats here at 106%, 150% and 90% — the 150% seat
# would have been auto-cleared on the first tick. **A window is resolved explicitly or read once from the
# banner; it is never assumed.** Reading a per-session CONSTANT once from the fragile surface, and the
# per-tick VARIABLE from the robust one, is the trade this makes.
# Calibrated 2026-08-31 against three live seats: banner 21/30/18% vs JSONL fill 21.2/30.0/17.9%. Same
# quantity, same direction, same denominator — so the existing WARN/ACT thresholds carry over unchanged.

CTX_JSONL=""
CTX_WINDOW="${TKR_CONTEXT_WINDOW:-0}"

# TARGET is an agent name or a pane id; `herdr agent list` carries both, plus the session uuid that names
# the JSONL. The uuid is unique, so glob for it rather than reconstructing the project-dir slug — a slug
# rule is a second thing that can rot.
resolve_jsonl() {
  local sid
  sid=$(herdr agent list 2>/dev/null | python3 -c '
import sys, json
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
t = sys.argv[1]
for a in d.get("result", {}).get("agents", []):
    if t in (a.get("pane_id"), a.get("name")):
        print((a.get("agent_session") or {}).get("value") or "")
        break
' "$TARGET" 2>/dev/null) || return 1
  [ -n "$sid" ] || return 1
  CTX_JSONL=$(ls "$HOME"/.claude/projects/*/"$sid".jsonl 2>/dev/null | head -1)
  [ -n "$CTX_JSONL" ]
}

# The banner names its own window ("Opus 5 (1M context)"). Read it ONCE; it cannot change mid-session.
resolve_window() {
  [ "$CTX_WINDOW" -gt 0 ] 2>/dev/null && return 0
  local w
  w=$(herdr agent read "$TARGET" --source visible --lines 8 2>/dev/null |
      grep -oEi '\(([0-9]+(\.[0-9]+)?)[KM] context\)' | tail -1 |
      grep -oEi '[0-9]+(\.[0-9]+)?[KM]') || return 1
  case "$w" in
    *[Kk]) CTX_WINDOW=$(awk -v n="${w%[Kk]}" 'BEGIN{printf "%d", n*1000}') ;;
    *[Mm]) CTX_WINDOW=$(awk -v n="${w%[Mm]}" 'BEGIN{printf "%d", n*1000000}') ;;
    *) return 1 ;;
  esac
  [ "$CTX_WINDOW" -gt 0 ] 2>/dev/null
}

jsonl_pct() {
  [ -n "$CTX_JSONL" ] && [ -f "$CTX_JSONL" ] && [ "$CTX_WINDOW" -gt 0 ] 2>/dev/null || return 1
  python3 -c '
import sys, json
path, window = sys.argv[1], int(sys.argv[2])
fill = 0
with open(path, encoding="utf-8", errors="replace") as fh:
    for line in fh:
        try: rec = json.loads(line)
        except Exception: continue
        usage = (rec.get("message") or {}).get("usage")
        if not isinstance(usage, dict): continue
        # CONTEXT FILL — this request s window occupancy. Never a running total.
        n = sum(int(usage.get(k) or 0) for k in
                ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        if n: fill = n
if not fill: sys.exit(1)
print(int(round(fill * 100.0 / window)))
' "$CTX_JSONL" "$CTX_WINDOW" 2>/dev/null
}

# The banner path stays as the FALLBACK, and it now selects by POSITION (OBS-865). A seat's statusline
# renders BELOW the input box's horizontal rule, so the only rows that can carry THIS seat's fill are the
# rows after the LAST rule line in the window. A tip, a transcript row, or a decoy quoting another seat's
# percentage sits ABOVE that rule and can no longer be chosen. The previous selector took the last
# vendor-word line ANYWHERE in the window: on a Fable seat that was `Tip: Ask Claude ...` (UNREADABLE,
# duty silently dead), and a quoted `opus 12%` would have been read as this seat's fill. The model
# vocabulary survives only as a SANITY CHECK on the already-chosen row, never as the selector (OBS-780).
banner_pct() {
  local screen banner pct
  screen=$(herdr agent read "$TARGET" --source visible --lines 8 2>/dev/null) || return 1
  # The rule glyph is passed IN, never written as an escape: this host's awk (BWK 20200816) does not
  # honour \xNN, and an unsupported escape matches nothing — the selector would find no rule line and
  # report UNREADABLE on every real pane while staying green against any fixture that skipped awk.
  banner=$(printf '%s\n' "$screen" | awk -v rule='─' '
    { line[NR] = $0
      bare = $0; gsub(/[[:space:]]/, "", bare)
      stripped = bare; gsub(rule, "", stripped)
      if (bare != "" && stripped == "") last = NR }
    END { if (last) for (i = last + 1; i <= NR; i++) if (line[i] ~ /[0-9]+%/) print line[i] }
  ' | tail -1)
  # No rule line in the window, or no percentage below it: say so out loud rather than guess.
  [ -n "$banner" ] || { printf 'UNREADABLE\n'; return 0; }
  printf '%s\n' "$banner" |
    grep -Eqi '(^|[^[:alnum:]])(claude|opus|sonnet|haiku|fable|gpt|gemini|glm|kimi|grok|composer|openai|zai)[[:alnum:]_./-]*([[:space:]]|$)' ||
    { printf 'UNREADABLE\n'; return 0; }
  pct=$(printf '%s\n' "$banner" | grep -oE '[0-9]+%' | tail -1 | tr -d '%')
  [ -n "$pct" ] && printf '%s\n' "$pct" || printf 'UNREADABLE\n'
}

context_pct() {
  local p
  if p=$(jsonl_pct) && [ -n "$p" ]; then printf '%s\n' "$p"; return 0; fi
  banner_pct
}

status_of() {
  herdr agent get "$TARGET" 2>/dev/null \
    | sed -n 's/.*"agent_status":"\([a-z_]*\)".*/\1/p' | head -1
}

# A clear is a SEND, so it inherits the verified-send precondition: the target must be between turns
# and its live prompt line must contain no typed draft. Claude Code's autosuggest is text in the plain
# rendering but is wrapped in SGR dim in the ANSI rendering; it is decoration, not a draft. Parse the
# Esc-prefixed SGR bytes instead of treating every visible character after the prompt glyph as state.
prompt_is_empty_or_dim() {
  herdr agent read "$TARGET" --source visible --lines 14 --format ansi 2>/dev/null | python3 -c '
import re, sys
screen = sys.stdin.read().splitlines()
ansi = re.compile(r"\x1b\[([0-9;]*)m")
prompt = None
for line in screen:
    plain = ansi.sub("", line).lstrip()
    if plain.startswith(("❯", "›")):
        prompt = line
if prompt is None:
    sys.exit(1)
glyph = min((i for i in (prompt.find("❯"), prompt.find("›")) if i >= 0), default=-1)
if glyph < 0:
    sys.exit(1)
payload = prompt[glyph + 1:]
dim = False
pos = 0
for match in ansi.finditer(payload):
    if payload[pos:match.start()].strip() and not dim:
        sys.exit(1)
    codes = [int(c) if c else 0 for c in match.group(1).split(";")]
    if 0 in codes:
        dim = False
    if 2 in codes:
        dim = True
    if 22 in codes:
        dim = False
    pos = match.end()
if payload[pos:].strip() and not dim:
    sys.exit(1)
' 2>/dev/null
}

clear_target_ready() {
  CLEAR_STATUS=$(status_of)
  case "$CLEAR_STATUS" in
    idle|done) ;;
    *) CLEAR_REASON="status=${CLEAR_STATUS:-unreadable}"; return 1 ;;
  esac
  if ! prompt_is_empty_or_dim; then
    CLEAR_REASON="status=$CLEAR_STATUS prompt=typed-or-unreadable"
    return 1
  fi
  return 0
}

# `/clear` has landed only when a fresh banner read says its context percentage is lower. The JSONL
# source deliberately does not participate in this receipt: it names the pre-clear session and can
# remain at the old fill while the new prompt is already visible. No drop means no re-brief and no
# CONTEXT_CLEARED claim.
wait_for_clear_receipt() {
  local before="$1" waited=0 after
  case "$SETTLE" in *[!0-9]*|'') return 1 ;; esac
  while :; do
    after=$(banner_pct 2>/dev/null) || after=""
    if printf '%s\n' "$after" | grep -qE '^[0-9]+$' \
       && [ "$after" -lt "$before" ] 2>/dev/null; then
      printf '%s\n' "$after"
      return 0
    fi
    [ "$waited" -lt "$SETTLE" ] || return 1
    sleep 1
    waited=$((waited + 1))
  done
}

handoff_fresh() {
  [ -n "$HANDOFF" ] || return 1
  [ -f "$HANDOFF" ] || return 1
  local age now mt
  now=$(date +%s)
  mt=$(stat -c %Y "$HANDOFF" 2>/dev/null || stat -f %m "$HANDOFF" 2>/dev/null) || return 1
  age=$((now - mt))
  [ "$age" -le "$MAXAGE" ]
}

act_on() {
  local P="$1" BEFORE AFTER
  if handoff_fresh; then
    if [ "${TKR_AUTO_CLEAR:-0}" = "1" ] && { [ "$ROLE" = "orchestrator" ] || [ "$ROLE" = "overseer" ]; }; then
      if ! clear_target_ready; then
        echo "CONTEXT_ACT_DEFERRED $TARGET at ${P}% — ${CLEAR_REASON}; waiting for idle and an empty/dim-only prompt line"
        return 0
      fi
      BEFORE=$(banner_pct 2>/dev/null) || BEFORE=""
      case "$BEFORE" in ''|*[!0-9]*) echo "CONTEXT_CLEAR_UNVERIFIED $TARGET — no numeric banner baseline; not clearing"; return 0 ;; esac
      herdr agent prompt "$TARGET" "/clear" >/dev/null 2>&1
      if ! AFTER=$(wait_for_clear_receipt "$BEFORE"); then
        echo "CONTEXT_CLEAR_UNVERIFIED $TARGET at ${P}% — banner did not re-read below ${BEFORE}% within ${SETTLE}s"
        echo "  no re-brief sent and CONTEXT_CLEARED withheld; inspect the seat before acting again"
        exit 0
      fi
      herdr agent prompt "$TARGET" "Read ${REBRIEF} and continue exactly where it says. Your context was cleared at ${P}% against that handoff; it is current as of $(date '+%H:%M'). The same-process clear kept every background task alive: kill only this seat's recorded watcher pids first, verify the process table twice, then re-arm. Do not reconstruct from memory — everything you need is on disk." >/dev/null 2>&1
      echo "CONTEXT_CLEARED $TARGET ${P}% -> ${AFTER}% — banner re-read lower, handoff fresh, re-briefed from ${REBRIEF}"
      exit 0
    fi
    echo "CONTEXT_ACT $TARGET ${P}% (>= ${ACT}) — handoff is FRESH, a clear is SAFE now"
    echo "  herdr agent prompt $TARGET \"/clear\"  then re-brief from ${REBRIEF}"
    exit 0
  fi
  echo "CONTEXT_ACT_UNSAFE $TARGET ${P}% (>= ${ACT}) — NO FRESH HANDOFF (${HANDOFF:-none})"
  echo "  the seat is holding state that exists only in its head; a clear would destroy it"
  echo "  make it write the handoff FIRST, then clear"
  exit 0
}

# Resolve the JSONL source ONCE, and SAY which surface is in use. A watcher that silently fell back to
# the fragile path looks identical to one on the robust path, and the difference is the whole point.
if resolve_jsonl && resolve_window; then
  echo "CONTEXT_SOURCE jsonl $TARGET — CONTEXT FILL from $CTX_JSONL against a ${CTX_WINDOW}-token window"
  echo "  this is FILL (what is in the window now), never cumulative consumption — measured 28x and 118x"
  echo "  apart here, and that factor GROWS with session length; never quote one figure as the ratio"
else
  echo "CONTEXT_SOURCE banner $TARGET — JSONL unresolved (session=${CTX_JSONL:-none} window=${CTX_WINDOW})"
  echo "  falling back to the rendered banner; set TKR_CONTEXT_WINDOW to use the JSONL"
fi

warned=0
elapsed=0
blind=0            # seconds in the current failed-read spell (OBS-739)
blind_alarmed=0
unreadable_reported=0
BLIND_ALARM_S="${TKR_BLIND_ALARM_S:-120}"
while [ "$elapsed" -lt "$CAP" ]; do
  if ! P=$(context_pct); then P=""; fi
  if [ -z "$P" ]; then
    # The screen read itself failed: no observation, no beat. The tier ages to STALE and the watcher
    # alarms once, because an instrument that cannot see its seat must never look healthy.
    unreadable_reported=0
    blind=$((blind + TICK))
    if [ "$blind" -ge "$BLIND_ALARM_S" ] && [ "$blind_alarmed" -eq 0 ]; then
      blind_alarmed=1
      echo "CONTEXT_BLIND $TARGET — screen unreadable for ${blind}s; tier ${TIER} is ALIVE AND BLIND"
      echo "  this watcher is NOT providing coverage: read the seat by hand and repair the screen read"
    fi
    sleep "$TICK"; elapsed=$((elapsed + TICK)); continue
  fi

  if [ "$P" = "UNREADABLE" ]; then
    # The screen read succeeded, so keep the watcher armed. The absent field is still not a number:
    # report it once per spell and never let it flow into warn or act.
    if [ "$blind_alarmed" -eq 1 ]; then
      echo "CONTEXT_BLIND_CLEARED $TARGET — screen readable again after ${blind}s blind"
    fi
    blind=0; blind_alarmed=0
    beat
    if [ "$unreadable_reported" -eq 0 ]; then
      unreadable_reported=1
      echo "CONTEXT_UNREADABLE $TARGET — model banner has no visible percentage; no warn or act authorised"
    fi
    sleep "$TICK"; elapsed=$((elapsed + TICK)); continue
  fi

  if [ "$unreadable_reported" -eq 1 ]; then
    echo "CONTEXT_UNREADABLE_CLEARED $TARGET — percentage readable again at ${P}%"
  fi
  if [ "$blind_alarmed" -eq 1 ]; then
    echo "CONTEXT_BLIND_CLEARED $TARGET — percentage readable again at ${P}% after ${blind}s blind"
  fi
  blind=0; blind_alarmed=0; unreadable_reported=0
  beat

  if [ "$P" -ge "$ACT" ] 2>/dev/null; then
    act_on "$P"
  fi

  if [ "$P" -ge "$WARN" ] 2>/dev/null && [ "$warned" -eq 0 ]; then
    # Rule 3: warn is a LINE, not an exit — the act is on the far side of it.
    warned=1
    echo "CONTEXT_WARN $TARGET ${P}% (>= ${WARN}) — write the handoff NOW, while judgement is still good"
    echo "  re-brief target when it acts: ${REBRIEF:-none}"
    echo "  a handoff written at ${ACT}% is written by a seat already degraded; that is the wrong time"
  fi

  sleep "$TICK"; elapsed=$((elapsed + TICK))
done

echo "WATCH_CAP_REACHED $TARGET — no threshold crossed in ${CAP}s"
