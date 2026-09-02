/**
 * A place is where shuttle stands: the position it reads from and the scope it
 * reads through. Both halves stick across navigation and both render, so they
 * travel as one pair and `cd` is the single door to either.
 *
 * Everything here is a value and a decision about a value — no connection, and
 * nothing read. The address grammar belongs to the fabric
 * (`normalizeLLMFriendlyRef` over the runner's `parseReferenceParts`) and this
 * module consumes it; what it adds is the navigation spellings that grammar
 * has no room for — `..`, `-`, and a scope-only `@scope` — and the refusals a
 * place is subject to.
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
 * are reserved at the root alone — inside a piece every segment is data.
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

  /** Path inside the piece's result; empty while standing at the piece. */
  readonly path: readonly PathSegment[];

  /**
   * The facet this piece was reached through, where it was reached through
   * one. A piece is the same piece however it is reached, so this records the
   * route and not the address: it is what `..` walks back out through, and it
   * is absent for a piece a reference named outright.
   */
  readonly facet?: Facet;
}

/** Where in a space shuttle stands. */
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
 * What a move did. It either lands, is refused, or names something only the
 * connection can settle: a wish target to resolve, or a space written as a
 * name, where comparing two spellings needs a session to derive a DID.
 */
export type Move =
  /** The move landed, and `place` is where shuttle now stands. */
  | { readonly kind: "moved"; readonly place: Place }
  /** The move is refused, for the reason given. */
  | { readonly kind: "refused"; readonly reason: string }
  /** The operand is a wish target, which the connected space resolves. */
  | { readonly kind: "wish"; readonly target: string }
  /**
   * The reference names its space by name. `place` is where it lands once that
   * name is confirmed to be the connected space, which `validateEmbeddedSpaces`
   * settles against a session.
   */
  | {
    readonly kind: "space-by-name";
    readonly name: string;
    readonly place: Place;
  };

/** What resolving a named entry point against the fabric produced. */
export interface ResolvedTarget {
  /** The space the target resolved in, which need not be the place's. */
  readonly space: MemorySpace;

  /** The piece the target resolved to. */
  readonly piece: string;

  /** Path inside that piece; absent or empty for the piece itself. */
  readonly path?: readonly PathSegment[];
}

/** The place a shuttle starts in: the space's root, read at the base scope. */
export function placeAtSpaceRoot(space: MemorySpace): Place {
  return { position: { kind: "root", space }, scope: "space" };
}

/**
 * What `pwd` prints: both halves of the place, each on its own line.
 *
 * The position renders as a complete reference wherever it is one, since that
 * is the form which denotes the same cell read from anywhere and so the form
 * worth copying. A root and a facet are containers rather than cells, and
 * render with the trailing slash their names carry. The scope renders here
 * rather than through the reference serializer, which emits no suffix for the
 * base scope.
 */
export function renderPlace(place: Place): string {
  return `position  ${renderPosition(place.position)}\n` +
    `scope     ${renderScope(place.scope)}`;
}

/**
 * The one owner of a shuttle's place: it holds where shuttle stands and where
 * it stood before, moves between them, and refuses what the design refuses.
 *
 * Per instance rather than per process, so that several places — tabs, split
 * views, an agent holding more than one — stay reachable.
 */
export class CurrentPlace {
  #place: Place;
  #previous: Place | undefined;

  /** Constructs an instance standing at `place`, with no previous place. */
  constructor(place: Place) {
    this.#place = place;
  }

  /** Where shuttle stands. */
  get place(): Place {
    return this.#place;
  }

  /** Where it stood before its last landed move, once there has been one. */
  get previous(): Place | undefined {
    return this.#previous;
  }

  /**
   * Moves as `operand` says, and returns what that did. The place changes only
   * where the move lands, so a refusal and an unsettled operand both leave
   * shuttle where it was.
   */
  cd(operand: string): Move {
    return this.#commit(movePlace(this.#place, operand, this.#previous));
  }

  /**
   * Moves into a target the fabric resolved, `operand` being the spelling that
   * named it. A target that resolved in another space is refused: one
   * connection serves one space.
   */
  enter(target: ResolvedTarget, operand: string): Move {
    return this.#commit(enterTarget(this.#place, target, operand));
  }

  /** What `pwd` prints for this place. */
  render(): string {
    return renderPlace(this.#place);
  }

  /** Helper for the movers, which adopts a move that landed. */
  #commit(move: Move): Move {
    if (move.kind === "moved") {
      this.#previous = this.#place;
      this.#place = move.place;
    }
    return move;
  }
}

/**
 * Where `operand` moves `place` to, `previous` being the place `-` returns to.
 *
 * The operand is read in the order the spellings can be told apart: `-` and a
 * scope-only `@scope` are shuttle's own navigation syntax, a rooted string is
 * a reference for the fabric's grammar to parse, a leading `#` is a wish
 * target, and anything else is a relative walk from where shuttle stands.
 */
function movePlace(place: Place, operand: string, previous?: Place): Move {
  const trimmed = operand.trim();
  if (trimmed === "") return refuse("`cd` takes a place to move to.");
  if (trimmed === "-") {
    return previous === undefined
      ? refuse("There is no previous place to return to.")
      : land(previous);
  }
  if (trimmed.startsWith("@")) return moveScope(place, trimmed.slice(1));

  let reference;
  try {
    reference = normalizeLLMFriendlyRef(trimmed, {
      space: place.position.space,
    });
  } catch (error) {
    return refuse(messageOf(error));
  }
  if (reference !== undefined) return moveByReference(place, reference);

  if (trimmed.startsWith("#")) return { kind: "wish", target: trimmed };
  return moveBySegments(place, trimmed);
}

