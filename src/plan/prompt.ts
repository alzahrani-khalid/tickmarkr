export function scopePrompt(intent: string, repair?: { draft: string; error: string }): string {
  return `TICKMARKR-SCOPE
You are drafting a tickmarkr native spec from an answered intent. Return only the Markdown spec, with no commentary or code fence.

The draft must:
- start with <!-- tickmarkr:spec -->
- include a Requirements section whose ids are sequential REQ-01, REQ-02, ...
- include an Assumptions section that makes every residual uncertainty explicit
- include a Traceability section mapping every REQ-nn to at least one Tn task
- use native "## Tn: Title" tasks and only command:, test:, or judge: acceptance entries
- keep scope guesses advisory in prose; runtime files scope remains authoritative

Intent:
<intent>
${intent.trim()}
</intent>
${repair ? `
The previous draft failed validation. Repair it without dropping valid detail.

Validation errors:
<errors>
${repair.error}
</errors>

Previous draft:
<draft>
${repair.draft}
</draft>
` : ""}
`;
}
