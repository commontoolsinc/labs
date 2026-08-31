/**
 * The boundary between a callable's section and the read step's.
 *
 * A call is read by three parties in one order: `cf` resolves the target, the
 * callable consumes its input, and the read step shapes what came back. The
 * verb names the callable, so it also opens that callable's section — the same
 * boundary `docker run` draws at an image name and `ssh` at a host, where a
 * positional makes a marker unnecessary. What a marker IS needed for is the
 * boundary no positional draws: the one where the callable's section ends and
 * the read step's begins.
 *
 * ```text
 * cf call <target> <verb> <verb input> -- <read opts>
 * cf exec <mountedFile> <verb input>   -- <read opts>
 * ```
 *
 * So a projection has exactly one place to stand, and every other reading of
 * one is refused here rather than absorbed. Before the verb it names
 * positions in a result nothing has identified yet. Inside the callable's
 * section it is read where a verb's fields are read, and those two
 * vocabularies are independent — either may grow a name the other already
 * has, so a line that worked would reach a different reader with no edit and
 * no warning. Past the marker with the section left empty, on a verb
 * declaring a field of that very name, neither reading can be told from the
 * other, and the caller is asked which they meant.
 *
 * Every refusal prints the line that works, which is what `refuseSectionMarker`
 * in `section-marker.ts` does for the marker written where nothing closes, and
 * what carries a change that lands at once rather than through a warned
 * window: a caller meeting one of these wrote a spelling that used to work, so
 * a message saying only what is wrong asks them to rediscover the grammar
 * while one that prints the line asks them to retype it.
 *
 * The design, and the four shapes rejected in reaching it, are recorded under
 * "Naming the target" in
 * [CLI surface shape](../../../docs/plans/cli-surface-shape.md).
 */

import { Command, ValidationError } from "@cliffy/command";
import { listFlags, nearestName } from "./refusal.ts";

/**
 * The flags that shape a result, in the order the commands declare them.
 *
 * One list rather than three literals: every door below asks the same
 * question of a name, and a fourth read option added to the commands has to
 * reach all of them or the boundary holds for three flags and leaks on the
 * fourth.
 */
export const READ_OPTION_NAMES: readonly string[] = [
  "filter",
  "select",
  "schema",
];

/** The parsed read options, in the shape `parseCellSelectionOptions` takes. */
export interface ReadSection {
  filter?: string;
  select?: string;
  schema?: string;
}

/** The name a `--flag` or `--flag=value` token spells, without its value. */
function optionName(token: string): string {
  return token.slice(2).split("=", 1)[0];
}

/** Whether `token` is a read option, in either the spaced or `=` spelling. */
function readOptionName(token: string): string | undefined {
  if (!token.startsWith("--")) return undefined;
  const name = optionName(token);
  return READ_OPTION_NAMES.includes(name) ? name : undefined;
}

/**
 * The first read option written among `tokens`, or `undefined` where none is.
 *
 * For the doors that judge a section holding no declared names of its own, and
 * so have nothing to weigh a read option against: the first one found is the
 * one the refusal is about.
 */
export function firstReadOption(
  tokens: readonly string[],
): string | undefined {
  for (const token of tokens) {
    const name = readOptionName(token);
    if (name !== undefined) return name;
  }
  return undefined;
}

/**
 * A token as it must be retyped: quoted where a shell would otherwise take it
 * apart, bare where it would not.
 *
 * A corrected line a caller cannot paste is a corrected line that has to be
 * worked out again, and a verb's payload is JSON with spaces in it more often
 * than not.
 */
