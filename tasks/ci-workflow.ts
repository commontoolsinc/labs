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
 * Drops comments. A `#` after whitespace ends a plain scalar, and ends a
 * command in the shell a block scalar hands its lines to. A `#` inside
 * quotes is a character of the command, so the rest of that line stays.
 * Applied before looking for commands, so that a comment naming a
 * command is not read as one and a comment after a command is not read
 * as part of it.
 */
export function withoutComments(contents: string): string {
  return contents.split("\n").map(uncommented).join("\n");
}

/** The part of one line that a comment does not take. */
function uncommented(line: string): string {
  let quote: string | undefined;
  for (let at = 0; at < line.length; at++) {
    const character = line[at]!;
    if (quote !== undefined) {
      // A backslash inside double quotes takes the next character with
      // it, in the shell and in a double-quoted scalar alike. Inside
      // single quotes both hand the backslash over as a character.
      if (character === "\\" && quote === '"') at += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character !== "#") continue;
    if (at === 0 || /\s/.test(line[at - 1]!)) return line.slice(0, at);
  }
  return line;
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
