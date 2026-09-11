/**
 * What a `%n` operand names: the row a listing numbered, and the place that
 * listing was read at.
 *
 * A listing mints the numbering (`listing.ts`) and a session holds it
 * (`session.ts`); this is the other half, which reads one back. The pair a
 * lookup answers with is what makes a handle a bound reference rather than a
 * row number (decision 27): the row's own operand reaches it from the place
 * the listing was read at, so the pair names a cell from anywhere and goes on
 * naming it after the place has moved.
 *
 * Reading one back is half of what this does. The other half is writing one
 * out: a line is recorded with each of its handles replaced by the row it
 * named ({@link recordedForm}), so a line recalled after a later listing acts
 * on what it acted on the first time.
 *
 * Nothing here reads the fabric and nothing walks. What a row's operand
 * reaches is `place.ts`'s to say, and it says it through the arm a `%n`
 * operand comes back as; what a callable row's name resolves to is the
 * fabric's. This decides only which row was named, why a token named none,
 * and how a row that was named is written back onto a line.
 */

import { quoteToken, tokensOfLine } from "./line.ts";
import type { ListingHandles, ListingRow } from "./listing.ts";
import { handleFor } from "./listing.ts";
import { readsAsOption } from "./options.ts";
import {
  HANDLE_SIGIL,
  handleMove,
  type Place,
  referenceForPlace,
} from "./place.ts";

/** What reading a `%n` operand against a listing produced. */
export type HandleReading =
  | {
    /** Names this arm of {@link HandleReading}. */
    readonly kind: "row";

    /** Where the listing was read, which the row stands inside. */
    readonly at: Place;

    /** The row the number named. */
    readonly row: ListingRow;
  }
  /** The token named no row, for the reason given. */
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Helper for {@link numberOf}, which is whether `token` is written as a
 * handle: the sigil at its head, whatever follows.
 *
 * Deliberately the sigil alone rather than the whole spelling, so that a token
 * opening with it and naming no row gets the reason {@link resolveHandle}
 * gives it, which names the spelling; read as anything else it would get a
 * reason about a key or a piece nobody wrote.
 *
 * Which operands are read as a handle at all is not decided here. That is the
 * operand grammar's (`movePlace`, `place.ts`), which reads the sigil at the
 * head of an operand and nowhere else, so a key named with it stays reachable
 * by a walk. This is asked only of a token that grammar already picked out.
 */
function isHandle(token: string): boolean {
  return token.startsWith(HANDLE_SIGIL);
}

/**
 * What `token` names in `handles`, or the reason it names nothing.
 *
 * `token` is the operand as it was written, the sigil included, because the
 * reason a handle names nothing quotes it back and a reason quoting something
 * else is a reason about another line.
 *
 * The row comes back whatever it is. Whether a row is somewhere to stand, and
 * whether it is something to call, are questions its kind and its operand
 * answer, and they are answered by the verb that asked — a row a `cd` has
 * nothing to walk to is one a `call` may still invoke.
 */
export function resolveHandle(
  handles: ListingHandles | undefined,
  token: string,
): HandleReading {
  const number = numberOf(token);
  if (number === undefined) {
    return refuse(
      `\`${token}\` names no handle. A handle is \`${HANDLE_SIGIL}\` and the ` +
        `number a listing printed beside a row, as in \`${handleFor(3)}\`.`,
    );
  }
  if (handles === undefined) {
    return refuse(
      `\`${token}\` names no row: no listing has numbered one yet. \`ls\` ` +
        `lists what stands here and numbers what it lists.`,
    );
  }
  const row = handles.rows[number - 1];
  if (row === undefined) {
    return refuse(
      handles.rows.length === 0
        ? `\`${token}\` names no row: the listing numbered none.`
        : `\`${token}\` names no row: the listing numbered \`${
          handleFor(1)
        }\` to \`${handleFor(handles.rows.length)}\`.`,
    );
  }
  return { kind: "row", at: handles.place, row };
}

/**
 * Helper for {@link resolveHandle}, which is the number `token` names, and
 * nothing where it names none.
 *
 * The digits are the whole of what follows the sigil: `%3x` and `%+3` and
 * `%3.0` each name no row, and the leading-zero spellings are turned down for
 * the same reason — a listing prints `%3` and nothing else, so `%03` is a
 * spelling of a number rather than a handle a listing offered.
 */
function numberOf(token: string): number | undefined {
  if (!isHandle(token)) return undefined;
  const digits = token.slice(HANDLE_SIGIL.length);
  return /^[1-9][0-9]*$/.test(digits) ? Number(digits) : undefined;
}

/** Helper for {@link resolveHandle}, which builds a refusal carrying `reason`. */
function refuse(reason: string): HandleReading {
  return { kind: "refused", reason };
}

/**
 * `line` as the run records it: what was typed, except that a handle naming a
 * row is written out as that row.
 *
 * A handle is a reference only until the next listing (decision 17) and a
 * recalled line outlives listings, so a line recorded as typed would, replayed
 * after a listing had renumbered, act on whichever row its number names then
 * and report that as what the line did. A wrong write reported as a success is
 * what writing the row out at the moment the line is taken prevents: a line
 * recalled acts on what it acted on the first time.
 *
 * What the person sees is untouched: the line on the screen and the transcript
 * above it are what was typed, and this is what `up` puts back.
 *
 * A row is written out as a spelling that reaches it from anywhere the session
 * stands. A row a facet listed stands as the id or the slug the listing
 * printed, each of which names the piece from wherever the line comes back; a
 * row a piece listed stands as the reference naming that piece and the path to
 * the row, since a key is a name inside one piece and two pieces hold a `title`
 * apiece. What the reference costs is length — a recalled line naming a cell
 * inside a piece runs some sixty characters longer than the handle did, and is
 * harder to edit for it.
 *
 * A callable row is written out otherwise, its handle carrying a receiver and
 * a verb name rather than a path (decision 27): what goes in its place is the
 * two tokens `call` reads those from ({@link callSpelling}).
 *
 * Everything else is left exactly as typed, because nothing came of writing it
 * out. A handle that named no row is one, and a row that is no callable and
 * that the listing offered no operand for is another. A third is a token whose
 * walk a reference has no spelling for ({@link referenceWalk}). The last is
 * every token the operand grammar does not read: the verb, and everything from
 * the first token that reads as an option, since from there what a token is
 * for is a verb's own table to say, and a `%2` standing in an option's value
 * or inside a callable's own section is a character of that value rather than
 * a handle. A line carrying no handle at all therefore comes back as the
 * string it was given, and so does a line the split refuses, which has no
 * tokens to write out.
 */
