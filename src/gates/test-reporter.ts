/** Loaded by the configured Vitest process. Atomic snapshots expose live lifecycle records to
 * the supervisor; only onTestRunEnd emits the terminal record. This is a completeness protocol,
 * not authentication against the installed runner (which the gate already trusts). */
export const TEST_REPORTER_SOURCE = String.raw`
import { writeFileSync, renameSync, realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
export default class TickmarkrReporter {
  constructor() {
    this.report = { nonce: process.env.TICKMARKR_TEST_NONCE, requested: [], started: {}, completed: {}, duplicateCompletions: [] };
    this.path = process.env.TICKMARKR_TEST_REPORT;
    this.cwd = realpathSync(process.cwd());
  }
  file(module) { return relative(this.cwd, module.moduleId).split(sep).join('/'); }
  // Bounded assertion evidence, kept BESIDE the failure fingerprint and never inside it: the
  // fingerprint is the failure's identity (the repeated-failure cap compares it), the evidence is
  // what the runner knew and the message elided. ONE 4096-byte budget per failed test, shared by
  // all of its errors (expect.soft yields several); never invented.
  evidence(test, errors) {
    const parts = [];
    for (const e of errors) {
      if (e && typeof e.diff === 'string' && e.diff) parts.push(e.diff);
      else for (const k of ['actual', 'expected']) if (e && e[k] !== undefined && e[k] !== null) parts.push(k + ': ' + (typeof e[k] === 'string' ? e[k] : JSON.stringify(e[k])));
      if (e && typeof e.stack === 'string' && e.stack) parts.push(e.stack.split('\n').slice(0, 8).join('\n'));
    }
    if (!parts.length) return { test, text: '', unavailable: true };
    const full = parts.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    if (Buffer.byteLength(full) <= 4096) return { test, text: full };
    let text = full.slice(0, 4096);
    while (Buffer.byteLength(text) > 4096) text = text.slice(0, -1);
    return { test, text, truncated: true };
  }
  save() {
    writeFileSync(this.path + '.tmp', JSON.stringify(this.report));
    renameSync(this.path + '.tmp', this.path);
  }
  onTestRunStart(specifications) {
    this.report.requested = specifications.map(s => this.file(s));
    this.save();
  }
  onTestModuleStart(module) {
    this.report.started[this.file(module)] = Date.now();
    this.save();
  }
  onTestModuleEnd(module) {
    const file = this.file(module);
    const failed = module.state() === 'failed';
    const failures = [];
    const evidence = [];
    // R41: count test bodies by their own state so a module whose every test was skipped (a
    // describe.skipIf gate) is recorded as SKIPPED — present in the lifecycle, but never as
    // executed test-body success. 'passed'/'failed' executed; anything else did not run.
    const tests = { passed: 0, failed: 0, skipped: 0 };
    for (const test of module.children.allTests()) {
      const state = test.result().state;
      if (state === 'failed') {
        tests.failed++;
        if (failed) {
          const errors = test.result().errors || [];
          const name = file + ' > ' + test.fullName;
          evidence.push(this.evidence(name, errors));
          failures.push(...(errors.length ? errors.map(e => 'FAIL ' + file + ' > ' + test.fullName + ': ' + e.message) : ['FAIL ' + file + ' > ' + test.fullName]));
        }
      } else if (state === 'passed') tests.passed++;
      else tests.skipped++;
    }
    if (failed && !failures.length) failures.push('FAIL ' + file);
    const status = failed ? 'failed' : tests.passed + tests.failed === 0 ? 'skipped' : 'passed';
    if (file in this.report.completed) this.report.duplicateCompletions.push(file);
    this.report.completed[file] = { at: Date.now(), status, failures, tests, ...(evidence.length ? { evidence } : {}) };
    this.save();
  }
  onTestRunEnd(modules, errors, reason) {
    const failed = reason === 'failed' || errors.length > 0 || Object.values(this.report.completed).some(c => c.status === 'failed');
    // Collection failures can reach run end without a module start/end event. Keep their
    // identity as diagnostics, without inventing lifecycle records or changing the verdict.
    const loadErrors = modules.flatMap(module => module.errors().map(e => this.file(module) + ': ' + e.message));
    this.report.certificate = { at: Date.now(), exitCode: failed ? 1 : 0,
      errors: errors.length + loadErrors.length,
      diagnostics: [...loadErrors, ...errors.map(e => [e.testPath, e.name, e.message].filter(Boolean).join(': '))] };
    this.save();
  }
}
`;
