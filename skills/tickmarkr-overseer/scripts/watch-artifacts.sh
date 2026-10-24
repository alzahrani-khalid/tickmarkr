#!/bin/bash
# Wake the overseer when spawned seats have actually DELIVERED.
#
#   watch-artifacts.sh [--changed-from <sha|mtime|now>] <marker> <cap-seconds> <poll-seconds> <file>...
#
# Completion is the ARTIFACT plus its TERMINAL MARKER — never an agent's `done`, which is turn end and
# fires the moment a seat finishes acknowledging you. Never file existence alone either: a seat killed
# mid-write leaves a large, plausible, truncated file. Size proves it started; the marker proves it
# finished. Measured 2026-08-06: one 10KB verdict was on disk while its seat still read `working`, and two
# 30KB/12.8KB verdicts sat COMPLETE for minutes with nothing watching, found only because the operator
# asked (OBS-369).
#
# ARM THIS IN THE SAME CALL THAT SPAWNS THE SEAT. A watcher armed later leaves an unwatched gap exactly as
# wide as however long you stay busy — and you will be busy, because you just spawned work.
#
# Prints one wake reason and EXITS. Re-arm after every wake.
#
# Queue row 240; D-2138 add.1 R3, add.4: optional close lists carry ONE recorded address per
# artifact, in argument order. Completion wakes on delivery; closure additionally requires the
# current mission's stand-down and live identity matching the spawn ledger. Never close on timeout.
set -u
# macOS ships bash 3.2, where `set -u` makes "${arr[@]}" on an EMPTY array a fatal unbound-variable
# error. Every expansion below therefore uses the ${arr[@]+"${arr[@]}"} guard. Caught by the timeout
# control, not by the completion one: the happy path was green while the path that runs on almost every
# arm crashed before printing its reason — a watcher that dies without a wake reason is the exact failure
# this script exists to prevent.

CHANGED_FROM=""
if [ "${1:-}" = "--changed-from" ]; then
  CHANGED_FROM="${2:?--changed-from requires a sha, prior mtime, or 'now'}"
  shift 2
fi

MARKER="${1:?usage: watch-artifacts.sh [--changed-from <sha|mtime|now>] <marker> <cap-seconds> <poll-seconds> <file>...}"
CAP="${2:?}"
POLL="${3:?}"
shift 3
[ "$#" -gt 0 ] || { echo "watch-artifacts: no files given" >&2; exit 2; }

# Refuse ambiguous arming before watching anything; preserve empty fields for count validation.
CLOSE_HOST=""
CLOSE_ADDRESSES="${TKR_CLOSE_TERMINALS:-${TKR_CLOSE_PANES:-}}"
if [ -n "${TKR_CLOSE_TERMINALS:-}" ] && [ -n "${TKR_CLOSE_PANES:-}" ]; then
  echo "watch-artifacts: choose one host close list" >&2; exit 2
fi
if [ -n "$CLOSE_ADDRESSES" ]; then
  if [ -n "${TKR_CLOSE_TERMINALS:-}" ]; then CLOSE_HOST=orca; else CLOSE_HOST=herdr; fi
  node -e 'const a=process.argv[1].split(","); if(a.length!==Number(process.argv[2]) || a.some(x=>!x.trim())) process.exit(2)' "$CLOSE_ADDRESSES" "$#" || {
    echo "watch-artifacts: close list requires one recorded address per artifact in argument order" >&2; exit 2;
  }
fi

# OBS-848: ownership is a pid-file fact, never an argv/path pattern. Two tiers intentionally watch
# the same artifacts, so the journal/file argument cannot identify which watcher a seat may retire.
PID_DIR="${TKR_STATE_DIR:-.tickmarkr}/overseer/pids"
PID_SEAT=$(printf '%s' "${TKR_ARMING_SEAT:-unattributed}" | sed 's/[^A-Za-z0-9_-]/_/g')
PID_FILE="$PID_DIR/${PID_SEAT}-watch-artifacts-$$.pid"
mkdir -p "$PID_DIR" && (umask 077; printf '%s\n' "$$" > "$PID_FILE") || {
  echo "watch-artifacts: cannot record pid under $PID_DIR" >&2; exit 73;
}
clear_pid() { rm -f "$PID_FILE"; }
trap clear_pid EXIT

