/**
 * How the tokens after a verb divide into options and operands, and the
 * `--help` every verb takes.
 *
 * `line.ts` says where a token ends; this says what a token is for. A token
 * opening with `-` is an option up to a bare `--`, and every other token is an
 * operand — the rule a shell already has, and the rule `cf` reads its own
 * flags by, since the parse here is `parseFlags` (`@cliffy/flags`), which
 * `Command` calls to read the flags on a `cf` line. A verb's options are
 * therefore spelled, defaulted and refused exactly as the same flag is on a
 * `cf` command line, rather than in a second dialect that would have to be
 * kept in step with one.
 *
 * Two tokens the rule turns on are the two a shell already spends the
 * character on. `-` alone is an operand — `cd`'s previous place and the stdin
 * sentinel — and a bare `--` ends the options, so every token after it is an
 * operand whatever it opens with. Neither is this module's addition: the
 * parser reads both that way, and {@link readsAsOption} is the same rule
 * written as a predicate for the one caller that has to ask without parsing.
 *
 * `--help` is added to every table here rather than declared by each verb,
 * which is what makes it an option every verb takes rather than one each verb
 * remembered to offer.
 *
 * What the parse hands back is a record of names, since that is what a parser
 * reading a table at run time can hand back. {@link optionString} and the two
 * beside it are how a verb reads one: each collects the promise the
 * declaration made about a type, so a verb writes the option's name once and
 * casts nowhere.
 */

import { type FlagOptions, parseFlags, ValidationError } from "@cliffy/flags";

/**
 * The option every verb takes, declared as `cf` declares its own: the
 * `-h, --help` spelling, and standalone.
 *
 * It is held here rather than by a verb because it is every verb's:
 * {@link readOptions} puts it in front of whatever the verb declared, so a
 * verb has no way to be without it.
 *
 * Standalone is what makes the page reachable from a verb whose table the line
 * does not satisfy. A required option the line leaves out refuses the whole
 * parse, and somebody asking what a verb takes has by definition not supplied
 * it yet, so the one line that would answer them is the line the table would
 * otherwise turn down. What it costs is that `--help` written beside another
 * option is refused rather than answered — which is what the same line gets
 * from `cf`, whose help option is standalone for this reason.
 */
const HELP_OPTION: FlagOptions = {
  name: "help",
  aliases: ["h"],
  standalone: true,
};

/**
 * What one option a verb declares looks like: what `cf` declares, so the
 * parse is the same one, plus the two things a page needs and a parse does
 * not.
 *
 * `description` is what the verb's page writes beside the option, and it is
 * required rather than optional because an option nothing describes is one a
 * reader of the page learns the spelling of and nothing else.
 * `placeholder` names the value on that page — `--filter <predicate>` rather
 * than `--filter <string>` — and is absent for an option that takes none,
 * which is exactly the options `type` is absent for.
 */
export type VerbOption = FlagOptions & {
  /** What the option does, in the line the verb's page writes for it. */
  readonly description: string;

  /** What the option's value is called on that page. */
  readonly placeholder?: string;
};

/**
 * What the options a line set came back as: each declared option by name,
 * carrying whatever the parser read for it.
 *
 * It is the parser's own record rather than a shape per verb, because the
 * types in it are the declaration's promise and not this type's: an option
 * declared `type: "number"` arrives a number or does not arrive.
 * {@link optionString} and the two beside it are where that promise is
 * collected, so a verb reads a value at the type it declared and nothing
 * casts.
 */
export type VerbOptions = Readonly<Record<string, unknown>>;

