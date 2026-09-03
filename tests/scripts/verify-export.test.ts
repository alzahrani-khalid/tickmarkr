import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VERIFY_SCRIPT = join(ROOT, "scripts/verify-export.sh");

test("test: npm run verify:export runs the suite command against the exported tree rather than the checkout so it exits non-zero when that suite exits non-zero or zero when it exits zero whereas a script that runs the suite in the checkout or swallows the suite exit status fails", () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(packageJson.scripts["verify:export"]).toBe("bash scripts/verify-export.sh");

  const checkout = mkdtempSync(join(tmpdir(), "tickmarkr-verify-export-"));
  const scripts = join(checkout, "scripts");
  const bin = join(checkout, "bin");
  const exported = join(checkout, "exported");
  const npmLog = join(checkout, "npm.log");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(scripts, "verify-export.sh"), readFileSync(VERIFY_SCRIPT));
  writeFileSync(join(scripts, "export-public.sh"), `#!/usr/bin/env bash
EXPORT_DIR="$EXPORT_FIXTURE_DIR"
mkdir -p "$EXPORT_DIR"
cleanup() { rm -rf "$EXPORT_DIR"; }
trap cleanup EXIT
echo "export path: $EXPORT_DIR"
`);
  writeFileSync(join(bin, "git"), `#!/usr/bin/env bash
if [ "$1 $2" = "rev-parse --show-toplevel" ]; then printf '%s\\n' "$CHECKOUT_FIXTURE_DIR"; else exit 64; fi
`);
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env bash
printf '%s|%s\\n' "$PWD" "$*" >> "$NPM_LOG"
if [ "$1" = "test" ]; then exit "$SUITE_STATUS"; fi
`);
  chmodSync(join(bin, "git"), 0o755);
  chmodSync(join(bin, "npm"), 0o755);

  for (const expected of [0, 23]) {
    writeFileSync(npmLog, "");
    const result = spawnSync("bash", [join(scripts, "verify-export.sh")], {
      cwd: checkout,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CHECKOUT_FIXTURE_DIR: checkout,
        EXPORT_FIXTURE_DIR: exported,
        NPM_LOG: npmLog,
        SUITE_STATUS: String(expected),
      },
    });

    expect(result.status, result.stderr).toBe(expected);
    expect(readFileSync(npmLog, "utf8").trim().split("\n")).toEqual([
      `${exported}|ci`,
      `${exported}|run build`,
      `${exported}|test`,
    ]);
  }
});