function quoteToken(token: string): string {
  if (token.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  return `'${token.replaceAll("'", `'\\''`)}'`;
}

/** A whole command line, ready to paste. */
export function commandLine(
  spelling: string,
  tokens: readonly string[],
): string {
  return `cf ${spelling} ${tokens.map(quoteToken).join(" ")}`.trimEnd();
}

/**
 * The two lines every refusal here ends with: what was written, and what to
 * write instead.
 *
 * The pair is the whole remediation, so it is rendered once. Two copies of a
 * two-line block drift in their padding before they drift in their words, and
 * a caller who meets both refusals reads one shape rather than two.
 */
export function writtenAndWrite(
  spelling: string,
  written: readonly string[],
  corrected: readonly string[],
): string {
  return `  written:  ${commandLine(spelling, written)}\n` +
    `  write:    ${commandLine(spelling, corrected)}`;
}

/**
 * The read options lifted out of the words written before the section opened,
 * paired with what is left once they are gone.
 *
 * `parsed` is what the command's own parser accepted, and it is what decides
 * which words this touches. Cliffy's `stopEarly` ends option parsing at the
 * section-opening positional, so a name it holds a value for was written
 * before the verb, and the same name written inside the section reached the
 * verb's parser instead — where it means whatever that verb says it means.
 * Reading the argv alone cannot tell the two apart, and would answer a
 * projection written in the callable's section with a sentence about a
 * position it was not in.
 *
 * The first occurrence of each name is the one lifted: `rawArgs` is in the
 * order it was typed, so a name appearing both before the verb and inside the
 * section has the parsed one first.
 */
function liftReadOptions(
  rawArgs: readonly string[],
  parsed: ReadSection,
): { rest: string[]; lifted: string[] } {
  const pending = new Set(
    READ_OPTION_NAMES.filter((name) =>
      parsed[name as keyof ReadSection] !== undefined
    ),
  );
  const rest: string[] = [];
  const lifted: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    const name = readOptionName(token);
    if (name === undefined || !pending.has(name)) {
      rest.push(token);
      continue;
    }
    pending.delete(name);
    lifted.push(token);
    // The spaced spelling carries its value in the next word; the `=`
    // spelling carries it inside the token and consumes nothing.
    if (!token.includes("=") && i + 1 < rawArgs.length) {
      lifted.push(rawArgs[++i]);
    }
  }
  return { rest, lifted };
}

/**
 * Refuse a projection written before the thing it shapes.
 *
 * `parsed` says WHICH read options the command accepted in that position, and
 * `rawArgs` is where the words themselves come from: the corrected line has to
 * be the caller's own, and a parsed value has lost which of the two spellings
 * they wrote it in.
 *
 * A line written this way is the old grammar in full, so the words past a `--`
 * it carries are the callable's own flags under that grammar. They move into
 * the section the verb now opens, and the marker is re-drawn after them — which
 * is why the corrected line can differ from the written one in two places at
 * once.
 */
export function refuseProjectionBeforeSection(
  spelling: string,
  opener: string,
  rawArgs: readonly string[],
  parsed: ReadSection,
): void {
  const { rest, lifted } = liftReadOptions(rawArgs, parsed);
  if (lifted.length === 0) return;

  const marker = rest.indexOf("--");
  const corrected = marker === -1
    ? [...rest, "--", ...lifted]
    : [...rest.slice(0, marker), ...rest.slice(marker + 1), "--", ...lifted];

  const names = lifted.filter((token) => readOptionName(token) !== undefined);
  throw new ValidationError(
    `${listFlags(names)} shape${names.length === 1 ? "s" : ""} the result, ` +
      `so ${
        names.length === 1 ? "it is" : "they are"
      } written after ${opener} ` +
      `rather than before it: a projection written here names positions in a ` +
      `result nothing has identified yet.\n\n` +
      `${writtenAndWrite(spelling, rawArgs, corrected)}\n\n` +
      `${opener[0].toUpperCase()}${
        opener.slice(1)
      } opens the callable's section and \`--\` closes it. The read options ` +
      `follow the marker.`,
  );
}

/**
 * Refuse a projection written inside the callable's section.
 *
 * Reached only for a name the verb does not declare as a field: a verb that
 * declares `select` owns the word inside its own section, and this door never
 * sees it. What is left is a caller who named a `cf` flag where the verb's
 * vocabulary is read — so the answer is which section the flag belongs to, and
 * the line that puts it there.
 *
 * `sectionArgs` is the callable's section as it was written, and `prefix` the
 * command through the verb, so the pair renders the same written/write block
 * the other doors print. The prefix elides the target the way a verb's own
 * help page elides it, because that is the part this door cannot see.
 *
 * `declared` is what keeps the corrected line honest when a verb declares one
 * of these names and not another: a line writing both moves only the one that
 * names no field, and leaves the field where its owner reads it.
 */
export function projectionInSectionRefusal(
  flagName: string,
  prefix: string,
  sectionArgs: readonly string[],
  declared: ReadonlySet<string>,
): string {
  const kept: string[] = [];
  const lifted: string[] = [];
  for (let i = 0; i < sectionArgs.length; i++) {
    const token = sectionArgs[i];
    const name = readOptionName(token);
    if (name === undefined || declared.has(name)) {
      kept.push(token);
      continue;
    }
    lifted.push(token);
    if (!token.includes("=") && i + 1 < sectionArgs.length) {
      lifted.push(sectionArgs[++i]);
    }
  }
  const render = (tokens: readonly string[]) =>
    [prefix, ...tokens.map(quoteToken)].join(" ").trimEnd();
  return `"--${flagName}" is a \`cf\` read option, not a field this verb ` +
    `declares. A projection shapes what the verb returned, so it is written ` +
    `past the \`--\` that closes this verb's section.\n\n` +
    `  written:  ${render(sectionArgs)}\n` +
    `  write:    ${render([...kept, "--", ...lifted])}`;
}

