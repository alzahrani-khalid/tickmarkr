/** Fail a built print entry if its dependency graph attempts to resolve Ink or React. */
export function resolve(specifier, context, next) {
  if (/^(ink|react)(\/|$)/.test(specifier)) throw new Error(`print imported ${specifier} from ${context.parentURL}`);
  return next(specifier, context);
}
