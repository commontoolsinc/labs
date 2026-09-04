/**
 * The verbs a line names, and the dispatch that picks one.
 *
 * A verb returns what it did rather than writing it: a place that moved, a
 * rendering shuttle composed, a value the fabric holds, or a refusal carrying
 * its reason.
 * Nothing here touches a terminal, so where any of it lands is the prompt's
 * decision and a test drives the whole surface with none.
 *
 * The reads are `packages/cli`'s, over the connection this process holds:
 * `getCellValue` for `get`, `readWish` for `wish` and for the `#name` targets
 * `cd` navigates, and `listing.ts`'s composition for `ls`. Each takes that
 * connection through `deps.loadPieces`, which is the seam a held connection
 * fills.
 *
 * Two spellings come back off a `cd` or a `get` unsettled, because settling
 * them is a read: a `#name` target, which the fabric resolves to an address,
 * and a space written as a name, which the connection is asked about. Settling
 * each and asking the place again is what this module adds to `place.ts`,
 * which decides everything about a place that a value can decide and stops
 * exactly there.
 */

import {
  LINK_MARKER_KEY,
  parseCellSelectionOptions,
} from "@commonfabric/cli/lib/cell-selection";
import { normalizeLLMFriendlyRef } from "@commonfabric/cli/lib/llm-friendly-ref";
import {
  getCellValue,
  type PieceConfig,
  type SpaceConfig,
} from "@commonfabric/cli/lib/piece";
import { projectWishValue, readWish } from "@commonfabric/cli/lib/wish";
import { isDID } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";

import type { HeldConnection } from "./connection.ts";
import { splitLine } from "./line.ts";
import { type ListingDeps, listPlace, renderListing } from "./listing.ts";
import {
  CurrentPlace,
  type FacetPosition,
  type Move,
  type Place,
  type ResolvedTarget,
  type SpaceRootPosition,
} from "./place.ts";

/**
 * What `--select` writes to ask a read for the address of what it resolved,
 * rather than for its value. It is the flag's own spelling, parsed by the
 * parser that reads the flag, so what `cd` asks a wish for is what
 * `cf wish --select '@'` asks it.
 */
const ADDRESS_SELECT = "@";

/** What running a line did. */
export type Outcome =
  /** The line named no verb, which is not a mistake and did nothing. */
  | { readonly kind: "nothing" }
  /** The place moved, and `place` is where shuttle now stands. */
  | { readonly kind: "moved"; readonly place: Place }
  /** The verb composed `text`, which is the whole of what it produced. */
  | { readonly kind: "text"; readonly text: string }
  /** The verb read `value` out of the fabric. */
  | { readonly kind: "value"; readonly value: unknown }
  /** The line is refused, for the reason given. */
  | { readonly kind: "refused"; readonly reason: string };

/**
 * The running shuttle a verb acts on: where it stands, what it connects as,
 * and the connection it holds.
 */
export interface Shuttle {
  /** What this process connects as, which every read rides. */
  readonly config: SpaceConfig;

  /** Where shuttle stands, which `cd` moves and every other verb reads. */
  readonly place: CurrentPlace;

  /** The one connection this process holds. */
  readonly connection: HeldConnection;
}

/**
 * What a verb reads through. A caller supplies its own to drive this module
 * with nothing behind it.
 */
export interface VerbDeps {
  /** Reads the value at a cell path, which is what `get` returns. */
  readonly getCellValue?: typeof getCellValue;

  /** Resolves a named entry point, for `wish` and for `cd` into one. */
  readonly readWish?: typeof readWish;

  /** The reads `ls` composes. */
  readonly listing?: ListingDeps;
}

/**
 * Runs `line` against `shuttle` and returns what that did.
 *
 * The line splits by `splitLine`, its first token names a verb, and the rest
 * are that verb's operands. A line with no token at all did nothing; one whose
 * first token names no verb is refused, and the refusal names it and lists
 * what would have been taken.
 *
 * A refusal is a fact about the line — a verb nobody defined, an operand a
 * place will not take, a target that resolves elsewhere — and every one
 * carries the reason. A read that failed is a different fact and is not one
 * of these: it raises, so that a server that cannot be reached is told apart
 * from a line that was wrong.
 *
 * @throws Whatever a read throws — an unreachable server, an identity that
 * will not load, a path the piece refuses.
 */