# Cap BELOW the host's background-job kill so every arm ends by PRINTING something. A job killed at the
# limit carries no wake reason and is indistinguishable from a real wake until you read the output —
# OBS-325, re-earned by a third watcher that had not been capped because the fix was applied only to the
# two that happened to be in view at the time. Class, not instance.
END=$((SECONDS + CAP))

# Queue row 240; D-2138 add.4: DONE requires the marker on the final line and stable content.
#
# Anchored to the tail on purpose: a report that merely *mentions* its own marker mid-body has not
# finished, and grepping the whole file would call that done. This brief tells seats to end the file with
# the marker, so the tail is where it must be.
#
# ⚠ THE MARKER ALONE IS NOT COMPLETION, AND THIS COST A RULING. Measured 2026-08-07: a consult report was
# recorded here at 46,365 bytes WITH its terminal marker at 13:19:03. The seat then kept working — its
# source had moved again — and at 13:20:10 it rewrote its own summary line from `23 WEAK · 19 SOUND` to
# `25 WEAK · 17 SOUND`, leaving the marker last. The supervising seat read the earlier version, quoted it
# faithfully into a binding ruling, and shipped the superseded numbers. **A marker asserts "the file ends
# with X", which a file still being REVISED satisfies perfectly** — rewrite-in-place keeps the marker
# terminal at every instant. The failure is silent and reads exactly like a finished artifact.
#
# TWO THINGS ARE DONE ABOUT IT, AND ONLY ONE OF THEM IS A MECHANISM.
#
# 1. A stability check: the file's CONTENT HASH must be unchanged across two consecutive polls. This
#    reduces early wakes and costs one poll interval.
# 2. The wake line PRINTS THE HASH it fired on.
#
# **The stability check does NOT establish finality, and the drill proved it cannot.** A seat that pauses
# longer than one poll interval is indistinguishable from a finished one — and in the incident above the
# pause was 67 seconds against a 45-second poll, so *this check would not have prevented it either*. That
# is not a tuning problem: "has stopped writing" is unknowable from the file, because the information
# lives with the seat. Widening the window only trades one silent failure for latency and a stronger
# false impression of coverage, which is this project's worst class.
#
# **So the load-bearing half is the printed hash, and it is a READER contract, not a watcher feature:**
# re-hash the artifact when you quote it, and put that hash in whatever you write. If it differs from the
# wake's, you are reading a superseded file. That is the discipline the supervising seat had already
# imposed on the seat one level down — record the hash, re-check before writing — and skipped for itself.
# Signatures are held in an INDEXED array parallel to "$@", not an associative one keyed by path:
# `declare -A` is bash 4+, macOS ships bash 3.2, and `bash -n` accepts it happily — the failure is at
# RUNTIME, where the arithmetic then errors, `done_file` returns 1 forever, and the watcher never wakes.
# Caught by the drill below, not by the syntax check. A syntax check is not a positive control.
PREV=()
BASELINE=()
i=0
for f in "$@"; do
  if [ -n "$CHANGED_FROM" ]; then
    # A SHA is an explicit single-artifact baseline. Historical callers recorded mtimes; retain that
    # spelling as the arming signal but capture content now, because equal-length rewrites and touches
    # prove that mtime is not the property this watcher claims to read.
    if printf '%s' "$CHANGED_FROM" | grep -qE '^[0-9a-fA-F]{40}$' && [ "$#" -eq 1 ]; then
      BASELINE[$i]=$(printf '%s' "$CHANGED_FROM" | tr 'A-F' 'a-f')
    else
      BASELINE[$i]=$(shasum -a 1 "$f" 2>/dev/null | cut -d' ' -f1)
    fi
  fi
  i=$((i + 1))
done

