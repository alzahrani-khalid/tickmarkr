import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { AcpError, createAcpPeer, isObject } from "../../src/acp/peer.js";
import { validateAgentMessage } from "../helpers/acp-schema.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a row over the sixty-four mebibyte bound gets one null-id invalid-request error before its newline and never runs while a row at the bound decodes, so an off-by-one or unbounded frame fails", async () => {
  const input = new PassThrough();
  const output: any[] = [];
  const calls: unknown[] = [];
  const peer = createAcpPeer({ input, isInitialized: () => true,
    write: line => output.push(JSON.parse(line)),
    requests: { run: params => { calls.push(params); return {}; } },
  });
  const bound = 64 * 1024 * 1024;
  const chunk = " ".repeat(64 * 1024);
  const originalIndexOf = String.prototype.indexOf;
  let checkingSearch = false;
  let searched = 0;
  // Inspect this process's actual searches without retaining the searched strings.
  String.prototype.indexOf = function (search, from) {
    if (checkingSearch && search === "\n") {
      expect(this.length).toBeLessThanOrEqual(chunk.length);
      searched += this.length - (from ?? 0);
    }
    return originalIndexOf.call(this, search, from);
  };
  const feedAtBound = (id: string) => {
    const row = JSON.stringify({ jsonrpc: "2.0", id, method: "run", params: { id } });
    // A non-ASCII id also proves the bound counts characters rather than UTF-8 bytes.
    input.emit("data", row);
    let left = bound - row.length;
    checkingSearch = true;
    try {
      while (left) {
        const size = Math.min(left, chunk.length);
        input.emit("data", chunk.slice(0, size));
        left -= size;
      }
    } finally { checkingSearch = false; }
  };
  try {
    feedAtBound("雪");
    expect(output).toEqual([]);
    expect(calls).toEqual([]);
    input.emit("data", "\n");
    await tick();
    expect(output).toEqual([{ jsonrpc: "2.0", id: "雪", result: {} }]);
    expect(calls).toEqual([{ id: "雪" }]);

    feedAtBound("oversized");
    expect(output).toHaveLength(1);
    input.emit("data", " ");
    const invalid = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    expect(output).toEqual([{ jsonrpc: "2.0", id: "雪", result: {} }, invalid]);
    input.emit("data", chunk);
    input.emit("data", '{"jsonrpc":"2.0","id":"discarded","method":"run"}');
    expect(output).toHaveLength(2);
    expect(calls).toEqual([{ id: "雪" }]);
    input.emit("data", '\n{"jsonrpc":"2.0","id":"after","method":"run","params":{}}\n');
    await tick();
    expect(output.at(-1)).toEqual({ jsonrpc: "2.0", id: "after", result: {} });
    expect(calls).toEqual([{ id: "雪" }, {}]);
    // The bound precedes JSON parsing for an oversized row arriving with its newline too.
    input.emit("data", "x".repeat(bound + 1) + "\n");
    expect(output).toHaveLength(4);
    expect(output.at(-1)).toEqual(invalid);
    expect(calls).toHaveLength(2);
    expect(searched).toBeLessThanOrEqual(2 * bound);
  } finally {
    String.prototype.indexOf = originalIndexOf;
    input.end();
    await peer.done;
  }
});

