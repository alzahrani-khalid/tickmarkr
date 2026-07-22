/** Decoded keypress shape. */
export interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** Handler for a named key. May be async. */
export type KeyHandler = (key: Key) => void | Promise<void>;

/** Readable stream with the small TTY surface the engine needs. */
export interface InputStream extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

/**
 * Decode the next key at the start of a byte buffer. Returns the decoded key and
 * how many bytes were consumed. Undefined when more bytes are needed.
 */
export function decodeOneKey(buf: Buffer): { key: Key; consumed: number } | undefined {
  if (buf.length === 0) return undefined;
  const b0 = buf[0];

  if (b0 === 0x1b) {
    // CSI arrow sequences: ESC [ A/B/C/D. Keep an incomplete CSI buffered so
    // arbitrary stream chunking cannot turn an arrow into Escape + plain keys.
    if (buf[1] === 0x5b) {
      if (buf.length < 3) return undefined;
      const name =
        buf[2] === 0x41 ? "up"
        : buf[2] === 0x42 ? "down"
        : buf[2] === 0x43 ? "right"
        : buf[2] === 0x44 ? "left"
        : undefined;
      if (name) {
        return { key: { name, sequence: buf.subarray(0, 3).toString("binary") }, consumed: 3 };
      }
    }
    // A lone ESC (or ESC followed by something we do not recognise) is Escape.
    return { key: { name: "escape", sequence: "\x1b" }, consumed: 1 };
  }

  if (b0 === 0x0d || b0 === 0x0a) {
    return { key: { name: "return", sequence: String.fromCharCode(b0) }, consumed: 1 };
  }
  if (b0 === 0x03) {
    return { key: { name: "c", ctrl: true, sequence: "\x03" }, consumed: 1 };
  }
  if (b0 >= 0x20 && b0 < 0x7f) {
    return { key: { name: String.fromCharCode(b0), sequence: String.fromCharCode(b0) }, consumed: 1 };
  }

  // Unknown byte: consume it without a name so it does not block the stream.
  return { key: { sequence: String.fromCharCode(b0) }, consumed: 1 };
}

/** Routes decoded keypress events to handlers registered by key name. */
export class InputRouter {
  private handlers = new Map<string, Set<KeyHandler>>();
  private started = false;
  private buffer = Buffer.alloc(0);

  constructor(private input: InputStream) {}

  /** Register a handler for a named key (e.g. "up", "escape", "q"). */
  on(name: string, handler: KeyHandler): void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler);
  }

  /** Remove a previously registered handler. */
  off(name: string, handler: KeyHandler): void {
    this.handlers.get(name)?.delete(handler);
  }

  /** Start decoding keypresses from the input stream. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.input.setRawMode?.(true);
    this.input.on("data", this.onData);
    this.input.resume();
  }

  /** Stop decoding and release the stream. Idempotent. */
  stop(): void {
    if (!this.started) return;
    this.input.off("data", this.onData);
    this.input.setRawMode?.(false);
    this.input.pause();
    this.started = false;
  }

  private onData = (chunk: Buffer | string) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "binary");
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length > 0) {
      const result = decodeOneKey(this.buffer);
      if (!result) break;
      this.dispatch(result.key);
      this.buffer = this.buffer.subarray(result.consumed);
    }
  };

  private dispatch(key: Key): void {
    const name = key.name ?? key.sequence;
    if (!name) return;
    const set = this.handlers.get(name);
    if (!set) return;
    for (const handler of set) void handler(key);
  }
}
