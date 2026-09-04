/**
 * What `ls` finds where shuttle stands, and how each row is written back.
 *
 * A listing prints names a person then types, so a row carries the operand
 * `cd` takes to reach it and not only the name it goes by. The two are the
 * same string for nearly every row and differ wherever a name's own characters
 * are readings — a key called `..`, one holding the separator — which is a
 * question about the place rather than about the listing, so
 * `operandForChild` answers it and this module asks.
 *
 * The reads are `packages/cli`'s, over the connection this process holds: a
 * space root has nothing to read, the two facets are `listSpaceSlugs` and
 * `listPieces`, and the keys inside a piece are `listCellKeys`. Each takes the
 * connection through `deps.loadPieces`, which is the seam a held connection
 * fills.
 */

import { listCellKeys } from "../cell-listing.ts";
import {
  listPieces,
  listSpaceSlugs,
  type PieceConfig,
  type SpaceConfig,
} from "../piece.ts";
import type { HeldConnection } from "./connection.ts";
import { quoteToken } from "./line.ts";
import {
  escapeControlCharacters,
  type Facet,
  FACETS,
  holdsControlCharacter,
  operandForChild,
  type PiecePosition,
  type Place,
} from "./place.ts";

/**
 * What a listing of `slugs/` is a listing of. `listSlugs`
 * (`@commonfabric/piece`) is where that bound is stated and where the reason
 * for it lives; what this carries is the part a reader of the listing needs,
 * which is that the rows are not every name the space answers to.
 */
const SLUG_INDEX_BOUND = "the space's slug index names these, and a slug it " +
  "never recorded still resolves";

/** One thing a listing found standing where it was read. */
export interface ListingRow {
  /** What the row is called where it stands. */
  readonly name: string;

  /**
   * The operand `cd` takes to reach it, written as a token, and absent where
   * `operandForChild` offers none. Absent is the narrower claim it makes:
   * that neither the name nor the reference names the row, not that nothing
   * reaches it.
   */
  readonly operand?: string;

  /** What the read said is wrong with what the name points at. */
  readonly error?: string;
}

/** What `ls` found at a place. */
export interface Listing {
  /** The rows, in the order the read listed them. */
  readonly rows: readonly ListingRow[];

  /**
   * What the rows are, where they are not everything standing there. A
   * listing that said nothing would be read as complete.
   */
  readonly bound?: string;
}

/**
 * The reads a listing is made of, each `packages/cli`'s own. A caller supplies
 * its own to drive this module with nothing behind it.
 */
export interface ListingDeps {
  /** Lists the slugs the space's index records. */
  readonly listSpaceSlugs?: typeof listSpaceSlugs;

  /** Lists the space's pieces. */
  readonly listPieces?: typeof listPieces;

  /** Lists the keys directly under a piece's cell path. */
  readonly listCellKeys?: typeof listCellKeys;
}

/**
 * What `ls` finds at `place`, read over `connection` with `config` saying what
 * to connect as.
 *
 * A row the read reported a failure against is still a row: a name the space
 * has and nothing resolves is a name the space has, so it comes back carrying
 * what went wrong rather than being dropped, and it never takes the listing
 * down with it. A read that failed outright is no listing, and raises.
 *
 * @throws Whatever the read throws — an unreachable server, an identity that
 * will not load, a path the piece refuses.
 */
export async function listPlace(
  config: SpaceConfig,
  place: Place,
  connection: HeldConnection,
  deps: ListingDeps = {},
): Promise<Listing> {
  const position = place.position;
  switch (position.kind) {
    case "root":
      return { rows: FACETS.map((facet) => rowFor(place, facet)) };
    case "facet":
      return await listFacet(config, place, position.facet, connection, deps);
    case "piece":
      return await listKeys(config, place, position, connection, deps);
  }
}

/**
 * What `ls` prints for `listing`: one line per row, and one more for a bound.
 *
 * A name is the first thing on its line and is written as a token, so what a
 * reader copies off the front of a line is what `cd` takes. A line that opens
 * with `<` carries no name — and `quoteToken` is what holds that, not anything
 * here: `<` is one of the characters the grammar reserves, so a name holding
 * one is printed quoted and a printed name never opens with it.
 *
 * Everything else on a line — the row with no operand, a row's error, and the
 * bound — is written between angle brackets. Those brackets delimit for a
 * reader and not for a parser: a payload may hold an angle bracket of its own
 * and nothing escapes it. Nothing parses a listed line, and a form that could
 * be parsed is a second output form rather than a rule for this one
 * (`docs/plans/shuttle/futures.md`).
 *
 * A row is one line, and lines are separated by a newline, so nothing written
 * on a line may put one inside it: a message and a bound each have their
 * newlines written as spaces, and a name carrying one is described rather than
 * written. What a message does with the rest of the class a terminal acts on,
 * and why a name cannot do the same, is with {@link oneLine}. Rewriting one
 * inside a name would leave a token `cd` no longer takes back to the row,
 * which is the guarantee the name is printed for, so what a terminal makes of
 * it is not something this can spend that on.
 */
export function renderListing(listing: Listing): string {
  const lines = listing.rows.map(lineFor);
  if (listing.bound !== undefined) lines.push(marker(oneLine(listing.bound)));
  return lines.join("\n");
}

