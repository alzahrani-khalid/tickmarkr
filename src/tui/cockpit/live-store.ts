import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, statSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { graphPath, stateDirName } from "../../graph/graph.js";
import { validateGraph, type RunGraph } from "../../graph/schema.js";
import { foldOwedChecks, parseJournalText, parseRunId, type JournalEvent, type OwedFold, type OwedProofMemo } from "../../run/journal.js";
import { isPidLive, STALE_MS } from "../../run/lock.js";
import { readTierLiveness, SUPERVISION_TIERS } from "../../run/supervision.js";
import { OperatorStateFold, type OperatorRecord, type OwedAuthority } from "../../run/operator-state.js";

export const OBSERVATION_INTERVAL_MS = 1_000;
/** Stat-to-fstat observations one poll spends on a journal a writer keeps appending to. */
export const APPEND_RACE_OBSERVATIONS = 3;
// Graph declarations have a separate 16 MiB bound; journal retention remains unchanged.
export const STORE_LIMITS = { graphBytes: 16 * 1024 * 1024, history: 256, historyBytes: 2 * 1024 * 1024, recordBytes: 1024 * 1024, readBytes: 1024 * 1024, subscribers: 64, metrics: 12, errors: 32 } as const;
export interface SourceError { source: string; error: string; line?: number; id?: string }
export interface JournalLine extends Omit<OperatorRecord, "event"> { event?: JournalEvent; raw: string; error?: string; offset: number; endOffset: number }
export interface TailSnapshot {
  /** `digest` (I2): sha256 of every byte the tail consumed, [0, offset) — the bytes its fold was built from. */
  source: string; generation: number; identity?: string; version?: string; digest: string; offset: number; lines: number;
  history: readonly JournalLine[]; errors: readonly SourceError[]; malformedCount: number;
  pending: { line: number; bytes: number } | undefined; backlogBytes: number;
  status: "readable" | "pending" | "corrupt" | "unreadable"; error?: SourceError;
  lastSuccessfulReadAt?: number; bytesRead: number;
}
const errorText = (e: unknown): string => e instanceof Error ? e.message : String(e);
const fileIdentity = (st: BigIntStats): string => `${st.dev}:${st.ino}`;
const stamp = (st: BigIntStats): string => `${fileIdentity(st)}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
/** The one record shape the tail accepts; the complete-journal (owed) read validates against it too. */
const isJournalRecord = (e: unknown): e is JournalEvent => {
  const r = e as { ts?: unknown; event?: unknown; data?: unknown; taskId?: unknown } | null;
  return !!r && typeof r === "object" && typeof r.ts === "string" && Number.isFinite(Date.parse(r.ts)) && typeof r.event === "string"
    && !!r.data && typeof r.data === "object" && !Array.isArray(r.data) && (r.taskId === undefined || typeof r.taskId === "string");
};
function decodeLine(bytes: Buffer, source: string, line: number, offset: number, endOffset: number, generation: number, oversized = false): JournalLine {
  const base = { source, line, id: `${source}#L${line}`, offset, endOffset, generation };
  let raw = "";
  try {
    if (oversized) throw new Error(`record exceeds ${STORE_LIMITS.recordBytes} bytes; page raw evidence from disk`);
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!raw.trim()) return { ...base, raw };
    const e: unknown = JSON.parse(raw);
    if (!isJournalRecord(e)) throw new Error("invalid journal record");
    return { ...base, raw, event: e };
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
  private stale = false;
  private hash = createHash("sha256");
  private invalid = false;
  constructor(readonly source: string, private readonly hooks: { record?: (record: OperatorRecord) => void; reset?: () => void } = {}) {}
  private reset(): void {
    this.offset = 0; this.line = 0; this.carry = Buffer.alloc(0); this.carryBytes = 0; this.lineOffset = 0;
    this.history = []; this.historyBytes = 0; this.errors = []; this.malformedCount = 0; this.generation++;
    this.hash = createHash("sha256"); this.invalid = false;
    this.hooks.reset?.();
  }
  /** I2: the consumed prefix was found rewritten (an in-place rewrite then growth reads as an append), so the
   * next poll treats the file as replaced and refolds it from its first byte. */
  invalidate(): void { this.invalid = true; }
  get invalidated(): boolean { return this.invalid; }
  /** A same-inode append between stat and fstat is retried; exhaustion keeps the last good snapshot, pending. */
  poll(now = Date.now()): TailSnapshot {
    try {
      for (let observation = 1; !this.observe(); observation++) {
        if (observation === APPEND_RACE_OBSERVATIONS) { this.stale = true; this.failure = undefined; return this.snapshot(); }
      }
      this.stale = false; this.failure = undefined; this.lastSuccessfulReadAt = now;
    } catch (e) { this.failure = { source: this.source, error: errorText(e) }; }
    return this.snapshot();
  }
  /** One stat-to-fstat observation. False when an append raced it; nothing was consumed or reset. */
  private observe(): boolean {
    let fd: number | undefined;
    try {
      const st = statSync(this.source, { bigint: true });
      if (!st.isFile()) throw new Error("journal source is not a regular file");
      const replaced = this.invalid || !this.st || fileIdentity(st) !== fileIdentity(this.st) || st.size < this.st.size || (st.size === this.st.size && stamp(st) !== stamp(this.st));
      if (Number(st.size) > (replaced ? 0 : this.offset)) {
        fd = openSync(this.source, "r");
        const opened = fstatSync(fd, { bigint: true });
        if (stamp(opened) !== stamp(st)) {
          if (fileIdentity(opened) === fileIdentity(st) && opened.size > st.size) return false;
          throw new Error("journal changed before read; retry observation");
        }
      }
      if (replaced) this.reset();
      if (fd !== undefined) {
        let remaining = STORE_LIMITS.readBytes as number;
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Number(st.size) - this.offset));
        while (this.offset < Number(st.size) && remaining > 0) {
          const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(st.size) - this.offset, remaining), this.offset);
          if (!count) throw new Error("journal truncated during read");
          this.bytesRead += count; remaining -= count;
          this.hash.update(buffer.subarray(0, count));
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
      this.st = st;
      return true;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  private appendCarry(bytes: Buffer): void {
    this.carryBytes += bytes.length;
    const available = Math.max(0, STORE_LIMITS.recordBytes - this.carry.length);
    if (available && bytes.length) this.carry = Buffer.concat([this.carry, bytes.subarray(0, available)]);
  }
  snapshot(): TailSnapshot {
    return {
      source: this.source, generation: this.generation, identity: this.st && fileIdentity(this.st), version: this.st && stamp(this.st), digest: this.hash.copy().digest("hex"), offset: this.offset, lines: this.line,
      history: this.history.slice(), errors: this.errors.slice(), malformedCount: this.malformedCount,
      pending: this.carryBytes ? { line: this.line + 1, bytes: this.carryBytes } : undefined,
      backlogBytes: Math.max(0, Number(this.st?.size ?? 0) - this.offset),
      status: this.failure ? "unreadable" : this.malformedCount ? "corrupt" : this.carryBytes || this.stale ? "pending" : "readable",
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
/** I2: the journal basis an owed-check fold read — the observed file version, its generation and the bytes consumed. */
export const journalBasis = (journal: TailSnapshot): string => `${journal.source}:${journal.generation}:${journal.version}:${journal.offset}`;
const unknownOwed = (reason: string): OwedFold => ({ known: false, debt: "unknown", outstanding: [], acceptedRisk: [], discharged: [], unknown: [{ reason }] });
/** I2: the bytes the tail consumed are no longer the file's prefix — rewritten in place, then grown. */
export class JournalRewritten extends Error { constructor() { super("journal prefix rewritten since the tail consumed it"); } }
/** I2 (D-857): the ONE way any reader beside the tail gets `journal`'s bytes — every consumed byte of the very
 * file version the tail observed (an in-place rewrite, even an equal-length one, changes it), stamped before
 * and after the read, and proved by digest to be the very bytes the tail's fold consumed (a rewrite followed by
 * growth keeps the tail appending). Any change throws, so no second read is ever combined with this
 * observation's lifecycle, owed or basis. */
export function readObservedJournal(journal: TailSnapshot): Buffer {
  const fd = openSync(journal.source, "r");
  try {
    const observed = () => { if (stamp(fstatSync(fd, { bigint: true })) !== journal.version) throw new Error("journal changed since its observation"); };
    observed();
    const bytes = Buffer.alloc(journal.offset);
    for (let length = 0; length < bytes.length;) {
      const n = readSync(fd, bytes, length, bytes.length - length, length);
      if (!n) throw new Error("journal truncated since its observation");
      length += n;
    }
    observed();
    if (createHash("sha256").update(bytes).digest("hex") !== journal.digest) throw new JournalRewritten();
    return bytes;
  } finally { closeSync(fd); }
}
/** The complete journal behind `journal`'s basis: its observed bytes, every non-blank line a valid record. */
function readLedger(journal: TailSnapshot): JournalEvent[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readObservedJournal(journal));
  const events = parseJournalText(text);
  if (events.length !== text.split("\n").filter(line => line.trim()).length || !events.every(isJournalRecord)) throw new Error("complete journal holds an invalid line");
  return events;
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
  // I2: the complete journal is re-read only when its basis moves; its owed fold re-reads every discharge
  // artifact on every observation, and only the immutable git re-proof is reused through this store's memo.
  // ponytail: an ended run's whole parsed journal stays resident; fold a debt-only projection if that measures large.
  const owedMemo: OwedProofMemo = new Set();
  let ledger: { basis: string; events: JournalEvent[] } | undefined;
  const owedAuthority = (journal: TailSnapshot): OwedAuthority => {
    const basis = journalBasis(journal);
    if (ledger?.basis !== basis) {
      // Never cache a failure: only a successful read is reused; a failed one is unknown debt now and re-read next observation.
      try { ledger = { basis, events: readLedger(journal) }; } catch (e) {
        ledger = undefined;
        if (e instanceof JournalRewritten) tail.invalidate();
        return { basis, fold: unknownOwed(`complete journal unreadable: ${errorText(e)}`) };
      }
    }
    return { basis, fold: foldOwedChecks(ledger.events, options.cwd, owedMemo) };
  };
  function observe() {
    const observedAt = now();
    const delayed = lastObservation !== undefined && observedAt - lastObservation > 2 * OBSERVATION_INTERVAL_MS;
    const isReadable = (j: TailSnapshot) => j.status === "readable" && j.backlogBytes === 0;
    // Debt decides only an ended run's headline; a running or unreadable journal never pays for the fold.
    const owedOf = (j: TailSnapshot) => isReadable(j) && fold.ended ? owedAuthority(j) : undefined;
    let journal = tail.poll(observedAt);
    let owed = owedOf(journal);
    // I2: the owed read found the tail's consumed prefix rewritten, so its fold (lifecycle) is stale. Refold the
    // whole file now: lifecycle and debt then come from the same bytes. A repeat rewrite is unknown debt.
    if (tail.invalidated) { journal = tail.poll(observedAt); owed = owedOf(journal); }
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
    const readable = isReadable(journal);
    return {
      sequence: ++sequence, observedAt, delayed, freshness: errors.length ? "failed" : delayed ? "delayed" : "fresh",
      // I1: only this run's own lock naming a provably-dead (ESRCH) holder settles unfinished cells; an alive,
      // EPERM, foreign, unreadable or absent lock is not proof the work stopped.
      operator: fold.snapshot({ graph: graphReading.status === "readable" ? graphReading.value : undefined, sequence, observedAt, readable, graphAvailability: { status: graphReading.status, error: graphReading.error }, daemonDead: lockState === "dead", owed, basis: journalBasis(journal) }),
      owed, journal, graph: graphReading, config: configReading, cache: cacheReading,
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
