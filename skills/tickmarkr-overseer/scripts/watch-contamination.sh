#!/bin/bash
# watch-contamination.sh â wake the AUTHORITY seat when a gate VERDICT may be contaminated.
#
# Operator, 2026-08-07: "that is the kind of job I need overseer to be vigilant about."
#
# Why this belongs to the authority tier and not the orchestrator: deciding gates is this seat's
# column, and a gate verdict produced under machine starvation is not a verdict. Verifying the
# CONDITIONS under which evidence was produced is therefore part of ruling on it, not run-driving.
#
# It wakes on the two things that make a red gate untrustworthy:
#   1. a NEW failed gate-result whose details carry an infrastructure fingerprint (OBS-426)
#   2. sustained load high enough that any suite result is suspect
#
# Prints ONE wake reason and exits, so its exit re-invokes the session. Re-arm after every wake.
#
# usage: watch-contamination.sh <journal> <load-ceiling> <poll-s> <cap-s>

set -u
J="${1:?journal path required}"
LOAD_CEIL="${2:-24}"
POLL="${3:-45}"
CAP="${4:-14400}"

# OBS-848: the arming seat owns this pid, even when a partner watches the same journal. Never derive
# retirement ownership from the script or journal argv: both are deliberately shared across tiers.
PID_DIR="${TKR_STATE_DIR:-.tickmarkr}/overseer/pids"
PID_SEAT=$(printf '%s' "${TKR_ARMING_SEAT:-unattributed}" | sed 's/[^A-Za-z0-9_-]/_/g')
PID_FILE="$PID_DIR/${PID_SEAT}-watch-contamination-$$.pid"
mkdir -p "$PID_DIR" && (umask 077; printf '%s\n' "$$" > "$PID_FILE") || {
  echo "watch-contamination: cannot record pid under $PID_DIR" >&2; exit 73;
}
clear_pid() { rm -f "$PID_FILE"; }
trap clear_pid EXIT

# Fingerprints of a harness collapse rather than a real regression. Deliberately narrow: a genuine
# assertion failure must NOT match, or the watcher launders real defects into "infra".
INFRA_RE='vitest-worker|Timeout calling|JS heap out of memory|ENOMEM|EAGAIN|spawn ENOENT|Killed|SIGKILL'

load1() { uptime | sed 's/.*load averages*: *//' | awk '{print $1}' | tr -d ','; }
# Count real vitest runners only. `pgrep -f vitest` over-counts by an order: it matches the WORD
# in any argv â worker prompts, VITEST_MAX_FORKS in shell strings (measured 7 vs 2 real, 2026-08-10).
# [v] keeps the pattern from matching its own grep. Forked workers retitle to "node (vitest N)" (comm).
vitest_n() { ps -axo comm,command 2>/dev/null | grep -Ec 'node_modules/(\.bin/)?[v]itest|[v]itest/dist/|\([v]itest [0-9]+\)'; }

# Seed the seen-set so we wake on what happens NEXT, not on history already ruled on.
if [ -f "$J" ]; then seen=$(grep -c '' "$J" 2>/dev/null); else seen=0; fi
[ -n "$seen" ] || seen=0

elapsed=0
while [ "$elapsed" -lt "$CAP" ]; do
  sleep "$POLL"
  elapsed=$((elapsed + POLL))

  L=$(load1); V=$(vitest_n)
  # OBS-585: strip at the first NON-DIGIT, never at "." - a locale that renders the load average
  # with U+066B (3٫48) or a comma leaves the period-strip a no-op, the numeric test below then
  # errors, and its 2>/dev/null hides that, so the LOAD trigger dies silently at every load.
  # Proven against the incident this watcher exists for: 35٫26 vs ceiling 24 never fired.
  Li=$(printf %s "$L" | sed "s/[^0-9].*//"); [ -z "$Li" ] && Li=0

  if [ -f "$J" ]; then
    now=$(grep -c '' "$J" 2>/dev/null); [ -z "$now" ] && now=0
    if [ "$now" -gt "$seen" ]; then
      newrows=$(tail -n "$((now - seen))" "$J" 2>/dev/null)
      seen="$now"
      # A fingerprint in arbitrary JSON details is prose, not an occurrence. Parse the event shape,
      # admit only runner gates, and stop before the baseline classifier's secondary echo list. Review
      # findings and acceptance prose are deliberately outside this instrument's claim.
      hit=$(printf '%s\n' "$newrows" | python3 -c '
import json, re, sys
infra = re.compile(sys.argv[1], re.I)
for raw in sys.stdin:
    try: row = json.loads(raw)
    except Exception: continue
    data = row.get("data") or {}
    gate = data.get("gate")
    if row.get("event") != "gate-result" or data.get("pass") is not False or gate not in {"test", "build", "lint"}: continue
    details = str(data.get("details") or "")
    runner = re.split(r"(?im)^new failure fingerprints vs baseline \(secondary\):[ \t]*$", details, maxsplit=1)[0]
    match = infra.search(runner)
    if match:
        end = runner.find("\n", match.end())
        line = runner[runner.rfind("\n", 0, match.start()) + 1:end if end >= 0 else len(runner)]
        print("%s\t%s\t%s" % (row.get("taskId", ""), gate, line))
        break
' "$INFRA_RE")
      if [ -n "$hit" ]; then
        task=$(printf '%s' "$hit" | cut -f1)
        gate=$(printf '%s' "$hit" | cut -f2)
        echo "CONTAMINATED_VERDICT task=$task gate=$gate load=$L vitest=$V"
        echo "  an infra fingerprint appeared in a FAILED gate â this red is not evidence about the diff"
        echo "  ruling owed: is the attempt chargeable? (OBS-426: infra failures are not)"
        exit 0
      fi
    fi
  fi

  if [ "$Li" -ge "$LOAD_CEIL" ] 2>/dev/null; then
    echo "LOAD_CEILING load=$L (ceiling $LOAD_CEIL) vitest=$V"
    echo "  any suite result produced now is suspect; a red test gate may be starvation, not a regression"
    exit 0
  fi
done

echo "WATCH_CAP_REACHED load=$(load1) vitest=$(vitest_n) â no contaminated verdict seen in ${CAP}s"