export function recordedForm(
  line: string,
  handles: ListingHandles | undefined,
): string {
  const tokens = tokensOfLine(line);
  if (tokens === undefined) return line;
  let written = "";
  let from = 0;
  // The first token names the verb, which is no operand, so the walk starts
  // after it. What is kept between one replacement and the next is the line
  // itself rather than the tokens either side, so every character this does
  // not replace is the character that was typed.
  for (const token of tokens.slice(1)) {
    if (readsAsOption(token.value)) break;
    const spelling = spellingFor(handles, token.value);
    if (spelling === undefined) continue;
    written += line.slice(from, token.start) + spelling;
    from = token.end;
  }
  return written + line.slice(from);
}

/**
 * Helper for {@link recordedForm}, which is `token` written out as what it
 * bound to, and nothing where it bound to nothing.
 *
 * The token is divided by the operand grammar's own reading (`handleMove`,
 * `place.ts`), so the handle this looks up is the one a verb would have looked
 * up and the walk written after it is the walk a verb would have taken.
 *
 * Where the listing stood decides which spelling names its rows from anywhere.
 * A listing read inside a piece names its rows by a key, and a key is a name
 * inside that piece — two pieces hold a `title` apiece — so the row is written
 * as the reference that reaches it, the piece and the path to the row, and the
 * walk written after the handle as further segments of the same reference.
 * A listing read at a facet or at the space root names its rows by a piece's
 * id, by a slug, or by a facet, each of which reaches the row from wherever
 * the line is recalled, so those are written as the operand the listing
 * minted.
 *
 * The row's own name goes into the reference rather than its operand, which
 * differs where the name is one no bare operand reaches: the operand is then
 * the rendering the row already prints as, and a rendering nested inside a
 * second reference names nothing. The operand is still what says a spelling
 * reaches the row at all, so a row the listing offered none for is left alone
 * either way.
 *
 * What comes back is one token, printed as one, so a row whose spelling holds
 * a separator or a character the grammar reserves is quoted the way a listing
 * prints it.
 */
function spellingFor(
  handles: ListingHandles | undefined,
  token: string,
): string | undefined {
  const move = handleMove(token);
  if (move === undefined) return undefined;
  const bound = resolveHandle(handles, move.handle);
  if (bound.kind === "refused") return undefined;
  const at = bound.at;
  if (move.rest === "" && bound.row.kind === "callable") {
    return callSpelling(at, bound.row.name);
  }
  const operand = bound.row.operand;
  if (operand === undefined) return undefined;
  const position = at.position;
  if (position.kind === "piece") {
    const walk = referenceWalk(move.rest);
    return walk === undefined ? undefined : quoteToken(referenceForPlace({
      position: {
        ...position,
        path: [...position.path, bound.row.name, ...walk],
      },
      scope: at.scope,
    }));
  }
  return quoteToken(
    move.rest === "" ? operand : `${operand}/${move.rest}`,
  );
}

/**
 * Helper for {@link spellingFor}, which is the walk written after a handle as
 * the segments a reference carries it in, and nothing where a reference cannot
 * carry it at all.
 *
 * A `..` is what it cannot carry. In a walk it backs out of the level the
 * segment before it reached, and in a reference it is the name of a key, so
 * the two read one token as two cells. Such a token is left as the handle it
 * was typed as — which names what it named before — rather than written with
 * the key's own name, that being the spelling the reference is here to avoid.
 *
 * The trailing separator is dropped as the walk itself drops it
 * (`moveBySegments`, `place.ts`): `%1/` and `%1` name one row, and a segment
 * with no name in it would make them two.
 */
function referenceWalk(rest: string): readonly string[] | undefined {
  if (rest === "") return [];
  const segments = rest.split("/");
  if (segments.at(-1) === "") segments.pop();
  return segments.includes("..") ? undefined : segments;
}

/**
 * Helper for {@link spellingFor}, which is the receiver and the verb name a
 * callable row's handle carries, written as the two tokens `call` takes in its
 * place, and nothing where the listing stood at no piece.
 *
 * Two tokens, and no one token would do: a verb name is interface vocabulary
 * rather than a data path (decision 27), so no operand names one and the
 * receiver has to be written beside it. What comes back is the typed spelling
 * of the same call — `call %4` records as `call <receiver> <name>` — and the
 * receiver is the reference that names the piece from anywhere, which is the
 * address the call itself hands the seam.
 *
 * A listing that numbered a callable was read inside a piece: `verbs` lists
 * one receiver's callables, and `ls` marks one only among a piece's keys. So
 * nothing comes back for a place that is no piece, rather than a spelling
 * invented for a row that cannot stand there.
 */
function callSpelling(at: Place, name: string): string | undefined {
  const position = at.position;
  if (position.kind !== "piece") return undefined;
  return `${quoteToken(referenceForPlace({ position, scope: at.scope }))} ${
    quoteToken(name)
  }`;
}
