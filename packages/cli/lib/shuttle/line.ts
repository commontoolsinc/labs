/**
 * How a shuttle line splits into tokens, and how a value prints as one of
 * them.
 *
 * `cf` never does either: it is handed `Deno.args`, split for it already by
 * the operating system's shell. Shuttle reads its own line, so the split is
 * shuttle's, and so is the printing that inverts it.
 *
 * The two halves live in one module because they are one decision: what
 * {@link quoteToken} writes, {@link splitLine} reads back as the one value it
 * was given. That is what lets a value print bare where nothing in it needs
 * more, which is the common case and the point.
 *
 * What a token then means is decided elsewhere — `place.ts` reads an operand
 * as a reference or as one of the navigation spellings, and a verb reads its
 * own. This module bounds where a token ends and says nothing past that.
 *
 * `packages/cli` splits a line too, in `tokenizeLine` under `lib/completion/`,
 * and this is not a second copy of it. That one reconstructs what bash would
 * have done to a *partial* line: it reads up to a cursor offset and always
 * pushes a last word for the cursor to sit in, so its list is never empty
 * where this one's is; it separates on the space and the tab alone; and it
 * refuses nothing, a half-typed line being its normal input. It is also not an
 * export entry of that package, so nothing here could call it.
 */

/**
 * The characters shuttle's line grammar spends on structure rather than on
 * data: the pipe, the local-program escape, the two redirection operators,
 * the `#` a wish target and an argument suffix are written with, and the `%`
 * a numbered handle is (`docs/plans/shuttle/grammar.md`).
 *
 * A value holding one of these is printed quoted wherever in the value it
 * sits. {@link quoteToken} is handed a value and no position, so it quotes on
 * the character rather than on the reading — which quotes values whose
 * position would have left the character ordinary, and is the price of a
 * printer that needs to know nothing about where its output lands.
 *
 * The characters an operand writes an address with are not here, the `:` of a
 * scheme and of a handle among them. Those are read inside a token by the
 * reference grammar rather than by the split, and a quote reaches no reading
 * (`docs/plans/shuttle/grammar.md`), so quoting them would change nothing a
 * reading does and would cost the bare printing of every address. A value
 * whose own characters a reading would take is named by a reference instead,
 * which reads none of them.
 */
export const RESERVED_CHARACTERS = "!#%<>|";

/**
 * The characters {@link splitLine} reads as syntax rather than as data: the
 * two quotes it groups with, and the backslash it escapes with. A value
 * holding one is printed quoted too, and this is the half of that rule the
 * split itself forces.
 */
const SYNTAX_CHARACTERS = "\"'\\";

/**
 * What a backslash escapes between double quotes: a double quote, and another
 * backslash. Every other character there is literal, so a path or a JSON
 * escape written between double quotes arrives as it was typed.
 */
const DOUBLE_QUOTE_ESCAPES = '"\\';

/**
 * What separates two tokens. The definition is JavaScript's own — what
 * `String.prototype.trim` removes — so a token this module split and an
 * operand a caller trimmed agree about where a value's edges are.
 */
const SEPARATOR = /\s/;

/** What splitting a line produced. */
export type LineSplit =
  /** The line split, and `tokens` are its tokens in the order written. */
  | { readonly kind: "split"; readonly tokens: readonly string[] }
  /** The line is refused, for the reason given. */
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Splits `line` into the tokens it is written as, or refuses it with the
 * reason.
 *
 * Whitespace separates tokens, and a run of it separates no more than one.
 * Single quotes are literal, so what sits between them is the token's own
 * whatever it is. Double quotes group, and between them a backslash escapes
 * one of {@link DOUBLE_QUOTE_ESCAPES} and is otherwise a character of the
 * token; outside quotes it escapes whatever follows it. Runs that touch are
 * one token, so `a"b c"d` is the single token `ab cd`, and an empty pair of
 * quotes is a token that is the empty string.
 *
 * A line is refused for one of two reasons, both of them a token with no end:
 * a quote that never closes, and a trailing backslash with nothing to escape.
 * Nothing else refuses a line here, so a line that splits says only that; it
 * says nothing about whether its tokens name anything.
 *
 * `line` is one line, and a terminator on it is whoever read it to strip. The
 * separator class holds the line terminators, so text carrying one splits
 * across the break into a single run of tokens rather than into two commands.
 * That is a choice and not a necessity: every value {@link quoteToken} writes
 * that holds a line break lands inside quotes, so a rule refusing an unquoted
 * one would leave the round trip whole. What the round trip settles is that
 * the choice is safe, not that it was forced.
 */
