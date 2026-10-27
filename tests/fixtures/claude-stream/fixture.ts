import { readFileSync } from "node:fs";

export const recordedPath = new URL("./recorded-2.1.311.jsonl", import.meta.url);
export const recorded = readFileSync(recordedPath, "utf8");
export const lines = recorded.trimEnd().split("\n").map((line) => line + "\n");
export const hooks = lines.slice(0, 2).join("");
export const init = lines[2]!;
export const working = lines.slice(0, -1).join("");
export const own = lines.slice(3, -1).join("");
// Every event variant starts with an event in the sanitized recording; only named keys change.
export function rewrite(line: string, patch: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(line), ...patch }) + "\n";
}
export function result(text: unknown, patch: Record<string, unknown> = {}): string {
  return rewrite(lines.at(-1)!, { result: text, ...patch });
}
export function answer(prompt: string): string {
  const nonce = /VERDICT_NONCE:\s*([0-9a-f]+)/i.exec(prompt)?.[1];
  return JSON.stringify(prompt.startsWith("TICKMARKR-JUDGE")
    ? { nonce, pass: true, criteria: [{ criterion: "c1", met: true, reason: "checked", evidence: { path: "src/work.ts", line: 1 } }] }
    : { nonce, approve: true, findings: [] });
}
export function turn(prompt: string): string {
  const assistant = JSON.parse(lines[6]!);
  assistant.message.content[0].text = JSON.stringify({ nonce: /VERDICT_NONCE:\s*([0-9a-f]+)/i.exec(prompt)?.[1], pass: false, approve: false });
  return lines.slice(0, 6).join("") + JSON.stringify(assistant) + "\n" + result(answer(prompt));
}
