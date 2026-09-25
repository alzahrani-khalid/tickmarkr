import { closeSync, fstatSync, openSync, readSync, statSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { graphPath, stateDirName } from "../../graph/graph.js";
import { validateGraph, type RunGraph } from "../../graph/schema.js";
import { parseRunId, type JournalEvent } from "../../run/journal.js";
import { isPidLive, STALE_MS } from "../../run/lock.js";
import { readTierLiveness, SUPERVISION_TIERS } from "../../run/supervision.js";
import { OperatorStateFold, type OperatorRecord } from "../../run/operator-state.js";

export const OBSERVATION_INTERVAL_MS = 1_000;
// Graph declarations have a separate 16 MiB bound; journal retention remains unchanged.
export const STORE_LIMITS = { graphBytes: 16 * 1024 * 1024, history: 256, historyBytes: 2 * 1024 * 1024, recordBytes: 1024 * 1024, readBytes: 1024 * 1024, subscribers: 64, metrics: 12, errors: 32 } as const;
export interface SourceError { source: string; error: string; line?: number; id?: string }
export interface JournalLine extends Omit<OperatorRecord, "event"> { event?: JournalEvent; raw: string; error?: string; offset: number; endOffset: number }
export interface TailSnapshot {
  source: string; generation: number; identity?: string; offset: number; lines: number;
  history: readonly JournalLine[]; errors: readonly SourceError[]; malformedCount: number;
  pending: { line: number; bytes: number } | undefined; backlogBytes: number;
  status: "readable" | "pending" | "corrupt" | "unreadable"; error?: SourceError;
  lastSuccessfulReadAt?: number; bytesRead: number;
}
const errorText = (e: unknown): string => e instanceof Error ? e.message : String(e);
const fileIdentity = (st: BigIntStats): string => `${st.dev}:${st.ino}`;
const stamp = (st: BigIntStats): string => `${fileIdentity(st)}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
function decodeLine(bytes: Buffer, source: string, line: number, offset: number, endOffset: number, generation: number, oversized = false): JournalLine {
  const base = { source, line, id: `${source}#L${line}`, offset, endOffset, generation };
  let raw = "";
  try {
    if (oversized) throw new Error(`record exceeds ${STORE_LIMITS.recordBytes} bytes; page raw evidence from disk`);
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!raw.trim()) return { ...base, raw };
    const e = JSON.parse(raw);
    if (!e || typeof e !== "object" || typeof e.ts !== "string" || !Number.isFinite(Date.parse(e.ts)) || typeof e.event !== "string" || !e.data || typeof e.data !== "object" || Array.isArray(e.data) || (e.taskId !== undefined && typeof e.taskId !== "string")) throw new Error("invalid journal record");
    return { ...base, raw, event: e as JournalEvent };
  } catch (e) { return { ...base, raw: raw || bytes.toString("utf8"), error: errorText(e) }; }
}

