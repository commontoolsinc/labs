/**
 * Reading the workflow files as text.
 *
 * A workflow is a YAML document, and the checks over these files read
 * them as text rather than as a parse tree, because what they ask about
 * is the commands the steps run. Two things about that text are subtle
 * enough to be worth writing once: where a comment ends, and where one
 * word ends and the next begins.
 */

/**
 * Drops YAML comments. A `#` after whitespace ends a plain scalar, so
 * what is left on a line is the value the workflow carries. Applied
 * before looking for commands, so that a comment naming a command is not
 * read as one and a comment after a command is not read as part of it.
 */
export function withoutComments(contents: string): string {
  return contents.replaceAll(/(^|\s)#.*$/gm, "$1");
}

/**
 * Splits a command the way a shell would count its words, except that a
 * `${{ ... }}` workflow expression holds spaces and still stands for one
 * word. The expression is matched to its first `}}` so that one
 * containing a brace, as `${{ format('{0}', github.sha) }}` does, still
 * comes out as one word.
 */
export function commandWords(command: string): string[] {
  return [...command.matchAll(/\$\{\{.*?\}\}|\S+/g)].map((match) => match[0]);
}

/**
 * Joins the lines a shell continuation splits a command across, so that
 * a command written over several lines counts its words as one command.
 */
export function withoutContinuations(contents: string): string {
  return contents.replaceAll(/\\\n/g, " ");
}
