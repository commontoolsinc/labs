/**
 * The session objects that stand beside the place: what the last listing
 * numbered, what a rendering had left over for `more`, and which pieces this
 * run has started.
 *
 * All three are things a run accumulates rather than things a place holds. A
 * place is where shuttle stands and moves under `cd`; these are what the lines
 * before this one left behind, and a `cd` neither resets nor carries any of
 * them. Keeping them beside the place rather than inside it is what decision
 * 17 means by a handle table as a session object, and what keeps `%3` naming
 * the row it was minted for after the place has moved on.
 *
 * They are three fields and not one, because they are reset by different
 * lines. A listing resets the numbering — `%1` is the first row of the newest
 * listing, and a run's handles stay valid until one arrives — while every
 * rendering that did not fit replaces what `more` continues. So a `get` past
 * an `ls` leaves the handles alone and takes over the continuation, which is
 * exactly what decision 24 says: `more` continues the listing, and a new
 * listing is what resets the numbering. The warm set is reset by nothing: a
 * piece started stays started for the life of the process.
 *
 * Nothing here reads or writes anything outside itself, so a case drives the
 * whole of it with no connection, no place and no terminal.
 */

import type { CellScope } from "@commonfabric/api";

import type { ListingHandles } from "./listing.ts";

/** What a rendering left for `more` to write. */
export interface Continuation {
  /** The lines not yet shown, in the order they were composed. */
  readonly lines: readonly string[];

  /**
   * What else would narrow the rendering, where the verb that composed it has
   * something to offer past `more`, and nothing where it has not.
   */
  readonly hint?: string;
}

/** The session objects one run accumulates. */
export class ShuttleSession {
  #handles: ListingHandles | undefined;
  #continuation: Continuation | undefined;
  #warm = new Set<string>();

  /**
   * What the last listing numbered, and nothing where no listing has run.
   *
   * The rows come back in the order they were numbered, so `%n` is the
   * `n`th of them, and the place they came back with is what they stand
   * inside.
   */
  get handles(): ListingHandles | undefined {
    return this.#handles;
  }

  /** What `more` writes next, and nothing where a rendering left nothing. */
  get continuation(): Continuation | undefined {
    return this.#continuation;
  }

  /**
   * Records `handles` as what `%n` names, replacing whatever the listing
   * before it numbered.
   *
   * Replacing rather than adding is decision 17: a new listing resets the
   * numbering, so a handle read off the screen names a row of the listing
   * still on it.
   */
  listed(handles: ListingHandles): void {
    this.#handles = handles;
  }

  /**
   * Records `continuation` as what `more` writes next, or that nothing is
   * waiting where none is given.
   *
   * Every rendering calls it, including one that fit whole, because what
   * `more` must never do is continue the line before last: a rendering that
   * fit has nothing left, and saying so is what clears the one before it.
   */
  holding(continuation?: Continuation): void {
    this.#continuation = continuation;
  }

  /**
   * Whether this run has already started the piece `piece`, read at `scope`.
   *
   * `piece` is the piece a resolution reached rather than the one an operand
   * spelled, which is what makes this the question it looks like: two lines
   * writing two fields of one piece ask about one piece, and two lines
   * reaching two members of one collection ask about two.
   */
  hasWarmed(piece: string, scope: CellScope): boolean {
    return this.#warm.has(warmKey(piece, scope));
  }

  /** Records that it has. */
  warmed(piece: string, scope: CellScope): void {
    this.#warm.add(warmKey(piece, scope));
  }
}

/**
 * Helper for the warm set, which is what a start is remembered under: the
 * piece that runs, and the scope it runs under.
 *
 * Those two are the whole of the decision and neither is a proxy for it. What
 * warms is a piece, so the piece is the key; and the same id under two scopes
 * is two documents, so the scope is beside it. The path an operand walked is
 * not here, and its absence is the point: a path decides *which* piece only by
 * being resolved, and by the time a warm is recorded the resolution has
 * already answered that (`warmPiece`, `lib/piece.ts`). Keying on the path
 * instead would make `set title` and `set body` two warms of one piece, and a
 * key that says two where the decision says one is a key about something else.
 *
 * A slug and the handle it resolves to key alike for the same reason: both
 * arrive here as what the resolution reached.
 */
function warmKey(piece: string, scope: CellScope): string {
  return `${scope} ${piece}`;
}
