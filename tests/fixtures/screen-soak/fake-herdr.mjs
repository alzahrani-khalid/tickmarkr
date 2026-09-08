#!/usr/bin/env node
/** Fake terminal host; pane launch executes the exact driver-supplied production command. */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const [family, verb, ...args] = process.argv.slice(2);
const file = process.env.C6_HERDR_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
appendFileSync(file + '.calls', JSON.stringify([family, verb, ...args]) + '\n');
let result = {}, failed = false;
if (family === 'pane' && verb === 'list') result = { panes: state.panes };
else if (family === 'pane' && verb === 'split') {
  if (state.failSplit) { failed = true; }
  else {
    const pane = { pane_id: `wC6:p${++state.next}`, workspace_id: 'wC6', tab_id: 'wC6:tCALLER', label: '', cwd: process.cwd() };
    state.panes.push(pane); result = { pane };
  }
} else if (family === 'pane' && verb === 'rename') {
  const pane = state.panes.find(p => p.pane_id === args[0]);
  if (pane && !state.failRename) pane.label = args[1]; else failed = true;
} else if (family === 'pane' && verb === 'run') {
  const pane = state.panes.find(p => p.pane_id === args[0]);
  if (!pane) failed = true;
  else if (!args[1].includes('TICKMARKR_START_')) pane.seed = args[1];
  else {
    const launch = state.noLaunch ? ':' : args[1];
    const frame = `${file}.${pane.pane_id.replaceAll(':', '-')}.frame`;
    const child = spawn('bash', ['-c', `${pane.seed ?? ':'}\n${launch}`], {
      cwd: pane.cwd, detached: true, stdio: 'ignore',
      env: { ...process.env, C6_FRAME_PATH: frame, NODE_OPTIONS: `--import ${new URL('./tty-bootstrap.mjs', import.meta.url).pathname}` },
    });
    child.unref(); pane.launcherPid = child.pid; pane.frame = frame;
    state.children.push(child.pid);
  }
} else if (family === 'pane' && verb === 'close') {
  const pane = state.panes.find(p => p.pane_id === args[0]);
  if (state.failClose) failed = true;
  else { if (pane?.launcherPid) { try { process.kill(-pane.launcherPid, 'SIGTERM'); } catch {} } state.panes = state.panes.filter(p => p !== pane); }
} else if (family === 'pane' && verb === 'read') {
  const pane = state.panes.find(p => p.pane_id === args[0]);
  try { process.stdout.write(JSON.parse(readFileSync(pane.frame, 'utf8')).frame); } catch {}
  writeFileSync(file, JSON.stringify(state)); process.exit(0);
} else if (family === 'pane' && verb === 'focus') {
  if (state.unsupportedFocus) failed = true;
  else state.focused = args[0];
} else if (family === 'pane' && verb === 'wait-output') { result = { matched: false }; failed = true; }
writeFileSync(file, JSON.stringify(state));
process.stdout.write(JSON.stringify({ result }));
if (failed) { process.stderr.write('fixture host refused operation'); process.exitCode = 1; }