/**
 * Helper for {@link listPlace}, which is what `facet` lists at `place`.
 *
 * The two facets read different things and are written out one arm each rather
 * than chosen from a table, so that a facet added to {@link FACETS} fails to
 * compile here instead of silently taking the other one's read.
 */
async function listFacet(
  config: SpaceConfig,
  place: Place,
  facet: Facet,
  connection: HeldConnection,
  deps: ListingDeps,
): Promise<Listing> {
  const loadPieces = () => connection.pieces();
  switch (facet) {
    case "slugs": {
      const slugs = await (deps.listSpaceSlugs ?? listSpaceSlugs)(config, {
        loadPieces,
      });
      return {
        rows: slugs.map((row) => rowFor(place, row.slug, row.error)),
        bound: SLUG_INDEX_BOUND,
      };
    }
    case "pieces": {
      const pieces = await (deps.listPieces ?? listPieces)(config, {
        loadPieces,
      });
      return { rows: pieces.map((row) => rowFor(place, row.id, row.error)) };
    }
  }
}

/**
 * Helper for {@link listPlace}, which is what the cell `position` names lists
 * at `place`.
 *
 * The piece, the path and the scope all ride the config. A place stands on the
 * piece as an operand named it, a slug included, so what makes a slug typed
 * back off a listing reach its piece is the read's own resolution step
 * (`PieceResolutionDeps.resolvePieceAddress`). An empty listing means the path
 * names a leaf, and nothing here can tell that from an empty container, so
 * nothing here says which it was.
 */
async function listKeys(
  config: SpaceConfig,
  place: Place,
  position: PiecePosition,
  connection: HeldConnection,
  deps: ListingDeps,
): Promise<Listing> {
  const pieceConfig: PieceConfig = {
    ...config,
    piece: position.piece,
    pieceScope: place.scope,
    piecePath: [...position.path],
  };
  const keys = await (deps.listCellKeys ?? listCellKeys)(pieceConfig, "", {}, {
    loadPieces: () => connection.pieces(),
  });
  return { rows: keys.map((key) => rowFor(place, key)) };
}

/**
 * Helper for {@link listPlace}, which is the row `name` stands as at `place`,
 * carrying `error` where the read reported one against it.
 */
function rowFor(place: Place, name: string, error?: string): ListingRow {
  const operand = operandForChild(place, name);
  return {
    name,
    ...(operand === undefined ? {} : { operand: quoteToken(operand) }),
    ...(error === undefined ? {} : { error }),
  };
}

/** Helper for {@link renderListing}, which is the line `row` prints as. */
function lineFor(row: ListingRow): string {
  const head = row.operand ?? marker(noOperandFor(row.name));
  return row.error === undefined
    ? head
    : `${head} ${marker(`error: ${oneLine(row.error)}`)}`;
}

/**
 * Helper for {@link renderListing}, which says that a row called `name` has no
 * operand, showing the name where a line has room for it.
 *
 * It says no operand rather than that nothing reaches the row, which is the
 * wider claim and a false one: a key whose first character is `#` is reached
 * by a multi-segment operand, `#` being data in a segment that names a data
 * key.
 * What holds of every row this is written for is that neither the name nor the
 * reference names it, and a name is what a listing prints.
 *
 * Two names are described rather than written, and for the same reason the
 * doors refuse them: one holding a line break would make a second row out of
 * one, and one holding a control character would reach a terminal as an
 * instruction. Writing either would put back, in the marker, exactly what
 * refusing the name kept off the screen. The name is shown
 * as it is written and not as something to type — it sits inside a marker,
 * which by the rule above carries no name.
 *
 * A name holding a newline is described rather than shown, because a row is
 * one line. That row is also one nothing reaches at all, a segment holding a
 * break being refused at every door, so what the description withholds is a
 * string no operand would have carried anyway.
 */
function noOperandFor(name: string): string {
  return name.includes("\n")
    ? "no operand: a name holding a line break"
    : holdsControlCharacter(name)
    ? "no operand: a name holding a control character"
    : `no operand: ${quoteToken(name)}`;
}

/** Helper for {@link renderListing}, which writes `text` as a marker. */
function marker(text: string): string {
  return `<${text}>`;
}

/**
 * Helper for {@link renderListing}, which is `text` fit to be written on a
 * line and acted on by nothing: each newline as a space, so that what is
 * written on a line takes one line, and each remaining character a terminal
 * acts on as the glyph that names it.
 *
 * The payloads that are a caller's own text go through it, the bound as much
 * as an error — the two agreeing is what keeps "a row is one line" a rule
 * rather than a habit of one of them. The marker for a row with no operand
 * builds its own text and answers a break, or a character a terminal acts on,
 * by describing the name instead of showing it.
 *
 * The two rewrites are two decisions. A newline becomes a space so that a
 * message stays one row; the rest become glyphs so that a message a person
 * reads cannot instruct the terminal it is read on. Escaping is what a message
 * gets and a name does not, because a message is read where a name is typed
 * back.
 *
 * Nothing else is touched, an angle bracket included: those delimit a marker
 * for a reader rather than for a parser, and a payload holding one is that
 * decision rather than this one.
 */
function oneLine(text: string): string {
  return escapeControlCharacters(text.replaceAll("\n", " "));
}
