/**
 * A place is where shuttle stands: the position it reads from and the scope it
 * reads through. Both halves stick across navigation and both render, so they
 * travel as one pair and `cd` is the single door to either.
 *
 * Everything here is a value and a decision about a value — no connection, and
 * nothing read. The address grammar belongs to the fabric
 * (`normalizeLLMFriendlyRef` over the runner's `parseReferenceParts`) and this
 * module consumes it; what it adds is the navigation spellings that grammar
 * has no room for — `..`, `-`, `/`, and a scope-only `@scope` — and the
 * refusals a place is subject to.
 */

import type { CellScope } from "@commonfabric/api";
import {
  type NormalizedLLMFriendlyRef,
  normalizeLLMFriendlyRef,
} from "@commonfabric/cli/lib/llm-friendly-ref";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  CELL_SCOPE_VALUES,
  encodeJsonPointer,
  linkPathSegmentToCellPathSegment,
  parseScopedIdSegment,
} from "@commonfabric/runner/shared";

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
   * Path inside the piece's result; empty while standing at the piece. Every
   * segment of it is one a rendering names back, which rules out three: an
   * empty segment, one ending in whitespace, and one holding a line break.
   * A path holding any of them renders as a reference to a different cell,
   * because writing the rendering and reading it back each lose characters
   * that {@link unnameableSegment} describes.
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
 * A move whose reference named its space by name rather than by DID, which
 * needs a session to derive the one from the other. Resolving that name —
 * `validateEmbeddedSpaces` does it — and handing this back to
 * {@link CurrentPlace.settle} with the space it resolved to is what lands it.
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

/** The place a shuttle starts in: the space's root, read at the base scope. */
export function placeAtSpaceRoot(space: MemorySpace): Place {
  return { position: { kind: "root", space }, scope: "space" };
}

/**
 * What `pwd` prints: both halves of the place, each on its own line.
 *
 * A leading `/` is what makes a string a reference, so it marks the one
 * position that is a cell. A piece therefore renders as a complete reference —
 * the form that denotes the same cell read from anywhere — while a root and a
 * facet are containers and render without one, which is what keeps a
 * container's own rendering from resolving as a piece whose slug happens to
 * match. `cd` reads a piece rendering back whole, except where a path segment
 * holds a `#`, which the reference grammar reserves: `cd` refuses such a
 * rendering rather than reading it as some other cell. A piece or segment
 * holding a newline would split the position line, leaving a shorter
 * reference that names another cell — which is why one is refused before it
 * can reach a place rather than handled here. The scope renders here
 * rather than through the reference serializer, which emits no suffix for the
 * base scope.
 */
export function renderPlace(place: Place): string {
  return `position  ${renderPosition(place.position)}\n` +
    `scope     ${renderScope(place.scope)}`;
}

/**
 * The one owner of a shuttle's place: it holds where shuttle stands, where it
 * stood before, and the levels it walked through to get there, moves between
 * them, and refuses what the design refuses.
 *
 * Per instance rather than per process, so that several places — tabs, split
 * views, an agent holding more than one — stay reachable.
 */
export class CurrentPlace {
  #here: Standing;
  #previous: Standing | undefined;

