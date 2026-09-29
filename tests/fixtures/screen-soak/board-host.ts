import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HerdrDriver } from "../../../src/drivers/herdr.js";
import { makeTestTempDir } from "../../helpers/tmprepo.js";
import { root } from "./test-support.js";
export type HostPane = { pane_id: string; label: string; workspace_id: string; tab_id?: string; cwd: string; launcherPid?: number; frame?: string };
export type HostState = { panes: HostPane[]; next: number; children: number[]; focused?: string; failSplit?: boolean; unsupportedFocus?: boolean; failClose?: boolean };
export function boardHost() {
  const directory = makeTestTempDir("c6-herdr-");
  const path = join(directory, "state.json");
  const old = { C6_HERDR_STATE: process.env.C6_HERDR_STATE, HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  process.env.C6_HERDR_STATE = path; process.env.HERDR_WORKSPACE_ID = "wC6"; process.env.HERDR_PANE_ID = "wC6:pCALLER";
  const write = (state: HostState) => writeFileSync(path, JSON.stringify(state));
  write({ panes: [], next: 0, children: [] });
  const read = () => JSON.parse(readFileSync(path, "utf8")) as HostState;
  return { path, read, write, driver: () => new HerdrDriver(join(root, "tests/fixtures/screen-soak/fake-herdr.mjs")),
    calls: () => { try { return readFileSync(path + ".calls", "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]); } catch { return []; } },
    dispose: () => {
      for (const pid of read().children) { try { process.kill(-pid, "SIGTERM"); } catch { /* already exited */ } }
      for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    },
  };
}
