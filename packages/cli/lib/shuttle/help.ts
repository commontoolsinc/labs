/**
 * How the verbs are written down: the one line `help` lists a verb on, and the
 * page `<verb> --help` writes.
 *
 * A shell whose only account of itself is the refusal a mistyped word gets
 * serves the person who already knows it and nobody else, which is why the
 * text a verb carries is part of the verb rather than something a document
 * elsewhere has to be kept in step with. What each verb says is `verbs.ts`'s;
 * how it is laid out is here, so the list and the page agree about a verb's
 * one-line summary by reading the same string.
 */

/**
 * The column a summary starts at, past the longest usage in `verbs`, so that
 * every summary in a list begins in the same place and a reader runs their eye
 * down them.
 */
const SUMMARY_GAP = 2;

/**
 * What the options block writes, which is the option every verb takes. It is
 * every verb's because `readOptions` (`options.ts`) puts it in front of
 * whatever a verb declared, rather than each verb offering one.
 */
const OPTIONS_BLOCK = "Options:\n  -h, --help   Write this page instead of " +
  "running the verb.";

/** What `help` says about one verb. */
export interface VerbHelp {
  /** The verb and its operands as one line, which opens the verb's page. */
  readonly usage: string;

  /** What the verb does, in the one line `help` lists it by. */
  readonly summary: string;

  /** What the verb's page says past the summary. */
  readonly detail: string;
}

/**
 * Returns `verbs` written as `help` lists them: one to a line, its usage
 * first and its summary in a column past the longest of them, with no
 * trailing break.
 *
 * The closing line names the option that says more, which is the whole of
 * what the list can carry about a verb it gives one line to.
 */
export function renderVerbList(verbs: readonly VerbHelp[]): string {
  const column = Math.max(...verbs.map((verb) => verb.usage.length)) +
    SUMMARY_GAP;
  const lines = verbs.map((verb) =>
    `${verb.usage.padEnd(column)}${verb.summary}`
  );
  return `${lines.join("\n")}\n\n\`<verb> --help\` says more about one verb.`;
}

/**
 * Returns the page `verb` writes for `<verb> --help`: what the verb and its
 * operands are written as, what it does, what it does with them, and the
 * option every verb takes, with no trailing break.
 *
 * The options block is a constant, so what it lists is that one option and
 * nothing a verb declared of its own.
 */
export function renderVerbPage(verb: VerbHelp): string {
  return `Usage: ${verb.usage}\n\n${verb.summary}\n\n${verb.detail}\n\n` +
    OPTIONS_BLOCK;
}
