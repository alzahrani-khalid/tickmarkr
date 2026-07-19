# VIS-09 trailer-width measurement (P43-03)

## Probe run

- **Command:** `HERDR_ENV=1 HERDR_WORKSPACE_ID=wJ node scripts/measure-trailer-width.mjs`
- **Agent CLI:** `cursor-agent` `2026.07.09-a3815c0`
- **Terminal full width:** 222 cols (`herdr pane layout` `layout.area.width` on an unsplit probe tab)
- **Nonce:** `vis09probe` (fixed; matches suite + probe)
- **Captures:** `.planning/phases/43-readable-worker-panes/measurement/` (`results.json` + `cols-*.txt`)

Probe tab: throwaway `VIS09-PROBE-r{1,2}` tabs; three successive `--direction right` splits on the right child to yield four pane widths per repeat; each pane runs `probe-run.sh` (real `tput cols`, CLI `--version`, then interactive `cursor-agent`).

## Per-width verdict table

| measured cols | repeats | parseOk (both) | capture files |
|---------------|---------|----------------|---------------|
| 108 | 2/2 | yes | `cols-108-r1-pwJp1NM.txt`, `cols-108-r2-pwJp1NR.txt` |
| 53 | 2/2 | yes | `cols-53-r1-pwJp1NN.txt`, `cols-53-r2-pwJp1NS.txt` |
| 25 | 2/2 | no | `cols-25-r1-pwJp1NP.txt`, `cols-25-r2-pwJp1NT.txt` |
| 24 | 2/2 | no | `cols-24-r1-pwJp1NQ.txt`, `cols-24-r2-pwJp1NV.txt` |

At 25–24 cols the `TICKMARKR_RESULT_vis09probe` marker token is hard-wrapped mid-token (`TICKMARKR_RESULT_v` / `is09probe`) — unrecoverable by `parseWorkerResult`. At 53+ cols the real parser recovers the trailer from cursor-agent's hard-wrapped JSON.

- **Narrowest measured-safe width:** 53 cols (both repeats pass)
- **Adopted safety floor:** 108 cols — the next measured-safe width above 53 (conservative by one step; a boundary sample is not a floor)

## Licensing condition 2 — herdr pane width introspection

**Verb:** `herdr pane layout --pane <pane_id>`

Raw output (representative):

```json
{"id":"cli:pane:layout","result":{"layout":{"area":{"height":71,"width":222,"x":34,"y":1},"panes":[{"focused":true,"pane_id":"wJ:p1NK","rect":{"height":71,"width":222,"x":34,"y":1}}],"splits":[],"tab_id":"wJ:tRN","workspace_id":"wJ","zoomed":false},"type":"pane_layout"}}
```

`result.layout.panes[].rect.width` (or `layout.area.width` for a single-pane tab) yields the pane width at layout time.

`herdr pane get <pane_id>` does **not** include width (only cwd, scroll, tab_id). `herdr tab get <tab_id>` does **not** include width either.

## Grid licensed

1. **Trailer-safe minimum exists:** yes — narrowest safe 53 cols; adopted floor 108 cols (see table).
2. **Driver can know pane width at layout time:** yes — `herdr pane layout --pane <id>` → `result.layout.panes[].rect.width`; introspection failure → fail closed to `--direction down`.
3. **Half-width column at observed terminal width ≥ floor + margin:** terminal 222 cols → half column 111 cols; floor 108 + margin 2 = 110; 111 ≥ 110 → **licensed**.

The phase-1 incident (e8aa003, COLUMNS≈2) is overturned by this data for widths ≥222; the driver gates the first generation split on runtime width via `workerSplitDirection` (see `src/drivers/herdr.ts`).
