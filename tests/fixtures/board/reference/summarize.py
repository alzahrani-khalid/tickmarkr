"""Summarize the newest tickmarkr run under <state-root> (a repo's .tickmarkr dir) as one JSON line.

Usage: python3 -I summarize.py <state-root>... [--release <release-dir>...]   (the newest run across every root; ~ and globs expand)      (python3 -I summarize.py --selftest runs the check)
Reads only: runs/*/journal.jsonl (the newest run's, plus the newest few others for typical phase times), that run's
graph.json, telemetry.jsonl and test-manifest reports, and graph.lock. Writes nothing.
"""
import glob
import json
import os
import re
import sys
import time
from datetime import datetime

GATES = ["build", "lint", "evidence", "scope", "acceptance", "review", "test"]
CHECKS = ("build", "lint", "evidence", "scope")
HISTORY_RUNS = 6  # ponytail: typical phase times from the newest 6 other journals; a per-repo cache if the scan gets slow


def ts_epoch(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def hm(t):
    return datetime.fromtimestamp(t).strftime("%H:%M")


def stamp(t):
    return datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M:%S")


def dur(sec):
    sec = int(max(0, sec))
    return f"{sec // 3600}h {sec % 3600 // 60:02d}m" if sec >= 3600 else f"{sec // 60}m" if sec >= 60 else f"{sec}s"


def first_red_line(d):
    lines = [l.strip() for l in str(d.get("details", "")).splitlines() if l.strip()]
    # an unclean checkout: its reason is the stray paths, not the raw git-status line ("?? atchersp")
    if lines and lines[0].startswith("refusing to gate a dirty worktree"):
        return "unclean checkout: " + ", ".join(l.split(None, 1)[-1] for l in lines[1:])
    hit = next((l for l in lines if l.startswith("FAIL ")), None) or (lines[1] if len(lines) > 1 and lines[0].endswith(":") else (lines[0] if lines else ""))
    return hit[5:] if hit.startswith("FAIL ") else hit


# ---- spans: each task's phases per attempt, open ones running to now (the now-sentence, attempt history and ETA read them) ----

def new_track(ids):
    return {"spans": {k: [] for k in ids}, "open": {k: {} for k in ids}, "marks": {k: [] for k in ids}, "att": {k: 0 for k in ids},
            "window": None, "start": None, "end": None, "conc": 1}


def feed(tr, e, line, t):
    ev, tid, d = e.get("event"), e.get("taskId"), e.get("data") or {}
    if ev in ("run-start", "run-resume"):
        tr["start"] = tr["start"] or t
        tr["conc"] = (d.get("effectivePolicy") or {}).get("concurrency", tr["conc"])
    elif ev == "approval-window-start":
        tr["window"] = {"closesAt": t + (d.get("windowMs") or 0) / 1000, "parked": list(d.get("parked") or [])}
    elif ev == "approval-window-expired":
        tr["window"] = None
    elif ev == "run-end":
        tr["end"] = t
        for k in tr["open"]:
            for kind in list(tr["open"][k]):
                stop(tr, k, kind, t, "unresolved" if kind == "park" else "cut")
    if tid not in tr["open"]:
        return
    if ev == "task-dispatch":
        tr["att"][tid] = int(d.get("attempt", 0)) + 1
        stop(tr, tid, "queue", t)
        release(tr, tid, t)
        if d.get("retryMode") == "repair" or tr["att"][tid] > 1:
            tr["marks"][tid].append({"kind": "retry", "t": t})
    elif ev == "phase-start" and d.get("phase") == "worker":
        a = d.get("assignment") or {}
        start(tr, tid, "worker", t, label=f"{a.get('adapter')}:{a.get('model')}" if a.get("model") else "")
    elif ev == "worker-result":
        stop(tr, tid, "worker", t, "pass" if d.get("ok") else ("harvested" if d.get("cause") == "clean-exit-no-trailer" else "fail"))
        start(tr, tid, "wait", t, label="awaiting gates")
    elif ev == "baseline-wait" and "wait" in tr["open"][tid]:
        tr["open"][tid]["wait"]["label"] = "the baseline suite"
    elif ev == "phase-start" and d.get("phase") == "gates":
        for kind, out in (("wait", "pass"), ("queue", "pass")):
            stop(tr, tid, kind, t, out)
        release(tr, tid, t)
        start(tr, tid, "checks", t)
    elif ev == "phase-start" and d.get("phase") in ("judge", "review"):
        stop(tr, tid, "checks", t)
        start(tr, tid, "accept" if d["phase"] == "judge" else "review", t)
    elif ev == "phase-start" and d.get("phase") == "gate:test":
        if d.get("index") is not None:
            stop(tr, tid, "checks", t)
            start(tr, tid, "test", t)
        else:
            stop(tr, tid, "suitewait", t)
    elif ev == "suite-wait" and "suitewait" not in tr["open"][tid]:
        start(tr, tid, "suitewait", t, parent="test" if d.get("gate") == "test" else "accept")
    elif ev == "suite-admitted":
        stop(tr, tid, "suitewait", t)
    elif ev == "gate-result":
        g, ok = d.get("gate"), bool(d.get("pass"))
        if g in CHECKS and not ok:
            stop(tr, tid, "checks", t, "fail", note=f"{g} ✖ {first_red_line(d)}")
        kind = {"acceptance": "accept", "review": "review", "test": "test"}.get(g)
        if kind:
            if tr["open"][tid].get("suitewait", {}).get("parent") == kind:
                stop(tr, tid, "suitewait", t)
            inv = [i.get("channel") for i in d.get("invocations") or [] if isinstance(i, dict) and i.get("channel")]
            stop(tr, tid, kind, t, "pass" if ok else "fail", seat=d.get("reviewer") or (inv[-1] if inv else None),
                 findings=len(d.get("findings") or []), note="" if ok else f"{g} ✖ {first_red_line(d)}")
    elif ev == "repair-attempt":
        tr["marks"][tid].append({"kind": "repair", "t": t, "of": d.get("of")})
    elif ev == "task-human":
        for kind in list(tr["open"][tid]):
            stop(tr, tid, kind, t, "cut")
        start(tr, tid, "park", t, label=str(d.get("kind") or "park"), line=line, ts=e["ts"])
    elif ev == "task-approved":
        release(tr, tid, t, note=f"{d.get('by') or 'operator'}: {d.get('release') or 'release'}")
        start(tr, tid, "queue", t)
    elif ev == "task-done":
        tr["marks"][tid].append({"kind": "merge", "t": t})
        for kind in list(tr["open"][tid]):
            stop(tr, tid, kind, t)


def release(tr, tid, t, **kw):
    """A dispatch, a gate round or an approval releases the task's park: the open one, and also the last one a run-end
    left unresolved, which a resume released by dispatching the task again (else the board says it still needs you)."""
    stop(tr, tid, "park", t, "released", **kw)
    last = next((sp for sp in reversed(tr["spans"][tid]) if sp["kind"] == "park"), None)
    if last and last["outcome"] == "unresolved":
        last.update(outcome="released", **{"note": "resumed", **kw})


def start(tr, tid, kind, t, **kw):
    stop(tr, tid, kind, t, "cut")  # a phase that starts again supersedes its open predecessor (an oracle re-run after its suite slot)
    sp = {"kind": kind, "att": tr["att"][tid], "t0": t, "t1": None, "outcome": "open", **kw}
    tr["spans"][tid].append(sp)
    tr["open"][tid][kind] = sp


def stop(tr, tid, kind, t, outcome="pass", **kw):
    sp = tr["open"][tid].pop(kind, None)
    if sp:
        sp.update(t1=t, outcome=outcome, **kw)


def admitted_at(spans, test):
    """When a full suite actually started: the end of the suite-slot wait inside its gate, else the gate's start."""
    q = [sp["t1"] for sp in spans if sp["kind"] == "suitewait" and sp.get("parent") == "test" and sp["t1"] and sp["t0"] >= test["t0"]]
    return max(q) if q else test["t0"]


SINCE = "{since}"  # the pane fills it from `since` every second, so a running duration ticks between polls


def now_sentence(r, spans, rows, open_by_task, now, hist, conc, busy, suite):
    """What the task is doing, for how long ({since}, ticking from the returned epoch), against its typical time."""
    op = {sp["kind"]: sp for sp in spans if sp["outcome"] == "open"}
    typ = lambda k: f" (typ {dur(hist[k])})" if hist.get(k) else ""
    if r["state"] == "done":
        return "merged" + (f" {hm(r['_merged'])}" if r.get("_merged") else "") + f" · {r['attempt'] + 1} attempt(s)", None
    if r["state"] == "failed":
        return f"failed — {r['note']}", None
    park = op.get("park") or next((sp for sp in reversed(spans) if sp["kind"] == "park" and sp["outcome"] == "unresolved"), None) if r["state"] == "parked" else None
    if park:  # an unresolved park outlives the run: still the operator's to release
        return f"parked {SINCE} · {park['label']}" + (f" · blocks {' → '.join(r['blocks'])}" if r["blocks"] else ""), park["t0"]
    if "suitewait" in op:
        what = "full suite" if op["suitewait"].get("parent") == "test" else "acceptance oracle"
        holders = [k for k, o in open_by_task.items() if k != r["id"] and "test" in o and "suitewait" not in o]
        return f"{what} waits {SINCE} for the suite slot" + (f" (held by {', '.join(holders)} full suite)" if holders else ""), op["suitewait"]["t0"]
    if "test" in op:
        prog = f" · {suite['done']}/{suite['total']} files" + (f", {len(suite['failing'])} failing" if suite["failing"] else "") if suite else ""
        return f"full suite running {SINCE}{typ('test')}{prog}", admitted_at(spans, op["test"])
    if "accept" in op or "review" in op:
        s = op.get("accept") or op.get("review")
        left = [n for k, n in (("accept", "acceptance"), ("review", "review")) if k in op]
        return f"{' ‖ '.join(left)} running {SINCE}{typ('semantics')}", s["t0"]
    if "checks" in op:
        return "build · lint · evidence · scope", None
    if "wait" in op:
        return f"worker done · waiting {SINCE} for {op['wait']['label']}", op["wait"]["t0"]
    if "worker" in op:
        w = op["worker"]
        return f"worker a{w['att']}{' (repair)' if w['att'] > 1 else ''} {SINCE} on {w['label'] or r['worker']}{typ('worker')}", w["t0"]
    if "queue" in op:
        return f"released {SINCE} ago · {r['note'] or 'restarting'}", op["queue"]["t0"]
    chain, cur = [], r
    while True:
        waits = [d for d in cur["deps"] if rows[d]["state"] != "done"]
        if not waits:
            break
        chain.append(waits[0])
        cur = rows[waits[0]]
    if chain:
        return "waits on " + " ← ".join(chain), None
    return f"queued for a worker slot ({busy}/{conc} busy)", None


def attempt_lines(spans, now):
    """One line per attempt, phases in order (replaces RECENT). Each part: short words, a tone, the red `reason` apart
    (the pane puts it last), and for a running part `{since}` with the epoch it ticks from."""
    by_att = {}
    for sp in sorted(spans, key=lambda x: x["t0"]):
        by_att.setdefault(sp["att"], []).append(sp)
    out = []
    for att, sps in by_att.items():
        parts = []
        for sp in sps:
            k, o = sp["kind"], sp["outcome"]
            took = (sp["t1"] or now) - sp["t0"]
            d = dur(took) if sp["t1"] else SINCE
            tone = {"pass": "pass", "harvested": "pass", "fail": "fail", "open": "open"}.get(o, "wait")
            mark = {"pass": "✓", "harvested": "✓ harvested", "fail": "✖", "open": "◉"}.get(o, "")
            part = None
            if k == "worker":
                part = {"text": f"worker {d} {mark}".strip()}
            elif k == "wait" and (took >= 60 or not sp["t1"]):
                part = {"text": f"{sp['label']} {d}"}
                tone = "wait" if sp["t1"] else "open"
            elif k == "checks":
                gate, _, why = str(sp.get("note") or "").partition(" ✖ ")
                part = {"text": f"{gate} ✖", "reason": why} if o == "fail" else {"text": f"checks {mark}".strip()}
            elif k in ("accept", "review") and o != "cut":
                seat = f" {sp['seat']}" if k == "review" and sp.get("seat") else ""
                name = "acceptance" if k == "accept" else "review"
                why = str(sp.get("note") or "").partition(" ✖ ")[2]
                part = {"text": f"{name} ✖ {d}{seat}", "reason": why} if o == "fail" else {"text": f"{name} {mark} {d}{seat}".replace("  ", " ")}
            elif k == "suitewait" and sp.get("parent") != "test" and (took >= 60 or not sp["t1"]):
                part = {"text": f"suite queue {d}"}
                tone = "wait" if sp["t1"] else "open"
            elif k == "test":
                # the suite's own queue reads before it, as it happened; a suite still queued has not started
                waits = [q for q in sps if q["kind"] == "suitewait" and q.get("parent") == "test" and q["t0"] >= sp["t0"]]
                queued = sum(((q["t1"] or now) - q["t0"]) for q in waits)
                if any(not q["t1"] for q in waits):
                    parts.append({"text": f"suite queue {SINCE}", "tone": "open", "since": next(q["t0"] for q in waits if not q["t1"])})
                    continue
                if queued >= 60:
                    parts.append({"text": f"suite queue {dur(queued)}", "tone": "wait"})
                ran = dur(took - queued) if sp["t1"] else SINCE
                part = {"text": f"full suite {mark} {ran}", **({"reason": str(sp.get("note") or "").partition(" ✖ ")[2]} if o == "fail" else {})}
                if not sp["t1"]:
                    part["since"] = admitted_at(sps, sp)
            elif k == "park":
                part = {"text": f"PARK {sp['label']} {d}" + (f" → {sp['note']}" if o == "released" and sp.get("note") else "")}
                tone = "fail" if o in ("open", "unresolved") else "wait"
            if part:
                part["tone"] = tone
                if SINCE in part["text"]:
                    part.setdefault("since", sp["t0"])
                parts.append(part)
        out.append({"att": att, "start": hm(sps[0]["t0"]), "parts": parts})
    return out


def closure(tid, deps):
    seen, stack = set(), list(deps.get(tid, []))
    while stack:
        x = stack.pop()
        if x not in seen:
            seen.add(x)
            stack += deps.get(x, [])
    return seen


def eta(rows, spans, now, hist, conc):
    """List-schedule the remaining work on `conc` worker slots at typical phase times, full suites one at a time (the
    daemon admits a suite only while none is live), plus a tip-verify suite; the pessimistic run adds a repair round per task."""
    w, s, t = (hist.get(k) or 0 for k in ("worker", "semantics", "test"))

    def remaining(r, pess):
        op = {sp["kind"]: sp for sp in spans[r["id"]] if sp["outcome"] == "open"}
        extra = (w + s + t) if pess else 0
        if "test" in op:
            if op.get("suitewait", {}).get("parent") == "test":
                return t + extra
            return max(60, t - (now - admitted_at(spans[r["id"]], op["test"]))) + extra
        if "accept" in op or "review" in op:
            return max(60, s - (now - (op.get("accept") or op.get("review"))["t0"])) + t + extra
        if "worker" in op:
            return max(60, w - (now - op["worker"]["t0"])) + s + t + extra
        return w + s + t + extra

    out = {}
    active = lambda r: r["state"] in ("worker", "waiting", "gates")
    in_test = lambda r: any(sp["kind"] == "test" and sp["outcome"] == "open" for sp in spans[r["id"]])
    for pess in (False, True):
        finish, running, suite_free, clock = {}, [], now, now
        left = [r for r in rows.values() if r["state"] not in ("done", "failed")]
        while left:
            ready = [r for r in left if active(r) or all(rows[d]["state"] == "done" or finish.get(d, 1e18) <= clock for d in r["deps"])]
            ready.sort(key=lambda r: (not active(r), not in_test(r), -len(r["blocks"]), r["id"]))
            if ready and (active(ready[0]) or len(running) < conc):
                r = ready[0]
                left.remove(r)
                rem = remaining(r, pess)
                test_part = min(rem, t)
                end = max(clock + rem - test_part, suite_free) + test_part
                suite_free = finish[r["id"]] = end
                running.append(end)
                continue
            if not running:
                break  # a dependency cycle or a task nothing will release: no estimate past it
            clock = min(running)
            running.remove(clock)
        out[pess] = max(finish.values(), default=now) + t - now
    by = {k: v["deps"] for k, v in rows.items()}
    tail = max(rows.values(), key=lambda r: (len(closure(r["id"], by)), r["id"]), default=None)
    crit = []
    while tail:
        crit.insert(0, tail["id"])
        tail = next((rows[d] for d in tail["deps"]), None)
    return {"cleanMin": round(out[False] / 60), "oneRepairMin": round(out[True] / 60), "criticalPath": crit,
            "stoppedBy": [r["id"] for r in rows.values() if r["state"] == "parked"]}


def summarize(events, graph, lock_pid, alive, now, hist=None, telemetry=(), suites=None):
    hist = hist or {}
    titles = {t["id"]: t.get("title", "") for t in graph.get("tasks", [])}
    deps = {t["id"]: list(t.get("deps", [])) for t in graph.get("tasks", [])}
    rows = {tid: {"id": tid, "title": titles[tid], "state": "pending", "attempt": 0, "dispatched": False, "budget": 3, "gates": {}, "note": "",
                  "deps": deps[tid], "blocks": sorted(k for k in titles if tid in closure(k, deps)), "worker": "", "judge": "", "reviewer": "",
                  "suiteWaiting": False, "startEpoch": None, "endEpoch": None, "launches": 0} for tid in titles}
    tr = new_track(list(rows))
    last_fail = {}
    run_id, ended = "", None
    for n, e in enumerate(events, 1):
        ev, tid, d = e.get("event"), e.get("taskId"), e.get("data", {})
        feed(tr, e, e.get("_line", n), ts_epoch(e["ts"]))
        if ev in ("run-start", "run-resume"):
            run_id = run_id or str(d.get("runId", ""))
        if ev == "run-end":
            ended = {k: d.get(k, []) for k in ("done", "failed", "human", "blocked", "pending")}
            ended["tipVerify"] = d.get("tipVerify")
            oc = d.get("owedChecks") or {}
            ended["owed"] = len(oc.get("outstanding") or []) if oc.get("known") else None
            run_id = d.get("runId", run_id)
        row = rows.get(tid) if tid else None
        if row is not None:
            if ev in ("task-dispatch", "repair-dispatch"):
                row.update(state="worker", note="repair" if ev == "repair-dispatch" else "", dispatched=True)
                if ev == "task-dispatch":
                    row["startEpoch"] = row["startEpoch"] or ts_epoch(e["ts"])
                    row["attempt"] = int(d.get("attempt", row["attempt"]))
                    a = d.get("assignment") or {}
                    if a.get("adapter") and a.get("model"):
                        row["worker"] = f"{a['adapter']}:{a['model']}"
            elif ev == "worker-launch":
                row["launches"] += 1  # every worker the run started for this task, across resumes and upheld rounds
            elif ev == "worker-result":
                row.update(state="waiting", note="")
            elif ev == "phase-start" and d.get("phase") == "gates":
                row.update(state="gates", gates={}, note="")
            elif ev == "gate-result" and d.get("gate") in GATES:
                if row["state"] not in ("done", "failed"):
                    row["state"] = "gates"
                row["gates"][d["gate"]] = "pass" if d.get("pass") else "fail"
                if d["gate"] == "test":
                    row["suiteWaiting"] = False
                if not d.get("pass"):
                    last_fail[tid] = f"{d['gate']} ✖ {first_red_line(d)}"[:70]
                inv = [i.get("channel") for i in (d.get("invocations") or []) if isinstance(i, dict) and i.get("channel")]
                if d["gate"] == "acceptance" and inv:
                    row["judge"] = inv[-1]
                if d["gate"] == "review" and (d.get("reviewer") or inv):
                    row["reviewer"] = str(d.get("reviewer") or inv[-1])
            elif ev == "suite-wait":
                row["suiteWaiting"] = True
            elif ev == "suite-admitted" or (ev == "phase-start" and d.get("admitted")):
                row["suiteWaiting"] = False
            elif ev == "repair-attempt" and d.get("of"):
                row["budget"] = 1 + int(d["of"])
            elif ev == "task-human":
                why = last_fail.get(tid, "")
                row.update(state="parked", suiteWaiting=False, note=(str(d.get("reason", ""))[:60] + (f" · {why}" if why else ""))[:110])
            elif ev == "task-approved":
                row.update(state="pending", note="approved: " + str(d.get("release", "")))
            elif ev == "task-done":
                row.update(state="done", note="", _merged=ts_epoch(e["ts"]), endEpoch=ts_epoch(e["ts"]))
            elif ev == "task-failed":
                row.update(state="failed", note=str(d.get("error", d.get("reason", "")))[:90])
    at = min(now, tr["end"] or now)
    open_by_task = {k: dict(v) for k, v in tr["open"].items()}
    busy = sum(1 for r in rows.values() if r["state"] in ("worker", "waiting", "gates"))
    for tl in telemetry:  # usage rows land at task end and carry no time: credit them once the task is done or the run ended
        r = rows.get(tl.get("taskId"))
        if r and tl.get("shape") == "implement" and tl.get("tokens") and (r["state"] == "done" or ended):
            tok = r.get("tokens") or {"input": 0, "output": 0, "cacheRead": 0}
            r["tokens"] = {k: tok[k] + int(tl["tokens"].get(k) or 0) for k in tok}
    for k, r in rows.items():
        r["now"], r["nowSince"] = now_sentence(r, tr["spans"][k], rows, open_by_task, at, hist, tr["conc"], busy, (suites or {}).get(k))
        r["history"] = attempt_lines(tr["spans"][k], at)
        r.setdefault("tokens", None)
        # local wall-clock text for the card (the board's module has no time zone of its own)
        r["startedAt"] = stamp(r["startEpoch"]) if r["startEpoch"] else ""
        r["endedAt"] = hm(r["endEpoch"]) if r["endEpoch"] else ""
    needs = []
    for k, r in rows.items():
        for sp in tr["spans"][k]:
            if sp["kind"] == "park" and sp["outcome"] in ("open", "unresolved"):
                needs.append({"task": k, "kind": sp["label"], "reason": r["note"], "since": sp["t0"], "blocks": r["blocks"],
                              "cmd": f"tickmarkr approve {{run}} {k} --park {sp['line']}@{sp['ts']}"})
    window = tr["window"] if tr["window"] and needs and not ended else None
    for r in rows.values():
        r.pop("_merged", None)
    return {
        "runId": run_id,
        "alive": alive,
        "pid": lock_pid,
        "elapsedMin": int((at - tr["start"]) / 60) if tr["start"] else 0,
        "ended": ended,
        "tasks": list(rows.values()),  # the graph's own order (the spec's), never a text sort that puts T4 after T33
        "needsYou": needs,
        "approvalWindow": window,
        "eta": None if ended or not rows else eta(rows, tr["spans"], at, hist, tr["conc"]),
        "atEpoch": at,
        "startEpoch": tr["start"],
        "endEpoch": tr["end"],
        "readAt": time.strftime("%H:%M:%S"),
    }


def history_p50(runs_dir, exclude):
    """Typical worker, semantic-round and full-suite seconds over the newest other journals (p50)."""
    w, sem, test = [], [], []
    journals = [j for j in glob.glob(os.path.join(runs_dir, "*", "journal.jsonl")) if os.path.dirname(j) != exclude]
    for j in sorted(journals, key=os.path.getmtime)[-HISTORY_RUNS:]:
        open_w, open_s = {}, {}
        with open(j) as f:
            for line in f:
                if not line.startswith("{"):
                    continue
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                ev, tid, d = e.get("event"), e.get("taskId"), e.get("data") or {}
                if ev == "phase-start" and d.get("phase") == "worker":
                    open_w[tid] = ts_epoch(e["ts"])
                elif ev == "worker-result" and tid in open_w:
                    w.append(ts_epoch(e["ts"]) - open_w.pop(tid))
                elif ev == "phase-start" and d.get("phase") == "judge":
                    open_s[tid] = [ts_epoch(e["ts"]), 0]
                elif ev == "gate-result" and d.get("gate") in ("acceptance", "review") and tid in open_s:
                    open_s[tid][1] += 1
                    if open_s[tid][1] == 2:  # both verdicts in: the round lasted until the later one
                        sem.append(ts_epoch(e["ts"]) - open_s.pop(tid)[0])
                elif ev == "gate-result" and d.get("gate") == "test" and d.get("pass") and (d.get("durationMs") or 0) > 60000:
                    test.append(d["durationMs"] / 1000)
    p50 = lambda xs: sorted(xs)[len(xs) // 2] if xs else None
    return {"worker": p50(w), "semantics": p50(sem), "test": p50(test)}


def suite_progress(run_dir):
    """Live full-suite progress per task from the running test-manifest job: files done of requested, failing so far."""
    out = {}
    for job_path in glob.glob(os.path.join(run_dir, "test-manifest-report-*.json.job.json")):
        try:
            with open(job_path) as f:
                job = json.load(f)
            if job.get("state") != "running":
                continue
            with open(job_path[: -len(".job.json")]) as f:
                rep = json.load(f)
        except (OSError, ValueError):
            continue  # a report mid-write reads at the next poll
        done = rep.get("completed") or {}
        out[(job.get("subject") or {}).get("taskId")] = {"done": len(done), "total": len(rep.get("requested") or []),
                                                         "failing": sorted(k for k, v in done.items() if isinstance(v, dict) and v.get("status") == "failed")}
    return out


def expand(patterns):
    """~ and globs expand; a pattern that matches nothing is skipped."""
    return [p for pat in patterns for p in sorted(glob.glob(os.path.expanduser(pat)))]


CI_HEAD = re.compile(r"--- CI run (\d+) on (\w+) \((?:release|recut) (\w+)\)")
POLL = re.compile(r"^(\d{4}-\d\d-\d\dT\S+Z) (\S+)(?: (\S+))?$")


def release_status(dirs, now):
    """The release chain from the newest ci-watch.log under `dirs`: its last CI run's polls, then the tag, npm and
    private-main stages from the files the release scripts leave beside it. None when no log exists."""
    logs = [os.path.join(d, "ci-watch.log") for d in dirs if os.path.isfile(os.path.join(d, "ci-watch.log"))]
    if not logs:
        return None
    log = max(logs, key=os.path.getmtime)
    d = os.path.dirname(log)
    lines = [l.rstrip() for l in open(log) if l.strip()]  # the watcher writes "<ts> in_progress " with a trailing space
    heads = [i for i, l in enumerate(lines) if l.startswith("--- CI run ")]
    head = CI_HEAD.match(lines[heads[-1]]) if heads else None
    polls = [m.groups() for m in (POLL.match(l) for l in lines[heads[-1] + 1 if heads else 0:]) if m]
    status, conclusion = (polls[-1][1], polls[-1][2] or "") if polls else ("unknown", "")
    since = ts_epoch(polls[0][0]) if polls else None

    def text(name):
        path = os.path.join(d, name)
        return open(path).read() if os.path.isfile(path) else None

    script = text("tag-and-publish.sh") or ""
    version = (re.search(r"\bV=v?([\d.]+)", script) or re.search(r"(\d+\.\d+\.\d+)", os.path.basename(d)) or [None, ""])[1]
    ci = ("running", dur(now - since) if since else "") if status != "completed" else (("done", "green") if conclusion == "success" else ("failed", conclusion or "red"))
    tag_log, pub, merged = text("tag-and-publish.log"), text("publish.log") or "", text("backup-push.log")
    tag = ("pending", "") if tag_log is None else ("done", "") if "TAG-PUSHED" in tag_log else ("failed", "stopped")
    npm = re.search(r"NPM_VERSION=(\S*)", pub)
    pub_state = ("done", npm.group(1)) if npm and npm.group(1) == version else ("failed", "release red") if "RELEASE-DONE completed failure" in pub else ("running", "") if tag[0] == "done" else ("pending", "")
    return {
        "version": version, "dir": d, "ciRun": head.group(1) if head else None, "mirror": head.group(2) if head else None,
        "status": status, "conclusion": conclusion, "polledAt": hm(ts_epoch(polls[-1][0])) if polls else "",
        "stages": [
            {"name": "CI", "state": ci[0], "detail": ci[1]},
            {"name": "tag", "state": tag[0], "detail": tag[1]},
            {"name": "npm", "state": pub_state[0], "detail": pub_state[1]},
            {"name": "main", "state": "done" if merged is not None else "pending", "detail": ""},
        ],
    }


def main(*argv):
    roots = expand(argv[:argv.index("--release")] if "--release" in argv else argv)
    releases = expand(argv[argv.index("--release") + 1:]) if "--release" in argv else []
    journals = []
    for r in roots:
        runs = os.path.join(r, "runs")
        if os.path.isdir(runs):
            journals += [(r, os.path.join(runs, d, "journal.jsonl")) for d in os.listdir(runs)]
    root, journal = max(((r, j) for r, j in journals if os.path.exists(j)), key=lambda rj: os.path.getmtime(rj[1]))
    run_dir = os.path.dirname(journal)
    with open(journal) as f:
        events = []
        for n, l in enumerate(f, 1):  # the journal line is the --park token the approve command needs
            if l.strip().startswith("{"):
                e = json.loads(l)
                e["_line"] = n
                events.append(e)
    graph_path = os.path.join(run_dir, "graph.json")
    graph = json.load(open(graph_path)) if os.path.exists(graph_path) else {"tasks": []}
    tel_path = os.path.join(run_dir, "telemetry.jsonl")
    telemetry = [json.loads(l) for l in open(tel_path) if l.strip().startswith("{")] if os.path.exists(tel_path) else []
    pid, alive = None, None
    try:
        lock = json.load(open(os.path.join(root, "graph.lock")))
        if lock.get("runId") == os.path.basename(run_dir):
            pid = int(lock["pid"])
            try:
                os.kill(pid, 0)
                alive = True
            except OSError:
                alive = False
    except (OSError, ValueError, KeyError):
        alive = False  # no lock for this run: nothing holds it
    out = summarize(events, graph, pid, alive, time.time(), history_p50(os.path.dirname(run_dir), run_dir), telemetry, suite_progress(run_dir))
    out["runId"] = out["runId"] or os.path.basename(run_dir)
    for n in out["needsYou"]:
        n["cmd"] = n["cmd"].replace("{run}", out["runId"])
    out["release"] = release_status(releases, time.time())
    print(json.dumps(out))


def selftest():
    graph = {"tasks": [{"id": "T1", "title": "one"}, {"id": "T2", "title": "two", "deps": ["T1"]}]}
    ev = [
        {"ts": "2026-10-22T17:00:00Z", "event": "run-start", "data": {"effectivePolicy": {"concurrency": 2}}},
        {"ts": "2026-10-22T17:00:01Z", "event": "task-dispatch", "taskId": "T1", "data": {"attempt": 0, "assignment": {"adapter": "codex", "model": "gpt-6.1-sol"}}},
        {"ts": "2026-10-22T17:00:01Z", "event": "phase-start", "taskId": "T1", "data": {"phase": "worker", "assignment": {"adapter": "codex", "model": "gpt-6.1-sol"}}},
        {"ts": "2026-10-22T17:10:00Z", "event": "worker-result", "taskId": "T1", "data": {"ok": True}},
        {"ts": "2026-10-22T17:11:00Z", "event": "phase-start", "taskId": "T1", "data": {"phase": "gates"}},
        {"ts": "2026-10-22T17:11:01Z", "event": "gate-result", "taskId": "T1", "data": {"gate": "build", "pass": True}},
        {"ts": "2026-10-22T17:11:02Z", "event": "phase-start", "taskId": "T1", "data": {"phase": "judge"}},
        {"ts": "2026-10-22T17:11:02Z", "event": "phase-start", "taskId": "T1", "data": {"phase": "review"}},
        {"ts": "2026-10-22T17:11:30Z", "event": "gate-result", "taskId": "T1", "data": {"gate": "acceptance", "pass": True, "invocations": [{"channel": "codex:gpt-6.1-sol", "durationMs": 1}]}},
        {"ts": "2026-10-22T17:12:00Z", "event": "gate-result", "taskId": "T1", "data": {"gate": "review", "pass": False, "reviewer": "claude-code:opus", "details": "requested changes:\nsrc/x.ts null deref"}},
        {"ts": "2026-10-22T17:12:01Z", "event": "task-human", "taskId": "T1", "data": {"kind": "gate-fail", "reason": "review round cap"}},
        {"ts": "2026-10-22T17:12:01Z", "event": "approval-window-start", "data": {"windowMs": 120000, "parked": ["T1"]}},
        {"ts": "2026-10-22T17:12:30Z", "event": "suite-wait", "taskId": "T2", "data": {"count": 1, "gate": "test"}},
        {"ts": "2026-10-22T17:13:00Z", "event": "task-dispatch", "taskId": "T2", "data": {"attempt": 0}},
        {"ts": "2026-10-22T17:20:00Z", "event": "task-done", "taskId": "T2", "data": {}},
    ]
    hist = {"worker": 420, "semantics": 180, "test": 1400}
    s = summarize(ev, graph, 1, True, ts_epoch("2026-10-22T17:30:00Z"), hist)
    t1, t2 = s["tasks"]
    assert t1["state"] == "parked" and t1["gates"] == {"build": "pass", "acceptance": "pass", "review": "fail"}, t1
    assert (t1["worker"], t1["judge"], t1["reviewer"]) == ("codex:gpt-6.1-sol", "codex:gpt-6.1-sol", "claude-code:opus"), t1
    assert t2["worker"] == "" and t2["judge"] == "" and t2["reviewer"] == "", t2
    assert "review round cap" in t1["note"] and "review ✖ src/x.ts null deref" in t1["note"], t1
    # the now-sentence says what, for how long, and what it holds up; the needs-you lane carries the exact approve command
    assert t1["now"] == "parked {since} · gate-fail · blocks T2" and t1["nowSince"] == ts_epoch("2026-10-22T17:12:01Z"), t1["now"]
    n = s["needsYou"][0]
    assert n["task"] == "T1" and n["cmd"] == "tickmarkr approve {run} T1 --park 11@2026-10-22T17:12:01Z" and n["blocks"] == ["T2"], n
    assert s["approvalWindow"] == {"closesAt": ts_epoch("2026-10-22T17:14:01Z"), "parked": ["T1"]}, s["approvalWindow"]
    # attempt history replaces RECENT: one line per attempt, the red named where it happened
    parts = [p["text"] for p in t1["history"][0]["parts"]]
    review = next(p for p in t1["history"][0]["parts"] if p["text"].startswith("review ✖"))
    assert parts[0] == "worker 9m ✓" and review["reason"] == "src/x.ts null deref" and review["tone"] == "fail", t1["history"]
    assert parts[-1] == "PARK gate-fail {since}" and t1["history"][0]["parts"][-1]["since"] == t1["nowSince"], parts
    assert t1["title"] == "one" and s["startEpoch"] == ts_epoch("2026-10-22T17:00:00Z") and s["endEpoch"] is None, s
    assert t1["dispatched"] and t1["attempt"] == 0 and t1["budget"] == 3 and t2["dispatched"], t1
    # ETA: the parked chain stops the clock; a clean pass of T1 then T2 is two worker+semantics+suite rounds plus the tip suite
    assert s["eta"]["stoppedBy"] == ["T1"] and s["eta"]["criticalPath"] == ["T1", "T2"], s["eta"]
    assert s["eta"]["cleanMin"] == round((420 + 180 + 1400 + 1400) / 60), s["eta"]
    # a running worker reads against its typical time
    live = summarize(ev[:3], graph, 1, True, ts_epoch("2026-10-22T17:05:01Z"), hist)
    assert live["tasks"][0]["now"] == "worker a1 {since} on codex:gpt-6.1-sol (typ 7m)", live["tasks"][0]["now"]
    assert live["tasks"][0]["nowSince"] == ts_epoch("2026-10-22T17:00:01Z"), live["tasks"][0]
    assert live["tasks"][1]["now"] == "waits on T1", live["tasks"][1]["now"]
    assert t2["state"] == "done" and t2["deps"] == ["T1"] and t2["now"].startswith("merged"), t2
    assert s["elapsedMin"] == 30 and s["ended"] is None, s
    # the card's clock: first dispatch and merge, as epochs and as local text
    assert t1["startEpoch"] == ts_epoch("2026-10-22T17:00:01Z") and t1["endEpoch"] is None and t1["endedAt"] == "", t1
    assert t1["startedAt"] == stamp(ts_epoch("2026-10-22T17:00:01Z")) and len(t1["startedAt"]) == 19, t1["startedAt"]
    assert t2["endEpoch"] == ts_epoch("2026-10-22T17:20:00Z") and t2["endedAt"] == hm(t2["endEpoch"]), t2
    assert live["tasks"][1]["startEpoch"] is None and live["tasks"][1]["startedAt"] == "", live["tasks"][1]
    # a park the run ended on is still owed; once a resume dispatches the task again it is released, not still needing you
    tail = ev[:12] + [{"ts": "2026-10-22T17:15:00Z", "event": "run-end", "data": {"done": [], "human": ["T1"], "blocked": ["T2"]}}]
    owed = summarize(tail, graph, 1, False, ts_epoch("2026-10-22T17:16:00Z"), hist)
    assert [n["task"] for n in owed["needsYou"]] == ["T1"], owed["needsYou"]
    resumed = tail + [{"ts": "2026-10-22T17:20:00Z", "event": "run-resume", "data": {}},
                      {"ts": "2026-10-22T17:20:01Z", "event": "task-dispatch", "taskId": "T1", "data": {"attempt": 2, "retryMode": "fresh"}}]
    again = summarize(resumed, graph, 1, True, ts_epoch("2026-10-22T17:21:00Z"), hist)
    assert again["needsYou"] == [] and again["tasks"][0]["state"] == "worker", (again["needsYou"], again["tasks"][0]["state"])
    # cards keep the graph's (the spec's) order: a text sort would put T2441 before T31 and T4 after T33
    spec_order = ["T1", "T2", "T241", "T31", "T4", "T2441"]
    ordered = summarize([], {"tasks": [{"id": i, "title": i} for i in spec_order]}, 1, True, ts_epoch("2026-10-22T17:30:00Z"), hist)
    assert [t["id"] for t in ordered["tasks"]] == spec_order, [t["id"] for t in ordered["tasks"]]
    # an unclean-checkout refusal reads as its stray paths, never the raw status line
    dirty = {"details": "refusing to gate a dirty worktree: the shell gates run against the working tree ...:\n?? atchersp\n M src/x.ts"}
    assert first_red_line(dirty) == "unclean checkout: atchersp, src/x.ts", first_red_line(dirty)
    # tries count every worker the run started, across resumes and upheld rounds (the attempt index restarts each round)
    wl = [{"ts": "2026-10-22T17:00:0%dZ" % i, "event": "worker-launch", "taskId": "T1", "data": {"attempt": a}} for i, a in enumerate([0, 1, 0])]
    assert summarize(wl, graph, 1, True, ts_epoch("2026-10-22T17:30:00Z"), hist)["tasks"][0]["launches"] == 3
    # the release card reads the LAST CI section of the newest ci-watch.log and the stage files beside it
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        rd = os.path.join(tmp, "release-2120")
        os.mkdir(rd)
        with open(os.path.join(rd, "tag-and-publish.sh"), "w") as f:
            f.write("ID=${1:?x}; V=v2.12.0\n")
        with open(os.path.join(rd, "ci-watch.log"), "w") as f:
            f.write("2026-10-30T20:00:00Z in_progress \nCI-DONE completed failure\n"
                    "--- CI run 41166679545 on e0abd3a (release 657d7e172)\n"
                    "2026-10-31T04:15:00Z in_progress \n2026-10-31T04:19:00Z in_progress \n")
        r = release_status([rd], ts_epoch("2026-10-31T06:20:00Z"))
        assert (r["version"], r["ciRun"], r["mirror"], r["status"]) == ("2.12.0", "41166679545", "e0abd3a", "in_progress"), r
        assert [(g["name"], g["state"]) for g in r["stages"]] == [("CI", "running"), ("tag", "pending"), ("npm", "pending"), ("main", "pending")], r["stages"]
        assert r["stages"][0]["detail"] == dur(2 * 3600 + 5 * 60), r["stages"][0]
        with open(os.path.join(rd, "ci-watch.log"), "a") as f:
            f.write("2026-10-31T07:01:00Z completed success\nCI-DONE completed success\n")
        with open(os.path.join(rd, "tag-and-publish.log"), "w") as f:
            f.write("TAG-PUSHED v2.12.0 at e0abd3a\n")
        with open(os.path.join(rd, "publish.log"), "w") as f:
            f.write("RELEASE-DONE completed success\nNPM_VERSION=2.12.0\n")
        r = release_status([rd], ts_epoch("2026-10-31T07:30:00Z"))
        assert [(g["name"], g["state"]) for g in r["stages"]] == [("CI", "done"), ("tag", "done"), ("npm", "done"), ("main", "pending")], r["stages"]
        assert release_status([tmp], 0) is None  # no ci-watch.log: no card
    print("selftest ok")


if __name__ == "__main__":
    selftest() if sys.argv[1:] == ["--selftest"] else main(*sys.argv[1:])