export async function runLine(
  line: string,
  shuttle: Shuttle,
  deps: VerbDeps = {},
): Promise<Outcome> {
  const split = splitLine(line);
  if (split.kind === "refused") return refuse(split.reason);
  const [word, ...operands] = split.tokens;
  if (word === undefined) return { kind: "nothing" };
  const verb = VERBS.get(word);
  if (verb === undefined) {
    return refuse(
      `\`${word}\` is not a verb. The verbs are ${listed([...VERBS.keys()])}.`,
    );
  }
  return await verb(shuttle, operands, deps);
}

/** What a verb does with the operands written after its name. */
type Verb = (
  shuttle: Shuttle,
  operands: readonly string[],
  deps: VerbDeps,
) => Outcome | Promise<Outcome>;

/**
 * Moves the place as `operands` say, and returns where shuttle now stands.
 *
 * The operand is `place.ts`'s to read, and the two spellings it hands back
 * unsettled are settled here: a `#name` target resolves against the fabric,
 * and a space written as a name is held against the name the connection was
 * opened under.
 */
async function cd(
  shuttle: Shuttle,
  operands: readonly string[],
  deps: VerbDeps,
): Promise<Outcome> {
  const tooMany = takesAtMostOne("cd", operands);
  if (tooMany !== undefined) return tooMany;
  // The empty operand rather than a refusal of this module's own: `cd` with
  // nothing after it and `cd ''` are one operand by the time a place reads
  // them, and the place says what it takes.
  return await landing(shuttle, shuttle.place.cd(operands[0] ?? ""), deps);
}

/**
 * Reads the value at the cell `operands` name, which is where shuttle stands
 * where they name nothing.
 *
 * The operand is read through the door `cd` reads one through, plus the
 * `#argument` suffix that door turns down: standing in an arguments cell is
 * what a result-rooted place cannot do, and reading one is a different act
 * that `cf cell get` performs too.
 *
 * A container is refused rather than read: a space root and a facet are lists
 * of what stands inside them and hold no value of their own.
 */
async function get(
  shuttle: Shuttle,
  operands: readonly string[],
  deps: VerbDeps,
): Promise<Outcome> {
  const tooMany = takesAtMostOne("get", operands);
  if (tooMany !== undefined) return tooMany;
  const operand = operands[0];
  if (operand === undefined) {
    return await read(shuttle, shuttle.place.place, false, deps);
  }
  const aim = shuttle.place.aim(operand);
  const where = await reading(shuttle, aim.move, deps);
  return where.kind === "refused"
    ? where
    : await read(shuttle, where.place, aim.input, deps);
}

/** Lists what stands where shuttle stands. */
async function ls(
  shuttle: Shuttle,
  operands: readonly string[],
  deps: VerbDeps,
): Promise<Outcome> {
  const tooMany = takesNothing("ls", operands);
  if (tooMany !== undefined) return tooMany;
  const listing = await listPlace(
    shuttle.config,
    shuttle.place.place,
    shuttle.connection,
    deps.listing,
  );
  return { kind: "text", text: renderListing(listing) };
}

/** Returns where shuttle stands, both halves of the pair. */
function pwd(shuttle: Shuttle, operands: readonly string[]): Outcome {
  const tooMany = takesNothing("pwd", operands);
  return tooMany ?? { kind: "text", text: shuttle.place.render() };
}

/**
 * Reads the value a named entry point resolves to.
 *
 * The resolution is the fabric's own (`readWish`), so a target this answers
 * is one `cf wish` answers, and a target that resolved against another space
 * is answered rather than refused: reading across spaces costs nothing, where
 * standing in one is what a single connection cannot do.
 */