/** What reading a verb's tokens produced. */
export type OptionReading =
  /** The line asked for the verb's help page and said nothing else. */
  | { readonly kind: "help" }
  /** The options the line set, by name, and the operands after them. */
  | {
    readonly kind: "read";
    readonly options: VerbOptions;
    readonly operands: readonly string[];
  }
  /** The line is refused, for the reason given. */
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Divides `tokens` into the options `declared` names and the operands after
 * them, for the verb called `verb`, or refuses them with the reason.
 *
 * `--help` is read whether or not `declared` names it, and whether or not the
 * line supplies what `declared` requires, and it takes the whole reading: what
 * comes back says the page was asked for and carries no operands to act on.
 * Anything else that parses comes back as the options by name and
 * the operands in the order they were written, with the bare `--` taken off
 * and every token after it an operand.
 *
 * A refusal is the parser's own sentence, which is the sentence the same flag
 * gets on a `cf` command line, plus one naming the verb's page. What the
 * parser refuses is what `cf` refuses: an option nothing declared, one written
 * as no option can be, a value missing from an option that takes one, and a
 * value given to one that does not.
 *
 * @throws Whatever the parser throws that is not a refusal of the line — a
 * table naming a type nothing registered, which is a fault in the verb rather
 * than in what was typed.
 */
export function readOptions(
  verb: string,
  tokens: readonly string[],
  declared: readonly VerbOption[] = [],
): OptionReading {
  let parsed;
  try {
    parsed = parseFlags([...tokens], { flags: [HELP_OPTION, ...declared] });
  } catch (thrown) {
    if (!(thrown instanceof ValidationError)) throw thrown;
    return {
      kind: "refused",
      reason: `${thrown.message} \`${verb} --help\` says what \`${verb}\` ` +
        `takes.`,
    };
  }
  if (parsed.flags.help === true) return { kind: "help" };
  return {
    kind: "read",
    options: parsed.flags,
    // The two arrays are the operands before the bare `--` and the ones after
    // it, and nothing after it can be written before one before it, so joining
    // them keeps the order the line was written in.
    operands: [...parsed.unknown, ...parsed.literal],
  };
}

/**
 * Whether {@link readOptions} reads `token` as an option rather than as an
 * operand: it opens with `-` and is longer than that one character.
 *
 * The predicate exists for a caller that has to know without parsing —
 * `operandForChild` (`place.ts`), which offers a name as the token `cd` takes
 * and may offer none this would eat. It answers about one token in isolation,
 * so it says nothing about a token standing after a bare `--`, which is an
 * operand whatever it opens with.
 */
export function readsAsOption(token: string): boolean {
  return token.startsWith("-") && token !== "-";
}

/**
 * What an option named `name` in `options` holds, where the verb declared it
 * `type: "string"`, and nothing where the line did not write it.
 *
 * @throws Error if it holds anything else, which is a fault in the verb's
 * table rather than in what was typed: the parser refuses a value of the
 * wrong type before it ever gets here, so the only way to reach this is to
 * declare one type and read another.
 */
export function optionString(
  options: VerbOptions,
  name: string,
): string | undefined {
  return declaredAs(options, name, "string") as string | undefined;
}

/**
 * What an option named `name` in `options` holds, where the verb declared it
 * with no value at all: whether the line wrote it.
 *
 * @throws Error under {@link optionString}'s condition, for the same reason.
 */
export function optionFlag(options: VerbOptions, name: string): boolean {
  return declaredAs(options, name, "boolean") === true;
}

/**
 * What an option named `name` in `options` holds, where the verb declared it
 * `type: "number"`, and nothing where the line did not write it.
 *
 * What comes back is a number and not a count: the parser takes a negative and
 * a fraction as readily as a whole one, so a verb wanting a count says so
 * itself and refuses the rest in its own words.
 *
 * @throws Error under {@link optionString}'s condition, for the same reason.
 */
export function optionNumber(
  options: VerbOptions,
  name: string,
): number | undefined {
  return declaredAs(options, name, "number") as number | undefined;
}

/**
 * Helper for the three readers above, which is what `name` holds in `options`
 * once it is `type` or absent.
 *
 * The three share one check because they make one claim, differing only in
 * which type the verb promised. Stating it once is what keeps a fourth reader
 * from being a fourth place the promise could be worded differently.
 *
 * @throws Error if the value is neither, naming the option and both types, so
 * that a table and a reading that disagree say which two they are.
 */
function declaredAs(
  options: VerbOptions,
  name: string,
  type: "string" | "boolean" | "number",
): unknown {
  const held = options[name];
  if (held === undefined || typeof held === type) return held;
  throw new Error(
    `The option \`--${name}\` is declared to hold a ${type} and holds a ` +
      `${typeof held}.`,
  );
}
