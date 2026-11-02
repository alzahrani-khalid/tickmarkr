"""The board oracle (queue row 332): every expected value here is the reference summarizer's own output.

Writes goldens.json next to this file:
  cases:    {name, run, cut, tz, now, pid, alive, hist, suites, expected}: reference summarize() over the first `cut`
            lines of runs/<run>/journal.jsonl (line numbers kept), that run's graph.json and every telemetry row, at the
            fixed `now` (epoch seconds) in time zone `tz`, readAt removed (it is the wall clock).
  io:       [{name, tz, now, layout, args, expected}]: reference main() over `layout` materialized under a temp folder,
            `now` fixed, readAt removed, the temp folder written as {root}. A layout entry is {path, mtime} plus text, or
            from (a runs/<name>/<file> path) with an optional cut (first N lines).
  release:  [{name, tz, now, dir, files, expected}]: reference release_status([<temp>/<dir>], now) with `files` written
            into that folder, the temp folder written as {root}.
runs/synthetic-edges is written by this script (build_synthetic) to reach branches the four real runs never take.

Usage (from this folder): python3 -I make-goldens.py .
"""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import time

HIST = {"worker": 600, "semantics": 240, "test": 900}
PER_RUN = 14
ZONES = ("Asia/Riyadh", "America/New_York")  # the fixtures straddle the US DST end (2026-11-01 06:00Z)
INTEREST = {"run-start", "run-resume", "task-dispatch", "phase-start", "worker-result", "baseline-wait", "suite-wait",
            "suite-admitted", "gate-result", "repair-attempt", "task-human", "task-approved", "task-done", "task-failed",
            "approval-window-start", "approval-window-expired", "run-end"}


def set_tz(tz):
    os.environ["TZ"] = tz
    time.tzset()


