/**
 * Markdown helpers. Message text in this project is Markdown -- see
 * `docs/development/code-comment-style.md` -- so anything that composes a
 * message out of text it did not write needs these.
 */

/**
 * Quotes `text` as a Markdown code span, choosing a delimiter and padding that
 * survive whatever `text` itself holds. Reach for this whenever a rendered
 * value is spliced into an error or log message: message text in this project
 * is Markdown, a rendering can hold a backtick run of any length, and a
 * hand-written pair of backticks around one produces a span that ends early or
 * loses its edges.
 *
 * Two limits are worth knowing. An empty `text` comes back as a bare pair of
 * backticks, because Markdown has no way to spell an empty code span. And a
 * code span is a single line -- a reader turns every line ending inside one
 * into a space -- so a multi-line rendering wants a fenced block instead.
 */
export function backtickQuote(text: string): string {
  // A code span's delimiter must be a longer backtick run than any inside it,
  // or the content closes the span early.
  let longestRun = 0;
  for (const [run] of text.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, run.length);
  }

  // A reader drops one leading and one trailing space from a span that has
  // both, unless the span is all spaces. A space on each side therefore buys
  // back an edge that would otherwise be lost: a backtick that would merge
  // into the delimiter, or a space of the content's own that the reader would
  // take for padding.
  const allSpaces = (text.length !== 0) && !/[^ ]/.test(text);
  const padded = !allSpaces &&
    (text.startsWith("`") || text.endsWith("`") ||
      (text.startsWith(" ") && text.endsWith(" ")));
  const pad = padded ? " " : "";
  const delimiter = "`".repeat(longestRun + 1);

  return `${delimiter}${pad}${text}${pad}${delimiter}`;
}
