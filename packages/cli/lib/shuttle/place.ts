/**
 * A place is where shuttle stands: the position it reads from and the scope it
 * reads through. Both halves stick across navigation and both render, so they
 * travel as one pair and `cd` is the single door to either.
 *
 * Everything here is a value and a decision about a value — no connection, and
 * nothing read. The address grammar belongs to the fabric
 * (`normalizeLLMFriendlyRef` over the runner's `parseReferenceParts`) and this
 * module consumes it; what it adds is the navigation spellings that grammar
 * has no room for — `..`, `-`, `/`, and a scope-only `@scope` — the refusals a
 * place is subject to, the operand that reaches a child, which is those same
 * readings asked in the other direction, and the one reading that differs
 * between moving somewhere and reading it: a place cannot stand in an
 * arguments cell, and an operand may still name one.
 */

import type { CellScope } from "@commonfabric/api";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { glyphFor } from "../view/display.ts";
import {
  CELL_SCOPE_VALUES,
  encodeJsonPointer,
  linkPathSegmentToCellPathSegment,
  parseScopedIdSegment,
} from "@commonfabric/runner/shared";

import {
  type NormalizedLLMFriendlyRef,
  normalizeLLMFriendlyRef,
  validatePieceSegment,
} from "../llm-friendly-ref.ts";
import { type RecordEntry, renderRecord } from "./record.ts";

/** One segment of a path inside a piece, in the form cell traversal takes. */
export type PathSegment = string | number;

/**
 * The facets a space root lists. A populated space is too large for a flat
 * root, so the root offers these and never pieces directly, and these names
 * are reserved at the root alone — inside a piece a facet name is an
 * ordinary data key.
 */
export const FACETS = ["slugs", "pieces"] as const;

/** One of the {@link FACETS}. */
export type Facet = (typeof FACETS)[number];

/** Standing at a space's root, whose children are its facets. */
export interface SpaceRootPosition {
  /** Names this arm of {@link Position}. */
  readonly kind: "root";

  /** The space, which one connection fixes for a shuttle's whole run. */
  readonly space: MemorySpace;
}

/** Standing inside one facet of a space, whose children are pieces. */
export interface FacetPosition {
  /** Names this arm of {@link Position}. */
  readonly kind: "facet";

  /** The space, which one connection fixes for a shuttle's whole run. */
  readonly space: MemorySpace;

  /** Which facet is open. */
  readonly facet: Facet;
}

/** Standing at a piece, or at a path inside its result. */
export interface PiecePosition {
  /** Names this arm of {@link Position}. */
  readonly kind: "piece";

  /** The space, which one connection fixes for a shuttle's whole run. */
  readonly space: MemorySpace;

  /** The piece as the operand named it: a handle or a slug. */
  readonly piece: string;

  /**
   * Path inside the piece's result; empty while standing at the piece.
   *
   * Every door into this module refuses a segment a rendering would not name
   * back — an empty one, one ending in whitespace, one holding a line break —
   * because writing a rendering and reading it back each lose characters that
   * {@link unnameableSegment} describes. That is an invariant the doors
   * establish rather than one this structural type enforces, so a position
   * reached any other way is outside it.
   */
  readonly path: readonly PathSegment[];
}

/**
 * Where in a space shuttle stands. A position is which cell this is and
 * nothing else, so two arrivals at one cell are one position however
 * differently they were reached; how shuttle got there is the trail
 * {@link CurrentPlace} keeps.
 */
export type Position = SpaceRootPosition | FacetPosition | PiecePosition;

/**
 * The cwd pair: the position shuttle reads from, and the scope it reads
 * through. A scope is a way of seeing every position rather than a location of
 * its own, which is why it sits beside the position instead of inside it.
 */
export interface Place {
  /** Where shuttle stands. */
  readonly position: Position;

  /** The overlay every read goes through while this place holds. */
  readonly scope: CellScope;
}

/**
 * A move whose reference named its space by name rather than by DID, which no
 * value can tell apart from the space this place holds. Settling that name
 * against a connection and handing this back to {@link CurrentPlace.settle}
 * with the space it stands for is what lands it.
 *
 * It carries what the reference determined and no space, because whether the
 * name denotes the connected space is the one thing not yet known: an arm
 * with no space in it has none to be wrong about, and `settle` builds the
 * place from the space it already holds.
 */
export interface SpaceNamedMove {
  /** Names this arm of {@link Move}. */
  readonly kind: "space-by-name";

  /** The space name the reference carried. */
  readonly name: string;

  /** The piece as the reference spelled it: a handle or a slug. */
  readonly piece: string;

  /** Path inside the piece's result; empty for the piece itself. */
  readonly path: readonly PathSegment[];

  /** The scope the reference asked for, or the place's where it asked none. */
  readonly scope: CellScope;
}

/** The arms of a {@link Move} that leave shuttle where it stood. */
type Unlanded =
  /** The move is refused, for the reason given. */
  | { readonly kind: "refused"; readonly reason: string }
  /** The operand is a wish target, which the connected space resolves. */
  | { readonly kind: "wish"; readonly target: string }
  | SpaceNamedMove;

/**
 * What a move did. It either lands, is refused, or names something only the
 * connection can settle: a wish target to resolve, or a space written as a
 * name.
 */
export type Move =
  /** The move landed, and `place` is where shuttle now stands. */
  | { readonly kind: "moved"; readonly place: Place }
  | Unlanded;

/**
 * What an operand named when it was read rather than moved to: where it
 * points, and which of a piece's two cells it selects.
 */
export interface Aim {
  /**
   * True where the operand ended in `#argument`, which selects the piece's
   * arguments cell — the same selection `--input` spells as a flag. The move
   * beside it carries the operand with that suffix taken off, so the position
   * is the same either way and this is the whole of what tells the two cells
   * apart.
   */
  readonly input: boolean;

  /** Where the operand points, with any `#argument` suffix off it. */
  readonly move: Move;
}

/** What resolving a named entry point against the fabric produced. */
export interface ResolvedTarget {
  /** The space the target resolved in, which need not be the place's. */
  readonly space: MemorySpace;