test("the ACP peer applies the closed decode table in its precedence, answering parse, envelope, method and params errors with the stated id, refusing malformed response shapes, emitting nothing for blank lines, ignored notifications and well-formed responses, and decoding a torn row only at its newline, so a partial-row decoder fails", async () => {
  const input = new PassThrough();
  const output: any[] = [];
  const calls: unknown[] = [];
  let diagnostics = "";
  const peer = createAcpPeer({
    input, isInitialized: () => true,
    write: (line) => {
      expect(line.endsWith("\n")).toBe(true);
      const message = JSON.parse(line);
      validateAgentMessage(message, "session/new");
      output.push(message);
    },
    stderr: (text) => { diagnostics += text; },
    requests: {
      "session/new": (params) => {
        if (!isObject(params) || typeof params.name !== "string") throw new AcpError(-32602, "Invalid params");
        calls.push(params);
        if (params.name === "fault") throw new Error("handler fault sentinel");
        return { sessionId: params.name };
      },
    },
  });
  const cases: [string, number, unknown][] = [
    ["not JSON", -32700, null], ["{", -32700, null],
    ["null", -32600, null], ["true", -32600, null], ["1", -32600, null],
    ['"str"', -32600, null], ["[]", -32600, null], ['[{"id":5}]', -32600, null],
    ['{"id":"keep","method":"missing"}', -32600, "keep"],
    ['{"jsonrpc":"1.0","id":7,"method":"missing"}', -32600, 7],
    ['{"jsonrpc":"2.0","id":8,"method":null}', -32600, 8],
    ['{"jsonrpc":"2.0","id":"method","method":42}', -32600, "method"],
    ...[true, {}, [], 1.5].map((id): [string, number, unknown] => [JSON.stringify({ jsonrpc: "2.0", id, method: "missing" }), -32600, null]),
    ...[null, 1, false, "text"].map((params): [string, number, unknown] => [JSON.stringify({ jsonrpc: "2.0", id: "params", method: "missing", params }), -32600, "params"]),
    ['{"jsonrpc":"2.0","id":10,"method":"missing","params":{}}', -32601, 10],
    ['{"jsonrpc":"2.0","id":null,"method":"missing","params":[]}', -32601, null],
    ['{"jsonrpc":"2.0","id":11,"method":"session/new","params":[]}', -32602, 11],
    ['{"jsonrpc":"2.0","id":12,"method":"session/new"}', -32602, 12],
    ['{"jsonrpc":"2.0","id":13,"method":"toString"}', -32601, 13],
    ['{"jsonrpc":"2.0","id":14,"method":"session/new","params":{"name":"fault"}}', -32603, 14],
  ];
  for (const [line, code, id] of cases) {
    const before = output.length;
    input.write(line + "\n");
    await tick();
    expect(output.slice(before), line).toEqual([{ jsonrpc: "2.0", id, error: { code, message: expect.any(String) } }]);
  }
  expect(diagnostics).toContain("Error: handler fault sentinel\n");
  expect(diagnostics).toMatch(/peer\.test\.ts:\d+/);

  // Bait: a response using an already answered request ID is still validated, never
  // dropped merely because the ID was seen before.
  for (const response of [
    { id: 10 }, { id: 10, result: {}, error: { code: 1, message: "both" } },
    { id: 10, error: {} }, { id: 10, error: { code: "1", message: "wrong" } },
    { id: 10, error: { code: 1.5, message: "wrong" } }, { id: 10, error: { code: 1, message: 3 } },
    { id: 10, error: null }, { id: 10, error: [] }, { result: {} },
    { id: 10, result: {}, params: {} }, { id: 10, result: {}, method: null },
  ]) {
    const before = output.length;
    input.write(JSON.stringify({ jsonrpc: "2.0", ...response }) + "\n");
    await tick();
    expect(output.slice(before)).toEqual([{ jsonrpc: "2.0", id: Object.hasOwn(response, "id") ? 10 : null, error: { code: -32600, message: expect.any(String) } }]);
  }
  const beforeIgnored = output.length;
  input.write("\n \t\r\n" + [
    { id: 10, result: {} }, { id: null, result: null }, { id: "x", result: 5 },
    { id: 10, error: { code: -32602, message: "valid", data: [] } },
    { method: "missing", params: [] }, { method: "session/cancel", params: { sessionId: "unknown" } },
    { method: "$/cancel_request", params: { requestId: 10 } },
    { id: 10, method: "$/cancel_request", params: { requestId: 10 } },
  ].map((row) => JSON.stringify({ jsonrpc: "2.0", ...row }) + "\n").join(""));
  await tick();
  expect(output).toHaveLength(beforeIgnored);

  const row = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "torn", method: "session/new", params: { name: "acp-雪🙂" } }));
  const cut = row.indexOf(Buffer.from("雪")) + 1;
  const beforeTorn = calls.length;
  input.write(row.subarray(0, cut));
  await tick();
  expect(calls).toHaveLength(beforeTorn);
  input.write(row.subarray(cut));
  await tick();
  expect(calls).toHaveLength(beforeTorn);
  expect(output).toHaveLength(beforeIgnored);
  input.write("\n");
  await tick();
  expect(output.at(-1)).toEqual({ jsonrpc: "2.0", id: "torn", result: { sessionId: "acp-雪🙂" } });
  expect(calls.at(-1)).toEqual({ name: "acp-雪🙂" });
  const atEnd = output.length;
  input.end(JSON.stringify({ jsonrpc: "2.0", id: "unterminated", method: "session/new", params: { name: "never" } }));
  await peer.done;
  expect(output).toHaveLength(atEnd);
  expect(calls).toHaveLength(beforeTorn + 1);
});
