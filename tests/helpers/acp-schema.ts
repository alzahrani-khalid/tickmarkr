import { readFileSync } from "node:fs";
import { z } from "zod";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/acp-v1/schema.json", import.meta.url), "utf8"));
// Zod 4.4.3 cannot import these five keywords. They occur only in elicitation
// definitions, which these peers never send. The pinned fixture stays untouched.
function importable(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "not" || key === "unevaluatedProperties") delete (value as Record<string, unknown>)[key];
    else importable(child);
  }
}
importable(fixture);
const agent = z.fromJSONSchema({ $defs: fixture.$defs, ...fixture.anyOf[0] });
const definition = (name: string) => z.fromJSONSchema({ $defs: fixture.$defs, $ref: `#/$defs/${name}` });
const methods = new Map([
  ["initialize", definition("InitializeResponse")],
  ["session/new", definition("NewSessionResponse")],
  ["session/prompt", definition("PromptResponse")],
  ["session/update", definition("SessionNotification")],
]);
const error = definition("Error");
export const textContentSchema = definition("TextContent");

/** Validate both the Agent envelope and the specific method, never just a permissive union. */
export function validateAgentMessage(message: any, method?: string): void {
  agent.parse(message);
  if (Object.hasOwn(message, "error")) { error.parse(message.error); return; }
  const name = message.method ?? method;
  const schema = methods.get(name);
  if (!schema) throw new Error(`Missing ACP method validator: ${name}`);
  schema.parse(message.method ? message.params : message.result);
}
