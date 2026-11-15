// The form of an overlay file, kept across a write (queue row 452): its line endings and byte-order
// mark, its own indent, list style, flow padding and long lines, and plain maps for the parents a
// write creates. Used by both writers: the 2.24.0 editor's (fleet-overlay.ts) and the screen's
// (src/fleet/edits.ts).
import { isCollection, isNode, isScalar, isSeq, parseDocument, visit } from "yaml";

type OverlayDocument = ReturnType<typeof parseDocument>;
type OverlayPath = readonly string[];

/**
 * `doc.setIn` with the missing parents made here, as plain maps. The library makes them from a JS
 * `Map`, which a `%YAML 1.1` document writes as `!!omap`: a list, which reads back as an EMPTY map,
 * so the save lands and the setting is not there.
 */
export function setInPlain(doc: OverlayDocument, path: OverlayPath, value: unknown): void {
  // (a file of comments only has no contents, and after a `---` or a `%YAML` line its contents are an empty value)
  const root: unknown = doc.contents;
  if (root === null || (isScalar(root) && root.value === null && !root.anchor)) {
    const map = doc.createNode({});
    // its comments stay where they are, above what is written
    const notes = isScalar(root) ? [root.commentBefore, root.comment].filter((c) => c != null) : [];
    if (notes.length) map.commentBefore = notes.join("\n");
    (doc as { contents: unknown }).contents = map;
  }
  for (let depth = 1; depth < path.length; depth++) {
    const prefix = path.slice(0, depth);
    if (doc.getIn(prefix, true) === undefined) doc.setIn(prefix, doc.createNode({}));
  }
  doc.setIn(path, value);
}

/**
 * A write keeps the form of the file it found (queue row 452): a byte-order mark stays, and a file
 * whose lines all end CR LF keeps them. The YAML library writes LF and no mark, so `render` is given
 * the text without either and both are put back on what it returns. A file with mixed line endings
 * is left to the library, as before: there is no one form to keep.
 */
export function keepingFileForm(text: string, render: (plain: string) => string): string {
  const mark = text.startsWith("\uFEFF") ? "\uFEFF" : "", body = text.slice(mark.length);
  const crlf = body.includes("\r\n") && !/(^|[^\r])\n/.test(body);
  const out = render(crlf ? body.replace(/\r\n/g, "\n") : body);
  return mark + (crlf ? out.replace(/\n/g, "\r\n") : out);
}

/**
 * How a file is written, read from the file's own nodes (never from scalar contents or comments,
 * where a `[ ` or a long line is text, not style). An empty file, or one that shows no preference,
 * gets the style this writer has always used: two spaces, list items indented, flow collections unpadded.
 * ponytail: one style for the whole file, by majority where it mixes two; a file that pads one flow
 * collection and not another has the minority rewritten. Per-collection style needs CST editing.
 */
export function styleOf(text: string): { indent: number; indentSeq: boolean; flowCollectionPadding: boolean; lineWidth: number } {
  const col = (offset: number): number => offset - text.lastIndexOf("\n", offset - 1) - 1;
  let indent = 0, flat = 0, nested = 0, padded = 0, bare = 0, long = false;
  visit(parseDocument(text), {
    // a block collection under its key: the file's indent, and its list items at the key's indent or under it
    Pair: (_k, pair) => {
      const { key, value } = pair;
      if (!isNode(key) || !key.range || !isCollection(value) || value.flow || !value.range || !value.items.length) return;
      const k = col(key.range[0]), v = col(value.range[0]);
      if (isSeq(value)) { if (v === k) flat++; else if (v > k) nested++; } else if (!indent && v > k) indent = v - k;
    },
    Node: (_k, node) => {
      if (!node.range || (!isScalar(node) && !(isCollection(node) && node.flow))) return;
      const [start, end] = node.range;
      // a flow collection's padding is the byte after its opening bracket
      if (isCollection(node) && node.items.length) { const c = text[start + 1]; if (c === " ") padded++; else if (c !== undefined && !/\s/.test(c)) bare++; }
      // a value with any of its own lines past 80 columns (a one-line value, or a line inside a block
      // or a multi-line quoted scalar): the file keeps its long lines whole (yaml folds at 80)
      for (let at = start; at <= end && !long; ) {
        const nl = text.indexOf("\n", at), stop = nl === -1 || nl > end ? end : nl;
        long = col(stop) > 80;
        at = stop + 1;
      }
    },
  });
  // A file that has none keeps the fold at 80 it was written with (a long flow list this writer folded
  // stays folded: every other line keeps its bytes).
  return { indent: indent || 2, indentSeq: flat <= nested, flowCollectionPadding: padded > bare, lineWidth: long ? 0 : 80 };
}