async function wish(
  shuttle: Shuttle,
  operands: readonly string[],
  deps: VerbDeps,
): Promise<Outcome> {
  const tooMany = takesAtMostOne("wish", operands);
  if (tooMany !== undefined) return tooMany;
  const target = operands[0];
  if (target === undefined) {
    return refuse(
      "`wish` takes the target to resolve, as in `wish #favorites`.",
    );
  }
  const { result, error } = await (deps.readWish ?? readWish)({
    ...shuttle.config,
    query: target,
  }, { loadPieces: () => shuttle.connection.pieces() });
  if (result === null && error !== undefined) {
    return refuse(`\`${target}\` resolved to nothing: ${error}`);
  }
  // The same walk `cf wish` renders through. A resolved object carries its
  // pattern's stream handles, and through them the runtime's whole object
  // graph, so what comes back is the plain data with each handle written as a
  // marker.
  return { kind: "value", value: projectWishValue(result) };
}

/**
 * The verbs, by the word that names one. It is the one record of what a line
 * may say, so the refusal listing them lists exactly what the dispatch takes.
 *
 * A `Map` rather than an object, because an object answers for every key
 * `Object.prototype` carries as well as for its own: `toString` and
 * `constructor` are words a person can type, and looked up on an object each
 * hands back a function the dispatch would then call with a shuttle. A `Map`
 * holds what was put in it and nothing else, so the word that names no verb
 * has no answer to give rather than one that has to be guarded against.
 */
const VERBS: ReadonlyMap<string, Verb> = new Map<string, Verb>([
  ["cd", cd],
  ["get", get],
  ["ls", ls],
  ["pwd", pwd],
  ["wish", wish],
]);

/**
 * Helper for {@link cd}, which finishes `move`.
 *
 * A landing and a refusal are the answer already. The two arms only a read can
 * settle are settled and the place asked again, which answers: a resolved
 * target and a confirmed space each land or refuse, so neither second ask
 * comes back with another arm to settle.
 */
async function landing(
  shuttle: Shuttle,
  move: Move,
  deps: VerbDeps,
): Promise<Outcome> {
  switch (move.kind) {
    case "moved":
      return { kind: "moved", place: move.place };
    case "refused":
      return move;
    case "wish": {
      const resolved = await resolveTarget(shuttle, move.target, deps);
      return resolved.kind === "refused" ? resolved : await landing(
        shuttle,
        shuttle.place.enter(resolved.target, move.target),
        deps,
      );
    }
    case "space-by-name": {
      const named = await connectedSpace(shuttle, move.name);
      return named.kind === "refused" ? named : await landing(
        shuttle,
        shuttle.place.settle(move, named.space),
        deps,
      );
    }
  }
}

/** A refusal, which is an arm of every outcome this module has. */
type Refusal = { readonly kind: "refused"; readonly reason: string };

/** Where an operand names, or the reason it names nothing to read. */
type Reading =
  /** The operand names `place`. */
  | { readonly kind: "place"; readonly place: Place }
  | Refusal;

/** What resolving a named entry point produced. */
type Targeting =
  /** The target resolved to the address `target` names. */
  | { readonly kind: "target"; readonly target: ResolvedTarget }
  | Refusal;

/**
 * Helper for {@link get}, which finishes `move` without moving.
 *
 * A space written as a name is settled the way {@link landing} settles one. A
 * `#name` target is not: `cf cell get` takes no such target and `cf wish`
 * does, and a data verb here means what it means there, so the refusal names
 * the verb that reads one. Resolving it here would answer a second way as
 * well as a second time — `wish` hands back what the fabric resolved with its
 * handles written as markers, and a cell read of the same address hands back
 * the raw value.
 *
 * That is the `#argument` suffix's opposite and for a reason that is not
 * arbitrary. The suffix says which of a piece's two cells to read and the
 * place it rides is reachable either way, so refusing it would put a cell out
 * of reach; a `#name` is a whole target with a verb of its own, so taking it
 * would put a second answer in reach. The two share the character and nothing
 * else (`docs/plans/shuttle/grammar.md`).
 */
