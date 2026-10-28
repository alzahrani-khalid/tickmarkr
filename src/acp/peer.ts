import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export type RpcId = string | number | null;
export type RpcParams = Record<string, unknown> | unknown[] | undefined;
export type AcpHandler = (params: RpcParams) => unknown | Promise<unknown>;

export class AcpError extends Error {
  constructor(public readonly code: number, message: string) { super(message); }
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value: unknown): value is RpcId =>
  value === null || typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));

/** A deliberately small, hand-rolled JSON-RPC peer. Only newline-terminated rows are messages. */
export function createAcpPeer(options: {
  input: Readable;
  write: (line: string) => void;
  requests: Record<string, AcpHandler>;
  notifications?: Record<string, AcpHandler>;
  isInitialized: () => boolean;
  stderr?: (text: string) => void;
  onEnd?: () => void;
}) {
  const send = (message: object) => options.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const error = (id: RpcId, code: number, message: string) => send({ id, error: { code, message } });
  const pending = new Set<Promise<void>>();
  const report = (fault: unknown) => (options.stderr ?? ((text) => { process.stderr.write(text); }))(
    (fault instanceof Error ? fault.stack ?? fault.message : String(fault)) + "\n",
  );
  const invoke = (handler: AcpHandler, params: RpcParams, id: RpcId, request: boolean) => {
    const failed = (fault: unknown) => {
      if (!(fault instanceof AcpError)) report(fault);
      if (request) error(id, fault instanceof AcpError ? fault.code : -32603,
        fault instanceof AcpError ? fault.message : "Internal error");
    };
    try {
      const result = handler(params);
      const task = Promise.resolve(result).then((value) => {
        if (request) send({ id, result: value });
      }, failed);
      pending.add(task);
      void task.finally(() => pending.delete(task));
    } catch (fault) { failed(fault); }
  };
  const decode = (line: string) => {
    if (!line.trim()) return;
    let row: unknown;
    try { row = JSON.parse(line); }
    catch { error(null, -32700, "Parse error"); return; }
    if (!isObject(row)) { error(null, -32600, "Invalid Request"); return; }
    const hasId = Object.hasOwn(row, "id");
    const id = hasId && validId(row.id) ? row.id : null;
    const hasMethod = Object.hasOwn(row, "method");
    const hasParams = Object.hasOwn(row, "params");
    if (row.jsonrpc !== "2.0" || (hasId && !validId(row.id))
      || (hasMethod && typeof row.method !== "string")
      || (hasParams && !isObject(row.params) && !Array.isArray(row.params))) {
      error(id, -32600, "Invalid Request"); return;
    }
    if (!hasMethod) {
      const result = Object.hasOwn(row, "result");
      const failure = Object.hasOwn(row, "error");
      const validError = isObject(row.error) && Number.isInteger(row.error.code) && typeof row.error.message === "string";
      if (hasId && !hasParams && result !== failure && (result || validError)) return;
      error(id, -32600, "Invalid Request"); return;
    }
    const method = row.method as string;
    // Premature requests, including unknown methods, precede method/parameter validation.
    if (!options.isInitialized()) {
      if (!hasId) return;
      if (method !== "initialize") { error(id, -32600, "Initialize first"); return; }
    }
    if (method === "$/cancel_request") return;
    const handlers = hasId ? options.requests : options.notifications;
    if (!handlers || !Object.hasOwn(handlers, method)) {
      if (hasId) error(id, -32601, "Method not found");
      return;
    }
    invoke(handlers[method]!, row.params as RpcParams, id, hasId);
  };
  const decoder = new StringDecoder("utf8");
  let tail = "";
  const done = new Promise<void>((resolve, reject) => {
    options.input.on("data", (chunk: Buffer | string) => {
      tail += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newline: number;
      while ((newline = tail.indexOf("\n")) !== -1) {
        const line = tail.slice(0, newline);
        tail = tail.slice(newline + 1);
        decode(line);
      }
    });
    options.input.once("error", reject);
    options.input.once("end", () => {
      // Never flush the decoder or dispatch an unterminated tail at EOF.
      tail = "";
      options.onEnd?.();
      void Promise.all(pending).then(() => resolve(), reject);
    });
  });
  return { done, notify: (method: string, params: object) => send({ method, params }) };
}
