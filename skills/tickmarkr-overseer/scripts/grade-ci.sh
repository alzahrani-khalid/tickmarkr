#!/bin/bash
# grade-ci.sh <run-id> <expected-sha> <repo-dir> [tag] — grade EVERY job of a public CI run of <expected-sha>
# from GitHub's structured run record and each job's uploaded proof group (v2.8.2 T3, ANL-022 §7.2b; queue rows
# 165 and 148). NO LOG TEXT IS READ: no job log, no step label, no `##[error]` annotation decides anything.
# Grade only at run-end. Exit 0 GREEN, 1 RED, 2 UNREADABLE, 3 INFRA_KILLED: a cancelled run, job or declared
# step with no failed declared step — never green, never a pass, only unproven.
# UNREADABLE dominates a mixed result, then RED: a failure anywhere dominates a kill.
#
# INPUT: <expected-sha> is 40 lowercase hex naming a commit in <repo-dir> — the mirror clone (RELEASING.md step
# 4) or the Release workflow's own checkout — else exit 2 before any gh call. No count argument: the manifest of
# tracked test files is recomputed from that commit.
# ONE READ: `gh run view <run-id> --json headSha,status,conclusion,jobs`. IDENTITY: UNREADABLE, before any
# download, unless the run's headSha is <expected-sha> and its status is completed.
#
# Two CLOSED inventories (v2.7.8 T4; the workflow renders these names): serial {test, test-macos}; sharded,
# for os in ubuntu-latest and macos-latest, `suite <os> k/4` for k 1..4, `single-fork <os>`, `aggregate <os>`.
# A run holding any sharded name is graded against the sharded inventory, else the serial one. The first
# line is `INVENTORY form=<serial|sharded> declared=<n> observed=<n>`; each missing, duplicated or unknown
# name prints `INVENTORY_DEFECT kind=<missing|duplicate|unknown> job=<json-quoted name>` and makes the run
# UNREADABLE: a job the inventory does not name is never skipped. The sharded proof-group selection is ANL-022
# §7.4's, so until it ships a sharded run reads UNREADABLE after its INVENTORY line.
#
# Per serial job, every part from the same read or the job's own artifact:
#   steps        each DECLARED step below present exactly once in .jobs[].steps[] (missing or duplicated ->
#                UNREADABLE); GREEN needs every one `success`. A cancelled job or declared step is INFRA_KILLED
#                unless a declared step concluded `failure` (then RED); the steps a kill skipped do not count.
#   conclusions  GREEN also needs the job's and the run's conclusion `success`, so a failing undeclared step (an
#                action's post-step) reds the grade; a cancelled run is INFRA_KILLED, and any other run conclusion
#                no job's grade accounts for is RED.
#   proof        `gh run download <run-id> -n proof-<job>` into a fresh directory (missing -> UNREADABLE), then
#                the grader's own checkout's `tsx scripts/ci/cli.ts proof --head <expected-sha> --repo <repo-dir>
#                <dir>` (that checkout is the git toplevel holding this script; without its cli.ts, exit 2):
#                the group's original records read CLEAN or RPC_ONLY at <expected-sha>, the tracked set recomputed
#                from the commit holds every file once and finished, and the floors sidecar reads GREEN.
# Output: the INVENTORY lines, `RUN head=… expected=… status=… conclusion=…`, per job `<job>: steps=[…]
# proof=[<PROOF line>]` then `<job>: <GRADE>`, and a final `VERDICT rc=<n> …`.
set -u

[ "$#" -ge 3 ] && [ "$#" -le 4 ] \
  || { echo "UNREADABLE: usage: grade-ci.sh <run-id> <expected-sha> <repo-dir> [tag]"; exit 2; }
run=$1
sha=$2
repo_dir=$3
tag=${4:-$run}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# the grader's own checkout — the same for the canonical copy and the installed .claude/skills one
checkout=$(git -C "$here" rev-parse --show-toplevel 2>/dev/null)
gh_repo=${TKR_GRADE_CI_REPO:-alzahrani-khalid/tickmarkr}
out_dir=${TKR_GRADE_CI_DIR:-${TKR_STATE_DIR:-.tickmarkr}/overseer/diag}

[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "UNREADABLE: the expected head is not 40 lowercase hex"; exit 2; }
git -C "$repo_dir" cat-file -e "$sha^{commit}" 2>/dev/null \
  || { echo "UNREADABLE: $sha is not a commit in $repo_dir"; exit 2; }
[ -n "$checkout" ] && [ -f "$checkout/scripts/ci/cli.ts" ] \
  || { echo "UNREADABLE: the grader's own checkout holds no scripts/ci/cli.ts to recompute the proof"; exit 2; }
mkdir -p "$out_dir" || { echo "UNREADABLE: cannot create the proof directory $out_dir"; exit 2; }

