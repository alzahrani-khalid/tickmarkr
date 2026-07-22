import { bold, dim, fail, legend } from "../../brand.js";
import { RELOAD_GUARD_NOTICE, type SaveTarget } from "../save.js";

export type DiffModalProps = {
  target: SaveTarget;
  targetPath: string;
  diff: string;
  liveRun: boolean;
};

/** Render the save-confirmation modal: header names the target path, body shows the exact overlay diff. */
export function renderDiffModal(props: DiffModalProps): string[] {
  const lines: string[] = [];
  lines.push(bold(`Save overlay — ${props.targetPath} (${props.target === "repo" ? "repository" : "global"} target)`));
  lines.push(legend("t toggle target · y confirm · n/esc cancel"));
  if (props.liveRun) {
    lines.push(fail(RELOAD_GUARD_NOTICE));
  }
  lines.push(dim("─ diff ─"));
  if (props.diff) {
    lines.push(...props.diff.trimEnd().split("\n"));
  } else {
    lines.push(dim("(no overlay changes)"));
  }
  return lines;
}