  /** Constructs an instance standing at `place`, with no previous place. */
  constructor(place: Place) {
    this.#here = { place, trail: [] };
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
    const connected = this.#here.place.position.space;
    if (confirmed !== connected) {
      return this.#commit(refuseOtherSpace(
        `\`${move.name}\` resolves to space \`${confirmed}\``,
        connected,
      ));
    }
    const fault = unnameablePiece(move.piece) ??
      firstUnnameableSegment(move.path);
    if (fault !== undefined) {
      return this.#commit(refuse(
        `The reference naming space \`${move.name}\` has ${fault}, so a ` +
          `rendering of the place would name a different cell.`,
      ));
    }
    return this.#commit(land({
      position: {
        kind: "piece",
        space: connected,
        piece: move.piece,
        path: move.path,
      },
      scope: move.scope,
    }, []));
  }

  /** What `pwd` prints for this place. */
  render(): string {
    return renderPlace(this.#here.place);
  }

  /**
   * Helper for the movers, which adopts a step that landed and reduces every
   * step to the outcome a caller sees. The trail is navigation history rather
   * than part of the place, so it stops here.
   */
  #commit(step: Step): Move {
    if (step.kind !== "moved") return step;
    this.#previous = this.#here;
    this.#here = step.to;
    return { kind: "moved", place: step.to.place };
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
 * rooted string is a reference for the fabric's grammar to parse, a leading
 * `#` is a wish target, and anything else is a relative walk from where
 * shuttle stands.
 */
function movePlace(
  from: Standing,
  operand: string,
  previous?: Standing,
): Step {
  const place = from.place;
  const trimmed = operand.trim();
  if (trimmed === "") return refuse("`cd` takes a place to move to.");
  if (trimmed === "-") {
    return previous === undefined
      ? refuse("There is no previous place to return to.")
      : land(previous.place, previous.trail);
  }
  if (trimmed.startsWith("@")) return moveScope(from, trimmed.slice(1));

  // A leading `/` roots a reference, and `/` alone roots one and names
  // nothing further: the space's own root, which the grammar has no id
  // segment to spell.
  if (trimmed === "/") {
    return land(
      { ...place, position: { kind: "root", space: place.position.space } },
      [],
    );
  }

  let reference;
  try {
    reference = normalizeLLMFriendlyRef(trimmed, {
      space: place.position.space,
    });
  } catch (error) {
    return refuse(messageOf(error));
  }
  if (reference !== undefined) {
    return moveByReference(place, reference, trimmed);
  }

  if (trimmed.startsWith("#")) return { kind: "wish", target: trimmed };
  return moveBySegments(from, trimmed);
}

/**
 * Where a `@scope` operand moves `from` to. `word` is the suffix without its
 * `@`, and the scopes it may name are the canonical grammar's own, so no
 * reference can carry a scope this refuses. The position does not move, so the
 * trail comes through untouched.
 */
function moveScope(from: Standing, word: string): Step {
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
 * A rooted reference fixes the piece and the path and takes its space from the
 * place; only a complete one carries a space of its own. The parse refuses a
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
 * Segments split on `/` and are taken literally. The reference grammar's `~1`
 * escaping belongs to a reference, which a relative operand is not, so `~1`
 * here is two characters of a key and a key holding the separator has no
 * relative spelling at all.
 */
function moveBySegments(from: Standing, operand: string): Step {
  const segments = operand.split("/");
  if (segments[segments.length - 1] === "") segments.pop();

  let moved = from;
  for (const segment of segments) {
    const fault = unnameableSegment(segment);
    if (fault !== undefined) return refuseUnnameable(operand, fault);
    const step = segment === ".." ? moveUp(moved) : moveDown(moved, segment);
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
function moveDown(from: Standing, segment: string): Step {
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
      return moveIntoPiece(place, position, segment, trail);
    case "piece":
      return land({
        ...place,
        position: {
          ...position,
          path: [...position.path, linkPathSegmentToCellPathSegment(segment)],
        },
      }, trail);
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
): Step {
  const hash = segment.indexOf("#");
  if (hash !== -1) {
    const suffix = segment.slice(hash);
    return suffix === "#argument" ? refuseArgumentSuffix() : refuse(
      `Unknown reference suffix "${suffix}". The one supported suffix ` +
        `is "#argument", which the reference form carries and a bare ` +
        `piece id does not.`,
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
  if (fault !== undefined) return refuseUnnameable(segment, fault);
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
      `\`${operand}\` resolves to ${badPiece}, so a rendering of the place ` +
        `would name a different cell.`,
    );
  }
  const badSegment = firstUnnameableSegment(target.path ?? []);
  if (badSegment !== undefined) {
    return refuse(
      `\`${operand}\` resolves to a path with ${badSegment}, so a rendering ` +
        `of the place would name a different cell.`,
    );
  }
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
      `connection serves one space.`,
  );
}

/**
 * Helper for {@link unnameableSegment} and {@link unnameablePiece}, which
 * names what the two steps every part of a rendering passes through would
 * lose from `text`, `noun` naming the part.
 *
 * Reading a rendering back is a parse of a reference, which trims the string
 * it is given and drops a trailing empty segment; something ending in
 * whitespace, and something empty, are what that reaches. Writing the
 * rendering separates its lines with a newline, so one holding a newline
 * splits the position line and leaves a shorter reference naming another
 * cell.
 *
 * Leading whitespace survives both and is admitted: the parse trims the whole
 * string, which no leading character of a part sits at the end of. What a
 * terminal does with the other control characters is the format's concern
 * rather than this one's, since a reference carrying them reads back whole.
 */
function unnameableText(text: string, noun: string): string | undefined {
  if (text === "") return `an empty ${noun}`;
  if (text !== text.trimEnd()) return `a ${noun} ending in whitespace`;
  if (text.includes("\n")) return `a ${noun} holding a line break`;
  return undefined;
}

/**
 * Helper for the movers, which names what stops a rendering of a path holding
 * `segment` from naming that path back, and returns nothing when nothing
 * does. A number renders as its digits and survives every step.
 */
function unnameableSegment(segment: PathSegment): string | undefined {
  return typeof segment === "number"
    ? undefined
    : unnameableText(segment, "segment");
}

/**
 * Helper for the movers, which names what stops a rendering from naming
 * `piece` back, and returns nothing when nothing does.
 *
 * A third step reads the piece segment and only that one, which is why this
 * is not {@link unnameableSegment}: `parseScopedIdSegment` splits the piece
 * at its last `@` and reads what follows as a scope, so a piece holding one
 * is read back shortened — under a scope it never asked for where the suffix
 * is a scope word, and as a refusal where it is not. A slug is lowercase
 * letters, numbers and hyphens and a handle carries none either, so no piece
 * the fabric can name is lost by refusing the character outright.
 */
function unnameablePiece(piece: string): string | undefined {
  return unnameableText(piece, "piece") ??
    (piece.includes("@") ? "a piece holding `@`" : undefined);
}

/** Helper for the movers, which is the first fault in `path`, if it has one. */
function firstUnnameableSegment(
  path: readonly PathSegment[],
): string | undefined {
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
function refuseUnnameable(operand: string, fault: string): Step {
  return refuse(
    `\`${operand}\` has ${fault}, so a rendering of the place would name a ` +
      `different cell.`,
  );
}

/** Helper for the movers, which builds a refusal carrying `reason`. */
function refuse(reason: string): Step {
  return { kind: "refused", reason };
}

/** Helper for the movers, which builds a step landing on `place`. */
function land(place: Place, trail: Trail): Step {
  return { kind: "moved", to: { place, trail } };
}

/** Helper for the movers, which reads the message off a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Helper for {@link renderPlace}, which writes the position half. */
function renderPosition(position: Position): string {
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
        position.piece,
        ...position.path.map(String),
      ]);
  }
}

/** Helper for {@link renderPlace}, which writes the scope half. */
function renderScope(scope: CellScope): string {
  return `@${scope}`;
}