serial_inventory=$'test\ntest-macos'
sharded_inventory=$(for os in ubuntu-latest macos-latest; do
  for k in 1 2 3 4; do echo "suite $os $k/4"; done
  echo "single-fork $os"
  echo "aggregate $os"
done)
# the serial job's declared steps as GitHub names them (an unnamed `run:` step is `Run <command>`)
serial_steps='Run npm ci
Run npm run build
Run npm run lint
Run coverage proof (parallel suite project)
Recheck coverage floors
Run single-fork projects (independent of the step above)
Assert collected test-file set
Upload proof group'
cli=("$checkout/node_modules/.bin/tsx" "$checkout/scripts/ci/cli.ts")

verdict=0
mark_unreadable() { verdict=2; }
mark_red() { [ "$verdict" -eq 2 ] || verdict=1; }
mark_killed() { [ "$verdict" -ne 0 ] || verdict=3; }
finish() { echo "VERDICT rc=$verdict (0=all GREEN 1=RED 2=UNREADABLE 3=INFRA_KILLED)"; exit "$verdict"; }
count() { printf '%s' "$1" | grep -c ''; }
# json <name> — one JSON string; awk -v decodes the @tsv escapes (\t \n \r \\) first
json() {
  LC_ALL=C awk -v s="$1" 'BEGIN {
    for (i = 1; i < 32; i++) esc[sprintf("%c", i)] = sprintf("\\u%04x", i)
    esc["\""] = "\\\""; esc["\\"] = "\\\\"
    for (i = 1; i <= length(s); i++) { c = substr(s, i, 1); out = out (c in esc ? esc[c] : c) }
    print "\"" out "\""
  }'
}
defect() { echo "INVENTORY_DEFECT kind=$1 job=$(json "$2")"; mark_unreadable; }

run_json=$(gh run view "$run" --repo "$gh_repo" --json headSha,status,conclusion,jobs) \
  || { echo "UNREADABLE: gh run view $run"; mark_unreadable; finish; }
# the read as @tsv-escaped rows — RUN <head> <status> <conclusion>, JOB <index> <name> <status> <conclusion>,
# STEP <job index> <name> <conclusion>; a null or empty value prints `null`; any other shape fails closed
rows=$(printf '%s' "$run_json" | node -e '
const field = (v) => v === null || v === undefined || v === "" ? "null"
  : String(v).replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
const scalar = (v) => v === null || v === undefined || typeof v === "string" || typeof v === "number";
let text = "";
process.stdin.setEncoding("utf8").on("data", (d) => { text += d; }).on("end", () => {
  try {
    const run = JSON.parse(text);
    const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    if (!object(run) || !Array.isArray(run.jobs) || ![run.headSha, run.status, run.conclusion].every(scalar)) throw 0;
    const out = [["RUN", run.headSha, run.status, run.conclusion]];
    run.jobs.forEach((job, i) => {
      if (!object(job) || ![job.name, job.status, job.conclusion].every(scalar)) throw 0;
      if (job.steps !== undefined && job.steps !== null && !Array.isArray(job.steps)) throw 0;
      out.push(["JOB", i, job.name, job.status, job.conclusion]);
      for (const step of job.steps ?? []) {
        if (!object(step) || ![step.name, step.conclusion].every(scalar)) throw 0;
        out.push(["STEP", i, step.name, step.conclusion]);
      }
    });
    process.stdout.write(out.map((row) => row.map(field).join("\t") + "\n").join(""));
  } catch { process.exit(2); }
});') || { echo "UNREADABLE: gh run view $run returned no readable run record"; mark_unreadable; finish; }
IFS=$'\t' read -r _ head status conclusion <<< "$(printf '%s\n' "$rows" | sed -n $'s/^RUN\t/-\t/p')"
jobs=$(printf '%s\n' "$rows" | sed -n $'s/^JOB\t//p')
steps=$(printf '%s\n' "$rows" | sed -n $'s/^STEP\t//p')
# an empty job list is an inventory like any other: serial, observed=0, every declared job missing

names=$(printf '%s\n' "$jobs" | cut -f2)
if printf '%s\n' "$names" | grep -qxF -f <(printf '%s\n' "$sharded_inventory"); then
  form=sharded; declared=$sharded_inventory
else
  form=serial; declared=$serial_inventory
fi
echo "INVENTORY form=$form declared=$(count "$declared") observed=$(count "$names")"
while IFS= read -r name; do
  case $(printf '%s\n' "$names" | grep -cxF -- "$name") in
    0) defect missing "$name" ;;
    1) ;;
    *) defect duplicate "$name" ;;
  esac
done <<< "$declared"
while IFS= read -r name; do
  printf '%s\n' "$declared" | grep -qxF -- "$name" || defect unknown "$name"
done < <([ -z "$jobs" ] || printf '%s\n' "$names" | awk '!seen[$0]++')

