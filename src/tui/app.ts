import { TerminalEngine, type OutputStream } from "../tui/engine.js";
import type { InputStream } from "../tui/input.js";
import type { FleetEditable } from "../config/config.js";
import { createFleetView } from "./views/fleet-view.js";
import { createPreviewView } from "./views/preview-view.js";
import { createProfileView } from "./views/profile-view.js";
import { createRoutingView } from "./views/routing-view.js";
import { renderDiffModal } from "./views/diff-modal.js";
import { buildSaveProposal, confirmSave, type SaveProposal, type SaveTarget } from "./save.js";
import { FleetStaging, type FleetEdit } from "./staging.js";

export type View = {
  id: string;
  label: string;
  render(props: { cols: number; rows: number }): string[];
};

export type StudioOptions = {
  input: InputStream;
  output: OutputStream;
  /** Loaded fleet state the buffer wraps. Defaults to an empty editable for the no-arg shell path. */
  loaded?: FleetEditable;
  /** Repository root used for overlay paths and live-run detection. Defaults to cwd. */
  repoRoot?: string;
  /** Global config directory override. */
  globalDir?: string;
};

const MUTATION_KEYS = ["r", "m", "return"] as const;
const READONLY_NOTICE = "read-only in v1.66 — write path ships in v1.67";

function emptyFleetEditable(): FleetEditable {
  return {
    denyAdapters: [],
    denyModels: [],
    tiers: {},
    map: {},
    floors: {},
  };
}

export class StudioApp {
  private engine: TerminalEngine;
  private views: View[];
  private active = 0;
  private showingHelp = false;
  private confirmingQuit = false;
  private showingSave = false;
  private saveTarget: SaveTarget = "repo";
  private saveProposal: SaveProposal | null = null;
  private notice: string | null = null;
  private staging: FleetStaging;
  private repoRoot: string;
  private globalDir: string | undefined;
  private _lines: string[] = [];
  private resolveExit: (() => void) | null = null;
  readonly exited: Promise<void>;