def load(path):
    spec = importlib.util.spec_from_file_location("reference_summarize", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read_lines(path):
    """Journal lines split on LF only, as the reference's file iteration does: U+2028 and other separators stay inside a line."""
    text = open(path, encoding="utf-8").read()
    return text[:-1].split("\n") if text.endswith("\n") else text.split("\n")


def events_of(lines):
    out = []
    for n, l in enumerate(lines, 1):
        if l.strip().startswith("{"):
            e = json.loads(l)
            e["_line"] = n
            out.append(e)
    return out


def build_synthetic(fx):
    """A hand-built run reaching the branches the real runs miss: failed cheap gates (a dirty-worktree reason), run-end
    and task-done closing open phases, a model without an adapter, a worker with no assignment, a park with no kind and
    an approval with no approver, a park cutting open acceptance and review, a full suite waiting on a named holder, a numeric-string attempt, non-dict invocation
    entries, a prototype-named task id, astral characters past a truncation, repeated separators and double spaces,
    unusual line separators, and concurrency three."""
    t0 = 1793508540  # 2026-11-01T05:29:00Z, half an hour before the US DST end
    ev, n = [], [0]

    def add(event, task=None, **data):
        n[0] += 1
        ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t0 + 45 * n[0])) + ".250Z"
        e = {"ts": ts, "event": event}
        if task is not None:
            e["taskId"] = task
        e["data"] = data
        ev.append(e)

    add("run-start", runId="run-20261101-052900-0000000000000777", effectivePolicy={"concurrency": 3})
    add("task-dispatch", "constructor", attempt="0", assignment={"model": "m1"})
    add("phase-start", "constructor", phase="worker", assignment={"model": "m1"})
    add("worker-launch", "constructor")
    add("worker-result", "constructor", ok=False, cause="clean-exit-no-trailer")
    add("baseline-wait", "constructor")
    add("phase-start", "constructor", phase="gates")
    add("gate-result", "constructor", gate="build", **{"pass": False}, details="refusing to gate a dirty worktree\n?? a b.txt\n M c\x1cd\n")
    add("task-dispatch", "T4", attempt=0, assignment={"adapter": "codex", "model": "sol"})
    add("phase-start", "T4", phase="worker", assignment={"adapter": "codex", "model": "sol"})
    add("worker-launch", "T4")
    add("repair-attempt", "constructor", of=2)
    add("task-dispatch", "constructor", attempt=1, retryMode="repair")
    add("phase-start", "constructor", phase="worker")
    add("worker-result", "constructor", ok=True)
    add("phase-start", "constructor", phase="gates")
    add("gate-result", "constructor", gate="lint", **{"pass": True})
    add("phase-start", "constructor", phase="judge")
    add("phase-start", "constructor", phase="review")
    add("gate-result", "constructor", gate="acceptance", **{"pass": False}, details="criteria:\nAC1 ✖ missing ✖ twice  double  spaces",
        invocations=[None, "x", {"channel": ""}, {"channel": "claude-code:opus"}], findings=[{}, {}])
    add("gate-result", "constructor", gate="review", **{"pass": True}, reviewer="codex:sol", invocations=[{"channel": "codex:sol"}])
    add("task-human", "constructor", reason="\U0001F600" * 70)
    add("approval-window-start", parked=["constructor"], windowMs=120000)
    add("task-dispatch", "T5", attempt=0, assignment={"adapter": "grok", "model": "g"})
    add("phase-start", "T5", phase="worker", assignment={"adapter": "grok", "model": "g"})
    add("worker-result", "T4", ok=True)
    add("phase-start", "T4", phase="gates")
    add("gate-result", "T4", gate="scope", **{"pass": True})
    add("phase-start", "T4", phase="gate:test", index=0)
    add("worker-result", "T5", ok=True)
    add("phase-start", "T5", phase="gates")
    add("phase-start", "T5", phase="gate:test", index=0)
    add("suite-wait", "T5", gate="test")
    add("task-approved", "constructor")
    add("approval-window-expired")
    add("task-dispatch", "constructor", attempt="2", assignment={"adapter": "claude-code", "model": "opus"})
    add("phase-start", "constructor", phase="worker", assignment={"adapter": "claude-code", "model": "opus"})
    add("gate-result", "T4", gate="test", **{"pass": False}, durationMs=70000, details="line one\r\nFAIL tests/x.test.ts > a b\nFAIL second")
    add("task-human", "T4", kind="gate-fail", reason="test red  twice  over")
    # a park while acceptance and review are both open cuts both spans (the attempt line drops cut semantic parts)
    add("task-dispatch", "T6", attempt=0, assignment={"adapter": "omp", "model": "glm"})
    add("phase-start", "T6", phase="worker", assignment={"adapter": "omp", "model": "glm"})
    add("worker-result", "T6", ok=True)
    add("phase-start", "T6", phase="gates")
    add("phase-start", "T6", phase="judge")
    add("phase-start", "T6", phase="review")
    add("task-human", "T6", kind="consult", reason="semantic park")
    add("suite-admitted", "T5")
    add("task-done", "T5")
    add("task-failed", "T4", error="boom ✖ x ✖ y")
    add("run-end", runId="run-20261101-052900-0000000000000777", done=["T5"], failed=["T4"], human=["constructor", "T6"], blocked=["T2", "T3"],
        pending=[], tipVerify=None, owedChecks={"known": False})
    graph = {"tasks": [{"id": "constructor", "title": "a prototype-named task \U0001F600", "deps": []},
                       {"id": "T2", "title": "waits", "deps": ["constructor"]},
                       {"id": "T3", "title": "waits further", "deps": ["T2"]},
                       {"id": "T4", "title": "fails", "deps": []},
                       {"id": "T5", "title": "merges", "deps": []},
                       {"id": "T6", "title": "parks mid-semantics", "deps": []}]}
    tel = [{"taskId": "T5", "shape": "implement", "tokens": {"input": 10, "output": 2, "cacheRead": 0}},
           {"taskId": "T5", "shape": "implement", "tokens": {"input": 5, "output": None}},
           {"taskId": "constructor", "shape": "review", "tokens": {"input": 99}}]
    d = os.path.join(fx, "runs", "synthetic-edges")
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, "journal.jsonl"), "w").write("".join(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n" for e in ev))
    json.dump(graph, open(os.path.join(d, "graph.json"), "w"), ensure_ascii=False, indent=1)
    open(os.path.join(d, "telemetry.jsonl"), "w").write("".join(json.dumps(t, separators=(",", ":")) + "\n" for t in tel))


def cuts_for(lines, every=False):
    """Cut after the first line of every (event, phase/gate, pass) kind, sampled evenly to PER_RUN, plus every park and
    window opening, plus the whole journal. `every` cuts after every line."""
    if every:
        return list(range(1, len(lines) + 1))
    seen, picks = set(), []
    for n, l in enumerate(lines, 1):
        if not l.startswith("{"):
            continue
        e = json.loads(l)
        d = e.get("data") or {}
        key = (e.get("event"), d.get("phase") or d.get("gate"), d.get("pass"))
        if e.get("event") in INTEREST and key not in seen:
            seen.add(key)
            picks.append(n)
    if len(picks) > PER_RUN:
        step = len(picks) / PER_RUN
        picks = [picks[int(i * step)] for i in range(PER_RUN)]
    always = [n for n, l in enumerate(lines, 1) if l.startswith("{") and json.loads(l).get("event") in ("task-human", "approval-window-start")]
    return sorted(set(picks + always + [len(lines)]))


EXTRA_CUTS = {"clean-pass": [66, 67]}  # T1 holds the full suite while T4 waits on the slot


def run_cases(ref, fx):
    cases = []
    for run in sorted(os.listdir(os.path.join(fx, "runs"))):
        d = os.path.join(fx, "runs", run)
        lines = read_lines(os.path.join(d, "journal.jsonl"))
        graph = json.load(open(os.path.join(d, "graph.json")))
        tel = [json.loads(l) for l in open(os.path.join(d, "telemetry.jsonl")) if l.strip().startswith("{")]
        cuts = sorted(set(cuts_for(lines, every=run == "synthetic-edges") + EXTRA_CUTS.get(run, [])))
        for tz in ZONES:
            # the second zone takes the synthetic run whole and the whole journal of each real run
            zone_cuts = cuts if tz == ZONES[0] or run == "synthetic-edges" else [len(lines)]
            set_tz(tz)
            for i, cut in enumerate(zone_cuts):
                evs = events_of(lines[:cut])
                ended = any(e.get("event") == "run-end" for e in evs)
                now = ref.ts_epoch(evs[-1]["ts"]) + (3600 if ended else 37)
                alive = [True, False, None][i % 3]
                pid = None if alive is None else 4242
                hist = HIST if i % 2 == 0 else {}
                failing = [] if (i // 3) % 2 == 0 else ["tests/a.test.ts", "tests/b.test.ts"]
                suites = {t["id"]: {"done": 120, "total": 400, "failing": failing} for t in graph["tasks"]} if i % 3 != 0 else None
                out = ref.summarize(evs, graph, pid, alive, now, hist, tel, suites)
                out.pop("readAt")
                cases.append({"name": f"{run}@{cut}/{tz}", "run": run, "cut": cut, "tz": tz, "now": now, "pid": pid, "alive": alive,
                              "hist": hist, "suites": suites, "expected": out})
    return cases


def materialize(fx, tmp, layout):
    for f in layout:
        p = os.path.join(tmp, f["path"])
        os.makedirs(os.path.dirname(p), exist_ok=True)
        if "text" in f:
            body = f["text"]
        else:
            body = open(os.path.join(fx, "runs", f["from"]), encoding="utf-8").read()
            if "cut" in f:
                body = "\n".join(read_lines(os.path.join(fx, "runs", f["from"]))[:f["cut"]]) + "\n"
        open(p, "w").write(body)
        os.utime(p, (f["mtime"], f["mtime"]))


def io_cases(ref, fx):
    T0 = 1793000000.0
    cur = "a/.tickmarkr/runs/run-20261102-040923-0000000000000427"
    siblings = [("run-20260901-000000-0000000000000001", "expired-window/journal.jsonl"),
                ("run-20260902-000000-0000000000000002", "failed-task/journal.jsonl"),
                ("run-20260903-000000-0000000000000003", "repairs-and-parks/journal.jsonl"),
                ("run-20260904-000000-0000000000000004", "synthetic-edges/journal.jsonl"),
                ("run-20260905-000000-0000000000000005", "failed-task/journal.jsonl"),
                ("run-20260906-000000-0000000000000006", "repairs-and-parks/journal.jsonl"),
                ("run-20260907-000000-0000000000000007", "clean-pass/journal.jsonl")]
    main = [
        {"path": f"{cur}/journal.jsonl", "from": "clean-pass/journal.jsonl", "cut": 66, "mtime": T0},
        {"path": f"{cur}/graph.json", "from": "clean-pass/graph.json", "mtime": T0},
        {"path": f"{cur}/telemetry.jsonl", "from": "clean-pass/telemetry.jsonl", "mtime": T0},
        {"path": f"{cur}/test-manifest-report-t1.json.job.json", "text": json.dumps({"state": "running", "subject": {"taskId": "T1"}}), "mtime": T0},
        {"path": f"{cur}/test-manifest-report-t1.json",
         "text": json.dumps({"requested": ["a", "b", "c", "d", "e"], "completed": {"a": {"status": "passed"}, "c": {"status": "failed"}, "b": "odd"}}), "mtime": T0},
        {"path": f"{cur}/test-manifest-report-t4.json.job.json", "text": json.dumps({"state": "running", "subject": {"taskId": "T4"}}), "mtime": T0},
        {"path": f"{cur}/test-manifest-report-t4.json", "text": "{\"requested\": [", "mtime": T0},
        {"path": f"{cur}/test-manifest-report-t2.json.job.json", "text": json.dumps({"state": "done", "subject": {"taskId": "T2"}}), "mtime": T0},
        {"path": f"{cur}/test-manifest-report-t2.json", "text": json.dumps({"requested": ["a"], "completed": {}}), "mtime": T0},
        {"path": "a/.tickmarkr/graph.lock", "text": json.dumps({"runId": "run-20261102-040923-0000000000000427", "pid": "99999999"}), "mtime": T0},
        {"path": "wt/b/.tickmarkr/runs/run-20261022-222302-0000000000000049/journal.jsonl", "from": "expired-window/journal.jsonl", "mtime": T0 - 200},
        {"path": "wt/.hidden/.tickmarkr/runs/run-20261103-000000-0000000000000999/journal.jsonl", "from": "expired-window/journal.jsonl", "mtime": T0 + 500},
        {"path": "rel/release-2180/ci-watch.log", "text": "--- CI run 41378498278 on 41d57df (release 76d393949)\n"
         "2026-11-02T02:35:44Z in_progress \n2026-11-02T02:39:45Z in_progress \n2026-11-02T02:51:00Z completed success\n", "mtime": T0},
        {"path": "rel/release-2180/tag-and-publish.sh", "text": "#!/bin/bash\nV=2.18.0\n", "mtime": T0},
        {"path": "rel/release-2180/tag-and-publish.log", "text": "TAG-PUSHED v2.18.0\n", "mtime": T0},
        {"path": "rel/release-2180/publish.log", "text": "NPM_VERSION=2.18.0\n", "mtime": T0},
        {"path": "rel/release-2170/ci-watch.log", "text": "--- CI run 1 on aaaaaaa (release bbbbbbb)\n2026-11-01T02:00:00Z completed failure\n", "mtime": T0 - 5000},
    ] + [{"path": f"a/.tickmarkr/runs/{rid}/journal.jsonl", "from": src, "mtime": T0 - 1000 * (k + 1)} for k, (rid, src) in enumerate(siblings)]
    no_lock_other = [dict(f) for f in main if f["path"] != "a/.tickmarkr/graph.lock"] + [
        {"path": "a/.tickmarkr/graph.lock", "text": json.dumps({"runId": "run-20990101-000000-0000000000000000", "pid": 1}), "mtime": T0}]
    no_lock = [dict(f) for f in main if f["path"] != "a/.tickmarkr/graph.lock"]
    specs = [
        ("main", main, ["{root}/a/.tickmarkr", "{root}/wt/*/.tickmarkr", "{root}/missing/.tickmarkr", "--release", "{root}/rel/release-*"]),
        ("lock-for-another-run", no_lock_other, ["{root}/a/.tickmarkr", "--release", "{root}/rel/none-*"]),
        ("no-lock", no_lock, ["{root}/a/.tickmarkr"]),
        ("dotted-glob-reaches-hidden", main, ["{root}/a/.tickmarkr", "{root}/wt/.*/.tickmarkr"]),
    ]
    out = []
    for tz in ZONES:
        set_tz(tz)
        for name, layout, args in specs:
            if tz != ZONES[0] and name != "main":
                continue
            now = T0 + 90
            tmp = tempfile.mkdtemp()
            try:
                materialize(fx, tmp, layout)
                ref.time.time = lambda: now
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    ref.main(*[a.replace("{root}", tmp) for a in args])
                got = json.loads(buf.getvalue())
                got.pop("readAt")
                got = json.loads(json.dumps(got).replace(tmp, "{root}"))
            finally:
                shutil.rmtree(tmp)
            out.append({"name": f"{name}/{tz}", "tz": tz, "now": now, "layout": layout, "args": args, "expected": got})
    return out


def release_cases(ref):
    ok_log = "--- CI run 9 on abc1234 (release def5678)\n2026-11-02T02:35:44Z in_progress \n2026-11-02T02:51:00Z completed success\n"
    table = [
        ("running", "release-2.19.0", {"ci-watch.log": "--- CI run 9 on abc1234 (release def5678)\n2026-11-02T02:35:44Z queued \n2026-11-02T02:40:00Z in_progress \n"}),
        ("failed-ci", "release-2.19.0", {"ci-watch.log": "--- CI run 9 on abc1234 (release def5678)\n2026-11-02T02:35:44Z completed failure\n"}),
        ("no-polls", "release-2.19.0", {"ci-watch.log": "--- CI run 9 on abc1234 (release def5678)\n"}),
        ("recut-and-two-sections", "release-2.19.0", {"ci-watch.log": "--- CI run 8 on aaa1111 (release bbb2222)\n2026-11-02T01:00:00Z completed failure\n"
                                                      "--- CI run 9 on ccc3333 (recut ddd4444)\n2026-11-02T02:00:00Z in_progress\n"}),
        ("malformed-final-header", "release-2.19.0", {"ci-watch.log": ok_log + "--- CI run nine on ? (other)\n2026-11-02T03:00:00Z in_progress \nCI-DONE x\n"}),
        ("version-from-script-v", "release-2180", {"ci-watch.log": ok_log, "tag-and-publish.sh": "set -e\nV=v2.20.1\nV=2.0.0\n"}),
        ("compact-dir-no-version", "release-2180", {"ci-watch.log": ok_log}),
        ("tag-empty-log", "release-2.19.0", {"ci-watch.log": ok_log, "tag-and-publish.log": ""}),
        ("tag-pushed-npm-running", "release-2.19.0", {"ci-watch.log": ok_log, "tag-and-publish.log": "x\nTAG-PUSHED\n"}),
        ("npm-mismatch", "release-2.19.0", {"ci-watch.log": ok_log, "tag-and-publish.log": "TAG-PUSHED", "publish.log": "NPM_VERSION=2.18.9\n"}),
        ("npm-red", "release-2.19.0", {"ci-watch.log": ok_log, "tag-and-publish.log": "TAG-PUSHED", "publish.log": "NPM_VERSION=2.18.9\nRELEASE-DONE completed failure\n"}),
        ("all-done-empty-backup", "release-2.19.0", {"ci-watch.log": ok_log, "tag-and-publish.log": "TAG-PUSHED", "publish.log": "NPM_VERSION=2.19.0\n", "backup-push.log": ""}),
    ]
    out = []
    set_tz(ZONES[0])
    for name, dirname, files in table:
        now = 1793000000.0
        tmp = tempfile.mkdtemp()
        try:
            d = os.path.join(tmp, dirname)
            os.makedirs(d)
            for fname, text in files.items():
                open(os.path.join(d, fname), "w").write(text)
            got = ref.release_status([d], now)
            got = json.loads(json.dumps(got).replace(tmp, "{root}"))
        finally:
            shutil.rmtree(tmp)
        out.append({"name": name, "tz": ZONES[0], "now": now, "dir": dirname, "files": files, "expected": got})
    return out


def release_selection_cases(ref):
    """R8a (a deliberate difference, OBSERVER-authored): the newest release folder by its newest file, CI pending before
    its ci-watch.log exists. Built from the reference's own card where R8a agrees with it, transformed only as R8a says."""
    ok_log = "--- CI run 9 on abc1234 (release def5678)\n2026-11-02T02:35:44Z completed success\n"
    T = 1793000000.0
    table = [
        ("next-release-before-ci", {"release-2170": ({"ci-watch.log": ok_log, "tag-and-publish.sh": "V=2.17.0\n", "tag-and-publish.log": "TAG-PUSHED",
                                                       "publish.log": "NPM_VERSION=2.17.0\n", "backup-push.log": ""}, T - 5000),
                                    "release-2180": ({"tag-and-publish.sh": "V=2.18.0\n", "export-chain.log": "verify:export running\n"}, T)}),
        ("next-release-in-ci", {"release-2170": ({"ci-watch.log": ok_log, "tag-and-publish.sh": "V=2.17.0\n"}, T - 5000),
                                "release-2180": ({"tag-and-publish.sh": "V=2.18.0\n", "ci-watch.log": "--- CI run 10 on aaa9999 (release bbb8888)\n2026-11-02T05:00:00Z in_progress \n"}, T)}),
        ("tie-later-name-wins", {"release-2.18.0": ({"tag-and-publish.sh": "V=2.18.0\n"}, T), "release-2.18.1": ({"tag-and-publish.sh": "V=2.18.1\n"}, T)}),
        ("empty-folder-skipped", {"release-2180": ({"tag-and-publish.sh": "V=2.18.0\n"}, T - 10), "release-2190": ({}, T)}),
    ]
    out = []
    set_tz(ZONES[0])
    for name, dirs in table:
        tmp = tempfile.mkdtemp()
        try:
            newest = None
            for dname, (files, mtime) in dirs.items():
                d = os.path.join(tmp, dname)
                os.makedirs(d)
                for fname, text in files.items():
                    open(os.path.join(d, fname), "w").write(text)
                    os.utime(os.path.join(d, fname), (mtime, mtime))
                if files and (newest is None or (mtime, dname) > (newest[0], newest[1])):
                    newest = (mtime, dname)
            d = os.path.join(tmp, newest[1])
            if os.path.exists(os.path.join(d, "ci-watch.log")):
                card = ref.release_status([d], T + 90)
            else:
                open(os.path.join(d, "ci-watch.log"), "w").write("")
                card = ref.release_status([d], T + 90)
                os.remove(os.path.join(d, "ci-watch.log"))
                card.update(ciRun=None, mirror=None, status="pending", conclusion="", polledAt="")
                card["stages"][0] = {"name": "CI", "state": "pending", "detail": ""}
            card = json.loads(json.dumps(card).replace(tmp, "{root}"))
        finally:
            shutil.rmtree(tmp)
        out.append({"name": name, "author": "OBSERVER (R8a, deliberate difference; D-2178 add.198)", "tz": ZONES[0], "now": T + 90,
                    "dirs": {k: {"files": v[0], "mtime": v[1]} for k, v in dirs.items()}, "args": ["{root}/release-*"], "expected": card})
    return out


def main(fx):
    ref = load(os.path.join(fx, "reference", "summarize.py"))
    build_synthetic(fx)
    cases = run_cases(ref, fx)
    ios = io_cases(ref, fx)
    rels = release_cases(ref)
    sel = release_selection_cases(ref)
    json.dump({"cases": cases, "io": ios, "release": rels, "releaseSelection": sel}, open(os.path.join(fx, "goldens.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    c = lambda pred: sum(1 for k in cases if pred(k["expected"]))
    print(f"{len(cases)} cases ({sum(1 for k in cases if k['tz'] != ZONES[0])} in {ZONES[1]}); "
          f"suite running {c(lambda e: any('full suite running' in t['now'] for t in e['tasks']))}, "
          f"suite waits with holder {c(lambda e: any('held by' in t['now'] for t in e['tasks']))}, "
          f"parks {c(lambda e: e['needsYou'])}, windows {c(lambda e: e['approvalWindow'])}, etas {c(lambda e: e['eta'])}, "
          f"failed checks {c(lambda e: any(p['text'].endswith(' ✖') and p.get('reason') for t in e['tasks'] for h in t['history'] for p in h['parts']))}; "
          f"io {len(ios)}: " + ", ".join(f"{k['name']} run={k['expected']['runId'][-4:]} alive={k['expected']['alive']} pid={k['expected']['pid']}" for k in ios)
          + f"; release {len(rels)}; {os.path.getsize(os.path.join(fx, 'goldens.json'))} bytes")


if __name__ == "__main__":
    main(*sys.argv[1:])