  /** The piece the target resolved to. */
  readonly piece: string;

  /**
   * Path inside that piece, absent or empty for the piece itself, with each
   * segment as the resolution spelled it. This is `NormalizedLink.path`'s
   * own component type, so a resolution hands over what it is already
   * holding; {@link CurrentPlace.enter} converts each segment to the
   * number-or-string form a cell path takes.
   */
  readonly path?: readonly string[];
}

/**
 * Whether `text` holds a character a terminal acts on rather than prints.
 *
 * It is the question a door and a printing surface both ask. A place refuses a
 * part holding one — {@link ACTED_ON} carries which characters those are and
 * why — and a listing with no name left to offer for such a row describes it
 * rather than writing it, which is the one place a refusal still leaves the
 * name to be shown.
 */
export function holdsControlCharacter(text: string): boolean {
  return ACTED_ON.test(text);
}

/**
 * `text` with every character a terminal acts on shown as the glyph that names
 * it, and everything else as it stands.
 *
 * This is the opposite treatment from a name, and what each is for is the
 * difference. A name is something a person types back, so one that cannot be
 * printed safely is better replaced by a description of why it is missing. A
 * message is something a person reads, so it has to arrive whole and merely
 * inert: every character survives, and the ones a terminal would act on
 * survive as the picture of themselves.
 *
 * The glyph is `lib/view/display.ts`'s, which is this package's answer to the
 * question already and draws exactly this class — C0 as `U+2400` plus the
 * code, `DEL` as its own picture, and C1 as the substitute. A glyph is what a
 * message wants and an escape is what a value wants;
 * {@link escapeControlCharactersInJson} is the other of the pair and carries
 * why the two differ.
 *
 * The class is walked a character at a time rather than replaced through a
 * global expression, because a global one carries a `lastIndex` between calls
 * and {@link holdsControlCharacter} tests the same class.
 */
export function escapeControlCharacters(text: string): string {
  return [...text].map((character) =>
    holdsControlCharacter(character) ? glyphFor(character) : character
  ).join("");
}

/**
 * `json` with every character a terminal acts on written as the escape JSON
 * spells it with, except the line feed, which is left alone.
 *
 * Two surfaces escape this class and they use different conventions, which is
 * a decision rather than an oversight. A message is prose somebody reads, so
 * {@link escapeControlCharacters} shows each character as one glyph naming
 * it. A serialized value is text somebody may parse or paste back, so it stays
 * JSON: `\uXXXX` is what JSON already writes an escape with, and extending it
 * to the rest of the class leaves output that still parses and still reads
 * back as the same value.
 *
 * The line feed is exempt because of what it can be by then. `JSON.stringify`
 * escapes every C0 character that came out of a value, the line feed among
 * them, so one still standing raw in its output is the pretty printer's own
 * formatting. Escaping that would fold the whole value onto one line.
 */
export function escapeControlCharactersInJson(json: string): string {
  return [...json].map((character) =>
    character !== "\n" && holdsControlCharacter(character)
      ? `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`
      : character
  ).join("");
}

/** The place a shuttle starts in: the space's root, read at the base scope. */
export function placeAtSpaceRoot(space: MemorySpace): Place {
  return { position: { kind: "root", space }, scope: "space" };
}

/**
 * The operand `cd` takes from `place` to the child of its position called
 * `child`, and nothing where neither spelling it offers reaches that child.
 *
 * Two spellings are offered, the shorter first. The name on its own is what
 * `cd` takes wherever `cd` reads that name as data. Where one of the readings
 * above takes it instead, the reference the child renders as reaches it
 * anyway: a reference reads none of them, and it escapes the separator where a
 * relative operand cannot. An absent answer means neither of these reaches
 * the child, which is narrower than nothing reaching it: some multi-segment
 * operand can reach one that neither does, since a walk splits on the
 * separator and reads a head reading only on the whole operand. None is looked
 * for, and which would work is not a question this answers — what it returns
 * is a name for the child, and a route is not one.
 *
 * Each spelling is answered by making the move rather than by a second copy of
 * the readings, so what comes back is an operand `cd` took. The move is made
 * from a standing with no trail and no previous place, which bounds the answer
 * in one direction only: `-` is never offered, even where shuttle's own
 * history would make it reach the child, and what is offered reaches the child
 * whatever that history holds.
 */
