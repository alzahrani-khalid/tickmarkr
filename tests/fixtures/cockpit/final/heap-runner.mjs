/** Run with node --import tsx --expose-gc; imports source, never a mock renderer. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { getHeapSpaceStatistics, getHeapStatistics } from 'node:v8';
import { setImmediate as yieldTick } from 'node:timers/promises';
import { runLiveCockpit } from '../../../../src/tui/cockpit/live.ts';
import { createLiveStore } from '../../../../src/tui/cockpit/live-store.ts';

const shape = process.argv[2] ?? 'static';
const destination = process.argv[3];
if (!['static', 'growth', 'resize'].includes(shape) || !global.gc || !destination) throw new Error('usage: node --import tsx --expose-gc heap-runner.mjs static|growth|resize result.json');
const root = resolve(import.meta.dirname, '../../../..');
const fixture = mkdtempSync(join(tmpdir(), 'operator-heap-'));
const runId = 'run-20260905-000000';
const runDir = join(fixture, '.tickmarkr', 'runs', runId);
mkdirSync(runDir, { recursive: true });
const journal = join(runDir, 'journal.jsonl');
const start = Date.parse('2026-09-05T00:00:00Z');
const event = (name, taskId, data = {}) => JSON.stringify({ ts: new Date(start).toISOString(), event: name, ...(taskId ? { taskId } : {}), data }) + '\n';
writeFileSync(journal, event('run-start', undefined, { branch: 'fixture', daemonPid: process.pid }) + event('task-dispatch', 'T1', { attempt: 0, assignment: { adapter: 'fake', model: 'fixture' } }));
let writes = 0, bytes = 0, lastChunk = '', tick = 0;
class CountingOutput extends Writable {
  isTTY = true; columns = 120; rows = 40;
  _write(chunk, _encoding, callback) {
    const text = chunk.toString();
    writes++; bytes += chunk.length;
    // Only a frame with visible text is retained: cursor/pointer-tracking control writes at unmount never replace it.
    if (text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').trim()) lastChunk = text.slice(-20000);
    callback();
  }
}
const output = new CountingOutput();
const input = new PassThrough();
input.isTTY = true; input.setRawMode = () => input; input.ref = () => input; input.unref = () => input;
const samples = [];
let firstFailure;
let delivery;
let mounted;
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceFiles = ['src/run/operator-state.ts', 'src/tui/cockpit/live-store.ts', 'src/tui/cockpit/derive.ts', 'src/tui/cockpit/live.ts', 'src/tui/cockpit/live-runtime.tsx', 'src/tui/cockpit/shell.tsx'];
const sourceDirty = execFileSync('git', ['status', '--porcelain', '--', ...sourceFiles], { cwd: root, encoding: 'utf8' }).trim();
const environment = { NODE_ENV: process.env.NODE_ENV ?? null, node: process.version, platform: process.platform, arch: process.arch, TERM: process.env.TERM ?? null, CI: process.env.CI ?? null };
const store = createLiveStore({ cwd: fixture, runId, now: () => start + tick * 1000 });
function sample() {
  global.gc();
  const usage = process.memoryUsage();
  const measures = performance.getEntriesByType('measure');
  const row = { timestamp: new Date().toISOString(), pid: process.pid, sourceCommit, environment: environment.NODE_ENV, tick, observedAt: start + tick * 1000, heap: usage.heapUsed, rss: usage.rss, writes, bytes, performanceMeasures: measures.length, store: store.diagnostics() };
  samples.push(row);
  // Retainer evidence is captured at the first failing sample, before later samples can replace it.
  // The global performance timeline is an observable root retaining these entries. Keep counts and
  // representative entries, plus V8 space sizes; never clear that root as a test-only workaround.
  if (tick >= 1000 && usage.heapUsed > 64 * 1024 * 1024 && !firstFailure) firstFailure = {
    tick, heap: usage.heapUsed, root: 'node:perf_hooks performance timeline', performanceMeasures: measures.length,
    entries: [...measures.slice(0, 3), ...measures.slice(-3)].map(m => ({ name: m.name, entryType: m.entryType, startTime: m.startTime, duration: m.duration, detailType: typeof m.detail })),
    heapSpaces: getHeapSpaceStatistics(), heapStatistics: getHeapStatistics(),
  };
}
try {
  mounted = runLiveCockpit({ input, output, cwd: fixture, runId, binaryVersion: 'heap-fixture', now: () => start + tick * 1000, refreshMs: 2 ** 30, debug: true, onShellDelivery: d => { delivery = d; } });
  await yieldTick();
  for (tick = 1; tick <= 11000; tick++) {
    if (shape === 'growth' && tick % 10 === 0) appendFileSync(journal, event('worker-nudge', 'T1', { reason: 'heap fixture' }));
    if (shape === 'resize' && tick % 100 === 0) {
      output.columns = output.columns === 120 ? 80 : 120; output.rows = output.columns === 120 ? 40 : 24;
      output.emit('resize'); store.resize(output.columns, output.rows);
    }
    // Exercise the mounted production input stream as well as its measured refresh boundary.
    if (tick % 1000 === 0) input.write('\u001b[A');
    delivery.refresh(); store.refresh();
    await yieldTick();
    if (tick % 1000 === 0) sample();
  }
  input.write('q'); await mounted;
  const measured = samples.filter(s => s.tick >= 1000);
  const peak = Math.max(...measured.map(s => s.heap));
  const lateGrowth = measured.at(-1).heap - measured.find(s => s.tick === 9000).heap;
  const verdict = peak <= 64 * 1024 * 1024 && lateGrowth <= 16 * 1024 * 1024 ? 'pass' : 'fail';
  const result = { protocol: 'C1-production-mount-v1', shape, pid: process.pid, sourceCommit, sourceDirty, environment, warmupTicks: 1000, measuredTicks: 10000, samples, peak, lateGrowth, verdict, firstFailure, lastFrame: lastChunk, writes, bytes, sinkLimit: 20000, pendingOutputBytes: output.writableLength, performanceMeasures: performance.getEntriesByType('measure').length, store: store.diagnostics() };
  writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ shape, environment: environment.NODE_ENV, verdict, peakMiB: peak / 1048576, lateGrowthMiB: lateGrowth / 1048576, writes, performanceMeasures: result.performanceMeasures }) + '\n');
} finally {
  store.dispose();
  if (delivery && !delivery.snapshot().state.quit) { input.write('q'); await mounted; }
  input.destroy(); output.destroy(); rmSync(fixture, { recursive: true, force: true });
}
