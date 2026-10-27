// Zero-token transport substitute: only the executable is replaced, retaining the real adapter argv.
const fs = require("node:fs");
const [fixture, ...args] = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
const nonce = /VERDICT_NONCE:\s*([0-9a-f]+)/i.exec(prompt)?.[1];
const verdict = JSON.stringify(prompt.startsWith("TICKMARKR-JUDGE")
  ? { nonce, pass: true, criteria: [{ criterion: "c1", met: true, reason: "checked", evidence: { path: "src/work.ts", line: 1 } }] }
  : prompt.startsWith("TICKMARKR-CONSULT") ? { nonce, action: "retry", notes: "inspect" }
    : { nonce, approve: true, findings: [] });
const format = args[args.indexOf("--output-format") + 1];
if (format === "stream-json") {
  if (!args.includes("--verbose")) throw new Error("stream-json print mode requires --verbose");
  const events = fs.readFileSync(fixture, "utf8").trimEnd().split("\n").map(JSON.parse);
  events[6].message.content[0].text = JSON.stringify({ nonce, pass: false, approve: false });
  events[7].result = verdict;
  process.stdout.write(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
} else {
  if (format !== "text" || args.includes("--verbose")) throw new Error("expected ordinary text invocation");
  process.stdout.write(verdict);
}
