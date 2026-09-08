/** Terminal transport only: the real built CLI owns rendering, input and shutdown. */
import { PassThrough, Writable } from 'node:stream';
import { writeFileSync } from 'node:fs';
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
      writeFileSync(destination, JSON.stringify({ pid: process.pid, raw: input.isRaw, frame: last }));
      callback();
    }
  }
  Object.defineProperty(process, 'stdin', { value: input });
  Object.defineProperty(process, 'stdout', { value: new Screen() });
}