  constructor(opts: StudioOptions) {
    this.engine = new TerminalEngine({
      input: opts.input,
      output: opts.output,
      onResize: () => this.paint(),
    });
    this.repoRoot = opts.repoRoot ?? process.cwd();
    this.globalDir = opts.globalDir;
    this.staging = new FleetStaging(opts.loaded ?? emptyFleetEditable());
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

  /** Apply an edit to the staging buffer and repaint. Intended as the test seam and future edit hook. */
  stageEdit(edit: FleetEdit): void {
    this.staging.apply(edit);
    this.paint();
  }

  private get isModalOpen(): boolean {
    return this.showingHelp || this.confirmingQuit || this.showingSave;
  }

  private bindKeys(): void {
    // view switching
    // Tab is decoded as the raw "\t" sequence by the micro-engine.
    this.engine.key("\t", () => {
      if (!this.isModalOpen) this.setView((this.active + 1) % this.views.length);
    });
    for (let i = 1; i <= this.views.length; i++) {
      const idx = i - 1;
      this.engine.key(String(i), () => {
        if (!this.isModalOpen) this.setView(idx);
      });
    }

    // help overlay
    this.engine.key("?", () => {
      if (!this.confirmingQuit && !this.showingSave) {
        this.showingHelp = true;
        this.paint();
      }
    });

    // dismissal / quit
    this.engine.key("escape", () => this.handleEscape());
    this.engine.key("q", () => this.handleQuit());

    // revert staged changes
    this.engine.key("u", () => this.handleRevert());

    // save modal
    this.engine.key("s", () => this.handleSaveOpen());
    this.engine.key("t", () => this.handleSaveToggle());

    // quit-confirmation / save-confirmation answers
    this.engine.key("y", () => this.handleConfirm());
    this.engine.key("n", () => this.handleCancel());

    // remaining mutation keys — read-only until wired
    for (const key of MUTATION_KEYS) {
      this.engine.key(key, () => {
        if (!this.isModalOpen) this.showNotice();
      });
    }
  }

  private handleEscape(): void {
    if (this.showingHelp) {
      this.showingHelp = false;
      this.paint();
    } else if (this.showingSave) {
      this.closeSave(false);
    } else if (this.confirmingQuit) {
      this.confirmingQuit = false;
      this.paint();
    } else if (this.staging.isDirty) {
      this.confirmingQuit = true;
      this.paint();
    } else {
      this.stop();
    }
  }

  private handleQuit(): void {
    if (this.showingHelp || this.showingSave) return; // modals block q
    if (this.confirmingQuit) {
      this.stop();
      return;
    }
    if (this.staging.isDirty) {
      this.confirmingQuit = true;
      this.paint();
    } else {
      this.stop();
    }
  }

  private handleSaveOpen(): void {
    if (this.isModalOpen) return;
    if (!this.staging.isDirty) {
      this.notice = "no staged changes";
      this.paint();
      return;
    }
    this.showingSave = true;
    this.saveTarget = "repo";
    this.saveProposal = buildSaveProposal({
      repoRoot: this.repoRoot,
      loaded: this.staging.loadedState,
      staged: this.staging.current,
      target: this.saveTarget,
      globalDir: this.globalDir,
    });
    this.paint();
  }

  private handleSaveToggle(): void {
    if (!this.showingSave) return;
    this.saveTarget = this.saveTarget === "repo" ? "global" : "repo";
    this.saveProposal = buildSaveProposal({
      repoRoot: this.repoRoot,
      loaded: this.staging.loadedState,
      staged: this.staging.current,
      target: this.saveTarget,
      globalDir: this.globalDir,
    });
    this.paint();
  }

  private handleConfirm(): void {
    if (this.showingSave) {
      this.executeSave();
      return;
    }
    if (this.confirmingQuit) {
      this.stop();
    }
  }

  private handleCancel(): void {
    if (this.showingSave) {
      this.closeSave(false);
      return;
    }
    if (this.confirmingQuit) {
      this.confirmingQuit = false;
      this.paint();
    }
  }

  private executeSave(): void {
    if (!this.saveProposal) return;
    const result = confirmSave({
      repoRoot: this.repoRoot,
      loaded: this.staging.loadedState,
      staged: this.staging.current,
      target: this.saveTarget,
      globalDir: this.globalDir,
    });
    if (result.kind === "written") {
      this.staging = new FleetStaging(this.staging.current);
      this.closeSave(true, `wrote ${result.path}`);
    } else if (result.kind === "refused") {
      this.closeSave(true, `save refused: ${result.reason}`);
    } else {
      this.closeSave(false);
    }
  }

  private closeSave(notify: boolean, message?: string): void {
    this.showingSave = false;
    this.saveProposal = null;
    if (notify && message) this.notice = message;
    this.paint();
  }

  private handleRevert(): void {
    if (this.isModalOpen) return;
    if (this.staging.isDirty) {
      this.staging.revert();
      this.notice = null;
      this.paint();
    } else {
      this.notice = "no staged changes";
      this.paint();
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
    } else if (this.showingSave && this.saveProposal) {
      lines.push(...renderDiffModal({
        target: this.saveProposal.target,
        targetPath: this.saveProposal.targetPath,
        diff: this.saveProposal.diff,
        liveRun: this.saveProposal.liveRun,
      }));
    } else if (this.confirmingQuit) {
      lines.push(...this.renderQuitConfirm());
    } else {
      const view = this.views[this.active]!;
      lines.push(...view.render({ cols, rows: Math.max(rows - 2, 1) }));
    }

    if (this.notice) {
      lines.push(this.notice);
    }
    lines.push(this.renderStatusBar());
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

  private renderStatusBar(): string {
    if (this.staging.isDirty) {
      const n = this.staging.changeCount;
      return `● ${n} staged change${n === 1 ? "" : "s"}`;
    }
    return "no staged changes";
  }

  private renderHelp(): string[] {
    return [
      "Key bindings",
      "1-4      switch view",
      "tab      cycle views",
      "?        show this help",
      "esc / q  quit",
      "u        revert staged changes",
      "r        re-probe (read-only)",
      "s        save",
      "m        mode (read-only)",
    ];
  }

  private renderQuitConfirm(): string[] {
    const n = this.staging.changeCount;
    return [`Quit with ${n} staged change${n === 1 ? "" : "s"}? (y/n)`];
  }
}
