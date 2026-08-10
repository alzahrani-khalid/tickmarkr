import { existsSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";

// v1.89 T4: `tickmarkr version` answers "which release do I claim to be", which is the EXPECTED reading in
// the failure case — package.json bumps only at release, so an installed package and a checkout two
// milestones ahead both print the same string. The only thing that separates them is where the executing
// file actually lives, so that is what this derives: a resolved path plus a provenance read off it.
export type HarnessProvenance = "installed" | "checkout" | "unknown" | "unresolved";
export type Harness = { path: string; provenance: HarnessProvenance };

const LABEL: Record<HarnessProvenance, string> = {
  installed: "installed package",
  checkout: "working checkout",
  unknown: "unknown origin",
  unresolved: "unresolved location",
};

// Read off the RESOLVED location — never a build-time constant and never a value the binary states about
// itself, because a self-report is exactly as trustworthy as the version string it exists to replace.
// node_modules first: a package installed inside a checkout is still an installed package.
const provenanceOf = (path: string): HarnessProvenance => {
  if (path.split(sep).includes("node_modules")) return "installed";
  // a git worktree's `.git` is a FILE, not a directory — existsSync covers both
  for (let d = dirname(path); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return "checkout";
    if (dirname(d) === d) return "unknown";
  }
};

/**
 * Resolve the harness that is executing from a path the CALLER supplies — never from process state, so a
 * caller can pin the rendering without pinning its own filesystem. The resolution is the point: a global
 * bin is a symlink into node_modules, and the invoked name hides exactly the segment provenance is read
 * from (`process.argv[1]` never shows it).
 */
export function resolveHarness(from: string | undefined): Harness {
  let path: string;
  try {
    // `realpathSync("")` does NOT throw — it returns the cwd, so an absent `process.argv[1]` would name a
    // DIRECTORY as the executing harness and read provenance off the caller's location instead of the
    // binary's (inside a checkout: a confident, false "working checkout"). Absence is admitted as ITSELF:
    // taking `undefined` means no caller has to invent an empty string to say "no location", and the one
    // function every caller routes through rejects both forms before realpathSync ever sees them.
    if (!from) throw new Error("no location");
    path = realpathSync(from);
  } catch {
    // Fail closed: with no resolved location there is nothing to derive FROM, and classifying the
    // unresolved TEXT would invent the claim — `/nowhere/node_modules/tickmarkr/…` would read
    // "installed package" about a file that does not exist. The raw text survives as diagnostic only,
    // never as evidence; a throw here would take down `plan`/`compile` over a provenance banner.
    return { path: from ?? "", provenance: "unresolved" };
  }
  return { path, provenance: provenanceOf(path) };
}

export const harnessLine = (h: Harness): string => `harness: ${h.path} (${LABEL[h.provenance]})`;
