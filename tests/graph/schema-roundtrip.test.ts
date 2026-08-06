import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { graphPath, loadGraph, saveGraph } from "../../src/graph/graph.js";
import {
  type AcceptanceItem,
  GraphValidationError,
  renderAcceptanceItem,
  validateGraph,
} from "../../src/graph/schema.js";

const graphOf = (acceptance: unknown[]) =>
  validateGraph({
    version: 1,
    spec: { source: "prd", paths: ["p.md"], hash: "h" },
    tasks: [
      {
        id: "T1",
        title: "t",
        goal: "g",
        shape: "implement",
        complexity: 1,
        acceptance,
      },
    ],
  });

// The two variants that accept an optional declared `text`.
const textCarrying: Array<[string, Record<string, unknown>]> = [
  ["command", { oracle: "command", command: "npm test", text: "npm test exits 0" }],
  ["test", { oracle: "test", test: "auth suite", text: "auth suite goes green" }],
];

// Every schema variant carrying NO text — the pre-change serialized shape, literally.
const textless: Array<[string, unknown]> = [
  ["plain string", "thing observable"],
  ["command item", { oracle: "command", command: "npm test" }],
  ["test item", { oracle: "test", test: "auth suite" }],
  ["judge item", { oracle: "judge", text: "behaves under load" }],
];

describe("acceptance item text round-trip (T35)", () => {
  test("a declared text survives saveGraph followed by loadGraph, proven member by member over the closed set of variants that accept it — a command item and a test item — each read back from the file on disk rather than from the in-memory object it was written from", () => {
    for (const [name, item] of textCarrying) {
      const dir = mkdtempSync(join(tmpdir(), `tickmarkr-t35-${name}-`));
      saveGraph(dir, graphOf([item]));
      // Proof from the disk bytes, not the in-memory object: the raw JSON carries text…
      const onDisk = JSON.parse(readFileSync(graphPath(dir), "utf8"));
      expect(onDisk.tasks[0].acceptance[0]).toEqual(item);
      // …and it survives loadGraph's revalidation instead of being stripped.
      const loaded = loadGraph(dir);
      expect(loaded.tasks[0].acceptance[0]).toEqual(item);
    }
  });

  test("an item carrying no text round-trips byte-identically to the pre-change schema, proven member by member over the closed set of every schema variant — a plain string, a command item, a test item and a judge item", () => {
    for (const [name, item] of textless) {
      const dir = mkdtempSync(join(tmpdir(), `tickmarkr-t35-notext-${name}-`));
      saveGraph(dir, graphOf([item]));
      const onDisk = JSON.parse(readFileSync(graphPath(dir), "utf8"));
      // Byte-identical to what the pre-change schema would have written: no added key, nothing moved.
      expect(JSON.stringify(onDisk.tasks[0].acceptance[0])).toBe(JSON.stringify(item));
      const loaded = loadGraph(dir);
      expect(JSON.stringify(loaded.tasks[0].acceptance[0])).toBe(JSON.stringify(item));
    }
  });

  test("rendering returns the carried text on the two variants that accept it and returns today's exact oracle rendering where none is carried, proven member by member over that same closed set", () => {
    for (const [name, item] of textCarrying) {
      const rendered = renderAcceptanceItem(item as AcceptanceItem);
      expect(rendered, name).toBe(item.text);
    }
    for (const [name, item] of textless) {
      const rendered = renderAcceptanceItem(item as AcceptanceItem);
      if (typeof item === "string") expect(rendered, name).toBe(item);
      else if (item && typeof item === "object" && "command" in item)
        expect(rendered, name).toBe(`$ ${(item as { command: string }).command}`);
      else if (item && typeof item === "object" && "test" in item)
        expect(rendered, name).toBe(`test: ${(item as { test: string }).test}`);
      else expect(rendered, name).toBe((item as { text: string }).text);
    }
  });

  test("a text key that is present but not a non-empty string is REJECTED by validateGraph rather than stripped, proven member by member over the closed set of non-conforming shapes — an empty string, a number, an object and null", () => {
    const nonConforming: Array<[string, unknown]> = [
      ["empty string", ""],
      ["number", 42],
      ["object", { nested: true }],
      ["null", null],
    ];
    for (const [shapeName, bad] of nonConforming) {
      for (const variant of ["command", "test"] as const) {
        const item =
          variant === "command"
            ? { oracle: "command", command: "npm test", text: bad }
            : { oracle: "test", test: "auth suite", text: bad };
        expect(
          () => graphOf([item]),
          `${shapeName} text on a ${variant} item must be rejected, never stripped`,
        ).toThrow(GraphValidationError);
      }
    }
  });
});
