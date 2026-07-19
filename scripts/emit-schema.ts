import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { RunGraphSchema } from "../src/graph/schema.js";

mkdirSync("schema", { recursive: true });
const json = z.toJSONSchema(RunGraphSchema, { io: "input", unrepresentable: "any" });
(json as Record<string, unknown>)["$comment"] =
  "Structural schema only; duplicate-id/unknown-dep/cycle checks live in validateGraph().";
writeFileSync("schema/rungraph.schema.json", JSON.stringify(json, null, 2) + "\n");
console.log("wrote schema/rungraph.schema.json");