done_file() {                  # $1 = index into "$@", $2 = path
  local i="$1" f="$2" sig
  [ -s "$f" ] || return 1
  tail -n 1 "$f" 2>/dev/null | grep -qF -- "$MARKER" || return 1
  # CONTENT HASH, not size+mtime. The first version of this used `stat` size and mtime and the drill
  # killed it on the incident's own shape: the correction that cost a ruling was `23 WEAK · 19 SOUND`
  # -> `25 WEAK · 17 SOUND`, which is **byte-identical in length**, and mtime is whole seconds. A
  # signature that cannot see an equal-length in-place edit is blind to exactly the edit this exists to
  # catch. Hashing 48KB per poll costs nothing.
  sig=$(shasum -a 1 "$f" 2>/dev/null | cut -d' ' -f1)
  [ -n "$sig" ] || return 1
  if [ -n "$CHANGED_FROM" ] && [ "${BASELINE[$i]:-}" = "$sig" ]; then return 1; fi
  if [ "${PREV[$i]:-}" = "$sig" ]; then return 0; fi
  PREV[$i]="$sig"              # marked but still moving — hold it one more poll
  return 1
}

# Queue row 240; D-2138 add.4 U04/U05/U08/U09, add.6 V01: both completion exits use
# this path. A bare address, title alone or old mission's stand-down never licenses a close.
close_completed() {
  [ -n "$CLOSE_HOST" ] || return 0
  node - "$PID_DIR" "$CLOSE_HOST" "$CLOSE_ADDRESSES" ${READY_INDEXES[@]+"${READY_INDEXES[@]}"} <<'NODE'
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const [dir, host, addresses, ...ready] = process.argv.slice(2);
const canonical = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const field = (o) => typeof o === "string" && o ? o : undefined;
const checkout = o => field(o.worktree) || field(o.worktreePath) || field(o.worktree_path)
  || field(o.worktree?.path) || (field(o.worktreeId)?.split("::").slice(1).join("::"))
  || field(o.path) || field(o.cwd);
const same = (a, b) => !!a && !!b && canonical(a) === canonical(b);
function record(file) {
  const raw = fs.readFileSync(file, "utf8");
  const entries = raw.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; });
  if (entries.some(([k]) => !k) || new Set(entries.map(([k]) => k)).size !== entries.length) throw Error("malformed spawn/stand-down record");
  return { raw, values: Object.fromEntries(entries) };
}
function call(args, refusal = false) {
  const r = spawnSync(host, args, { encoding: "utf8", timeout: 10000 });
  if (r.error || r.signal) throw Error("host call unreadable or timed out");
  let body; try { body = JSON.parse(r.stdout); } catch { throw Error("host response is not JSON"); }
  if (refusal && r.status === 1 && body.ok === false && body.error?.code === "runtime_error" && body.error?.message === "tab_not_found") return body;
  if (r.status !== 0 || body.ok === false || !body.result) throw Error("host call refused");
  return body;
}
function orcaList(visual = true) {
  const body = call(["terminal", "list", ...(visual ? ["--include-visual-layouts"] : []), "--limit", "10000", "--json"]);
  if (body.ok !== true || !body._meta?.runtimeId || body._meta.runtimeId === "none" || body.result.truncated === true
    || !Array.isArray(body.result.terminals) || (visual && !Array.isArray(body.result.visualLayouts))) throw Error("unverifiable terminal list");
  return body;
}
function tabs(node, out = []) {
  if (Array.isArray(node)) node.forEach(n => tabs(n, out));
  else if (node && typeof node === "object") {
    if (Array.isArray(node.tabs)) out.push(...node.tabs);
    tabs(node.first, out); tabs(node.second, out);
  }
  return out;
}
function leaves(node, out = []) {
  if (Array.isArray(node)) node.forEach(n => leaves(n, out));
  else if (node && typeof node === "object") {
    if (node.type === "terminal" && field(node.handle)) out.push(node.handle);
    else { leaves(node.panes, out); leaves(node.first, out); leaves(node.second, out); }
  }
  return out;
}
function liveTabs(body) {
  return body.result.visualLayouts.flatMap(layout => tabs(layout.root).map(tab => ({ tab, checkout: checkout(layout), handles: leaves(tab.panes) })));
}
function paneList() {
  const result = call(["pane", "list"]).result;
  if (!Array.isArray(result.panes)) throw Error("unverifiable pane list");
  return result.panes;
}
for (const index of ready) {
  let attempted = false;
  const address = addresses.split(",")[Number(index)];
  try {
    if (address === process.env.ORCA_TERMINAL_HANDLE || address === process.env.HERDR_PANE_ID) throw Error("own launching terminal");
    const matches = fs.readdirSync(dir).filter(n => n.endsWith(".handle")).map(n => ({ file: path.join(dir, n), seat: n.slice(0, -7), ...record(path.join(dir, n)) }))
      .filter(r => r.values.address === address && r.values.host === host);
    if (matches.length !== 1) throw Error("no unique spawn ledger record names address");
    const r = matches[0], v = r.values;
    if (!v.title || !v.checkout || !v.mission) throw Error("incomplete spawn ledger");
    if (r.seat === process.env.TKR_ARMING_SEAT) throw Error("own arming seat");
    if (v.next_mission || v["next-mission"]) throw Error("named next mission keeps seat open until clear and reassignment");
    const stood = path.join(dir, `${r.seat}.stood-down`);
    const stoodDown = () => {
      if (record(r.file).raw !== r.raw) throw Error("spawn ledger changed during verification");
      if (record(stood).values.mission !== v.mission) throw Error("stand-down does not name current mission");
    };
    stoodDown();
    if (host === "orca") {
      const before = orcaList();
      const rows = before.result.terminals.filter(t => t.handle === address);
      const allTabs = liveTabs(before);
      const owned = allTabs.filter(t => t.tab.title === v.title && same(t.checkout, v.checkout) && t.handles.includes(address));
      if (rows.length !== 1 || !same(checkout(rows[0]), v.checkout) || owned.length !== 1) {
        // Read-only re-resolution by title. Never substitute this candidate into a close command.
        const candidates = allTabs.filter(t => t.tab.title === v.title && same(t.checkout, v.checkout)).flatMap(t => t.handles);
        for (const handle of candidates) call(["terminal", "read", "--terminal", handle, "--screen", "--json"]);
        throw Error("live tab title and checkout mismatch or stale handle; read-only re-resolution by title");
      }
      const tab = owned[0], tabId = tab.tab.id ?? tab.tab.tabId ?? rows[0].tabId;
      if (!tabId) throw Error("owned tab id is unverifiable");
      const finalTerminal = tab.handles.length === 1;
      stoodDown();
      attempted = true;
      const receipt = call(["terminal", "close", "--terminal", address, "--json"], true);
      if (receipt._meta?.runtimeId !== before._meta.runtimeId) throw Error("runtime changed at close");
      if (receipt.ok !== false && (receipt.ok !== true || receipt.result?.close?.handle !== address)) throw Error("close receipt does not name recorded handle");
      const after = orcaList(false), layoutAfter = orcaList();
      if (after._meta.runtimeId !== before._meta.runtimeId || layoutAfter._meta.runtimeId !== before._meta.runtimeId
        || after.result.terminals.some(t => t.handle === address)
        || (finalTerminal && liveTabs(layoutAfter).some(t => (t.tab.id ?? t.tab.tabId) === tabId || (t.tab.title === v.title && same(t.checkout, v.checkout))))
        || (!finalTerminal && tab.handles.filter(h => h !== address).some(h => !after.result.terminals.some(t => t.handle === h)))) throw Error("handle or final owned tab survives close, sibling disappeared, or runtime changed; spec question, never close by title");
      console.log(`  CLOSED ${address}: receipt ${receipt.ok === false ? "runtime_error: tab_not_found" : receipt.result.close.handle}; handle absent from terminal list; ${finalTerminal ? `owned tab ${tabId} absent from visual layout` : `shared tab ${tabId} kept for sibling terminals`}`);
    } else {
      const before = paneList(), rows = before.filter(p => p.pane_id === address);
      if (rows.length !== 1 || rows[0].label !== v.title || !same(rows[0].cwd, v.checkout)) throw Error("live pane label and checkout mismatch");
      stoodDown();
      attempted = true;
      call(["pane", "close", address]);
      const after = paneList();
      if (after.some(p => p.pane_id === address)) throw Error("pane survives close");
      // A shared consultant tab belongs to several seats. Only a recorded sole owner reaps its tab.
      if (v.tab && rows[0].tab_id === v.tab && !after.some(p => p.tab_id === v.tab)) {
        call(["tab", "close", v.tab]);
        const listed = call(["tab", "list"]).result.tabs;
        if (!Array.isArray(listed) || listed.some(t => (t.tab_id ?? t.id) === v.tab)) throw Error("owned tab survives close");
      }
      console.log(`  CLOSED ${address}: spawn record matched label and cwd; pane absent from pane list`);
    }
  } catch (error) { console.log(`  ${attempted ? "CLOSE UNPROVEN" : "LEFT OPEN"} ${address}: ${error.code === "ENOENT" ? "missing spawn or stand-down record" : error.message}`); }
}
NODE
}

