# Board summarizer oracle (queue row 332)

`reference/` is the operator's run board as built and used before 2.19.0 (tkr-run-progress 0.3.1), frozen. It is the
oracle for `src/board/` and `hooks/board/`. Do not edit it. `reference/plugin.json` has its two folder defaults blanked.

`runs/<name>/` holds four real run journals and one synthetic run (`synthetic-edges`, written by make-goldens.py), shrunk to the fields `reference/summarize.py` reads, with:
- journal line numbers kept, since the park token is a journal line;
- each gate's first red line unchanged;
- the reference output unchanged by the shrink;
- home paths scrubbed to `/home/user`.

`goldens.json` is the reference output (Python 3.9; each case names its time zone) over 174 journal cuts in two time zones (one with a DST change), five state-root layouts and twelve release folders. `releaseSelection` holds four OBSERVER-authored cases for the deliberate difference R8a in PORT-RULES.md; they are labeled, because the reference cannot produce them.
Regenerate it with `python3 -I make-goldens.py .` from this folder. Tests never run Python.
