// Line-diff renderer for the alternate screen. Maintains the previous line model and
// repaints only rows that changed since the last render, keeping terminal traffic small.

/** A write target — anything with a write(chunk: string) method. */
export interface OutputSink {
  write: (chunk: string) => unknown;
}

/** Frame state + diff rendering. */
export class Frame {
  private prev: string[] = [];
  private active = false;

  constructor(private out: OutputSink) {}

  /** Enter the alternate screen, hide the cursor, and paint the initial frame. */
  enter(lines: string[]): void {
    this.active = true;
    this.prev = [];
    this.out.write("\x1b[?1049h"); // alternate screen buffer
    this.out.write("\x1b[?25l"); // hide cursor
    this.render(lines);
  }

  /**
   * Paint only the lines that differ from the previous model. Lines are addressed with
   * absolute cursor positioning; unchanged rows produce no output.
   */
  render(lines: string[]): void {
    if (!this.active) return;
    const curr = lines.slice();
    const max = Math.max(this.prev.length, curr.length);
    for (let i = 0; i < max; i++) {
      if (this.prev[i] !== curr[i]) {
        this.out.write(`\x1b[${i + 1};1H`); // row i+1, column 1
        this.out.write(curr[i] ?? "");
        this.out.write("\x1b[K"); // clear to end of line
      }
    }
    if (curr.length < this.prev.length) {
      // The frame shrank — clear everything below the new last line.
      this.out.write(`\x1b[${curr.length + 1};1H`);
      this.out.write("\x1b[J");
    }
    this.prev = curr;
  }

  /** Invalidate the cached frame so the next render writes every line. */
  resize(lines: string[]): void {
    this.prev = [];
    this.render(lines);
  }

  /** Restore the terminal: show cursor and return to the normal screen buffer. */
  exit(): void {
    if (!this.active) return;
    this.out.write("\x1b[?25h"); // show cursor
    this.out.write("\x1b[?1049l"); // normal screen buffer
    this.active = false;
    this.prev = [];
  }
}
