import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../../package.json");
const distDir = join(dirname(pkgPath), "dist");

export function distFingerprint(dir = distDir): string {
  if (!existsSync(dir)) return "missing";
  const files: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  visit(dir);
  const hash = createHash("sha256");
  for (const file of files.sort()) hash.update(relative(dir, file)).update("\0").update(readFileSync(file)).update("\0");
  return hash.digest("hex");
}

export async function version(argv: string[] = [], dir = distDir, cwd = process.cwd()): Promise<string> {
  const { version: v } = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  const stamp = argv.includes("--dist") ? `${v} dist:${resolve(dir)} fingerprint:${distFingerprint(dir)}` : v;
  if (!argv.includes("--check")) return stamp;

  let manifest: { name?: string; version?: string } | undefined;
  try { manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")); } catch { /* no source manifest — consumer guidance check */ }
  if (manifest?.name === "tickmarkr") {
    const repoVersion = manifest.version ?? "missing";
    const equal = v === repoVersion;
    const out = `tickmarkr binary ${stamp}: compared tickmarkr source repository package.json version ${repoVersion} — ${equal ? "entire version matches" : "versions differ; update or link the correct binary"}`;
    if (!equal) throw new Error(out);
    return out;
  }

  const { agentSkillEvidence, docsDrift, installedAgentGuidance, skillDrift } = await import("./init.js");
  const evidence = agentSkillEvidence(cwd);
  const installed = installedAgentGuidance(cwd);
  if (!installed.length) return `tickmarkr binary ${stamp}: no installed agent guidance to compare`;
  const skillChanges = skillDrift(cwd);
  const docsChanges = docsDrift(cwd);
  const modifiedPaths = new Set(skillChanges.flatMap(({ dir: skillDir, modified }) => modified.map((file) => join(skillDir, file))));
  const refresh = (path: string) => `refresh ${relative(cwd, path)} with tickmarkr init --agent --force`;
  const drift = [
    ...evidence.links.map((path) => `kept ${relative(cwd, path)} (symbolic link); move ${relative(cwd, path)} to a regular, unlinked location`),
    ...evidence.skills.flatMap((skill) => [
      ...(!skill.current && skill.removable ? [skill.dir] : []).concat(skill.leftovers)
        .map((path) => `leftover ${relative(cwd, path)}; ${skill.current && skill.removable
          ? `${refresh(skill.dir)} to remove ${relative(cwd, path)}`
          : `remove ${relative(cwd, path)} with tickmarkr init --agent`}`),
      ...skill.unproven.map((path) => `unproven ${relative(cwd, path)}; ${modifiedPaths.has(path)
        ? refresh(path) : `move ${relative(cwd, path)} out of the skill directory before refreshing`}`),
    ]),
    ...skillChanges.flatMap(({ dir: skillDir, missing, modified }) => [
      ...missing.map((file) => `missing ${relative(cwd, join(skillDir, file))}; ${refresh(join(skillDir, file))}`),
      ...modified.map((file) => `modified ${relative(cwd, join(skillDir, file))}; ${refresh(join(skillDir, file))}`),
    ]),
    ...docsChanges.map((file) => `stale agent-docs block in ${relative(cwd, file)}; ${refresh(file)}`),
  ];
  const out = [
    `tickmarkr binary ${stamp}: compared installed agent guidance with this binary's packaged block and skills:`,
    ...installed.map((file) => `  ${relative(cwd, file)}`),
    ...(drift.length ? [...drift, ...(skillChanges.length || docsChanges.length ? ["refresh: tickmarkr init --agent --force"] : [])] : ["installed guidance matches"]),
  ].join("\n");
  if (drift.length) throw new Error(out);
  return out;
}
