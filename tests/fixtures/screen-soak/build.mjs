/** Build an immutable committed production tree for duration measurements. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
if (git('status', '--porcelain', '--', 'src', 'tests/fixtures/screen-soak').toString().trim()) {
  throw new Error('commit production source and soak machinery before preparing a duration build');
}
const sourceCommit = git('rev-parse', 'HEAD').toString().trim();
const destination = mkdtempSync(join(tmpdir(), 'c6-soak-build-'));
execFileSync('tar', ['-xf', '-', '-C', destination], {
  input: git('archive', sourceCommit, 'src', 'package.json', 'tsconfig.json'),
});
symlinkSync(join(root, 'node_modules'), join(destination, 'node_modules'), 'dir');
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(destination, 'tsconfig.json')], { stdio: 'pipe' });
const hashes = {};
for (const source of git('ls-tree', '-r', '--name-only', sourceCommit, 'src').toString().trim().split('\n').filter(file => /\.tsx?$/.test(file))) {
  const built = source.replace(/^src\//, 'dist/').replace(/\.tsx?$/, '.js');
  hashes[built] = createHash('sha256').update(readFileSync(join(destination, built))).digest('hex');
}
writeFileSync(join(destination, 'soak-build.json'), JSON.stringify({ sourceCommit, hashes }, null, 2) + '\n');
process.stdout.write(destination + '\n');