if [ "$form" = sharded ]; then
  echo "SHARDED: UNREADABLE (the sharded proof-group selection is ANL-022 §7.4's and has not shipped)"
  mark_unreadable
  finish
fi

echo "RUN head=$head expected=$sha status=$status conclusion=$conclusion"
if [ "$head" != "$sha" ]; then
  echo "RUN: UNREADABLE (the run's head is not the expected head; nothing downloaded)"
  mark_unreadable
  finish
fi
if [ "$status" != completed ]; then
  echo "RUN: UNREADABLE (the run has not reached run-end; nothing downloaded)"
  mark_unreadable
  finish
fi

[ -z "$jobs" ] || while IFS=$'\t' read -r index name job_status job_conclusion; do
  # an unknown or duplicated job has no role to grade: its INVENTORY_DEFECT already made the run UNREADABLE
  [ "$(printf '%s\n' "$names" | grep -cxF -- "$name")" -eq 1 ] && printf '%s\n' "$declared" | grep -qxF -- "$name" || continue

  echo "$name: status=$job_status conclusion=$job_conclusion"
  if [ "$job_status" != completed ]; then
    echo "$name: UNREADABLE (job has not reached run-end)"
    mark_unreadable
    continue
  fi

  own=$(printf '%s\n' "$steps" | awk -F'\t' -v i="$index" '$1 == i')
  listed=; unread=; failed=; unproven=; killed=
  [ "$job_conclusion" != cancelled ] || killed=1
  while IFS= read -r step; do
    matches=$(printf '%s\n' "$own" | awk -F'\t' -v s="$step" '$2 == s { print $3 }')
    case $(count "$matches") in
      0) outcome=MISSING; unread=1 ;;
      1) outcome=$matches ;;
      *) outcome="MULTIPLE($(count "$matches"))"; unread=1 ;;
    esac
    case $outcome in
      success|MISSING|MULTIPLE*) ;;
      cancelled) killed=1 ;;
      failure) failed=1 ;;
      *) unproven=1 ;; # skipped, or no conclusion: never success
    esac
    listed="$listed${listed:+ | }$step: $outcome"
  done <<< "$serial_steps"

  proof=
  grade=GREEN
  if [ -n "$unread" ]; then
    grade=UNREADABLE; proof="not downloaded: a declared step is missing or duplicated"
  elif [ -n "$killed" ]; then
    grade=INFRA_KILLED; [ -z "$failed" ] || grade=RED; proof="not downloaded: the job was cancelled"
  else
    dir=$(mktemp -d "$out_dir/CI-$(printf '%s' "$tag" | tr -c 'A-Za-z0-9._-' '-')-proof-$name.XXXXXX") \
      && gh run download "$run" --repo "$gh_repo" -n "proof-$name" -D "$dir" > /dev/null 2>&1
    if [ $? -ne 0 ]; then
      grade=UNREADABLE; proof="MISSING: artifact proof-$name not downloaded"
    else
      proof_out=$("${cli[@]}" proof --head "$sha" --repo "$repo_dir" "$dir" 2> "$dir.stderr")
      proof_status=$?
      printf '%s\n' "$proof_out" | sed -n "s/^PROOF_DEFECT /$name: PROOF_DEFECT /p"
      proof=$(printf '%s\n' "$proof_out" | grep '^PROOF ')
      word=$(printf '%s\n' "$proof" | sed -n 's/^PROOF dir=.* verdict=\([A-Z]*\) head=.*/\1/p')
      # fail closed: one PROOF line, and its word believed only beside its own exit status
      if [ "$(count "$proof")" -ne 1 ]; then
        grade=UNREADABLE; proof="UNREADABLE: cli.ts proof exited $proof_status with $(count "$proof") PROOF lines"
      elif [ "$word:$proof_status" = GREEN:0 ] || [ "$word:$proof_status" = RED:1 ]; then
        grade=$word
      else
        grade=UNREADABLE
      fi
    fi
    if [ "$grade" != UNREADABLE ] && { [ -n "$failed$unproven" ] || [ "$job_conclusion" != success ]; }; then grade=RED; fi
  fi
  echo "$name: steps=[$listed] proof=[$proof]"
  echo "$name: $grade"
  case $grade in
    RED) mark_red ;;
    UNREADABLE) mark_unreadable ;;
    INFRA_KILLED) mark_killed ;;
  esac
done <<< "$jobs"

# the run's own conclusion: GREEN needs success; a cancelled run is INFRA_KILLED; any other conclusion is RED
# unless a job's grade above already accounts for it (a killed job concludes its run `failure` too)
case $conclusion in
  success) ;;
  cancelled) mark_killed ;;
  *) if [ "$verdict" -eq 0 ]; then echo "RUN: RED (run conclusion $conclusion with every job GREEN)"; mark_red; fi ;;
esac
finish