/** Byte-offset tail with a fixed read budget. Idle observations stat, but read no journal bytes. */
export class JournalTail {
  private st?: BigIntStats;
  private offset = 0;
  private line = 0;
  private generation = 0;
  private carry = Buffer.alloc(0);
  private carryBytes = 0;
  private lineOffset = 0;
  private history: JournalLine[] = [];
  private historyBytes = 0;
  private errors: SourceError[] = [];
  private malformedCount = 0;
  private bytesRead = 0;
  private lastSuccessfulReadAt?: number;
  private failure?: SourceError;
  constructor(readonly source: string, private readonly hooks: { record?: (record: OperatorRecord) => void; reset?: () => void } = {}) {}
  private reset(): void {
    this.offset = 0; this.line = 0; this.carry = Buffer.alloc(0); this.carryBytes = 0; this.lineOffset = 0;
    this.history = []; this.historyBytes = 0; this.errors = []; this.malformedCount = 0; this.generation++;
    this.hooks.reset?.();
  }
  poll(now = Date.now()): TailSnapshot {
    let fd: number | undefined;
    try {
      const st = statSync(this.source, { bigint: true });
      if (!st.isFile()) throw new Error("journal source is not a regular file");
      if (!this.st || fileIdentity(st) !== fileIdentity(this.st) || st.size < this.st.size || (st.size === this.st.size && stamp(st) !== stamp(this.st))) this.reset();
      if (Number(st.size) > this.offset) {
        fd = openSync(this.source, "r");
        if (stamp(fstatSync(fd, { bigint: true })) !== stamp(st)) throw new Error("journal changed before read; retry observation");
        let remaining = STORE_LIMITS.readBytes as number;
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Number(st.size) - this.offset));
        while (this.offset < Number(st.size) && remaining > 0) {
          const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(st.size) - this.offset, remaining), this.offset);
          if (!count) throw new Error("journal truncated during read");
          this.bytesRead += count; remaining -= count;
          let begin = 0;
          for (let index = 0; index < count; index++) if (buffer[index] === 10) {
            this.appendCarry(buffer.subarray(begin, index));
            const endOffset = this.offset + index + 1;
            const row = decodeLine(this.carry, this.source, ++this.line, this.lineOffset, endOffset, this.generation, this.carryBytes > STORE_LIMITS.recordBytes);
            this.history.push(row); this.historyBytes += Buffer.byteLength(row.raw);
            while (this.history.length > STORE_LIMITS.history || this.historyBytes > STORE_LIMITS.historyBytes) this.historyBytes -= Buffer.byteLength(this.history.shift()!.raw);
            if (row.error) {
              this.malformedCount++;
              this.errors.push({ source: row.source, error: row.error, line: row.line, id: row.id });
              if (this.errors.length > STORE_LIMITS.errors) this.errors.shift();
            }
            if (row.event) this.hooks.record?.({ ...row, event: row.event });
            this.carry = Buffer.alloc(0); this.carryBytes = 0; this.lineOffset = endOffset; begin = index + 1;
          }
          this.appendCarry(buffer.subarray(begin, count));
          this.offset += count;
        }
      }
      this.st = st; this.failure = undefined; this.lastSuccessfulReadAt = now;
    } catch (e) { this.failure = { source: this.source, error: errorText(e) }; }
    finally { if (fd !== undefined) closeSync(fd); }
    return this.snapshot();
  }
  private appendCarry(bytes: Buffer): void {
    this.carryBytes += bytes.length;
    const available = Math.max(0, STORE_LIMITS.recordBytes - this.carry.length);
    if (available && bytes.length) this.carry = Buffer.concat([this.carry, bytes.subarray(0, available)]);
  }
  snapshot(): TailSnapshot {
    return {
      source: this.source, generation: this.generation, identity: this.st && fileIdentity(this.st), offset: this.offset, lines: this.line,
      history: this.history.slice(), errors: this.errors.slice(), malformedCount: this.malformedCount,
      pending: this.carryBytes ? { line: this.line + 1, bytes: this.carryBytes } : undefined,
      backlogBytes: Math.max(0, Number(this.st?.size ?? 0) - this.offset),
      status: this.failure ? "unreadable" : this.malformedCount ? "corrupt" : this.carryBytes ? "pending" : "readable",
      error: this.failure, lastSuccessfulReadAt: this.lastSuccessfulReadAt, bytesRead: this.bytesRead,
    };
  }
  /** Demand paging scans with fixed buffers, independent of the retained history; no growing line index. */
  page(firstLine: number, count = 32, generation = this.generation): readonly JournalLine[] {
    if (!Number.isInteger(firstLine) || firstLine < 1) throw new Error("evidence line must be a positive integer");
    if (generation !== this.generation) throw new Error("evidence belongs to a replaced journal");
    const rows: JournalLine[] = [];
    const reader = new JournalTail(this.source, { record: undefined });
    // Read only enough for the requested page. The retained scanner window is bounded, even on huge files.
    const fd = openSync(this.source, "r");
    try {
      const st = fstatSync(fd, { bigint: true });
      if (this.st && stamp(st) !== stamp(this.st)) throw new Error("journal changed; refresh before paging");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0, line = 0, start = 0;
      const limit = Math.max(1, Math.min(STORE_LIMITS.history, Math.floor(count)));
      while (position < Number(st.size) && rows.length < limit) {
        const n = readSync(fd, buffer, 0, buffer.length, position);
        if (!n) break;
        let begin = 0;
        for (let i = 0; i < n; i++) if (buffer[i] === 10) {
          if (line + 1 >= firstLine) reader.appendCarry(buffer.subarray(begin, i));
          line++;
          if (line >= firstLine) rows.push(decodeLine(reader.carry, this.source, line, start, position + i + 1, generation, reader.carryBytes > STORE_LIMITS.recordBytes));
          reader.carry = Buffer.alloc(0); reader.carryBytes = 0; start = position + i + 1; begin = i + 1;
          if (rows.length >= limit) break;
        }
        if (line + 1 >= firstLine && rows.length < limit) reader.appendCarry(buffer.subarray(begin, n));
        position += n;
      }
      if (stamp(fstatSync(fd, { bigint: true })) !== stamp(st)) throw new Error("journal changed during evidence read");
      return rows;
    } finally { closeSync(fd); }
  }
}

