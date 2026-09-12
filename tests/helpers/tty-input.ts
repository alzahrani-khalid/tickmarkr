import { Readable } from "node:stream";

export type TtyInput = NodeJS.ReadStream & {
  /** True while the fake's handle is reading — the libuv `readStart` state of a real tty. */
  armed: () => boolean;
  /** Bytes written while un-armed, still waiting in the "kernel". */
  kernel: () => string;
  write: (bytes: string | Uint8Array) => boolean;
  end: () => void;
};

/**
 * A stdin fake that is an INSTANCE of a tty stream, not a pipe (OBS-965). Like `tty.ReadStream`
 * it has highWaterMark 0: every `push()` returns false and stops the handle (`armed = false`, the
 * `readStop`), and only a `read()` that finds the buffer EMPTY re-arms it (`_read` → `armed = true`).
 * Bytes written while un-armed wait in the kernel until the next re-arm — exactly where a deaf board
 * leaves them. A PassThrough (16 KiB) cannot deadlock, which is why the suite stayed green through
 * three releases while the real board went deaf after one pointer report.
 */
export function ttyInput(options: { onRawMode?: (mode: boolean) => void } = {}): TtyInput {
  const kernel: string[] = [];
  let armed = false;
  const drain = () => { while (armed && kernel.length > 0) if (!input.push(kernel.shift()!)) armed = false; };
  const input = new Readable({ highWaterMark: 0, read() { armed = true; drain(); } }) as unknown as TtyInput;
  Object.assign(input, {
    isTTY: true, isRaw: false,
    setRawMode: (mode: boolean) => { input.isRaw = mode; options.onRawMode?.(mode); return input; },
    ref: () => input, unref: () => input,
    write: (bytes: string | Uint8Array) => { kernel.push(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8")); drain(); return true; },
    end: () => { input.push(null); },
    armed: () => armed,
    kernel: () => kernel.join(""),
  });
  return input;
}
