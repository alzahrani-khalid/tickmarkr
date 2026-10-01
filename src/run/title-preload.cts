// A2 (D-787): loaded through NODE_OPTIONS into Darwin shell children (title-environment.ts decides
// when). Node's native process.title setter checks in with LaunchServices on every write, and test
// runners write it per worker; a burst of those check-ins has restarted launchservicesd. Here a title
// write stays in JavaScript, so `ps` keeps the original command line.
//
// npm is the exception: its entry sets the native title first thing so `ps` never shows secrets given
// on its command line, and that hiding must survive. The entry is recognised by the script it runs —
// `bin/npm-cli.js` / `bin/npx-cli.js` in every npm major's package layout, or corepack's npm/npx shim —
// resolved through symlinks, since the `npm` command on PATH is a link to it.
//
// CommonJS (.cts → .cjs) so `--require` loads it in every supported Node, ESM package or not. It never
// throws: a preload that throws kills the payload it was meant to protect.
import { realpathSync } from "node:fs";

const NPM_ENTRY = /[\\/](?:bin[\\/]np[mx]-cli|corepack[\\/]dist[\\/]np[mx])\.js$/;

// The script node was asked to run; an unresolvable one (`node -e`, a deleted file) is simply not npm.
const entry = (): string => {
  try { return realpathSync(process.argv[1]!); } catch { return process.argv[1] ?? ""; }
};

try {
  const native = Object.getOwnPropertyDescriptor(process, "title");
  if (native?.configurable && !NPM_ENTRY.test(entry())) {
    let title = process.title;
    Object.defineProperty(process, "title", {
      configurable: true,
      enumerable: native.enumerable,
      get: () => title,
      set: (value: unknown) => { title = String(value); },
    });
  }
} catch { /* fail open: the native setter stays */ }
