import { Frame } from "./frame.js";
import { InputRouter, type Key, type KeyHandler, type InputStream } from "./input.js";

export type { Key, KeyHandler };

/** Writable stream with the small surface the engine needs. */
export interface OutputStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write: (chunk: string) => unknown;
  on?(event: "resize", listener: () => void): this;
  off?(event: "resize", listener: () => void): this;
}

export interface EngineOptions {
  input: InputStream;
  output: OutputStream;
  onResize?: (cols: number, rows: number) => void;
  onError?: (error: unknown) => void;
}

/**
 * Dependency-free terminal engine: alternate-screen line-diff renderer, named-key routing,
 * resize tracking, and terminal restoration on every exit path including thrown handlers.
 */
export class TerminalEngine {
  private frame: Frame;
  private input: InputRouter;
  private lastLines: string[] = [];
  private _cols: number;
  private _rows: number;
  private running = false;
  private userHandlers = new Map<KeyHandler, KeyHandler>();

  constructor(private opts: EngineOptions) {
    this.frame = new Frame(opts.output);
    this.input = new InputRouter(opts.input);
    this._cols = opts.output.columns ?? 80;
    this._rows = opts.output.rows ?? 24;
  }

  /** Enter the alternate screen, begin listening for keys and resize events. */
  start(lines: string[]): void {
    if (this.running) return;
    this.running = true;
    this.lastLines = lines.slice();
    this.frame.enter(this.lastLines);
    this.input.start();
    this.attachResize();
  }

  /** Restore the terminal and stop listening. Safe to call multiple times. */
  stop(): void {
    if (!this.running) return;
    this.detachResize();
    this.input.stop();
    this.frame.exit();
    this.running = false;
  }

  /** Update the line model; only changed lines are repainted. */
  render(lines: string[]): void {
    this.lastLines = lines.slice();
    this.frame.render(this.lastLines);
  }

  /** Register a handler for a named key. */
  key(name: string, handler: KeyHandler): void {
    const wrapped: KeyHandler = async (k) => {
      try {
        await handler(k);
      } catch (e) {
        this.stop();
        this.opts.onError?.(e);
      }
    };
    this.userHandlers.set(handler, wrapped);
    this.input.on(name, wrapped);
  }

  /** Unregister a handler. */
  unkey(name: string, handler: KeyHandler): void {
    const wrapped = this.userHandlers.get(handler);
    if (wrapped) {
      this.input.off(name, wrapped);
      this.userHandlers.delete(handler);
    }
  }

  /** Trigger a full repaint at the new size. */
  resize(cols: number, rows: number): void {
    this._cols = cols;
    this._rows = rows;
    this.frame.resize(this.lastLines);
    this.opts.onResize?.(cols, rows);
  }

  /** Current terminal size as last seen or reported by a resize event. */
  get size(): { cols: number; rows: number } {
    return { cols: this._cols, rows: this._rows };
  }

  private onResize = () => {
    this._cols = this.opts.output.columns ?? this._cols;
    this._rows = this.opts.output.rows ?? this._rows;
    this.frame.resize(this.lastLines);
    this.opts.onResize?.(this._cols, this._rows);
  };

  private attachResize(): void {
    this.opts.output.on?.("resize", this.onResize);
  }

  private detachResize(): void {
    this.opts.output.off?.("resize", this.onResize);
  }
}