export function splitLine(line: string): LineSplit {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: string | undefined;
  let openedAt = 0;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else if (
        character === "\\" && quote === '"' && index + 1 < line.length &&
        DOUBLE_QUOTE_ESCAPES.includes(line[index + 1])
      ) {
        current += line[++index];
      } else {
        // A backslash escaping nothing lands here and is a character of the
        // token like any other. Where it is the line's last character, the
        // line then ends with the quote still open, so what the caller reads
        // is the unterminated-quote refusal below rather than a second reason
        // for one fault.
        current += character;
      }
      continue;
    }
    if (SEPARATOR.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    // Set before the branches rather than in each of them, so that an empty
    // pair of quotes opens a token the way a character does.
    started = true;
    if (character === "'" || character === '"') {
      quote = character;
      openedAt = index;
      continue;
    }
    if (character === "\\") {
      if (index + 1 === line.length) {
        return refuse("The line ends in a `\\`, which has nothing to escape.");
      }
      current += line[++index];
      continue;
    }
    current += character;
  }

  if (quote !== undefined) {
    return refuse(
      `The \`${quote}\` opened at column ${columnOf(line, openedAt)} is ` +
        `never closed.`,
    );
  }
  if (started) tokens.push(current);
  return { kind: "split", tokens };
}

/**
 * Returns `value` written as one token of a line: bare where it holds
 * nothing that ends a token and nothing the grammar reserves, and quoted
 * where it holds one of those. {@link splitLine} reads what this returns back
 * as exactly `value`, whatever `value` holds.
 *
 * That round trip is the whole of the guarantee. What an operand reading then
 * does with the token is decided where the operand is read, and nothing here
 * tells a reading that a quote delivered its token.
 *
 * Single quotes are the first choice, since nothing between them needs an
 * escape. A value holding one is written in double quotes instead, with its
 * own quotes and backslashes escaped.
 */
export function quoteToken(value: string): string {
  if (!needsQuoting(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replaceAll(/["\\]/g, "\\$&")}"`;
}

/**
 * Helper for {@link splitLine}, which is the 1-based column of the character
 * at `index`, counted in code points. The number is there for a person to find
 * that character with, and a code point is the unit this can count: it is
 * neither the code unit the string is stored in, nor the grapheme cluster a
 * reader sees as one character.
 */
function columnOf(line: string, index: number): number {
  return [...line.slice(0, index)].length + 1;
}

/** Helper for {@link splitLine}, which builds a refusal carrying `reason`. */
function refuse(reason: string): LineSplit {
  return { kind: "refused", reason };
}

/**
 * Helper for {@link quoteToken}, which is whether `value` needs quoting to
 * come back as itself: it is empty, or it holds a separator, a syntax
 * character, or one of {@link RESERVED_CHARACTERS}.
 *
 * The empty value is in that list for a reason the others are not: a token
 * written bare cannot be empty, so quoting is what makes it a token at all.
 */
function needsQuoting(value: string): boolean {
  if (value === "") return true;
  for (const character of value) {
    if (
      SEPARATOR.test(character) || SYNTAX_CHARACTERS.includes(character) ||
      RESERVED_CHARACTERS.includes(character)
    ) {
      return true;
    }
  }
  return false;
}
