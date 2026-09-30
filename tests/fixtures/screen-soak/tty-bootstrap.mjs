/** Terminal transport only: the real built CLI owns rendering, input and shutdown. */
import { PassThrough, Writable } from 'node:stream';
import { renameSync, writeFileSync } from 'node:fs';
const destination = process.env.C6_FRAME_PATH;
if (destination) {
  const input = new PassThrough();
  input.isTTY = true; input.isRaw = false;
  input.setRawMode = raw => { input.isRaw = raw; return input; };
  input.ref = () => input; input.unref = () => input;
  let last = '';
  class Screen extends Writable {
    isTTY = true; columns = 120; rows = 40;
    _write(chunk, _encoding, callback) {
      last = (last + chunk.toString()).slice(-20000);
      // Readers poll this frame by path: write aside, then rename, so no reader ever parses a half-written frame.
      const staged = `${destination}.${process.pid}.tmp`;
      writeFileSync(staged, JSON.stringify({ pid: process.pid, raw: input.isRaw, frame: last }));
      renameSync(staged, destination);
      callback();
    }
  }
  Object.defineProperty(process, 'stdin', { value: input });
  Object.defineProperty(process, 'stdout', { value: new Screen() });
}
