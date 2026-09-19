import { writeFileSync } from "node:fs";
import { shq } from "../../src/adapters/types.js";

/** Preserve the caller's shell setup, then override only the capability this fixture controls.
 * Replacing BASH_ENV outright can also replace Git/tool resolution in login-shell workers. */
export function writeBashEnvFixture(path: string, body: string): void {
  const prior = process.env.BASH_ENV;
  writeFileSync(path, `${prior ? `. ${shq(prior)}\n` : ""}${body}`);
}
