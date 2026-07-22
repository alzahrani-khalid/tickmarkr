import { TerminalEngine, type OutputStream } from "../tui/engine.js";
import type { InputStream } from "../tui/input.js";
import { createFleetView } from "./views/fleet-view.js";
import { createPreviewView } from "./views/preview-view.js";
import { createProfileView } from "./views/profile-view.js";
import { createRoutingView } from "./views/routing-view.js";

export type View = {
  id: string;
  label: string;
  render(props: { cols: number; rows: number }): string[];
};

export type StudioOptions = {
  input: InputStream;
  output: OutputStream;
};

const MUTATION_KEYS = ["r", "s", "m", "return"] as const;
const READONLY_NOTICE = "read-only in v1.66 — write path ships in v1.67";

export class StudioApp {
  private engine: TerminalEngine;
  private views: View[];
  private active = 0;
  private showingHelp = false;
  private notice: string | null = null;
  private _lines: string[] = [];
  private resolveExit: (() => void) | null = null;
  readonly exited: Promise<void>;

  constructor(opts: StudioOptions) {
    this.engine = new TerminalEngine({
      input: opts.input,
      output: opts.output,
      onResize: () => this.paint(),
    });
    this.views = [createFleetView(), createRoutingView(), createPreviewView(), createProfileView()];
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  /** Current line model last rendered or prepared. */
  get lines(): string[] {
    return this._lines;
  }

  /** Labels of every registered view, in order. */
  get viewLabels(): string[] {
    return this.views.map((v) => v.label);
  }

  /** Enter the alternate screen and start routing input. */
  start(): void {
    this.bindKeys();
    this.paint();
    this.engine.start(this._lines);
  }

  /** Restore the terminal and release the input stream. */
  stop(): void {
    this.engine.stop();
    if (this.resolveExit) {
      this.resolveExit();
      this.resolveExit = null;
    }
  }

  private bindKeys(): void {
    // view switching
    // Tab is decoded as the raw "\t" sequence by the micro-engine.
    this.engine.key("\t", () => this.setView((this.active + 1) % this.views.length));
    for (let i = 1; i <= this.views.length; i++) {
      const idx = i - 1;
      this.engine.key(String(i), () => this.setView(idx));
    }

    // help overlay
    this.engine.key("?", () => {
      this.showingHelp = true;
      this.paint();
    });

    // dismissal / quit
    this.engine.key("escape", () => {
      if (this.showingHelp) {
        this.showingHelp = false;
        this.paint();
      } else {
        this.stop();
      }
    });
    this.engine.key("q", () => this.stop());

    // mutation keys — read-only until the v1.67 write path
    for (const key of MUTATION_KEYS) {
      this.engine.key(key, () => this.showNotice());
    }
  }

  private setView(idx: number): void {
    this.active = idx;
    this.showingHelp = false;
    this.notice = null;
    this.paint();
  }

  private showNotice(): void {
    this.notice = READONLY_NOTICE;
    this.paint();
  }

  private paint(): void {
    this._lines = this.buildFrame();
    this.engine.render(this._lines);
  }

  private buildFrame(): string[] {
    const { cols, rows } = this.engine.size;
    const lines: string[] = [];
    lines.push(this.renderTabBar());

    if (this.showingHelp) {
      lines.push(...this.renderHelp());
    } else {
      const view = this.views[this.active]!;
      lines.push(...view.render({ cols, rows: Math.max(rows - 2, 1) }));
    }

    if (this.notice) {
      lines.push(this.notice);
    }

    return lines;
  }

  private renderTabBar(): string {
    const parts = ["tickmarkr ui ──"];
    for (let i = 0; i < this.views.length; i++) {
      const view = this.views[i]!;
      const marker = i === this.active ? `*${view.label}` : view.label;
      parts.push(`[${i + 1}]${marker}`);
    }
    return parts.join(" ");
  }

  private renderHelp(): string[] {
    return [
      "Key bindings",
      "1-4      switch view",
      "tab      cycle views",
      "?        show this help",
      "esc / q  quit",
      "r        re-probe (read-only)",
      "s        save (read-only)",
      "m        mode (read-only)",
    ];
  }
}