async function reading(
  shuttle: Shuttle,
  move: Move,
  deps: VerbDeps,
): Promise<Reading> {
  switch (move.kind) {
    case "moved":
      return { kind: "place", place: move.place };
    case "refused":
      return move;
    case "wish":
      return {
        kind: "refused",
        reason: `\`${move.target}\` names an entry point rather than a cell ` +
          `under this place. \`wish ${move.target}\` reads what it resolves ` +
          `to.`,
      };
    case "space-by-name": {
      const named = await connectedSpace(shuttle, move.name);
      return named.kind === "refused" ? named : await reading(
        shuttle,
        shuttle.place.resolveNamedSpace(move, named.space),
        deps,
      );
    }
  }
}

/**
 * Helper for {@link get}, which is the value at `place`, in the piece's
 * arguments cell where `input` says so and in its result otherwise.
 *
 * The piece, the path and the scope all ride the config, as they do for a
 * listing, so a slug stands unresolved in the place and the read resolves it
 * the way `--cell` does. The read does not start the piece, so a computed
 * value is as fresh as the last thing that ran the pattern.
 */
async function read(
  shuttle: Shuttle,
  place: Place,
  input: boolean,
  deps: VerbDeps,
): Promise<Outcome> {
  const position = place.position;
  if (position.kind !== "piece") {
    return refuse(
      `${container(position)} is a list of what stands inside it rather ` +
        `than a cell, so it holds no value. \`ls\` lists it.`,
    );
  }
  const pieceConfig: PieceConfig = {
    ...shuttle.config,
    piece: position.piece,
    pieceScope: place.scope,
  };
  const value = await (deps.getCellValue ?? getCellValue)(
    pieceConfig,
    [...position.path],
    { input },
    { loadPieces: () => shuttle.connection.pieces() },
  );
  return { kind: "value", value };
}

/**
 * Helper for {@link landing}, which is the address the fabric resolved
 * `target` to.
 *
 * The resolution asks `readWish` for the target's address rather than its
 * value, which is what `--select` spells `@`: a marked position answers with
 * the reference naming it, and that reference carries the space in front
 * whenever the target resolved outside the space the read went to. That is
 * the whole of what a home-anchored target needs in order to be refused for
 * the right reason — the space is in the answer, so nothing has to know which
 * targets are anchored where.
 */
async function resolveTarget(
  shuttle: Shuttle,
  target: string,
  deps: VerbDeps,
): Promise<Targeting> {
  const selection = await parseCellSelectionOptions({ select: ADDRESS_SELECT });
  const { result, error } = await (deps.readWish ?? readWish)({
    ...shuttle.config,
    query: target,
    selection,
  }, { loadPieces: () => shuttle.connection.pieces() });
  const address = addressIn(result);
  if (address === undefined) {
    return {
      kind: "refused",
      reason: error === undefined
        ? `\`${target}\` resolved to nothing.`
        : `\`${target}\` resolved to nothing: ${error}`,
    };
  }
  let reference;
  try {
    reference = normalizeLLMFriendlyRef(address);
  } catch (thrown) {
    return { kind: "refused", reason: messageOf(thrown) };
  }
  if (reference === undefined) {
    return {
      kind: "refused",
      reason: `\`${target}\` resolved to \`${address}\`, which is no ` +
        `reference: one is rooted, and this is not.`,
    };
  }
  const carried = reference.scope !== undefined
    ? `an \`@${reference.scope}\` suffix`
    : reference.input === true
    ? "the `#argument` suffix"
    : undefined;
  if (carried !== undefined) {
    return {
      kind: "refused",
      reason: `\`${target}\` resolved to an address carrying ${carried}, ` +
        `which a place reached through a target does not keep: a place holds ` +
        `one scope and roots at a result. Reach that cell by its own ` +
        `reference, \`${address}\`.`,
    };
  }
  const space = reference.embeddedSpace;
  if (space !== undefined && !isDID(space)) {
    return {
      kind: "refused",
      reason: `\`${target}\` resolved to an address naming space ` +
        `\`${space}\`, which is no DID. An address the fabric wrote names ` +
        `its space by DID or leaves it out.`,
    };
  }
  return {
    kind: "target",
    target: {
      space: space ?? shuttle.place.place.position.space,
      piece: reference.pieceId,
      // Back to the strings a resolution hands over. `ResolvedTarget` carries
      // the component type a link's own path has, and the place converts each
      // segment as it lands it, so a canonical index that arrived as a number
      // leaves as one.
      path: reference.path.map(String),
    },
  };
}

