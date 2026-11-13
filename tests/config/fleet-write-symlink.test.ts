// The overlay writer on a config that is a symbolic link (queue row 443): the link stays a link and
// the file it points to is the one written. The whole save, through the command, is tested in
// tests/cli/fleet-screen.test.ts.
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeFleetOverlay } from "../../src/cli/commands/fleet.js";

const dir = () => mkdtempSync(join(tmpdir(), "tickmarkr-symlink-"));

test("a config that is a symbolic link is written through the link: the link stays, the file it points to changes, no temporary file is left", () => {
  const dot = dir(), repo = dir();
  const real = join(dot, "config.yaml"), link = join(repo, "config.yaml");
  writeFileSync(real, "# kept in dotfiles\n");
  symlinkSync(real, link);
  writeFleetOverlay(link, (prior) => `${prior}review:\n  required: true\n`);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(real);
  expect(readFileSync(real, "utf8")).toBe("# kept in dotfiles\nreview:\n  required: true\n");
  for (const d of [dot, repo]) expect(readdirSync(d).filter((f) => f.endsWith(".tmp")), d).toEqual([]);
});

test("a symbolic link that points to nothing refuses, naming the config, and creates nothing where it points", () => {
  const repo = dir(), gone = join(dir(), "gone", "config.yaml"), link = join(repo, "config.yaml");
  symlinkSync(gone, link);
  let serialized = false;
  expect(() => writeFleetOverlay(link, () => { serialized = true; return "x\n"; })).toThrow(`${link} is a symbolic link that points to nothing`);
  expect(serialized).toBe(false);
  expect(existsSync(join(gone, ".."))).toBe(false);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readdirSync(repo)).toEqual(["config.yaml"]);
});

test("a config that is a regular file, or does not exist yet, is written where it is", () => {
  const repo = dir(), path = join(repo, "nested", "config.yaml");
  writeFleetOverlay(path, (prior) => `${prior}a: 1\n`);
  writeFleetOverlay(path, (prior) => `${prior}b: 2\n`);
  expect(readFileSync(path, "utf8")).toBe("a: 1\nb: 2\n");
  expect(lstatSync(path).isSymbolicLink()).toBe(false);
});
