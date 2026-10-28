import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { expect, test } from "vitest";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

function acpSection(): string {
  const heading = "## `tickmarkr acp`";
  expect(readme.split(heading)).toHaveLength(2);
  const start = readme.indexOf(heading);
  const end = readme.indexOf("\n## ", start + heading.length);
  expect(readme.slice(end)).toMatch(/^\n## Contributing\n/u);
  return readme.slice(start, end);
}

type Launch = { command: string; args: string[]; env: Record<string, string>; type?: string };

function assertAbsoluteLaunch(entry: Launch): void {
  expect(posix.isAbsolute(entry.command), "absolute Node executable").toBe(true);
  expect(posix.basename(entry.command)).toBe("node");
  expect(entry.args).toHaveLength(2);
  expect(posix.isAbsolute(entry.args[0]!), "absolute tickmarkr script").toBe(true);
  expect(entry.args[0]).toMatch(/\/tickmarkr\/dist\/cli\/index\.js$/u);
  expect(entry.args[1]).toBe("acp");
  expect(entry.env).toEqual({});
}

test("test: the README's acp section gives Zed and JetBrains entries that parse as JSON and launch absolute node and tickmarkr script paths with the acp argument, so a bare command name fails", () => {
  const section = acpSection();
  expect(section).toMatch(/Dock-launched editors may lack your shell's `PATH`/u);
  expect(section).toContain("Replace both example paths");
  const clients = [
    { name: "Zed", text: section.slice(section.indexOf("For [Zed]"), section.indexOf("For [JetBrains]")), file: "settings.json" },
    { name: "JetBrains", text: section.slice(section.indexOf("For [JetBrains]")), file: "~/.jetbrains/acp.json" },
  ];
  expect([...section.matchAll(/^```json\n/gmu)]).toHaveLength(2);
  const launches = clients.map(({ name, text, file }) => {
    expect(text, name).toContain(file);
    const blocks = [...text.matchAll(/^```json\n([\s\S]*?)\n```/gmu)];
    expect(blocks, name).toHaveLength(1);
    const config = JSON.parse(blocks[0]![1]!);
    expect(Object.keys(config.agent_servers)).toEqual(["tickmarkr"]);
    const entry = config.agent_servers.tickmarkr as Launch;
    if (name === "Zed") expect(entry.type).toBe("custom");
    assertAbsoluteLaunch(entry);
    for (const command of ["node", "tickmarkr", "~/bin/node"]) {
      expect(() => assertAbsoluteLaunch({ ...entry, command }), `${name}: ${command}`).toThrow();
    }
    for (const script of ["tickmarkr", "dist/cli/index.js", "~/tickmarkr/dist/cli/index.js"]) {
      expect(() => assertAbsoluteLaunch({ ...entry, args: [script, "acp"] }), `${name}: ${script}`).toThrow();
    }
    expect(() => assertAbsoluteLaunch({ ...entry, args: [entry.args[0]!, "--acp"] })).toThrow();
    return { command: entry.command, args: entry.args, env: entry.env };
  });
  expect(launches[0]).toEqual(launches[1]);
  expect(section).toContain("Other ACP clients use the same command and arguments");
  // Every README JSON example must be strict JSON, including any outside this section.
  for (const block of readme.matchAll(/^```json\n([\s\S]*?)\n```/gmu)) {
    expect(() => JSON.parse(block[1]!)).not.toThrow();
  }
});

function assertConsoleContract(section: string): void {
  const prose = section.replace(/\s+/gu, " ");
  expect(prose).toContain("ACP v1 agent that an editor launches over stdio");
  expect(prose).toContain("runs no model and accepts only console commands");
  const commands = new Map([...section.matchAll(/^\| `(\/[^`]+)` \| (.+) \|$/gmu)]
    .map((row) => [row[1]!, row[2]!]));
  expect([...commands.keys()]).toEqual([
    "/attach [run]", "/status [run]", "/compile <spec>", "/plan", "/run", "/resume <run id>",
  ]);
  for (const command of ["/compile <spec>", "/plan"]) {
    expect(commands.get(command)).toMatch(/`tickmarkr version --check` first; .* only if it succeeds/u);
  }
  for (const [command, cli] of [["/run", "run"], ["/resume <run id>", "resume <runId>"]]) {
    expect(commands.get(command!)).toContain(`tickmarkr ${cli} --driver subprocess`);
    expect(commands.get(command!)).toContain("as a detached daemon, then watch it");
  }
  for (const phrase of [
    "Journalled runs appear as sessions",
    "Both launch commands also check the version before launching",
    "they accept no driver override or other flags",
    "A park shows its exact `tickmarkr approve` commands, who enacts each decision",
    "approval window's close time when a window is open",
    "The live daemon enacts a release at its next task boundary",
    "without a live owner, run the printed `tickmarkr resume` command after approving",
    "Window expiry is a lapse: approvals are swept again before final close",
    "ACP never decides: no ACP answer or client setting releases a park",
    "Run a printed approval command explicitly in a terminal",
    "Closing the editor or a session stops only the watch; nothing is signalled to the daemon or workers",
    "ACP never stops a run",
    "tickmarkr is not in the ACP registry",
  ]) expect(prose).toContain(phrase);
  expect(prose).not.toMatch(/\b(?:editor|ACP|client)\s+(?:can|will)\s+(?:approve|release|decide|stop|kill|signal)\b/iu);
}

test("test: the README's acp section names every console command and the version check, and states that acp never decides, that closing stops only the watch with nothing signalled, and that it is not in the registry, so a section promising an editor approval fails", () => {
  const section = acpSection();
  assertConsoleContract(section);
  for (const promise of ["The editor can approve a park.", "ACP will stop the run on close."]) {
    expect(() => assertConsoleContract(`${section}\n${promise}`)).toThrow();
  }
  for (const phrase of ["/attach [run]", "/status [run]", "/compile <spec>", "/plan", "/run", "/resume <run id>",
    "tickmarkr version --check", "--driver subprocess", "detached", "ACP never decides", "nothing is signalled", "not in the ACP registry"]) {
    expect(() => assertConsoleContract(section.replaceAll(phrase, "omitted")), phrase).toThrow();
  }
});
