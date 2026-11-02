import { expect, test } from "vitest";
import { dispatch, USAGE } from "../../src/cli/index.js";
import { COMMAND_HELP, PROFILE_HELP, commandHelp } from "../../src/cli/help.js";

const PRIVATE_ID = /queue rows?\s+\d+|\bD-\d+|\bOBS-\d+/i;

function expectNoPrivateIds(rendered: string, label: string): void {
  expect(rendered, `${label} help must contain no private record ids`).not.toMatch(PRIVATE_ID);
  expect(rendered.length, `${label} rendering must be non-trivial`).toBeGreaterThan(0);
}

// Leaf title is the complete acceptance criterion, verbatim.
test("the sweep covers every command key, every profile key and the real root help with no private-id token, and its checker independently rejects planted \"queue row 7\", \"Queue rows 244\", \"D-1\", \"D-2178\" and \"OBS-31\" while accepting flag examples, task ids and version strings, so an empty or fallback-only sweep fails", async () => {
  // The checker itself must reject planted private ids...
  for (const planted of ["queue row 7", "Queue rows 244", "D-1", "D-2178", "OBS-31"]) {
    expect(PRIVATE_ID.test(planted), `checker must reject ${planted}`).toBe(true);
  }
  // ...while accepting flag examples, task ids and version strings.
  for (const benign of ["--agent", "--force --remove", "T4", "run-20261102-040923", "1.31.0", "v2.3"]) {
    expect(PRIVATE_ID.test(benign), `checker must accept ${benign}`).toBe(false);
  }

  for (const [command, entry] of Object.entries(COMMAND_HELP)) {
    const rendered = commandHelp(command);
    expect(rendered, `commandHelp(${command}) must render`).toContain(entry.usage);
    expectNoPrivateIds(rendered, command);
  }

  for (const [operation, entry] of Object.entries(PROFILE_HELP)) {
    const rendered = commandHelp("profile", [operation, "--help"]);
    expect(rendered, `profile ${operation} help must render`).toContain(entry.usage);
    expectNoPrivateIds(rendered, `profile ${operation}`);
  }

  const root = (await dispatch("--help", [])).out;
  expect(root, "root help must render").toContain(USAGE);
  expectNoPrivateIds(root, "root");
});
