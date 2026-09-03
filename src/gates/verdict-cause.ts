export type VerdictDiscriminator = "approve" | "pass" | "ok" | "action";
export type VerdictUnparseableCause = "empty-output" | "no-verdict" | "malformed-verdict" | "timeout" | "startup-failure";

export interface VerdictProcessFacts {
  timedOut?: boolean;
  exitCode?: number;
}

const MAX_WITNESS_BYTES = 4096;
const JSON_STRING_VALUE = String.raw`"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\u0000-\u001F])*"`;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pane renderers hard-wrap at physical columns and prefix continuation lines with whitespace or box
// chrome. Joining those renderer lines is deliberately narrower than parsing: it restores split keys,
// values and delimiters, but it does not require the response to be complete or valid JSON.
function joinRendererLines(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").split("\n")
    .map((line) => line.replace(/^[\t │|]+/, "").replace(/[\t │|]+$/, ""))
    .join("");
}

// Yield only the first structural prefix of each object candidate. Stopping at the next unquoted
// opening brace prevents a nonce from one object binding a discriminator from another; the prompts
// put their discriminator before any nested object, so no valid boundary shape is lost.
function objectPrefixes(raw: string): string[] {
  const joined = joinRendererLines(raw);
  const prefixes: string[] = [];
  for (let open = joined.indexOf("{"); open !== -1; open = joined.indexOf("{", open + 1)) {
    const ceiling = Math.min(joined.length, open + MAX_WITNESS_BYTES);
    let end = ceiling;
    let quoted = false;
    let escaped = false;
    for (let i = open + 1; i < ceiling; i++) {
      const char = joined[i]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") {
        end = i;
        break;
      } else if (char === "}") {
        end = i + 1;
        break;
      }
    }
    prefixes.push(joined.slice(open, end));
  }
  return prefixes;
}

export function hasVerdictParticipationWitness(
  raw: string,
  nonce: string,
  discriminator: VerdictDiscriminator,
): boolean {
  const noncePattern = new RegExp(
    String.raw`"nonce"\s*:\s*${escapeRegex(JSON.stringify(nonce))}\s*[,]`,
  );
  const valuePattern = discriminator === "action" ? JSON_STRING_VALUE : "(?:true|false)";
  const discriminatorPattern = new RegExp(
    String.raw`"${discriminator}"\s*:\s*${valuePattern}\s*[,}]`,
  );
  return objectPrefixes(raw).some((prefix) => noncePattern.test(prefix) && discriminatorPattern.test(prefix));
}

export function classifyVerdictCause(
  raw: string,
  nonce: string,
  discriminator: VerdictDiscriminator,
  process: VerdictProcessFacts = {},
): VerdictUnparseableCause {
  if (process.timedOut) return "timeout";
  if (raw.trim().length === 0) return "empty-output";
  if (hasVerdictParticipationWitness(raw, nonce, discriminator)) return "malformed-verdict";
  if (process.exitCode !== undefined && process.exitCode !== 0) return "startup-failure";
  return "no-verdict";
}