export function operandForChild(
  place: Place,
  child: string,
): string | undefined {
  const position = childPosition(place.position, child);
  if (position === undefined) return undefined;
  const goal: Place = { ...place, position };
  const from: Standing = { place, trail: [] };
  for (const candidate of [child, renderPosition(goal)]) {
    const step = movePlace(from, candidate);
    if (step.kind === "moved" && samePlace(step.to.place, goal)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * The place's two dimensions, as the ambient record prints one (`record.ts`):
 * what `pwd` prints whole, and what `where` prints under the connection's.
 *
 * A leading `/` is what makes a string a reference, so it marks the one
 * position that is a cell. A piece therefore renders as a fully qualified
 * reference — the rung that supplies every level, and so the one that denotes
 * the same cell read from anywhere — while a root and a
 * facet are containers and render without one, which is what keeps a
 * container's own rendering from resolving as a piece whose slug happens to
 * match. What holds of a rendering is one property and not a list: `cd` may
 * refuse it, but it never reads one as some other cell. A `#` reaches the
 * first half wherever it sits, the reference grammar reserving that character
 * for the `#argument` suffix. A piece or segment holding a newline would reach
 * the second half, by splitting the position line into a shorter reference,
 * which is why one is refused before it can reach a place rather than handled
 * here.
 *
 * The scope is written on the piece even when it is the base, which is what
 * makes "read from anywhere" true rather than nearly so. Scope is part of a
 * cell's identity, and an omitted suffix is filled from wherever the reader
 * stands, so a rendering without one denotes whatever cell the reader's own
 * scope selects. Writing it absolutely and reading it ambiently is the
 * asymmetry a shell has between what `pwd` prints and what a relative path
 * means. The reference serializer omits a base scope for the opposite
 * convention, that an omitted suffix means the base, so this writes the
 * suffix itself. The split that reads it back takes the last `@`, and this
 * writes one after the piece, so the suffix it reads is always the one this
 * wrote — whatever the piece holds, and independently of any rule about
 * what a piece may hold.
 */
function placeEntries(place: Place): readonly RecordEntry[] {
  return [
    { label: "position", value: renderPosition(place) },
    { label: "scope", value: renderScope(place.scope) },
  ];
}

/**
 * The one owner of a shuttle's place: it holds where shuttle stands, where it
 * stood before, and the levels it walked through to get there, moves between
 * them, answers where an operand points without going there, and refuses what
 * the design refuses.
 *
 * Per instance rather than per process, so that several places — tabs, split
 * views, an agent holding more than one — stay reachable.
 */
export class CurrentPlace {
  #here: Standing;
  #previous: Standing | undefined;

  /**
   * Constructs an instance standing at the root of `space`, with no previous
   * place.
   *
   * A space is all a shuttle has when it starts, and taking one rather than a
   * whole {@link Place} is what keeps {@link PiecePosition}'s invariant a
   * property of every door rather than of whoever remembered it. It is not a
   * property of the type: `Place` is a structural interface anyone can write
   * a literal for. What holds is narrower and is what matters — no door into
   * this module admits a position the invariant rules out. Restoring a saved
   * place is a named entry point with checking of its own, for whenever
   * something needs one.
   */
  constructor(space: MemorySpace) {
    this.#here = { place: placeAtSpaceRoot(space), trail: [] };
  }

  /** Where shuttle stands. */
  get place(): Place {
    return this.#here.place;
  }

  /** Where it stood before its last landed move, once there has been one. */
  get previous(): Place | undefined {
    return this.#previous?.place;
  }

  /**
   * Moves as `operand` says, and returns what that did. The place changes only
   * where the move lands, so a refusal and an unsettled operand both leave
   * shuttle where it was.
   */
  cd(operand: string): Move {
    return this.#commit(movePlace(this.#here, operand, this.#previous));
  }

  /**
   * Where `operand` points and which of a piece's two cells it selects,
   * without going there.
   *
   * It differs from {@link CurrentPlace.cd} in the two ways a read differs
   * from a move. Nothing moves, so shuttle stays where it stood whatever
   * comes back. And a trailing `#argument` is read rather than refused: a
   * place is result-rooted and cannot *stand* in an arguments cell, which is
   * why `cd` turns the suffix down in every spelling it is written in, but
   * reading one is a different act and the suffix is how an operand asks for
   * it.
   *
   * Everything else is `cd`'s reading exactly, asked from where shuttle
   * actually stands rather than from a standing built for the occasion. That
   * is what makes the two agree about `..`, which walks the trail shuttle
   * took and not the levels a position happens to name.
   */
  aim(operand: string): Aim {
    if (operand === ARGUMENT_SUFFIX) {
      return { input: false, move: outcomeOf(refuse(SUFFIX_NAMES_NO_TARGET)) };
    }
    const stripped = argumentSuffixOff(operand);
    return {
      input: stripped !== undefined,
      move: outcomeOf(
        movePlace(this.#here, stripped ?? operand, this.#previous),
      ),
    };
  }

  /**
   * Moves into a target the fabric resolved, `operand` being the spelling that
   * named it. A target that resolved in another space is refused: one
   * connection serves one space.
   */
  enter(target: ResolvedTarget, operand: string): Move {
    return this.#commit(enterTarget(this.#here.place, target, operand));
  }

  /**
   * Lands a {@link SpaceNamedMove}, `confirmed` being the space its name
   * resolved to. A name that resolved to any space but the connected one is
   * refused here, so the comparison the reference deferred is made where the
   * place would be adopted rather than left to the caller. The place is built
   * from the connected space and the move's own piece, path and scope, which
   * is what carries an `@scope` suffix through a reference that named its
   * space by name.
   */
  settle(move: SpaceNamedMove, confirmed: MemorySpace): Move {
    return this.#commit(this.#settled(move, confirmed));
  }

  /**
   * Like {@link CurrentPlace.settle}, except that it moves nothing: what comes
   * back is where the settled move names, and shuttle stays where it stood.
   */
  resolveNamedSpace(move: SpaceNamedMove, confirmed: MemorySpace): Move {
    return outcomeOf(this.#settled(move, confirmed));
  }

  /**
   * This place written short, for the prompt to carry: its position without
   * the space, and its scope after a space.
   *
   * The space is the one thing left out, and leaving it out costs nothing: one
   * connection serves one space, so the omitted part is the same on every line
   * of a run and `where` prints it. Nothing else is shortened — no id is cut
   * down to a prefix that would print exactly as a whole one, and no name is
   * shown that this process did not read — so what is here is what the place
   * holds. It is not an address for all that: the space is missing, a
   * container is written with the trailing separator that says it is one, and
   * the scope sits last rather than where a reference carries it.
   */
  label(): string {
    const place = this.#here.place;
    return `${labelPosition(place.position)} ${renderScope(place.scope)}`;
  }

  /**
   * The two dimensions of this place, for `where` to print under the ones the
   * connection contributes.
   */
  entries(): readonly RecordEntry[] {
    return placeEntries(this.#here.place);
  }

  /** What `pwd` prints for this place. */
  render(): string {
    return renderRecord(this.entries());
  }

  /**
   * Helper for the movers, which adopts a step that landed and reduces every
   * step to the outcome a caller sees. The trail is navigation history rather
   * than part of the place, so it stops here.
   */
  #commit(step: Step): Move {
    if (step.kind === "moved") {
      this.#previous = this.#here;
      this.#here = step.to;
    }
    return outcomeOf(step);
  }

  /**
   * Helper for {@link CurrentPlace.settle} and
   * {@link CurrentPlace.resolveNamedSpace}, which is where `move` lands once
   * `confirmed` is known. The comparison the reference deferred is made here
   * rather than left to the caller, so a name that resolved to any space but
   * the connected one is refused whichever of the two asked.
   */
  #settled(move: SpaceNamedMove, confirmed: MemorySpace): Step {
    const connected = this.#here.place.position.space;
    if (confirmed !== connected) {
      return refuseOtherSpace(
        `\`${move.name}\` resolves to space \`${confirmed}\``,
        connected,
      );
    }
    const fault = unnameablePiece(move.piece) ??
      firstUnnameableSegment(move.path);
    if (fault !== undefined) {
      return refuse(
        `The reference naming space \`${move.name}\` has ${fault.what}, ` +
          `so ${fault.so}.`,
      );
    }
    const outside = outsideVocabulary(move.piece);
    if (outside !== undefined) return outside;
    return land({
      position: {
        kind: "piece",
        space: connected,
        piece: move.piece,
        // Normalized the way every other door normalizes, so that a
        // position names its cell the same however it was reached, which is
        // what {@link Position} promises. A move `cd` minted carries a path
        // the reference grammar already converted; one a caller built does
        // not, and this is a public door.
        path: move.path.map((segment) =>
          typeof segment === "number"
            ? segment
            : linkPathSegmentToCellPathSegment(segment)
        ),
      },
      scope: move.scope,
    }, []);
  }
}

/**
 * The levels walked through to reach where shuttle stands, outermost first,
 * each the position one descent came from.
 *
 * `..` walks back out through it, which is what lets `cd slugs`, `cd board`,
 * `cd ..` return to `slugs/` while the piece itself stays one position however
 * it was reached. Three moves replace it wholesale rather than pushing: a
 * reference and a resolved target carry no route, and `-` restores the route
 * that came with the place it returns to.
 */
type Trail = readonly Position[];

/** Where shuttle stands, and the trail it walked to get there. */
interface Standing {
  /** The place itself. */
  readonly place: Place;

  /** How shuttle reached it. */
  readonly trail: Trail;
}

/** A move as the movers pass it around, a landing carrying its trail. */
type Step =
  /** The move landed on `to`. */
  | { readonly kind: "moved"; readonly to: Standing }
  | Unlanded;

/**
 * Where `operand` moves `from` to, `previous` being the standing `-` returns
 * to.
 *
 * The operand is read in the order the spellings can be told apart: `-`, a
 * scope-only `@scope`, and `/` are shuttle's own navigation syntax, any other
 * string starting with `/` is a reference for the fabric's grammar to parse,
 * whichever rung of it, a leading
 * `#` is a wish target, and anything else is a relative walk from where
 * shuttle stands.
 *
 * Each reading is matched against the operand as it was written, edges
 * included, so none of them reads a string that merely resembles the
 * spelling: `cd " -"` walks to the key `" -"` rather than returning to the
 * previous place. Whitespace reaches an edge only through a quote, the split
 * that produced the operand separating on it (`line.ts`), so it is a
 * character of the part it sits in and the part is held to the rule that part
 * answers to.
 */
function movePlace(
  from: Standing,
  operand: string,
  previous?: Standing,
): Step {
  const place = from.place;
  if (operand === "") return refuse("`cd` takes a place to move to.");
  if (operand === "-") {
    return previous === undefined
      ? refuse("There is no previous place to return to.")
      : land(previous.place, previous.trail);
  }
  if (operand.startsWith("@")) return moveScope(from, operand.slice(1));

  // A leading `/` roots a reference, and `/` alone roots one and names
  // nothing further: the space's own root, which the grammar has no id
  // segment to spell.
  if (operand === "/") {
    return land(
      { ...place, position: { kind: "root", space: place.position.space } },
      [],
    );
  }

  let reference;
  try {
    reference = normalizeLLMFriendlyRef(operand, {
      space: place.position.space,
    });
  } catch (error) {
    return refuse(messageOf(error));
  }
  if (reference !== undefined) {
    return moveByReference(place, reference, operand);
  }

  if (operand.startsWith("#")) return { kind: "wish", target: operand };
  return moveBySegments(from, operand);
}

/**
 * Where a `@scope` operand moves `from` to. `word` is the suffix without its
 * `@`, and the scopes it may name are the canonical grammar's own, so no
 * reference can carry a scope this refuses. The position does not move, so the
 * trail comes through untouched.
 */
function moveScope(from: Standing, word: string): Step {
  if (word.includes("/")) {
    return refuse(
      `\`@${word}\` names no scope: a scope word holds no \`/\`. What ` +
        `\`pwd\` prints for a space root or a facet is spelled this way and ` +
        `names no cell — reach one by its facet or its piece.`,
    );
  }
  if (!CELL_SCOPE_VALUES.has(word)) return refuseUnknownScope(word);
  return land({ ...from.place, scope: word as CellScope }, from.trail);
}

/** Helper for the movers, which refuses `@word` for naming no scope. */
function refuseUnknownScope(word: string): Step {
  return refuse(
    `\`@${word}\` names no scope. The scopes are \`@space\`, \`@user\`, ` +
      `and \`@session\`.`,
  );
}

/**
 * Where a parsed reference moves `place` to.
 *
 * A rooted reference fixes the piece and the path and takes both its space
 * and its scope from the place; a `@did:key:…` prefix supplies the space, and
 * an `@scope` suffix the scope. The parse refuses a
 * space whose DID differs from the place's, and hands one written as a name
 * back for a session to settle, since deriving a DID from a name needs one.
 */
function moveByReference(
  place: Place,
  reference: NormalizedLLMFriendlyRef,
  operand: string,
): Step {
  if (reference.input === true) return refuseArgumentSuffix();
  const badPiece = unnameablePiece(reference.pieceId);
  if (badPiece !== undefined) return refuseUnnameable(operand, badPiece);
  const badSegment = firstUnnameableSegment(reference.path);
  if (badSegment !== undefined) {
    return refuseUnnameable(operand, badSegment);
  }
  const scope = reference.scope ?? place.scope;
  if (reference.embeddedSpace !== undefined) {
    return {
      kind: "space-by-name",
      name: reference.embeddedSpace,
      piece: reference.pieceId,
      path: reference.path,
      scope,
    };
  }
  return land({
    position: {
      kind: "piece",
      space: place.position.space,
      piece: reference.pieceId,
      path: reference.path,
    },
    scope,
  }, []);
}

/**
 * Where a relative operand moves `from` to, one segment at a time. Each
 * segment is read against the level the one before it landed on, so `..` and a
 * descent compose in one operand.
 *
 * The operand's own edges are the outer edges of the first and last segments,
 * the operand reaching here as it was written: `cd " a"` reaches the key
 * `" a"`, and `cd "a "` is refused, a part ending in whitespace being
 * refused wherever it sits. Between those edges a segment is taken literally —
 * the reference grammar's `~1` escaping belongs to a reference, which a
 * relative operand is not, so `~1` here is two characters of a key and a key
 * holding the separator has no relative spelling at all.
 */
function moveBySegments(from: Standing, operand: string): Step {
  const segments = operand.split("/");
  if (segments[segments.length - 1] === "") segments.pop();

  let moved = from;
  for (const segment of segments) {
    // No fault check here: which rule a segment answers to depends on what it
    // is about to become, and only `moveDown` knows that. A segment naming a
    // piece is held to the piece rules and told the piece's reason, which is
    // not the reason a data key gets.
    const step = segment === ".."
      ? moveUp(moved)
      : moveDown(moved, segment, operand);
    if (step.kind !== "moved") return step;
    moved = step.to;
  }
  return land(moved.place, moved.trail);
}

/**
 * Where `..` moves `from` to: back out through the trail where there is one,
 * and out of the level it stands in where the trail is empty, which is how a
 * position a reference named outright backs out.
 */
function moveUp(from: Standing): Step {
  const top = from.trail.at(-1);
  return top === undefined
    ? land({ ...from.place, position: enclosing(from.place.position) }, [])
    : land({ ...from.place, position: top }, from.trail.slice(0, -1));
}

/**
 * Helper for {@link moveUp}, which is the level `position` sits inside: the
 * path one segment shorter where the position is one, and the space root
 * otherwise, since a facet and a piece alike sit directly inside it.
 */
function enclosing(position: Position): Position {
  return position.kind === "piece" && position.path.length > 0
    ? { ...position, path: position.path.slice(0, -1) }
    : { kind: "root", space: position.space };
}

/**
 * Where one relative segment moves `from` to: a facet at a space root, a piece
 * inside a facet, and a data key or index inside a piece. A descent pushes the
 * level it left onto the trail, which is what `..` walks back out.
 */
function moveDown(from: Standing, segment: string, operand: string): Step {
  const place = from.place;
  const position = place.position;
  const trail = [...from.trail, position];
  switch (position.kind) {
    case "root":
      return isFacet(segment)
        ? land({
          ...place,
          position: { kind: "facet", space: position.space, facet: segment },
        }, trail)
        : refuse(
          `A space root lists facets, and \`${segment}\` names none. The ` +
            `facets are \`slugs/\` and \`pieces/\`.`,
        );
    case "facet":
      return moveIntoPiece(place, position, segment, trail, operand);
    case "piece": {
      const fault = unnameableSegment(segment);
      if (fault !== undefined) return refuseUnnameable(operand, fault);
      return land({
        ...place,
        position: {
          ...position,
          path: [...position.path, linkPathSegmentToCellPathSegment(segment)],
        },
      }, trail);
    }
  }
}

/**
 * Where a segment naming a piece inside `facet` moves `place` to. The segment
 * is the one a scope suffix may ride, since that is where the canonical
 * grammar carries it, and a suffix here moves the scope half of the place.
 *
 * A `#` is refused rather than taken as part of the id, for one of two
 * reasons. `#argument` is refused for the reason it is refused on a
 * reference — a place is result-rooted — which holds however the suffix is
 * written, so both spellings give that one reason. Any other fragment is a
 * spelling nothing carries, `#` being reserved for `#argument` in the
 * reference form too, so the refusal says that rather than naming a form
 * which would refuse it again for a second reason.
 */
function moveIntoPiece(
  place: Place,
  facet: FacetPosition,
  segment: string,
  trail: Trail,
  operand: string,
): Step {
  const hash = segment.indexOf("#");
  if (hash !== -1) {
    const suffix = segment.slice(hash);
    return suffix === "#argument" ? refuseArgumentSuffix() : refuse(
      `Unknown suffix "${suffix}". The one supported suffix is ` +
        `"#argument", which selects the piece's arguments cell the way ` +
        `"--input" does.`,
    );
  }
  if (segment.startsWith("@")) {
    return refuse(
      `\`${segment}\` names no piece. A scope suffix rides a piece id, and ` +
        `a scope on its own is a whole operand rather than a segment.`,
    );
  }
  let scoped;
  try {
    scoped = parseScopedIdSegment(segment);
  } catch {
    // The one throw left: the suffix names no scope, `@` with no piece in
    // front of it having been refused above.
    return refuseUnknownScope(segment.slice(segment.lastIndexOf("@") + 1));
  }
  const fault = unnameablePiece(scoped.id);
  if (fault !== undefined) return refuseUnnameable(operand, fault);
  const outside = outsideVocabulary(scoped.id);
  if (outside !== undefined) return outside;
  return land({
    position: {
      kind: "piece",
      space: facet.space,
      piece: scoped.id,
      path: [],
    },
    scope: scoped.scope ?? place.scope,
  }, trail);
}

/**
 * Where a resolved target moves `place` to, `operand` being the spelling that
 * named it. A target that resolved in another space — which is what a
 * home-anchored entry point does whenever the reading identity's home space
 * is not the connected one — is refused: one connection serves one space.
 *
 * The path is normalized the way a reference's and a relative walk's are, so
 * that a position names its cell the same however it was reached, which is
 * what {@link Position} promises.
 */
function enterTarget(
  place: Place,
  target: ResolvedTarget,
  operand: string,
): Step {
  if (target.space !== place.position.space) {
    return refuseOtherSpace(
      `\`${operand}\` resolves in space \`${target.space}\``,
      place.position.space,
    );
  }
  const badPiece = unnameablePiece(target.piece);
  if (badPiece !== undefined) {
    return refuse(
      `\`${operand}\` resolves to ${badPiece.what}, so ${badPiece.so}.`,
    );
  }
  const badSegment = firstUnnameableSegment(target.path ?? []);
  if (badSegment !== undefined) {
    return refuse(
      `\`${operand}\` resolves to a path with ${badSegment.what}, so ` +
        `${badSegment.so}.`,
    );
  }
  const outside = outsideVocabulary(target.piece);
  if (outside !== undefined) return outside;
  return land({
    ...place,
    position: {
      kind: "piece",
      space: target.space,
      piece: target.piece,
      path: target.path?.map(linkPathSegmentToCellPathSegment) ?? [],
    },
  }, []);
}

/** Whether `segment` names one of the facets a space root lists. */
function isFacet(segment: string): segment is Facet {
  return (FACETS as readonly string[]).includes(segment);
}

/**
 * Helper for {@link operandForChild}, which is the position one level inside
 * `position` called `child`, and nothing where that level has no child of
 * that name.
 *
 * A root's children are its facets and are a closed set, so a name outside it
 * denotes nothing. A facet's and a piece's are whatever the space holds, so
 * this builds the position and leaves whether an operand reaches it to the
 * move that tries one.
 */
function childPosition(
  position: Position,
  child: string,
): Position | undefined {
  switch (position.kind) {
    case "root":
      return isFacet(child)
        ? { kind: "facet", space: position.space, facet: child }
        : undefined;
    case "facet":
      return { kind: "piece", space: position.space, piece: child, path: [] };
    case "piece":
      return {
        ...position,
        path: [...position.path, linkPathSegmentToCellPathSegment(child)],
      };
  }
}

/**
 * Helper for {@link operandForChild}, which is whether two places are the same
 * place: both halves of the pair, since a scope is half of what a place is and
 * two scopes select two cells at one position.
 */
function samePlace(one: Place, other: Place): boolean {
  return one.scope === other.scope &&
    samePosition(one.position, other.position);
}

/**
 * Helper for {@link samePlace}, which is whether two positions of one space
 * are the same cell. It is {@link Position}'s own promise read as a
 * comparison: the levels a position names and nothing about how either was
 * reached.
 *
 * The space is not among the levels it compares. One connection fixes the
 * space for a shuttle's whole run and every door refuses a position outside
 * it, so the pair this is handed carries one space and a comparison of it
 * could only ever hold.
 */
function samePosition(one: Position, other: Position): boolean {
  switch (one.kind) {
    case "root":
      return other.kind === "root";
    case "facet":
      return other.kind === "facet" && one.facet === other.facet;
    case "piece":
      return other.kind === "piece" && one.piece === other.piece &&
        one.path.length === other.path.length &&
        one.path.every((segment, index) => segment === other.path[index]);
  }
}

/**
 * The suffix an operand ends in to select a piece's arguments cell, which is
 * the selection `--input` spells as a flag.
 */
const ARGUMENT_SUFFIX = "#argument";

/**
 * The reason {@link ARGUMENT_SUFFIX} written with nothing in front of it is
 * refused. It selects a piece's arguments cell, so what it wants in front of
 * it is a target.
 */
const SUFFIX_NAMES_NO_TARGET =
  `\`${ARGUMENT_SUFFIX}\` selects a piece's arguments cell, so it follows ` +
  `the target it selects, as in \`get topics${ARGUMENT_SUFFIX}\`.`;

/**
 * Helper for {@link CurrentPlace.aim}, which is `operand` with a trailing
 * {@link ARGUMENT_SUFFIX} taken off, and nothing where it carries none.
 *
 * The rule is narrower than `splitArgumentSuffix`'s
 * (`packages/cli/lib/llm-friendly-ref.ts`), which additionally refuses every
 * other fragment. That is right where that one runs — at `cf`'s intake, and
 * inside the parse a rooted operand goes through here — and wrong for a
 * relative operand, where `#` is an ordinary character of a data key. So this
 * reads the one spelling it accepts and leaves every other `#` to whichever
 * door decides it: a reference refuses a fragment through that same function,
 * a walk inside a piece takes it as data, and a `#` at the head is a wish
 * target rather than a suffix on one.
 *
 * What it costs is one shape, and the reference door pays the same one: a data
 * key whose name ends in the suffix has no relative spelling, since this
 * reading takes the suffix off before the walk splits the operand.
 *
 * The suffix on its own never reaches here, {@link CurrentPlace.aim} having
 * answered it already, so what this returns for one is not a case: it names no
 * target, and the refusal it gets says that rather than pointing at the empty
 * operand taking the suffix off would leave.
 */
function argumentSuffixOff(operand: string): string | undefined {
  return operand.endsWith(ARGUMENT_SUFFIX)
    ? operand.slice(0, -ARGUMENT_SUFFIX.length)
    : undefined;
}

/**
 * Helper for the movers, which refuses the `#argument` suffix on a `cd`
 * operand. A place is result-rooted, so no spelling of the suffix moves one
 * and the reason never turns on which spelling carried it.
 */
function refuseArgumentSuffix(): Step {
  return refuse(
    "A place is result-rooted, so `cd` takes no `#argument` suffix. A " +
      "place rooted at the arguments cell would leave every later " +
      "relative read ambiguous about which side of the piece it " +
      "addressed. Reach arguments per operand instead, as in " +
      "`get topics/3#argument`.",
  );
}

/**
 * Helper for the movers, which refuses something that named a space other
 * than `connected`. `clause` says what named it and which space it named; the
 * rest is the same fact whichever route reached it, so it is written once.
 */
function refuseOtherSpace(clause: string, connected: MemorySpace): Step {
  return refuse(
    `${clause}, and this shuttle is connected to \`${connected}\`. One ` +
      `connection serves one space, so reaching that cell means a shuttle ` +
      `started against that space.`,
  );
}

/**
 * What is wrong with one part of a place, and why that is refused. The two
 * reasons are not interchangeable and a message is built from both, so a part
 * carries the one that actually applies to it.
 */
interface Fault {
  /** The part and its flaw, as a noun phrase. */
  readonly what: string;

  /** Why it is refused, as a clause completing "so". */
  readonly so: string;
}

/**
 * The reason a part whose rendering would denote some other cell is
 * refused.
 */
const NAMES_ANOTHER = "a rendering of the place would name a different cell";

/**
 * The reason a piece the fabric could not have produced is refused. It holds
 * of every rule that uses it; the mechanism behind it turns on the piece's
 * shape rather than on which rule caught it.
 *
 * For a handle-shaped piece — a colon, and twenty characters — `isPieceHandle`
 * is a length rule rather than an alphabet one, so the parse accepts a
 * "handle" the `fid1` encoding cannot make and hands it back verbatim: a
 * rendering that round-trips exactly and denotes nothing, neither a wrong
 * address nor a dead one, so the reason it is refused cannot be either. An
 * empty piece and a slug-shaped one the parse refuses on its own account, and
 * this door reaches them first.
 */
const NO_SUCH_NAME = "no piece carries that name: a slug is lowercase " +
  "letters, numbers, and single hyphens between words, and a handle is " +
  "`of:fid1:` and unpadded base64url";

/**
 * The reason a part a terminal would act on rather than print is refused.
 *
 * Everything a place is written into goes to a terminal — the prompt carrying
 * it, the listing offering it, the rendering `pwd` prints — and a terminal
 * reads these characters as instructions rather than as text. One moves the
 * cursor, one opens a sequence that colors or clears what follows. So the
 * screen stops saying what the fabric holds, and a name read off it is not the
 * name that was printed.
 */
const ACTS_ON_A_TERMINAL = "a terminal would act on it rather than print it";

/**
 * The characters a terminal acts on: Unicode's `Cc` category, which is C0
 * (`U+0000`–`U+001F`), `DEL`, and C1 (`U+0080`–`U+009F`).
 *
 * The category is the rule rather than a list of the ones anybody has seen
 * misbehave, because what makes them one class is what a terminal does with
 * them and not which of them a person has met. C1 is in it for a reason worth
 * naming: `U+009B` is the single-character form of the sequence introducer,
 * so a name holding one opens a sequence with no escape in front of it.
 *
 * What is not here is as decided as what is. `U+00A0` prints as a space and
 * instructs nothing. `U+2028` and `U+2029` separate lines for a reader of text
 * rather than for a terminal, and the printer quotes both, being whitespace to
 * the split. Refusing either would take a name away for no harm.
 */
const ACTED_ON = /\p{Cc}/u;

/**
 * Helper for the movers, which names what stops a rendering of a path holding
 * `segment` from naming that path back, and returns nothing when nothing
 * does.
 *
 * Characters go missing on the way out and on the way back. Reading a
 * rendering back is a parse of a reference, which trims the string it is
 * given and drops a trailing empty
 * segment. Writing the rendering separates its lines with a newline, so a
 * segment holding one splits the position line and leaves a shorter reference
 * naming another cell. Both are refused wherever a segment sits and not only
 * last, because `..` makes any segment the last one. Leading whitespace
 * survives both and is admitted: the parse trims the whole string, which no
 * leading character of a segment sits at the end of.
 *
 * A control character survives both losses and is refused all the same, for a
 * reason the round trip cannot see ({@link ACTS_ON_A_TERMINAL}): the rendering
 * goes to a terminal, where these are instructions rather than text. That the
 * reference reads back whole is what makes them dangerous rather than what
 * excuses them — the screen no longer shows the name, so what a person copies
 * off it is what the terminal did.
 */
function unnameableSegment(segment: PathSegment): Fault | undefined {
  if (typeof segment !== "number") {
    if (segment === "") return { what: "an empty segment", so: NAMES_ANOTHER };
    if (segment !== segment.trimEnd()) {
      return { what: "a segment ending in whitespace", so: NAMES_ANOTHER };
    }
    if (segment.includes("\n")) {
      return { what: "a segment holding a line break", so: NAMES_ANOTHER };
    }
    if (holdsControlCharacter(segment)) {
      return {
        what: "a segment holding a control character",
        so: ACTS_ON_A_TERMINAL,
      };
    }
    return undefined;
  }
  // A number renders as its digits, and only a canonical array index reads
  // back as the number it was: `1e21`, `-1` and `1.5` all print as something
  // the conversion leaves a string. The canonical rule decides, rather than a
  // second copy of it here.
  return linkPathSegmentToCellPathSegment(String(segment)) === segment
    ? undefined
    : { what: "a segment that is no canonical index", so: NAMES_ANOTHER };
}

/**
 * The characters the reference grammar reads inside an id segment: the `@` a
 * scope suffix rides on (`parseScopedIdSegment`), and the `#` an argument
 * suffix does (`splitArgumentSuffix`). Neither vocabulary holds one — a slug
 * is lowercase letters, numbers and hyphens, and a handle is base64url — but
 * `isPieceHandle` is a length rule rather than an alphabet one, so a long
 * enough piece carries either past the vocabulary check.
 *
 * The separator and the escape are deliberately not here. A rendering escapes
 * both, `/` becoming `~1` and `~` becoming `~0`, so a piece holding one is
 * read back whole; refusing it would be an alphabet this module does not own,
 * against a canonical check that owns one and declines to apply it.
 */
const READ_INSIDE_AN_ID = ["@", "#"];

/**
 * Helper for the movers, which names what stops a piece from being one a place
 * may stand on, and returns nothing when nothing does.
 *
 * Of what a rendering loses, only the newline costs a piece its name. The scope suffix the rendering
 * always writes sits between the piece and the end of the string, so the trim
 * takes the suffix rather than the piece, and the split at the last `@` takes
 * the suffix's own — a piece with something in it comes back whole from both.
 * An empty one is the exception, and one fact generates it: its rendered id
 * segment is the suffix and nothing else, so the split finds no id in front of
 * it and the parse refuses the whole reference.
 *
 * The rules that are not the newline answer to {@link NO_SUCH_NAME} instead,
 * which is a weaker claim than the segment rules make and the honest one.
 * {@link outsideVocabulary} runs after this door and refuses an empty piece
 * and every colon-less name that is no slug on its own account. What this door
 * adds is the handle-shaped piece: `isPieceHandle` is a length rule, so a
 * trailing space and either of {@link READ_INSIDE_AN_ID} ride past it and are
 * refused here, and so does a control character, which no vocabulary holds
 * either: no slug carries one and base64url has none. Other characters no
 * vocabulary holds ride past it too — a `.` or an escaped separator — and are
 * admitted, their renderings reading back whole; what is refused here is what
 * a rendering would lose, what a reading would take, and what no name the
 * fabric made could have held.
 */
function unnameablePiece(piece: string): Fault | undefined {
  if (piece.includes("\n")) {
    return { what: "a piece holding a line break", so: NAMES_ANOTHER };
  }
  if (piece === "") return { what: "an empty piece", so: NO_SUCH_NAME };
  if (piece !== piece.trimEnd()) {
    return { what: "a piece ending in whitespace", so: NO_SUCH_NAME };
  }
  for (const character of READ_INSIDE_AN_ID) {
    if (piece.includes(character)) {
      return { what: `a piece holding \`${character}\``, so: NO_SUCH_NAME };
    }
  }
  if (holdsControlCharacter(piece)) {
    return { what: "a piece holding a control character", so: NO_SUCH_NAME };
  }
  return undefined;
}

/** Helper for the movers, which is the first fault in `path`, if it has one. */
function firstUnnameableSegment(
  path: readonly PathSegment[],
): Fault | undefined {
  for (const segment of path) {
    const fault = unnameableSegment(segment);
    if (fault !== undefined) return fault;
  }
  return undefined;
}

/**
 * Helper for the movers, which refuses `operand` for a part no rendering
 * names back, `fault` saying which part and why.
 */
function refuseUnnameable(operand: string, fault: Fault): Step {
  return refuse(`\`${operand}\` has ${fault.what}, so ${fault.so}.`);
}

/**
 * Helper for the movers, which refuses `piece` where it is in neither
 * vocabulary a piece is named by, and returns nothing where it is in one of
 * them. Every door runs it after its own rendering rules, so a part no
 * rendering names back is reported as that rather than as a name outside a
 * vocabulary.
 *
 * The rule is `validatePieceSegment`'s
 * (`packages/cli/lib/llm-friendly-ref.ts`), called rather than copied, so that
 * a piece is held to the same two vocabularies whichever door admits it and
 * one name gets one reason whichever door refused it. Its sentence reaches the
 * reader unaltered.
 */
function outsideVocabulary(piece: string): Step | undefined {
  try {
    validatePieceSegment(piece);
  } catch (error) {
    return refuse(messageOf(error));
  }
  return undefined;
}

/** Helper for the movers, which builds a refusal carrying `reason`. */
function refuse(reason: string): Step {
  return { kind: "refused", reason };
}

/** Helper for the movers, which builds a step landing on `place`. */
function land(place: Place, trail: Trail): Step {
  return { kind: "moved", to: { place, trail } };
}

/**
 * Helper for the movers, which is what a caller sees of `step`. The trail is
 * navigation history rather than part of a place, so it stops here whether or
 * not the step was adopted.
 */
function outcomeOf(step: Step): Move {
  return step.kind === "moved" ? { kind: "moved", place: step.to.place } : step;
}

/**
 * The message a thrown value carries, for every surface that reports one.
 *
 * Total, which the obvious spelling is not. `String` throws on a value with no
 * `toString` — `Object.create(null)` is the reachable one, out of a rejection
 * built from a bare record — and on one whose conversion throws; an `Error`
 * may carry a `message` that is a getter which throws, or that is not a string
 * at all, which the next reader of it would be the one to fail on. Every
 * caller is already on its way to reporting a failure, so a throw raised here
 * replaces the failure being reported with itself: at the prompt that ends the
 * session on the read that failed, rather than answering the line and reading
 * the next one.
 *
 * A value that will not describe itself gets the sentence below instead. It
 * tells a reader less than a real message would and a great deal more than a
 * run that stopped.
 */
export function messageOf(thrown: unknown): string {
  try {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    if (typeof message === "string") return message;
  } catch {
    // The conversion is what failed, which is the case this exists for.
  }
  return "The failure carries nothing that can be written as a message.";
}

/**
 * Helper for {@link placeEntries}, which writes the position. A piece
 * carries the scope, since only a piece is a cell for a scope to select
 * within; a container renders its own name and leaves the scope to the line
 * below.
 */
function renderPosition(place: Place): string {
  const position = place.position;
  const space = `@${position.space}`;
  switch (position.kind) {
    case "root":
      return encodeJsonPointer([space, ""]);
    case "facet":
      return encodeJsonPointer([space, position.facet, ""]);
    case "piece":
      return encodeJsonPointer([
        "",
        space,
        `${position.piece}@${place.scope}`,
        ...position.path.map(String),
      ]);
  }
}

/**
 * Helper for {@link CurrentPlace.label}, which writes the position half of the
 * short form: everything the position holds except the space.
 *
 * The separator is escaped in every segment, as it is in the rendering `pwd`
 * prints, so a key holding one is one segment here too. What differs is the
 * leading separator: it marks a cell in a place's rendering and marks nothing
 * here, a short form being no reference for it to mark one in, so a container
 * takes it and reads as the walk down from the root that it is.
 */
function labelPosition(position: Position): string {
  switch (position.kind) {
    case "root":
      return encodeJsonPointer(["", ""]);
    case "facet":
      return encodeJsonPointer(["", position.facet, ""]);
    case "piece":
      return encodeJsonPointer([
        position.piece,
        ...position.path.map(String),
      ]);
  }
}

/** Helper for the renderings, which writes the scope. */
function renderScope(scope: CellScope): string {
  return `@${scope}`;
}