while :; do
  pending=()
  ready=()
  READY_INDEXES=()
  i=0
  for f in "$@"; do
    if done_file "$i" "$f"; then ready+=("$f"); READY_INDEXES+=("$i"); else pending+=("$f"); fi
    i=$((i + 1))
  done

  # TKR_WAKE_ON_ANY: wake as soon as ANY artifact completes, naming what is still outstanding.
  #
  # Measured 2026-08-07: three consultants were watched as one set. Two produced COMPLETE 30.9KB and
  # 22.2KB verdicts; the third sat BLOCKED on a permission prompt and never wrote a byte. The watcher
  # stayed silent — correctly, by its own all-or-nothing contract — and two finished verdicts went unread
  # until the operator asked. **An all-or-nothing watcher is hostage to its deadest member**, and the more
  # seats you watch the likelier one of them is stuck. This is OBS-369 recurring through a mechanism the
  # original fix did not cover: that fix keyed on the marker, which was right, and assumed the set
  # completes together, which is not.
  #
  # Default stays all-or-nothing so existing arms are unchanged. For a fan-out of independent seats,
  # WAKE_ON_ANY is the correct mode and the outstanding list tells you what to re-arm on.
  if [ "${TKR_WAKE_ON_ANY:-0}" = "1" ] && [ "${#ready[@]}" -gt 0 ]; then
    echo "WAKE: ${#ready[@]} of $# artifact(s) complete with marker '$MARKER' — ${#pending[@]} still outstanding"
    for f in ${ready[@]+"${ready[@]}"};   do echo "  READY       $(wc -c <"$f" | tr -d ' ') bytes  sha1 $(shasum -a 1 "$f" | cut -c1-12)  $f"; done
    for f in ${pending[@]+"${pending[@]}"}; do
      if [ -s "$f" ]; then echo "  PARTIAL     $(wc -c <"$f" | tr -d ' ') bytes, no marker yet  $f  last-line: $(tail -n 1 "$f" | tr -d '\0' | cut -c1-72)"
      else echo "  NOT STARTED $f  <- check whether that seat is BLOCKED; a stalled seat writes nothing"; fi
    done
    close_completed
    exit 0
  fi

  if [ "${#pending[@]}" -eq 0 ]; then
    echo "WAKE: all ${#ready[@]} artifact(s) complete with marker '$MARKER'"
    for f in ${ready[@]+"${ready[@]}"}; do echo "  READY  $(wc -c <"$f" | tr -d ' ') bytes  sha1 $(shasum -a 1 "$f" | cut -c1-12)  $f"; done
    echo "  RE-HASH BEFORE YOU QUOTE IT. The marker means the file ENDS with '$MARKER', never that its"
    echo "  author has stopped: a rewrite-in-place keeps the marker terminal at every instant. If shasum"
    echo "  now differs from the value above, you are reading a superseded file."
    close_completed
    exit 0
  fi

  if [ "$SECONDS" -ge "$END" ]; then
    # Timing out is NOT failure and must not read as one: it is the heartbeat that proves the watcher was
    # alive and still watching. Report both sides so the state is unambiguous on arrival.
    echo "WAKE: cap ${CAP}s reached — ${#ready[@]} of $# complete, re-arm"
    for f in ${ready[@]+"${ready[@]}"};   do echo "  READY    $(wc -c <"$f" | tr -d ' ') bytes  $f"; done
    for f in ${pending[@]+"${pending[@]}"}; do
      # PARTIAL prints the file's ACTUAL last line: a seat that reports the wrong marker for its own
      # artifact leaves the file complete while this watcher waits forever, and the mismatch is visible
      # only here (measured 2026-08-17: demanded/reported `SWEEP-END`, written `ORDER4-END`).
      if [ -s "$f" ]; then echo "  PARTIAL  $(wc -c <"$f" | tr -d ' ') bytes, no '$MARKER' yet  $f  last-line: $(tail -n 1 "$f" | tr -d '\0' | cut -c1-72)"
      else echo "  ABSENT   $f"; fi
    done
    exit 0
  fi

  sleep "$POLL"
done