/**
 * The command the words past the marker are parsed against: the read options
 * and nothing else.
 *
 * Built from the declaration the commands already carry, so value typing and
 * the refusal of `--schema` beside `--select` are the same rules on both sides
 * of the marker rather than a second opinion about them. Its own `--help` is
 * turned off: `--help` past the marker reaches the callable, and a command
 * that answered it here would print this page instead of the verb's.
 */
export function readSectionCommand() {
  return new Command()
    .helpOption(false)
    .noExit()
    .throwErrors()
    .option("--filter <predicate:string>", "Filter an array with a predicate")
    .option("--select <fields:string>", "Project to comma-separated paths")
    .option("--schema <schema:string>", "Project with a JSON Schema", {
      conflicts: ["select"],
    });
}

/**
 * `--help` past the marker, which reaches the callable rather than the read
 * step.
 *
 * Written after the verb it falls inside the callable's section and prints
 * that verb's page. Written past the marker it would otherwise land among the
 * read options and print this command's page instead, with nothing to refuse
 * it — `--help` is the one flag that is never an unknown one. The shape has no
 * competing reading, since a caller wanting the command's own page writes it
 * with no verb at all, so it is given the meaning it already has.
 */
export function readSectionAsksVerbHelp(
  literalArgs: readonly string[],
): boolean {
  return literalArgs[0] === "--help" &&
    (literalArgs.length === 1 ||
      (literalArgs.length === 2 && literalArgs[1] === "--json"));
}

/**
 * The words that name a callable's verb at the head of its section.
 *
 * Writing one or leaving it out calls the same verb; what it changes is that
 * the section is not empty. One list rather than a literal at each door, so a
 * third keyword reaches every reader that has to recognize one.
 */
export const VERB_KEYWORDS: readonly string[] = ["invoke", "run"];

/**
 * The callable's section with a marker-routed `--help` placed where the
 * callable's own parser reads it.
 *
 * That is the head of the section, except where the section opens with a verb
 * keyword: the keyword is the first word the callable reads, and a `--help`
 * put ahead of it arrives as an argument to `--help` — which every verb
 * declaring no `help` field refuses.
 */
export function sectionWithVerbHelp(
  sectionArgs: readonly string[],
  literalArgs: readonly string[],
): string[] {
  const opensWithKeyword = VERB_KEYWORDS.includes(sectionArgs[0]) ? 1 : 0;
  return [
    ...sectionArgs.slice(0, opensWithKeyword),
    ...literalArgs,
    ...sectionArgs.slice(opensWithKeyword),
  ];
}

/**
 * Refuse a word past the marker that is not a read option.
 *
 * The corrected line answers the likelier of two readings, and the near miss
 * is what decides which. A name a read option is one typo from is a read
 * option the caller misspelled, so the marker stays and the name is fixed in
 * place. Anything else is a word the callable's section was meant to hold, so
 * the marker comes out and the words rejoin the section the verb opened —
 * which is the whole migration from the spelling this replaces, and why the
 * line is printed rather than described.
 *
 * The near miss is the repository's own, scaled to the name's length, rather
 * than the argument parser's: a verb field is not a misspelled read option,
 * and answering `--query` with "did you mean --filter" sends a caller to fix
 * a name that was never wrong.
 *
 * `index` is the token's position past the marker, and it is what the
 * rewritten line is keyed on: the same spelling may also stand in the
 * callable's section, where it is a field of the verb's and not this door's
 * to touch.
 */
function refuseWordPastMarker(
  spelling: string,
  rawArgs: readonly string[],
  token: string,
  index: number,
): never {
  const marker = rawArgs.indexOf("--");
  const written = marker + 1 + index;
  const equals = token.indexOf("=");
  const nearest = token.startsWith("--")
    ? nearestName(optionName(token), READ_OPTION_NAMES)
    : undefined;
  // The `=` spelling carries its value inside the token, so only the name is
  // replaced: a read option printed without the value the caller wrote is a
  // corrected line that fails for a second reason.
  const spelled = nearest === undefined
    ? undefined
    : `--${nearest}${equals === -1 ? "" : token.slice(equals)}`;
  const corrected = spelled === undefined
    ? [...rawArgs.slice(0, marker), ...rawArgs.slice(marker + 1)]
    : rawArgs.map((word, at) => at === written ? spelled : word);
  throw new ValidationError(
    `"${token}" is not a read option, and \`--\` opens the read step's ` +
      `section. ` +
      (nearest === undefined ? "" : `Did you mean "--${nearest}"? `) +
      `The marker takes ${
        READ_OPTION_NAMES.map((name) => `"--${name}"`).join(", ")
      } and nothing else; a verb's own flags are written before it, in the ` +
      `section the verb opened.\n\n` +
      `${writtenAndWrite(spelling, rawArgs, corrected)}`,
  );
}

