// The document's prose carries emphasis. It used to be stored as `Seg[]` — an
// array of `{t, b}` span objects — which the renderer walked directly.
//
// That shape is unusable once a person can edit the text: nobody types an array
// of spans into a textarea. Prose is stored as a markup string with `**bold**`
// instead, and parsed back into the same Seg runs at render, so the renderer is
// unchanged and the stored form is something you can actually type.
//
// The vocabulary is deliberately one rule wide. This is a document about a
// software platform, not a place to reimplement Markdown; anything more would
// be a parser to maintain and a way for edited text to render as a surprise.

import { type Seg } from "./content.ts";

const DELIM = "**";

/**
 * `"Fabric **is** the core"` -> `[{t:"Fabric "},{t:"is",b:true},{t:" the core"}]`
 *
 * Splitting on the delimiter makes every odd-indexed part the emphasised one.
 * A lone `*` never splits, so `email_triage_*` in the tier chips survives as
 * literal text. An unclosed `**` leaves its tail unemphasised rather than
 * throwing — editing half a phrase should look wrong, not blank the panel.
 */
export const parseMarkup = (src: string): Seg[] =>
  (src ?? "").split(DELIM).reduce<Seg[]>((acc, part, i) => {
    if (part === "") return acc;
    return acc.concat([i % 2 === 1 ? { t: part, b: true } : { t: part }]);
  }, []);

/** The inverse, for seeding and for tests. */
export const toMarkup = (segs: readonly Seg[]): string =>
  segs.map((s) => (s.b ? DELIM + s.t + DELIM : s.t)).join("");

/** Prose split into paragraphs on blank lines, for the multi-paragraph fields. */
export const paragraphs = (src: string): string[] =>
  (src ?? "").split("\n\n").filter((p) => p.trim() !== "");