/**
 * Where a `@scope` operand moves `place` to. `word` is the suffix without its
 * `@`, and the scopes it may name are the canonical grammar's own, so no
 * reference can carry a scope this refuses.
 */
function moveScope(place: Place, word: string): Move {
  if (!CELL_SCOPE_VALUES.has(word)) {
    return refuse(
      `\`@${word}\` names no scope. The scopes are \`@space\`, \`@user\`, ` +
        `and \`@session\`.`,
    );
  }
  return land({ ...place, scope: word as CellScope });
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
): Move {
  if (reference.input === true) {
    return refuse(
      "A place is result-rooted, so `cd` takes no `#argument` suffix. A " +
        "place rooted at the arguments cell would leave every later " +
        "relative read ambiguous about which side of the piece it " +
        "addressed. Reach arguments per operand instead, as in " +
        "`get topics/3#argument`.",
    );
  }
  const moved: Place = {
    position: {
      kind: "piece",
      space: place.position.space,
      piece: reference.pieceId,
      path: reference.path,
    },
    scope: reference.scope ?? place.scope,
  };
  return reference.embeddedSpace === undefined
    ? land(moved)
    : { kind: "space-by-name", name: reference.embeddedSpace, place: moved };
}

/**
 * Where a relative operand moves `place` to, one segment at a time. Each
 * segment is read against the level the one before it landed on, so `..` and a
 * descent compose in one operand.
 */
function moveBySegments(place: Place, operand: string): Move {
  const segments = operand.split("/");
  if (segments[segments.length - 1] === "") segments.pop();

  let moved = place;
  for (const segment of segments) {
    if (segment === "") {
      return refuse(`\`${operand}\` has an empty segment.`);
    }
    const step = segment === ".." ? moveUp(moved) : moveDown(moved, segment);
    if (step.kind !== "moved") return step;
    moved = step.place;
  }
  return land(moved);
}

/** Where `..` moves `place` to: out of the level it stands in. */
function moveUp(place: Place): Move {
  const position = place.position;
  switch (position.kind) {
    case "root":
      return land(place);
    case "facet":
      return land({
        ...place,
        position: { kind: "root", space: position.space },
      });
    case "piece":
      if (position.path.length > 0) {
        return land({
          ...place,
          position: { ...position, path: position.path.slice(0, -1) },
        });
      }
      return land({
        ...place,
        position: position.facet === undefined
          ? { kind: "root", space: position.space }
          : { kind: "facet", space: position.space, facet: position.facet },
      });
  }
}

/**
 * Where one relative segment moves `place` to: a facet at a space root, a
 * piece inside a facet, and a data key or index inside a piece.
 */
function moveDown(place: Place, segment: string): Move {
  const position = place.position;
  switch (position.kind) {
    case "root":
      return isFacet(segment)
        ? land({
          ...place,
          position: { kind: "facet", space: position.space, facet: segment },
        })
        : refuse(
          `A space root lists facets, and \`${segment}\` names none. The ` +
            `facets are \`slugs/\` and \`pieces/\`.`,
        );
    case "facet":
      return moveIntoPiece(place, position, segment);
    case "piece":
      return land({
        ...place,
        position: {
          ...position,
          path: [...position.path, linkPathSegmentToCellPathSegment(segment)],
        },
      });
  }
}

/**
 * Where a segment naming a piece inside `facet` moves `place` to. The segment
 * is the one a scope suffix may ride, since that is where the canonical
 * grammar carries it, and a suffix here moves the scope half of the place.
 */
function moveIntoPiece(
  place: Place,
  facet: FacetPosition,
  segment: string,
): Move {
  let scoped;
  try {
    scoped = parseScopedIdSegment(segment);
  } catch (error) {
    return refuse(messageOf(error));
  }
  return land({
    position: {
      kind: "piece",
      space: facet.space,
      piece: scoped.id,
      path: [],
      facet: facet.facet,
    },
    scope: scoped.scope ?? place.scope,
  });
}

/**
 * Where a resolved target moves `place` to, `operand` being the spelling that
 * named it. A target that resolved in another space — which is what a
 * home-anchored entry point does whenever the reading identity's home space
 * is not the connected one — is refused: one connection serves one space.
 */
function enterTarget(
  place: Place,
  target: ResolvedTarget,
  operand: string,
): Move {
  if (target.space !== place.position.space) {
    return refuse(
      `\`${operand}\` resolves in space \`${target.space}\`, and this ` +
        `shuttle is connected to \`${place.position.space}\`. One ` +
        `connection serves one space.`,
    );
  }
  return land({
    ...place,
    position: {
      kind: "piece",
      space: target.space,
      piece: target.piece,
      path: target.path ?? [],
    },
  });
}

/** Whether `segment` names one of the facets a space root lists. */
function isFacet(segment: string): segment is Facet {
  return (FACETS as readonly string[]).includes(segment);
}

/** Helper for the movers, which builds a refusal carrying `reason`. */
function refuse(reason: string): Move {
  return { kind: "refused", reason };
}

/** Helper for the movers, which builds a move that landed on `place`. */
function land(place: Place): Move {
  return { kind: "moved", place };
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
      return encodeJsonPointer(["", space, ""]);
    case "facet":
      return encodeJsonPointer(["", space, position.facet, ""]);
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
