import picomatch from "picomatch";

/**
 * The ONE matcher for files[] / scope.allowDeviations semantics (Q120s, TRIAL T-OBS-4).
 *
 * Parens in a files[] entry are LITERAL path characters. Expo Router and Next.js name
 * group directories `(app)`, `(marketing)` — but picomatch compiles a bare `(app)` to a
 * regex CAPTURE GROUP matching `app`, so a pattern naming such a path can never match it
 * (SentioQ run-1: T3 burned 3 dispatches on a scope red unwinnable by construction).
 * Brackets need no help: this picomatch already compiles `[id]` to the alternation
 * `(?:\[id\]|[id])`, literal-or-class.
 *
 * The price is extglobs (`@(a|b)` etc.) become literal text in files[] entries — they
 * have no recorded use in any spec, and a scope allowlist wants boring, predictable
 * matching over regex power. Every consumer of files[]-shaped patterns MUST match
 * through this module; a second picomatch call with hand-rolled options is how the
 * gate and the compiler drift apart.
 */
export const literalParens = (pattern: string): string =>
  pattern.replace(/\\?[()]/g, (m) => (m.length === 2 ? m : `\\${m}`));

export function filesGlob(patterns: string | string[]): (path: string) => boolean {
  const list = (Array.isArray(patterns) ? patterns : [patterns]).map(literalParens);
  return picomatch(list, { dot: true });
}
