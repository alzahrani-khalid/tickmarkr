/** Lossless storage for completed soak outputs; minute samples stay plain JSONL. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Hashes and callers always see original bytes, including whitespace/newlines. */
export function readArtifact(path) {
  const plain = existsSync(path), compressed = existsSync(`${path}.gz`);
  if (plain && compressed) throw new Error(`ambiguous artifact: ${path} and ${path}.gz`);
  if (plain) return readFileSync(path);
  return gunzipSync(readFileSync(`${path}.gz`), { maxOutputLength: 8 * 1024 * 1024 });
}

/** Only bulky, completed outputs are packed; no values or original verdicts change. */
export function archiveRecord(directory) {
  const paths = ['result.json', 'journal.jsonl'].map(file => join(directory, file));
  const receipt = join(directory, 'archive.json');
  if (existsSync(receipt) || paths.some(path => existsSync(`${path}.gz`))) {
    throw new Error(`archive already exists: ${directory}`);
  }
  const outputs = paths.map(path => {
    const raw = readFileSync(path), packed = gzipSync(raw, { level: 9 });
    return { path, raw, packed };
  });
  for (const { path, raw, packed } of outputs) {
    writeFileSync(`${path}.gz`, packed, { flag: 'wx' });
    if (!gunzipSync(readFileSync(`${path}.gz`)).equals(raw)) throw new Error(`archive verification failed: ${path}`);
  }
  writeFileSync(receipt, JSON.stringify({ version: 1, encoding: 'gzip', files: outputs.map(({ path, raw, packed }) => ({
    path: path.endsWith('result.json') ? 'result.json' : 'journal.jsonl',
    rawBytes: raw.length, rawSha256: hash(raw), archiveBytes: packed.length, archiveSha256: hash(packed),
  })) }, null, 2) + '\n', { flag: 'wx' });
  // Originals are retired only after every archive was read back and the hashes saved.
  for (const { path } of outputs) unlinkSync(path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('usage: node screen-soak/archive.mjs artifact-dir [...]');
  for (const directory of process.argv.slice(2)) archiveRecord(directory);
}
