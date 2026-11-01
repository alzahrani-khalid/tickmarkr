import { randomBytes } from "node:crypto";

// 2.16.0 (D-2178 add.171): the native parser refuses any task-block line it cannot consume (OBS-488), so the
// prompt states that grammar as a closed list and carries one complete draft that tests/plan/prompt.test.ts runs
// through the real draft validator — the example can never drift from what the compiler accepts.
export const SCOPE_EXAMPLE = `<!-- tickmarkr:spec -->
# Export reports as JSON

## Requirements
- REQ-01: An operator can export any report as a JSON file.
- REQ-02: The export is documented.

## Assumptions
- The existing report loader is reused; no new dependency is added.

## Traceability
| Requirement | Tasks |
| --- | --- |
| REQ-01 | T1 |
| REQ-02 | T2 |

## T1: Export a report as JSON
- goal: Add an exportJson(report) function that returns the report as pretty-printed JSON, and a
  --json flag on the export command that writes it to the chosen path.
  A missing report path is an error that names the path.
- shape: implement
- deps: none
- files: src/reports/export.ts, tests/reports/export.test.ts
- outOfScope:
  - CSV and other export formats.
- acceptance:
  - command: npm test
  - judge: The diff adds exportJson and the --json flag, and a missing report path fails with an
    error naming the path.

## T2: Document the JSON export
- goal: Describe the --json flag and one example invocation in the README export section.
- shape: docs
- deps: T1
- files: README.md
- acceptance:
  - judge: The README export section names the --json flag and shows one example invocation.
`;

// The last line is a per-call nonce (D-2178 add.174): a seat run through a driver echoes the prompt into its transcript,
// and extractDraft reads only what follows the LAST copy of this line — a user's intent cannot contain it.
export const SCOPE_END = "TICKMARKR-SCOPE-END";

export function scopePrompt(intent: string, repair?: { draft: string; error: string }, nonce = randomBytes(8).toString("hex")): string {
  return `TICKMARKR-SCOPE
You are drafting a tickmarkr native spec from an answered intent. Return only the Markdown spec, with no commentary or code fence.

The draft must:
- start with <!-- tickmarkr:spec -->
- include a Requirements section whose ids are sequential REQ-01, REQ-02, ...
- include an Assumptions section that makes every residual uncertainty explicit
- include a Traceability section mapping every REQ-nn to at least one Tn task
- use native "## Tn: Title" tasks and only command:, test:, or judge: acceptance entries
- name real repository paths: read the repository first, so files and context hold concrete paths, never the repository root or a description

Task block grammar (closed; the compiler rejects every other line):
- A task starts at a "## Tn: Title" heading (T1, T2, ... in order) and ends at the next "## " heading.
- Inside a task block, every non-blank line is exactly one of:
  1. a field bullet at column 0, "- <field>: <value>", where <field> is goal, shape, deps, files, context or complexity, or a list header with no value, "- acceptance:" or "- outOfScope:";
  2. a list item indented by two spaces, "  - <item>", directly under "- acceptance:" or "- outOfScope:";
  3. a continuation line indented by two spaces that does not start with "- ", continuing the field or list item above it.
- Never put unindented prose, a sub-heading, a table, a numbered list or a code fence inside a task block. A goal that needs several sentences or paragraphs indents every line after its first by two spaces. Text that belongs to no field goes above the first task heading.
- shape is one of: implement, tests, docs, ui, migration, refactor, chore. deps is "none" or a comma-separated list of earlier task ids. files is a comma-separated list of the repository paths the task creates or changes (new files are allowed; never "." or a bare directory). context, when present, is a comma-separated list of existing repository paths the worker should read, never prose; omit it when unsure.
- Each acceptance item is one of: "command: <shell command that exits 0 only when the criterion holds>", "test: <exact test title> | suite: <test file path>" (only in a repository that runs vitest; otherwise use command:), or "judge: <a criterion a reviewer checks against the diff>".

A complete draft in this format:
<example>
${SCOPE_EXAMPLE}</example>

Intent:
<intent>
${intent.trim()}
</intent>
${repair ? `
The previous draft failed validation. Repair it without dropping valid detail, and re-check every task block against the grammar above.

Validation errors:
<errors>
${repair.error}
</errors>

Previous draft:
<draft>
${repair.draft}
</draft>
` : ""}
${SCOPE_END} ${nonce}
`;
}
