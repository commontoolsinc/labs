/**
 * The `--` marker, on a command that has no section for it to close.
 *
 * `--` closes a callable's section, so it is written on the commands that have
 * one — `call` and `exec` — and nowhere else. A command whose read options
 * follow the target directly has no such boundary, and Cliffy hands every word
 * after the marker to the literal arguments instead. An action that reads none
 * of them discards the words in silence: a projection written that way returns
 * an unprojected value and exits zero.
 *
 * That is the failure this refuses. It is the same shape as a field named for
 * a read option being read as one — a line that means something else, succeeds,
 * and says nothing — which is why the marker is refused rather than accepted as
 * a second spelling.
 *
 * The decision, and the alternative of accepting it, are recorded under
 * "Alternatives, and why they are not the design" in
 * [CLI surface shape](../../../docs/plans/cli-surface-shape.md).
 */

import { ValidationError } from "@cliffy/command";

/**
 * Refuse a `--` written on a command that has no callable section.
 *
 * `literalArgs` is what the parser set aside at the marker. Empty means no
 * marker was written, which is every ordinary line.
 *
 * The message names the words that would have been discarded and the line that
 * works, because every caller who meets it wrote a spelling they expected to
 * mean something.
 */
export function refuseSectionMarker(
  spelling: string,
  literalArgs: readonly string[],
): void {
  if (literalArgs.length === 0) return;
  const discarded = literalArgs.join(" ");
  throw new ValidationError(
    `\`--\` closes a callable's section, and \`cf ${spelling}\` has none. ` +
      `The words after it are set aside rather than read, so this line would ` +
      `return a value you did not ask for.\n\n` +
      `  written:  cf ${spelling} … -- ${discarded}\n` +
      `  write:    cf ${spelling} … ${discarded}\n\n` +
      `\`--\` is written on \`cf call\` and \`cf exec\`, where a callable's ` +
      `own flags come first and the marker ends them.`,
  );
}
