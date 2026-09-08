/** Isolated real dispatcher with an injected terminal; no mock application or model. */
import { PassThrough, Writable } from 'node:stream';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [cwd, command, args, tty = 'false'] = process.argv.slice(2);
process.chdir(cwd);
const input = new PassThrough();
input.isTTY = tty === 'true'; input.isRaw = false;
input.setRawMode = raw => { input.isRaw = raw; return input; };
input.ref = () => input; input.unref = () => input;
let stdout = '', stderr = '', writes = 0;
const snapshots = () => ({ stdout, stderr, writes, raw: input.isRaw, pid: process.pid, presence: (() => {
  try { return readdirSync(join(cwd, '.tickmarkr', 'supervision')).filter(n => n.startsWith(`watch.live.${process.pid}.`)); }
  catch { return []; }
})() });
class Output extends Writable {
  isTTY = tty === 'true'; columns = 120; rows = 40;
  _write(chunk, _encoding, callback) { stdout = (stdout + chunk.toString()).slice(-40000); writes++; callback(); }
}
const output = new Output();
const error = new Writable({ write(chunk, _encoding, callback) { stderr = (stderr + chunk.toString()).slice(-20000); callback(); } });
Object.defineProperty(process, 'stdin', { value: input });
Object.defineProperty(process, 'stdout', { value: output });
Object.defineProperty(process, 'stderr', { value: error });
process.on('message', message => {
  if (message.key) input.write(message.key);
  if (message.resize) { [output.columns, output.rows] = message.resize; output.emit('resize'); }
  if (message.snapshot) process.send?.({ type: 'snapshot', ...snapshots() });
});
if (!process.env.C6_BUILD_ROOT) throw new Error('observer requires an isolated production build');
const { dispatch } = await import(pathToFileURL(join(process.env.C6_BUILD_ROOT, 'dist/cli/index.js')).href);
const timer = setInterval(() => process.send?.({ type: 'snapshot', ...snapshots() }), 100);
try {
  const result = await dispatch(command, JSON.parse(args));
  process.send?.({ type: 'done', ...snapshots(), result });
  if (result.code) process.exitCode = result.code;
} finally {
  clearInterval(timer); input.destroy(); output.destroy(); error.destroy();
  process.disconnect?.();
}
