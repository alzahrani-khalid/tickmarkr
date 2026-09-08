/** Real-duration production UI: node --expose-gc soak.mjs static|growth artifact-dir [seconds]. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { writeHeapSnapshot } from 'node:v8';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep, setImmediate as yieldTick } from 'node:timers/promises';
import { validateSoak } from './validate.mjs';

const [shape, target, durationArg = '14400'] = process.argv.slice(2);
const duration = Number(durationArg);
if (!['static', 'growth'].includes(shape) || !target || !global.gc || !Number.isInteger(duration) || duration < 1) throw new Error('usage: node --expose-gc soak.mjs static|growth artifact-dir [seconds]');
const root = resolve(import.meta.dirname, '../../..');
const buildRoot = process.env.C6_BUILD_ROOT ?? root;
const { runLiveCockpit } = await import(pathToFileURL(join(buildRoot, 'dist/tui/cockpit/live.js')).href);
const artifacts = resolve(target);
if (existsSync(artifacts) && readdirSync(artifacts).length) throw new Error('artifact directory is not empty; preserve prior measurements and choose a new destination');
mkdirSync(artifacts, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const provenancePath = join(buildRoot, 'soak-build.json');
const provenance = existsSync(provenancePath) ? JSON.parse(readFileSync(provenancePath, 'utf8')) : undefined;
if (duration >= 14400 && !provenance) throw new Error('prepare an isolated committed build with screen-soak/build.mjs before a duration run');
const sourceCommit = provenance?.sourceCommit ?? git('rev-parse', 'HEAD');
if (git('status', '--porcelain', '--', 'src')) throw new Error('commit production source before building and measuring');
const builtFiles = git('ls-tree', '-r', '--name-only', sourceCommit, 'src').split('\n');
// A fresh build is required before launch; the manifest preserves the exact bytes actually imported.
const { createHash } = await import('node:crypto');
const hashes = {};
for (const file of builtFiles.filter(f => /\.tsx?$/.test(f))) {
  const built = file.replace(/^src\//, 'dist/').replace(/\.tsx?$/, '.js');
  hashes[built] = createHash('sha256').update(readFileSync(join(buildRoot, built))).digest('hex');
  if (provenance && hashes[built] !== provenance.hashes[built]) throw new Error(`isolated build changed: ${built}`);
}
writeFileSync(join(artifacts, 'build.json'), JSON.stringify({ sourceCommit, hashes }, null, 2) + '\n');
const fixture = mkdtempSync(join(tmpdir(), `screen-soak-${shape}-`));
execFileSync('git', ['init', '-q', fixture]);
const runId = 'run-screen-soak';
const runDir = join(fixture, '.tickmarkr', 'runs', runId);
mkdirSync(runDir, { recursive: true });
const journal = join(runDir, 'journal.jsonl');
let tick = 0;
const observedStart = Date.now();
const event = (name, taskId, data = {}) => JSON.stringify({ ts: new Date(observedStart + tick * 1000).toISOString(), event: name, ...(taskId ? { taskId } : {}), data }) + '\n';
writeFileSync(journal, event('run-start', undefined, { branch: 'fixture', daemonPid: process.pid }) + event('task-dispatch', 'T1', { attempt: 0, assignment: { adapter: 'fake', model: 'fixture' } }));
let writes = 0, bytes = 0, lastFrame = '', resizeCount = 0, inputCount = 0;
class CountingOutput extends Writable {
  isTTY = true; columns = 120; rows = 40;
  _write(chunk, _encoding, callback) {
    writes++; bytes += chunk.length;
    const text = chunk.toString();
    if (text.includes('│')) lastFrame = text.slice(-20000);
    callback();
  }
}
const output = new CountingOutput();
const input = new PassThrough();
input.isTTY = true; input.isRaw = false;
input.setRawMode = raw => { input.isRaw = raw; return input; };
input.ref = () => input; input.unref = () => input;
let delivery, ended = false, failure, peak = 0, startMono;
const samples = [];
const metadata = {
  protocol: 'C6-four-hour-production-v1', shape, sourceCommit, buildRoot, pid: process.pid, fixture, journal,
  durationSeconds: duration, sinkLimit: 20000, sampleIntervalSeconds: 60, observationIntervalSeconds: 1,
  warmupTicks: 1000, population: 'run-start plus one T1 task-dispatch; growth adds one worker-nudge every ten seconds',
  inputSchedule: 'every 100 observations: Run, Evidence, Home, Run (400-observation cycle); both late-growth endpoints are Run at 120x40',
  environment: { NODE_ENV: process.env.NODE_ENV ?? null, node: process.version, platform: process.platform, arch: process.arch, TERM: process.env.TERM ?? null, CI: process.env.CI ?? null },
  startedAt: new Date().toISOString(), artifacts,
};
writeFileSync(join(artifacts, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
const sample = () => {
  global.gc();
  const memory = process.memoryUsage();
  const row = { timestamp: new Date().toISOString(), monotonicMs: performance.now() - startMono, tick,
    observedAt: observedStart + tick * 1000, pid: process.pid, heap: memory.heapUsed, rss: memory.rss,
    writes, bytes, view: lastFrame.match(/\| (HOME|RUN|EVIDENCE) \|/)?.[1] ?? null,
    performanceMeasures: performance.getEntriesByType('measure').length, pendingOutputBytes: output.writableLength, resizeCount, inputCount };
  const previous = samples.at(-1);
  samples.push(row); peak = Math.max(peak, row.heap);
  appendFileSync(join(artifacts, 'samples.jsonl'), JSON.stringify(row) + '\n');
  writeFileSync(join(artifacts, 'last-frame.ansi'), lastFrame);
  if (previous && (row.monotonicMs - previous.monotonicMs > 120000 || Date.parse(row.timestamp) - Date.parse(previous.timestamp) > 120000)) {
    throw new Error('missing or late minute sample; refusing to catch up an invalid duration record');
  }
  if (tick >= 1000 && row.heap > 64 * 1048576 && !failure) {
    failure = 'retained heap exceeds 64 MiB';
    writeHeapSnapshot(join(artifacts, 'failure.heapsnapshot'));
  }
};
let mounted;
try {
  mounted = runLiveCockpit({ input, output, cwd: fixture, runId, binaryVersion: '2.4.1', now: () => observedStart + tick * 1000,
    refreshMs: 2 ** 30, debug: true, onDelivery: d => { delivery = d; } });
  void mounted.then(() => { ended = true; }, error => { ended = true; failure = String(error); });
  await yieldTick();
  if (!delivery || ended) throw new Error('production UI failed before observation');
  startMono = performance.now();
  sample();
  for (tick = 1; tick <= duration; tick++) {
    await sleep(Math.max(0, startMono + tick * 1000 - performance.now()));
    if (ended) throw new Error(`production UI exited early at tick ${tick}`);
    if (shape === 'growth' && tick % 10 === 0) appendFileSync(journal, event('worker-nudge', 'T1', { reason: 'duration fixture' }));
    if (tick % 100 === 0) {
      output.columns = output.columns === 120 ? 80 : 120; output.rows = output.columns === 120 ? 40 : 24;
      output.emit('resize'); resizeCount++;
      input.write(tick % 400 === 200 ? '5' : tick % 400 === 300 ? '1' : '4'); inputCount++;
    }
    delivery.refresh();
    await yieldTick();
    if (tick % 60 === 0 || tick === duration - 2000 || tick === duration || tick === 1000) sample();
  }
  input.write('q'); await mounted;
} catch (error) {
  failure = String(error);
  if (delivery && !ended) { input.write('q'); await mounted.catch(() => {}); }
} finally {
  input.destroy(); output.destroy();
  writeFileSync(join(artifacts, 'journal.jsonl'), readFileSync(journal));
  const result = { ...metadata, endedAt: new Date().toISOString(), elapsedMs: performance.now() - startMono,
    peak, writes, bytes, resizeCount, inputCount, orderlyExit: ended && !input.isRaw, failure: failure ?? null, samples };
  const validation = validateSoak(result);
  writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ ...result, validation }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ shape, pid: process.pid, validation }) + '\n');
  if (!validation.ok) process.exitCode = 1;
}
