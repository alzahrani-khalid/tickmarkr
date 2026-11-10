// Queue row 392 R6 (D-2187 add.11): a zero-token stand-in for a model proxy on node:http, bound to
// 127.0.0.1 port 0. It answers each request with the next scripted reply (the last one repeats) and
// records every request's method, path and headers. No test reaches any other endpoint.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";

export type ScriptedReply = {
  status?: number;
  /** A string is sent as is; anything else is sent as JSON. */
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Destroy the socket instead of answering (a connection reset). */
  reset?: boolean;
};
export type RecordedRequest = { method: string; path: string; headers: IncomingHttpHeaders };
export type FakeCliproxy = { url: string; requests: RecordedRequest[]; close: () => Promise<void> };

/** An OpenAI-style model list, the shape CLIProxyAPI's GET /v1/models answers with. */
export const modelList = (ids: string[]): ScriptedReply => ({
  status: 200,
  body: { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "cliproxy" })) },
});

const listen = (server: Server) => new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
});
const shut = (server: Server) => new Promise<void>((resolve) => {
  server.closeAllConnections();
  server.close(() => resolve());
});

export async function startFakeCliproxy(script: ScriptedReply | ScriptedReply[]): Promise<FakeCliproxy> {
  const replies = Array.isArray(script) ? script : [script];
  const requests: RecordedRequest[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const server = createServer((req, res) => {
    const reply = replies[Math.min(requests.length, replies.length - 1)] ?? {};
    requests.push({ method: req.method ?? "", path: req.url ?? "", headers: { ...req.headers } });
    const answer = () => {
      if (reply.reset) {
        req.socket.destroy();
        return;
      }
      const body = typeof reply.body === "string" ? reply.body : reply.body === undefined ? "" : JSON.stringify(reply.body);
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
      res.end(body);
    };
    if (!reply.delayMs) return answer();
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!res.destroyed) answer();
    }, reply.delayMs);
    timers.add(timer);
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      await shut(server);
    },
  };
}

/** The resolver node:http calls in place of dns.lookup, failing with the errno the OS gives for an
 *  unresolved name (ENOTFOUND, EAI_AGAIN) or an unreachable route (EHOSTUNREACH, ENETUNREACH). Those
 *  cells run through the production transport and no packet leaves the host. `calls` records each
 *  hostname it was asked for. */
export function failingLookup(code: string): LookupFunction & { calls: string[] } {
  const calls: string[] = [];
  const lookup = (hostname: string, _options: unknown, callback: (err: NodeJS.ErrnoException | null, address: string, family?: number) => void) => {
    calls.push(hostname);
    const err: NodeJS.ErrnoException = Object.assign(new Error(`${code} ${hostname}`), { code, hostname });
    process.nextTick(() => callback(err, "", 0));
  };
  return Object.assign(lookup as LookupFunction, { calls });
}

/** A 127.0.0.1 URL whose port was just released, so connecting to it is refused. */
export async function refusedUrl(): Promise<string> {
  const server = createServer();
  const port = await listen(server);
  await shut(server);
  return `http://127.0.0.1:${port}`;
}
