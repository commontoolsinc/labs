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
}

/**
 * Where in a space shuttle stands. A position answers which cell this is and
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
 * A move that worked out a place but not whether the space its reference named
 * by name is the connected one, which needs a session to derive a DID from a
 * name. Confirming that name — `validateEmbeddedSpaces` does it — and handing
 * this back to {@link CurrentPlace.settle} is what lands it.
 */
export interface SpaceNamedMove {
  /** Names this arm of {@link Move}. */
  readonly kind: "space-by-name";

  /** The space name the reference carried. */
  readonly name: string;

  /** Where the reference lands, in the scope the reference asked for. */
  readonly place: Place;
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
 * A leading `/` is what makes a string a reference, so it marks the one
 * position that is a cell. A piece therefore renders as a complete reference —
 * the form that denotes the same cell read from anywhere, and so the form
 * worth copying — while a root and a facet are containers and render without
 * one, which is what keeps a container's own rendering from resolving as a
 * piece whose slug happens to match. The scope renders here rather than
 * through the reference serializer, which emits no suffix for the base scope.
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
   * Lands a {@link SpaceNamedMove} whose space name the caller has confirmed
   * names the connected space. The place is adopted as the move worked it out,
   * scope included, which is what carries an `@scope` suffix through a
   * reference that also named its space by name.
   */
  settle(move: SpaceNamedMove): Move {
    return this.#commit(land(move.place, []));
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
  if (reference !== undefined) return moveByReference(place, reference);

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
  if (!CELL_SCOPE_VALUES.has(word)) {
    return refuse(
      `\`@${word}\` names no scope. The scopes are \`@space\`, \`@user\`, ` +
        `and \`@session\`.`,
    );
  }
  return land({ ...from.place, scope: word as CellScope }, from.trail);
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
): Step {
  if (reference.input === true) return refuseArgumentSuffix();
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
    ? land(moved, [])
    : { kind: "space-by-name", name: reference.embeddedSpace, place: moved };
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
    if (segment === "") {
      return refuse(`\`${operand}\` has an empty segment.`);
    }
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
    },
    scope: scoped.scope ?? place.scope,
  }, trail);
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
): Step {
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
