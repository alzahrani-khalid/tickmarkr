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
          failures.push(...(errors.length ? errors.map(e => 'FAIL ' + file + ' > ' + test.fullName + ': ' + e.message) : ['FAIL ' + file + ' > ' + test.fullName]));
        }
      } else if (state === 'passed') tests.passed++;
      else tests.skipped++;
    }
    if (failed && !failures.length) failures.push('FAIL ' + file);
    const status = failed ? 'failed' : tests.passed + tests.failed === 0 ? 'skipped' : 'passed';
    if (file in this.report.completed) this.report.duplicateCompletions.push(file);
    this.report.completed[file] = { at: Date.now(), status, failures, tests };
    this.save();
  }
  onTestRunEnd(modules, errors, reason) {
    const failed = reason === 'failed' || errors.length > 0 || Object.values(this.report.completed).some(c => c.status === 'failed');
    this.report.certificate = { at: Date.now(), exitCode: failed ? 1 : 0 };
    this.save();
  }
}
`;
