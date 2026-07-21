// T3 (repo-scan Tier A #2): the shared secret-redaction pass for captured agent text at the
// persistence seams. Every seam that persists captured agent text routes its bytes through
// redactSecrets before hitting disk — journal event payloads and telemetry rows (journal.ts) and
// consult dossier artifacts (consult.ts). In-memory originals are never touched: redaction applies
// to the serialized bytes only, at the write site.
//
// Two shape families:
//   - vendor keys: recognizable prefix + high-entropy body. The prefix survives masking so the
//     credential class stays identifiable; the body never persists.
//   - secret assignments: KEY=value / "key": "value" where the key NAME announces a secret. The key
//     survives; the value is masked.
// Text with no credential shapes passes through byte-identical. Masks contain no quote or backslash
// and value charsets never cross a JSON string boundary, so redacting a serialized JSON line always
// yields a line that still parses.

export const MASK = "[REDACTED]";

// Order matters: more specific prefixes (sk-ant-, sk-proj-) before the generic sk- form.
const VENDOR_KEY_RES: RegExp[] = [
  /\b(sk-ant-)[A-Za-z0-9_-]{8,}/g, // Anthropic
  /\b(sk-proj-)[A-Za-z0-9_-]{8,}/g, // OpenAI project key
  /\b(sk-)[A-Za-z0-9_-]{16,}/g, // OpenAI classic / sk-prefixed secret keys
  /\b(github_pat_)[A-Za-z0-9_]{8,}/g, // GitHub fine-grained PAT
  /\b(gh[pousr]_)[A-Za-z0-9]{16,}/g, // GitHub token family (ghp_/gho_/ghu_/ghs_/ghr_)
  /\b(glpat-)[A-Za-z0-9_-]{8,}/g, // GitLab PAT
  /\b(xox[baprs]-)[A-Za-z0-9-]{8,}/g, // Slack token family
  /\b(npm_)[A-Za-z0-9]{16,}/g, // npm token
  /\b(AKIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(AIza)[0-9A-Za-z_-]{35}\b/g, // Google API key
];

// Key names that announce a secret. The optional quote after the key closes a JSON key ("apiKey": "…").
// The match starts AT the keyword — chars before it (MY_ in MY_API_KEY=) are simply left in place by
// replace, so anchoring on the keyword yields identical output while keeping the scan linear (a
// leading [A-Za-z0-9_.-]* here backtracks quadratically on long tokens — seconds on a 50K blob, and
// journal payloads carry parked diffs up to the diff cap).
// The value charset excludes quotes/backslash (never crosses a JSON string boundary) and square
// brackets (an already-masked value never re-matches ⇒ idempotent, and a vendor prefix kept by the
// pass above survives). The letter lookahead skips purely numeric values ("maxTokens":30000000 is a
// count, not a credential — and masking a bare JSON number would break the line's parse).
// Quotes may arrive backslash-escaped (a transcript already serialized inside a JSON string), so the
// optional opening/closing quote around key and value accepts \" as well as ".
const ASSIGNMENT_RE =
  /((?:api[_-]?key|apikey|secret|token|passwd|password|credential|access[_-]?key)[A-Za-z0-9_.-]*(?:\\?["'])?\s*[=:]\s*(?:\\?["'])?)(?=[^\s"'`\\,;[\]]*[A-Za-z])([^\s"'`\\,;[\]]{8,})/gi;

// Authorization headers are the most common credential shape in captured transcripts.
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g;

// Cheap literal prescan: every pattern above needs one of these substrings, and most persisted text
// (diffs, prose, telemetry) has none — those payloads skip all 12 regex passes in one linear scan.
const HINT_RE =
  /sk-|github_pat_|gh[pousr]_|glpat-|xox[baprs]-|npm_|AKIA|AIza|Bearer|api[_-]?key|apikey|secret|token|passwd|password|credential|access[_-]?key/i;

export function redactSecrets(text: string): string {
  if (!HINT_RE.test(text)) return text;
  let out = text;
  for (const re of VENDOR_KEY_RES) out = out.replace(re, `$1${MASK}`);
  return out.replace(ASSIGNMENT_RE, `$1${MASK}`).replace(BEARER_RE, `$1${MASK}`);
}