export interface CachedSource<T = unknown> { source: string; identity?: string; value?: T; status: "readable" | "absent" | "unreadable"; error?: string; observedAt: number }
class JsonSource<T> {
  private cached?: CachedSource<T>;
  constructor(private path: string, private parse: (raw: string) => T, private maxBytes: number = STORE_LIMITS.recordBytes) {}
  read(now: number): CachedSource<T> {
    try {
      const st = statSync(this.path, { bigint: true });
      const id = stamp(st);
      if (this.cached?.identity === id && this.cached.status === "readable") return this.cached = { ...this.cached, observedAt: now };
      if (!st.isFile()) throw new Error("source is not a regular file");
      if (st.size > BigInt(this.maxBytes)) throw new Error(`source exceeds ${this.maxBytes} byte cap`);
      // Bound the read itself too: a writer can grow the file after stat.
      const fd = openSync(this.path, "r");
      let value: T;
      try {
        const bytes = Buffer.alloc(Number(st.size) + 1);
        let length = 0;
        while (length < bytes.length) {
          const n = readSync(fd, bytes, length, bytes.length - length, length);
          if (!n) break;
          length += n;
        }
        if (length !== Number(st.size) || stamp(fstatSync(fd, { bigint: true })) !== id) throw new Error("source changed during read; retry observation");
        value = this.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
      } finally { closeSync(fd); }
      return this.cached = { source: this.path, identity: id, value, status: "readable", observedAt: now };
    } catch (e) {
      const absent = (e as NodeJS.ErrnoException).code === "ENOENT";
      return this.cached = { source: this.path, status: absent ? "absent" : "unreadable", error: absent ? undefined : errorText(e), observedAt: now };
    }
  }
}
export interface LiveStoreOptions {
  cwd: string; runId: string; now?: () => number; configPath?: string; cachePath?: string;
  isDaemonAlive?: (pid: number) => boolean;
}

