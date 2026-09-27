import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { TickmarkrConfigSchema } from "../src/config/config.js";
import { RunGraphSchema } from "../src/graph/schema.js";

mkdirSync("schema", { recursive: true });
const emit = (file: string, schema: z.ZodType, comment: string) => {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  (json as Record<string, unknown>)["$comment"] = comment;
  writeFileSync(`schema/${file}`, JSON.stringify(json, null, 2) + "\n");
  console.log(`wrote schema/${file}`);
};
emit("rungraph.schema.json", RunGraphSchema,
  "Structural schema only; duplicate-id/unknown-dep/cycle checks live in validateGraph().");
emit("config.schema.json", TickmarkrConfigSchema,
  "Structural schema of the merged (defaults + overlays) config; cross-field refinements live in loadConfig().");
