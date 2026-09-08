/** Revalidate immutable raw artifacts, preserving the original harness verdict. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateSoak } from './validate.mjs';
import { readArtifact } from './archive.mjs';

const root = resolve(import.meta.dirname, '../../..');
const paths = process.argv.slice(2);
if (!paths.length) throw new Error('usage: node screen-soak/recheck.mjs artifact-dir [...]');
if (execFileSync('git', ['status', '--porcelain', '--', 'tests/fixtures/screen-soak/validate.mjs', 'tests/fixtures/screen-soak/recheck.mjs', 'tests/fixtures/screen-soak/archive.mjs'], { cwd: root, encoding: 'utf8' }).trim()) {
  throw new Error('commit the validator and rechecker before recording validation provenance');
}
const hash = path => createHash('sha256').update(readArtifact(path)).digest('hex');
const records = paths.map(path => {
  const result = JSON.parse(readArtifact(join(path, 'result.json')).toString('utf8'));
  const samples = readFileSync(join(path, 'samples.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  if (!isDeepStrictEqual(samples, result.samples)) throw new Error(`${path}: result differs from raw sample series`);
  const metadata = JSON.parse(readFileSync(join(path, 'metadata.json'), 'utf8'));
  for (const key of Object.keys(metadata)) {
    if (!isDeepStrictEqual(result[key], metadata[key])) throw new Error(`${path}: metadata differs for ${key}`);
  }
  const build = JSON.parse(readFileSync(join(path, 'build.json'), 'utf8'));
  if (build.sourceCommit !== result.sourceCommit) throw new Error(`${path}: build identity differs`);
  return { path, sourceCommit: result.sourceCommit, pid: result.pid,
    originalValidation: result.validation, validation: validateSoak(result),
    hashes: Object.fromEntries(['build.json', 'metadata.json', 'samples.jsonl', 'result.json', 'journal.jsonl', 'last-frame.ansi'].map(file => [file, hash(join(path, file))])),
  };
});
process.stdout.write(JSON.stringify({ checkedAt: new Date().toISOString(),
  validatorSourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  validatorSha256: hash(join(import.meta.dirname, 'validate.mjs')), records,
}, null, 2) + '\n');
if (records.some(record => !record.validation.ok)) process.exitCode = 1;
