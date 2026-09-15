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
    if (failed) {
      for (const test of module.children.allTests()) {
        if (test.result().state === 'failed') {
          const errors = test.result().errors || [];
          failures.push(...(errors.length ? errors.map(e => 'FAIL ' + file + ' > ' + test.fullName + ': ' + e.message) : ['FAIL ' + file + ' > ' + test.fullName]));
        }
      }
      if (!failures.length) failures.push('FAIL ' + file);
    }
    if (file in this.report.completed) this.report.duplicateCompletions.push(file);
    this.report.completed[file] = { at: Date.now(), status: failed ? 'failed' : 'passed', failures };
    this.save();
  }
  onTestRunEnd(modules, errors, reason) {
    const failed = reason === 'failed' || errors.length > 0 || Object.values(this.report.completed).some(c => c.status === 'failed');
    this.report.certificate = { at: Date.now(), exitCode: failed ? 1 : 0 };
    this.save();
  }
}
`;