/** Refuse a `--` written past the one that already closed the section. */
function refuseSecondMarker(
  spelling: string,
  rawArgs: readonly string[],
): never {
  const first = rawArgs.indexOf("--");
  const second = rawArgs.indexOf("--", first + 1);
  const corrected = [
    ...rawArgs.slice(0, second),
    ...rawArgs.slice(second + 1),
  ];
  throw new ValidationError(
    "One boundary follows the callable's section, and this line has already " +
      "drawn it. A second `--` closes nothing: the words after it are read " +
      "options either way.\n\n" +
      `${writtenAndWrite(spelling, rawArgs, corrected)}`,
  );
}

/**
 * The read options a line asked for, parsed from the words past the marker.
 *
 * Every word is checked against the read options before the parse, so a name
 * the read step does not take is answered as the section mistake it is rather
 * than as a misspelling of the nearest flag. What survives that check is
 * parsed against {@link readSectionCommand}, which is where a value's type,
 * a missing value, and `--schema` beside `--select` are decided.
 *
 * `--help` is the caller's business before this is reached; see
 * {@link readSectionAsksVerbHelp}.
 */
export async function parseReadSection(
  spelling: string,
  rawArgs: readonly string[],
  literalArgs: readonly string[],
): Promise<ReadSection> {
  if (literalArgs.length === 0) return {};
  for (let i = 0; i < literalArgs.length; i++) {
    const token = literalArgs[i];
    if (token === "--") refuseSecondMarker(spelling, rawArgs);
    const name = readOptionName(token);
    if (name === undefined) refuseWordPastMarker(spelling, rawArgs, token, i);
    // The value of a spaced read option is the caller's own word and is not
    // checked against anything here; the parse below is what judges it.
    if (!token.includes("=")) i++;
  }
  const { options } = await readSectionCommand().parse([...literalArgs]);
  return options as unknown as ReadSection;
}

/**
 * Refuse a line whose words past the marker are all fields the verb declares,
 * written with nothing in the callable's section.
 *
 * Nothing reserves a field name, so a verb may declare `select`, `filter` or
 * `schema`. Past the marker those words are read as a projection, and a line
 * that wrote no other field leaves the verb running with no input at all — it
 * succeeds, exits zero, and does something else. That is the one mistake here
 * that would otherwise pass quietly, which is why it is answered even though
 * the reading is not wrong so much as unknowable.
 *
 * Both readings are printed, because this door genuinely cannot tell them
 * apart: the caller has to say which they meant. A caller writing the grammar
 * as taught never reaches it — a field before the marker leaves the section
 * non-empty, and the section is what this is about.
 *
 * The verb's declared fields have to be in hand, so this settles after the
 * schema loads rather than during argument handling.
 */
export function refuseFieldsReadAsProjection(
  prefix: string,
  verbKeyword: string,
  literalArgs: readonly string[],
  declared: ReadonlySet<string>,
): void {
  const names = literalArgs
    .map(readOptionName)
    .filter((name): name is string => name !== undefined);
  if (names.length === 0) return;
  if (names.some((name) => !declared.has(name))) return;

  const written = literalArgs.map(quoteToken).join(" ");
  const one = names.length === 1;
  throw new ValidationError(
    `${listFlags(names.map((name) => `"--${name}"`))} ` +
      `${one ? "is a field" : "are fields"} this verb declares AND ` +
      `${one ? "a `cf` read option" : "`cf` read options"}, and this line ` +
      `leaves the callable's section empty. Past the \`--\` the read step ` +
      `takes ${one ? "it" : "them"}, so the verb would run with no input at ` +
      `all. Say which was meant:\n\n` +
      `  written:          ${prefix} -- ${written}\n` +
      `  as verb input:    ${prefix} ${written}\n` +
      `  as a projection:  ${prefix} ${verbKeyword} -- ${written}\n\n` +
      `The \`${verbKeyword}\` keyword is the callable's own word, so it ` +
      `leaves the section non-empty and the marker closing something.`,
  );
}
