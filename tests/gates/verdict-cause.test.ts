import { describe, expect, test } from "vitest";
import { dewrapPaneVerdict, extractVerdictJson } from "../../src/gates/llm.js";
import { classifyVerdictCause, hasVerdictParticipationWitness } from "../../src/gates/verdict-cause.js";

const NONCE = "a11ce209";

function reviewPromptEcho(nonce = NONCE): string {
  return [
    "TICKMARKR-REVIEW",
    `VERDICT_NONCE: ${nonce}`,
    "Respond with ONLY this JSON:",
    `{"nonce": "${nonce}", "approve": true|false, "findings": []}`,
  ].join("\n");
}

describe("verdict participation cause", () => {
  test("participation requires a STRUCTURALLY VALID nonce-bound response, not the presence of a nonce, proven member by member over the closed set of nonce-bearing non-responses — a harness-exit-marker-only fixture, a verbatim-prompt-echo fixture carrying this call's nonce and its true-pipe-false template, and a hard-wrapped template-echo fixture — each classified as silence", () => {
    const fixtures = [
      { member: "harness exit marker", raw: `TICKMARKR_EXIT_${NONCE}:0` },
      { member: "verbatim prompt echo", raw: reviewPromptEcho() },
      {
        member: "hard-wrapped template echo",
        raw: [
          "│ Respond with ONLY this JSON:",
          `│ {"nonce": "${NONCE}", "appro`,
          `│   ve": tru`,
          "│   e|fal",
          "│   se, " + '"findings": []}',
        ].join("\n"),
      },
    ] as const;

    for (const fixture of fixtures) {
      expect(hasVerdictParticipationWitness(fixture.raw, NONCE, "approve"), fixture.member).toBe(false);
      expect(classifyVerdictCause(fixture.raw, NONCE, "approve"), fixture.member).toBe("no-verdict");
    }
  });

  test("participation is decided by the PARTIAL witness — this call's nonce, a real discriminator value under the key that boundary's prompt requests, and its exact delimiter, with the value grammar taken from the key rather than assumed uniform: a boolean for approve, pass and ok, and one JSON string for action, so a syntactically valid but semantically wrong action is participation while the prompt template's own alternation is not — never by a full parse, proven member by member over the closed set of response shapes: a well-formed verdict fixture that parses, a HARD-WRAPPED fixture whose valid discriminator and delimiter are split across renderer line breaks, a malformed-JSON-after-the-delimiter fixture, and a truncated-after-the-discriminator's-required-delimiter fixture — all four classified as participation, the last two failing closed as malformed rather than as silence", () => {
    const wellFormed = `{"nonce":"${NONCE}","approve":true,"findings":[]}`;
    const hardWrapped = [
      `• {"non`,
      `  ce":"${NONCE}","pa`,
      `  ss":fal`,
      "  se",
      "  ,\"criteria\":[]}",
    ].join("\n");
    const malformedAfterDelimiter = `{"nonce":"${NONCE}","ok":false, definitely-not-json`;
    const truncatedAfterDelimiter = `{"nonce":"${NONCE}","action":"dance",`;
    const fixtures = [
      { member: "well-formed", raw: wellFormed, key: "approve" },
      { member: "hard-wrapped", raw: hardWrapped, key: "pass" },
      { member: "malformed after delimiter", raw: malformedAfterDelimiter, key: "ok" },
      { member: "truncated after delimiter", raw: truncatedAfterDelimiter, key: "action" },
    ] as const;

    expect(extractVerdictJson(wellFormed, NONCE)).toEqual({ approve: true, findings: [] });
    for (const fixture of fixtures) {
      expect(hasVerdictParticipationWitness(fixture.raw, NONCE, fixture.key), fixture.member).toBe(true);
    }
    expect(classifyVerdictCause(malformedAfterDelimiter, NONCE, "ok")).toBe("malformed-verdict");
    expect(classifyVerdictCause(truncatedAfterDelimiter, NONCE, "action")).toBe("malformed-verdict");

    expect(hasVerdictParticipationWitness(`{"nonce":"${NONCE}","approve":"true",`, NONCE, "approve")).toBe(false);
    expect(hasVerdictParticipationWitness(`{"nonce":"${NONCE}","action":true,`, NONCE, "action")).toBe(false);
    expect(hasVerdictParticipationWitness(`{"nonce":"${NONCE}","action":"retry" | "human"}`, NONCE, "action")).toBe(false);
  });

  test("silence is named over the closed set of silence shapes — an empty-output fixture, a banner-only-echo fixture, a foreign-nonce fixture, a truncated-before-any-discriminator fixture, and a truncated-after-the-discriminator-but-before-its-delimiter fixture that has not yet satisfied the witness", () => {
    const fixtures = [
      { member: "empty output", raw: "", cause: "empty-output" },
      { member: "banner only", raw: "TICKMARKR-REVIEW — waiting for response", cause: "no-verdict" },
      { member: "foreign nonce", raw: '{"nonce":"deadbeef","approve":true}', cause: "no-verdict" },
      { member: "before discriminator", raw: `{"nonce":"${NONCE}",`, cause: "no-verdict" },
      { member: "before delimiter", raw: `{"nonce":"${NONCE}","approve":true`, cause: "no-verdict" },
    ] as const;

    for (const fixture of fixtures) {
      expect(hasVerdictParticipationWitness(fixture.raw, NONCE, "approve"), fixture.member).toBe(false);
      expect(classifyVerdictCause(fixture.raw, NONCE, "approve"), fixture.member).toBe(fixture.cause);
    }
  });

  test("the witness admits only the discriminator key this call's own prompt requests, proven member by member over the closed set of harness emitters that place a nonce-bearing object into the classifier's input — the harness exit marker, a verbatim prompt echo, and the pane dewrap path — none satisfying the witness on its own, and a fixture built on a foreign discriminator key classified as silence rather than as participation", () => {
    const promptEcho = reviewPromptEcho();
    const emitters = [
      { member: "harness exit marker", raw: `TICKMARKR_EXIT_${NONCE}:0` },
      { member: "verbatim prompt echo", raw: promptEcho },
      { member: "pane dewrap", raw: dewrapPaneVerdict(promptEcho, NONCE) },
    ] as const;

    for (const emitter of emitters) {
      expect(hasVerdictParticipationWitness(emitter.raw, NONCE, "approve"), emitter.member).toBe(false);
      expect(classifyVerdictCause(emitter.raw, NONCE, "approve"), emitter.member).toBe("no-verdict");
    }

    const judgeAnswerAtReviewBoundary = `{"nonce":"${NONCE}","pass":true,"criteria":[]}`;
    expect(hasVerdictParticipationWitness(judgeAnswerAtReviewBoundary, NONCE, "approve")).toBe(false);
    expect(classifyVerdictCause(judgeAnswerAtReviewBoundary, NONCE, "approve")).toBe("no-verdict");
  });
});
