#!/bin/bash
# context-statusline.sh — opt-in Claude statusLine sidecar: a seat's context % on disk (OBS-1122).
#
# Claude has ONE statusLine slot and it is the operator's. This collector never takes it over: it CHAINS
# the operator's existing command — same stdin, its stdout and exit status returned unchanged — and only
# as a side effect writes the payload's `context_window.used_percentage` to
# `$TKR_CONTEXT_ROOT/.tickmarkr/overseer/context/<seat>.json`, atomically (temp file + rename).
# Nothing else from the payload is kept. A malformed payload still writes the seat's record — with no
# percentage — so the last good number is invalidated, never left standing. The destination never
# depends on the payload or the process cwd: a malformed payload names no directory, and a cwd can drift,
# so either would let the invalidation land in another tree while the stale number stays readable.
# Every collector failure is swallowed: the operator's statusline must never break because the sidecar did.
#
# Seat AND root come ONLY from the seat's launch recipe: TKR_CONTEXT_SEAT must be a safe basename
# ([A-Za-z0-9][A-Za-z0-9._-]{0,63}) and TKR_CONTEXT_ROOT an absolute path. Either unset or unsafe means
# nothing is written — never a sanitized name, which could land in another seat's file.
#
# Reading is fail-closed to `unknown`, NEVER 0: absent, malformed, attributed to another seat, older than
# 120 s (or dated in the future), or a payload that carried no percentage all read `unknown`. Claude only:
# a Codex seat has no such payload and stays screen-read.
#
# usage:
#   statusLine command:  TKR_CONTEXT_SEAT=<seat> TKR_CONTEXT_ROOT=<abs repo> in the seat's env, then
#                        context-statusline.sh '<existing statusLine command>'   (no argument: prints nothing)
#   read:                context-statusline.sh --read <seat> [<project-dir>]       → <pct> | unknown
set -u

PY='
import json, os, re, sys, tempfile, time
MAX_AGE_S = 120
mode, seat, root = sys.argv[1], sys.argv[2], sys.argv[3]
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", seat) or not os.path.isabs(root):
    sys.exit(1)
ctx = os.path.join(root, ".tickmarkr", "overseer", "context")
def pct_of(value):
    ok = isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 100
    return value if ok else None
def field(obj, *keys):
    for key in keys:
        obj = obj.get(key) if isinstance(obj, dict) else None
    return obj
if mode == "collect":
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = None  # malformed: still recorded below, as no percentage
    pct = pct_of(field(payload, "context_window", "used_percentage"))
    os.makedirs(ctx, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=ctx, prefix="." + seat + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump({"seat": seat, "pct": pct, "ts": time.time()}, f)
        os.replace(tmp, os.path.join(ctx, seat + ".json"))
    except BaseException:
        os.unlink(tmp)
        raise
else:
    with open(os.path.join(ctx, seat + ".json")) as f:
        record = json.load(f)
    ts, pct = record.get("ts"), pct_of(record.get("pct"))
    age = time.time() - ts if isinstance(ts, (int, float)) and not isinstance(ts, bool) else None
    if record.get("seat") != seat or pct is None or age is None or not -5 <= age <= MAX_AGE_S:
        sys.exit(1)
    print(int(pct) if pct == int(pct) else pct)
'

if [ "${1:-}" = "--read" ]; then
  python3 -c "$PY" read "${2:-}" "${3:-$PWD}" 2>/dev/null || echo unknown
  exit 0
fi

# $(...) strips trailing newlines; the sentinel keeps stdin byte-for-byte
# ponytail: bash drops NUL bytes, which a JSON statusLine payload never carries
payload=$(cat; printf .)
payload=${payload%.}
if [ -n "${TKR_CONTEXT_SEAT:-}" ] && [ -n "${TKR_CONTEXT_ROOT:-}" ]; then
  printf '%s' "$payload" | python3 -c "$PY" collect "$TKR_CONTEXT_SEAT" "$TKR_CONTEXT_ROOT" >/dev/null 2>&1
fi
[ $# -eq 0 ] && exit 0
# the operator's command runs exactly as Claude ran it (a shell string), so its output and status are its own
printf '%s' "$payload" | /bin/sh -c "$*"