/**
 * Helper for {@link resolveTarget}, which is the reference a marked position
 * answered with, and nothing where `result` is not one.
 *
 * A marked position answers as one key on an object, so what a caller reads
 * back is the key `--select` writes rather than a bare string. Anything else
 * is a wish that resolved to no address at all.
 */
function addressIn(result: unknown): string | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const address = (result as Record<string, unknown>)[LINK_MARKER_KEY];
  return typeof address === "string" ? address : undefined;
}

/** What asking the connection about a space name produced. */
type Named =
  /** The name is this shuttle's own, and `space` is the space it holds. */
  | { readonly kind: "connected"; readonly space: MemorySpace }
  | Refusal;

/**
 * Helper for {@link landing} and {@link reading}, which is whether `name` is
 * the space this shuttle holds a connection to.
 *
 * The connection is asked rather than the name derived. A session opened by
 * name records it (`PiecesController.getSpaceName`), and one connection serves
 * one space, so the only thing a reference naming a space can want to know is
 * whether it names this one — for which the recorded name is the answer and a
 * key derivation on a navigation keystroke is a longer way round to it.
 *
 * The comparison is exact, and that is not an approximation of the derivation
 * but its own answer. A named space's key hangs off the name's bytes and
 * nothing else, so two names denote one space when they are one string; and
 * the reference reading has already put the operand's name in the form the
 * connection recorded, `decodeJsonPointer` having read back the `~1` a name
 * holding the separator is written with.
 *
 * A session opened by a DID recorded no name, and then there is no answer to
 * give: what the name denotes would take the derivation, and whether it
 * denotes this space is exactly what was asked. The refusal says so and says
 * what would answer it.
 */
async function connectedSpace(
  shuttle: Shuttle,
  name: string,
): Promise<Named> {
  const pieces = await shuttle.connection.pieces();
  const connected = pieces.getSpaceName();
  if (connected === undefined) {
    return refuse(
      `This shuttle names its space by DID, so it cannot say whether ` +
        `\`${name}\` is that space. One connection serves one space, and a ` +
        `shuttle started against \`${name}\` by name is what reaches that ` +
        `cell.`,
    );
  }
  if (connected !== name) {
    return refuse(
      `\`${name}\` is not the space this shuttle is connected to, which is ` +
        `\`${connected}\`. One connection serves one space, so reaching ` +
        `that cell means a shuttle started against \`${name}\`.`,
    );
  }
  return { kind: "connected", space: pieces.getSpace() };
}

/**
 * Helper for {@link read}, which names a container as a refusal opens with
 * it. A root and a facet are the only positions that are not a cell.
 */
function container(position: SpaceRootPosition | FacetPosition): string {
  return position.kind === "root" ? "A space root" : `\`${position.facet}/\``;
}

/**
 * Helper for the verbs, which refuses `operands` where `verb` takes none, and
 * returns nothing where it takes what it was given.
 */
function takesNothing(
  verb: string,
  operands: readonly string[],
): Outcome | undefined {
  return operands.length === 0 ? undefined : refuse(
    `\`${verb}\` takes no operand, and was given ${operands.length}.`,
  );
}

/**
 * Helper for the verbs, which refuses `operands` where `verb` takes at most
 * one, and returns nothing where it takes what it was given.
 */
function takesAtMostOne(
  verb: string,
  operands: readonly string[],
): Outcome | undefined {
  return operands.length <= 1 ? undefined : refuse(
    `\`${verb}\` takes one operand, and was given ${operands.length}.`,
  );
}

/**
 * Helper for {@link runLine}, which writes `words` as the English list a
 * refusal reads them in.
 */
function listed(words: readonly string[]): string {
  const marked = words.map((word) => `\`${word}\``);
  const last = marked.pop();
  return marked.length === 0 ? `${last}` : `${marked.join(", ")}, and ${last}`;
}

/** Helper for the verbs, which builds a refusal carrying `reason`. */
function refuse(reason: string): Refusal {
  return { kind: "refused", reason };
}

/** Helper for the verbs, which reads the message off a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
