import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { LABELLED_429_RE, QUOTA_PHRASE_RE, quotaSignal } from "../../src/adapters/types.js";

const fixture = (dir: string, name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${dir}/${name}`, import.meta.url)), "utf8");

// Queue row 106's closed table (D-1597): a quota signal is a phrase or a labelled 429, never a bare 429. Q1–Q3 are the
// captured corpus: the one real 429 banner, and the two bare-429 shapes it holds (line numbers).
test.each([
  ["Q1 the real 429 banner", () => fixture("quota", "rate-limit-429.out"), true],
  ["Q2 a bare 429 line number in a worker's diff listing", () => fixture("quota", "run3522-T2-a0.out"), false],
  ["Q3 a column of pane line numbers holding 429", () => fixture("nudge-echo", "pane-100-after.txt"), false],
  ["Q4 a 429 duration in telemetry", () => '{"durationMs":429}', false],
  ["Q5 an HTTP 429 status line", () => "HTTP 429", true],
  ["Q6 a status code 429 phrase", () => "request failed with status code 429", true],
  ["Q7 a JSON statusCode 429 field", () => '{"statusCode":429}', true],
  ["Q8 an Error 429 label", () => "Error: 429", true],
  ["Q9 a 429 after code inside the word zipCode", () => "zipCode: 429", false],
  ["Q10 a rate-limit sentence", () => "rate limit exceeded", true],
  ["Q11 a usage-limit sentence", () => "You have hit your usage limit", true],
  ["Q12 a too-many-requests sentence without a number", () => "Too Many Requests", true],
  ["Q13 usage limit spelled with a long s", () => "uſage limit", false],
  ["Q14 the ZAI exhaustion text", () => "Insufficient balance or no resource package. Please recharge.", true],
] as const)("the quota signal reads %s", (_row, text, quota) => {
  expect(quotaSignal(text()) !== null).toBe(quota);
});

// The quota-banner record carries matched + offset (OBS-926) and, from row 106, the source of the regex that matched.
test("L1 the leftmost quota signal wins and names the regex that matched it", () => {
  const label = quotaSignal("status 429 then rate limit")!;
  expect([label[0], label.index, label.source]).toEqual(["status 429", 0, LABELLED_429_RE.source]);
  const phrase = quotaSignal("rate limit then status 429")!;
  expect([phrase[0], phrase.index, phrase.source]).toEqual(["rate limit", 0, QUOTA_PHRASE_RE.source]);
});

test("L2 the real banner's signal is its labelled 429, the leftmost, inside its final rows", () => {
  const text = fixture("quota", "rate-limit-429.out");
  const signal = quotaSignal(text)!;
  expect([signal[0], signal.source]).toEqual(["status 429", LABELLED_429_RE.source]);
  expect(text.length - signal.index).toBeLessThan(400);
});