/** C1 mount/C6 reader boundary. No timers or presence writes: the mount owns scheduling and disarm. */
export function createLiveStore(options: LiveStoreOptions) {
  const now = options.now ?? Date.now;
  const state = join(options.cwd, stateDirName(options.cwd));
  let fold = new OperatorStateFold();
  const tail = new JournalTail(join(state, "runs", parseRunId(options.runId), "journal.jsonl"), {
    reset: () => { fold = new OperatorStateFold(); }, record: record => fold.apply(record),
  });
  const graph = new JsonSource<RunGraph>(graphPath(options.cwd), raw => validateGraph(JSON.parse(raw)), STORE_LIMITS.graphBytes);
  const config = new JsonSource(options.configPath ?? join(state, "config.yaml"), raw => raw);
  const cache = new JsonSource(options.cachePath ?? join(state, "doctor.json"), JSON.parse);
  const lock = new JsonSource<{ pid: number; runId: string; startedAt: number }>(join(state, "graph.lock"), raw => {
    const v = JSON.parse(raw);
    if (!v || !Number.isInteger(v.pid) || v.pid < 1 || typeof v.runId !== "string" || typeof v.startedAt !== "number") throw new Error("invalid lock payload");
    return v;
  });
  const listeners = new Set<() => void>();
  let sequence = 0, lastObservation: number | undefined, inputSequence = 0;
  let viewport = { columns: 120, rows: 40 };
  let disposed = false;
  let queued: Promise<void> | undefined;
  const metrics: { observedAt: number; bytesRead: number }[] = [];
  function observe() {
    const observedAt = now();
    const delayed = lastObservation !== undefined && observedAt - lastObservation > 2 * OBSERVATION_INTERVAL_MS;
    const journal = tail.poll(observedAt);
    const graphReading = graph.read(observedAt);
    const configReading = config.read(observedAt);
    const cacheReading = cache.read(observedAt);
    const owner = lock.read(observedAt);
    const alive = owner.status === "readable" && owner.value ? (options.isDaemonAlive ?? isPidLive)(owner.value.pid) : undefined;
    const lockState = owner.status === "absent" ? "absent" : owner.status === "unreadable" ? "unreadable" : owner.value?.runId !== options.runId ? "foreign" : alive ? "alive" : "dead";
    const supervision = SUPERVISION_TIERS.map(t => readTierLiveness(options.cwd, t, observedAt));
    const errors: SourceError[] = [journal.error, ...journal.errors, ...[graphReading, configReading, cacheReading, owner].filter(s => s.error).map(s => ({ source: s.source, error: s.error! })), ...supervision.filter(s => s.state === "UNREADABLE").map(s => ({ source: join(state, "supervision", s.tier), error: "unreadable supervision" }))].filter((e): e is SourceError => !!e);
    metrics.push({ observedAt, bytesRead: journal.bytesRead });
    if (metrics.length > STORE_LIMITS.metrics) metrics.shift();
    lastObservation = observedAt;
    const readable = journal.status === "readable" && journal.backlogBytes === 0;
    return {
      sequence: ++sequence, observedAt, delayed, freshness: errors.length ? "failed" : delayed ? "delayed" : "fresh",
      operator: fold.snapshot({ graph: graphReading.status === "readable" ? graphReading.value : undefined, sequence, observedAt, readable, graphAvailability: { status: graphReading.status, error: graphReading.error } }),
      journal, graph: graphReading, config: configReading, cache: cacheReading,
      lock: { ...owner, state: lockState, alive, expired: owner.identity ? observedAt - Number(owner.identity.split(":")[3]) / 1e6 > STALE_MS : undefined },
      supervision, errors, actionsEnabled: readable && !errors.length && !delayed,
      viewport, inputSequence, metrics: metrics.slice(),
    };
  }
  let snapshot = observe();
  const publish = () => { for (const listener of listeners) listener(); };
  const refresh = () => { if (!disposed) { snapshot = observe(); publish(); } return snapshot; };
  return {
    snapshot: () => snapshot, refresh,
    requestRefresh: (): Promise<void> => {
      if (disposed) return Promise.resolve();
      return queued ??= Promise.resolve().then(() => { refresh(); }).finally(() => { queued = undefined; });
    },
    subscribe: (listener: () => void) => {
      if (disposed) throw new Error("store is disposed");
      if (listeners.size >= STORE_LIMITS.subscribers) throw new Error("store subscription limit reached");
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    input: () => {
      if (!disposed) {
        inputSequence++;
        const nextSequence = ++sequence;
        snapshot = { ...snapshot, sequence: nextSequence, operator: { ...snapshot.operator, sequence: nextSequence }, inputSequence };
        publish();
      }
    },
    resize: (columns: number, rows: number) => {
      if (!disposed) {
        viewport = { columns, rows };
        const nextSequence = ++sequence;
        snapshot = { ...snapshot, sequence: nextSequence, operator: { ...snapshot.operator, sequence: nextSequence }, viewport };
        publish();
      }
    },
    page: (firstLine: number, count?: number, generation?: number) => tail.page(firstLine, count, generation),
    diagnostics: () => ({ subscriptions: listeners.size, pendingReads: queued ? 1 : 0, metrics: metrics.length }),
    dispose: () => { disposed = true; listeners.clear(); },
  };
}
export type LiveStore = ReturnType<typeof createLiveStore>;
export type LiveStoreSnapshot = ReturnType<LiveStore["snapshot"]>;
