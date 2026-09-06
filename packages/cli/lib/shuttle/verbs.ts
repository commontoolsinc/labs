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

import { isDID } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";

import {
  LINK_MARKER_KEY,
  parseCellSelectionOptions,
} from "../cell-selection.ts";
import { normalizeLLMFriendlyRef } from "../llm-friendly-ref.ts";
import { getCellValue, type PieceConfig, type SpaceConfig } from "../piece.ts";
import { projectWishValue, readWish } from "../wish.ts";
import { connectionEntries, type HeldConnection } from "./connection.ts";
import { renderVerbList, renderVerbPage, type VerbHelp } from "./help.ts";
import { splitLine } from "./line.ts";
import { type ListingDeps, listPlace, renderListing } from "./listing.ts";
import { readOptions } from "./options.ts";
import {
  CurrentPlace,
  type FacetPosition,
  messageOf,
  type Move,
  type Place,
  type ResolvedTarget,
  type SpaceRootPosition,
} from "./place.ts";
import { renderRecord } from "./record.ts";

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
 * The line splits by `splitLine`, its first token names a verb, and the tokens
 * after it are divided by `readOptions`: one opening with `-` is an option up
 * to a bare `--`, and every other one is an operand the verb reads. A line
 * with no token at all did nothing; one whose first token names no verb is
 * refused, and the refusal names it and lists what would have been taken.
 *
 * `--help` is an option every verb takes, and a line carrying it writes that
 * verb's page instead of running it, which is the same page `help <verb>`
 * writes.
 *
 * How many operands a verb takes is the table's too, so the count is held
 * here and no verb states one of its own.
 *
 * A refusal is a fact about the line — a verb nobody defined, an option nobody
 * declared, an operand a place will not take, a target that resolves elsewhere
 * — and every one carries the reason. A read that failed is a different fact
 * and is not one of these: it raises, so that a server that cannot be reached
 * is told apart from a line that was wrong.
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
  const [word, ...tokens] = split.tokens;
  if (word === undefined) return { kind: "nothing" };
  const entry = VERBS.get(word);
  if (entry === undefined) return refuse(notAVerb(word));
  const reading = readOptions(word, tokens);
  switch (reading.kind) {
    case "refused":
      return reading;
    case "help":
      return { kind: "text", text: renderVerbPage(entry) };
    case "read": {
      const wrong = wrongOperandCount(word, entry.arity, reading.operands);
      return wrong ?? await entry.run(shuttle, reading.operands, deps);
    }
  }
}

/**
 * How many operands a verb takes, and what one that needs an operand calls the
 * one it needs.
 *
 * The noun phrase rides the arity because the refusal for a missing operand is
 * the verb's own sentence and the count is the dispatch's rule: declaring them
 * together is what lets one reader enforce every verb's arity without every
 * verb's refusal collapsing into one wording.
 *
 * Taking no operand and taking an optional one are told apart by what a verb
 * does with none, which is why `optional` is an arm rather than the absence of
 * one: `get` reads where it stands and `help` lists the verbs, and neither is
 * a verb that was given too few.
 */
type Arity =
  /** No operand at all, so any is too many. */
  | { readonly operands: "none" }
  /** One at most, and what no operand means is the verb's own. */
  | { readonly operands: "optional" }
  /** One, needed, `names` being what the refusal for none calls it. */
  | { readonly operands: "required"; readonly names: string };

/** What a verb does with the operands written after its name. */
type Verb = (
  shuttle: Shuttle,
  operands: readonly string[],
  deps: VerbDeps,
) => Outcome | Promise<Outcome>;

/**
 * One verb: what running it does, how many operands it takes, and what `help`
 * says about it.
 */
interface VerbEntry extends VerbHelp {
  /** Runs the verb over the operands its line carried. */
  readonly run: Verb;

  /**
   * How many operands the verb takes, which the dispatch holds it to before
   * running it. A verb declares this and counts nothing itself, so one added
   * to the table is one whose operands are already counted at both ends.
   */
  readonly arity: Arity;
}

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
  // `cd ''` is one operand, so the dispatch passes it on and the place is what
  // answers it — in the sentence the dispatch composes for no operand at all,
  // so the two spellings read alike. That guard is `movePlace`'s own and
  // stands for the callers this one is not.
  return await landing(shuttle, shuttle.place.cd(operands[0]), deps);
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
  const operand = operands[0];
  if (operand === undefined) {
    return await read(shuttle, shuttle.place.place, false, deps);
  }
  const aim = shuttle.place.aim(operand);
  const at = await reading(shuttle, aim.move, deps);
  return at.kind === "refused"
    ? at
    : await read(shuttle, at.place, aim.input, deps);
}

/**
 * Lists the verbs, or writes the page of the one `operands` names.
 *
 * The list and the page read the same strings — each verb's own, held beside
 * what it does — so a verb's one-line summary is one string wherever it is
 * shown. A word that names no verb is refused in the sentence the dispatch
 * refuses one in: `help` is where a person goes when they are unsure what the
 * words are, so it is the door most likely to be given one that is not.
 */
function help(_shuttle: Shuttle, operands: readonly string[]): Outcome {
  const word = operands[0];
  if (word === undefined) {
    return { kind: "text", text: renderVerbList([...VERBS.values()]) };
  }
  const entry = VERBS.get(word);
  return entry === undefined
    ? refuse(notAVerb(word))
    : { kind: "text", text: renderVerbPage(entry) };
}

/** Lists what stands where shuttle stands. */
async function ls(
  shuttle: Shuttle,
  _operands: readonly string[],
  deps: VerbDeps,
): Promise<Outcome> {
  const listing = await listPlace(
    shuttle.config,
    shuttle.place.place,
    shuttle.connection,
    deps.listing,
  );
  return { kind: "text", text: renderListing(listing) };
}

/** Returns where shuttle stands, both halves of the pair. */
function pwd(shuttle: Shuttle): Outcome {
  return { kind: "text", text: shuttle.place.render() };
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
  const target = operands[0];
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
 * Returns the whole ambient record: what this process connects as, and where
 * it stands.
 *
 * It prints the record `pwd` prints, so the two share one format
 * (`record.ts`) and `pwd` is this minus the connection's dimensions. A
 * milestone that adds a dimension to the record adds it here.
 *
 * Nothing here reads. Every dimension is a value this process is already
 * holding, so a shuttle whose connection will not open still says what it was
 * launched as and where it stands — which is what a verb for saying where you
 * are should do.
 */
function where(shuttle: Shuttle): Outcome {
  return {
    kind: "text",
    text: renderRecord([
      ...connectionEntries(shuttle.config),
      ...shuttle.place.entries(),
    ]),
  };
}

/**
 * The verbs, by the word that names one. It is the one record of what a line
 * may say, so the refusal listing them lists exactly what the dispatch takes,
 * and `help` lists exactly the same set from the same entries.
 *
 * Each entry carries how many operands the verb takes, and what `help` says
 * about it, beside what running it does. So the three cannot drift: a verb
 * added here is a verb `help` lists and a verb the dispatch already refuses
 * too many operands for, and one whose behavior changes has its account of
 * itself in the same place.
 *
 * A `Map` rather than an object, because an object answers for every key
 * `Object.prototype` carries as well as for its own: `toString` and
 * `constructor` are words a person can type, and looked up on an object each
 * hands back a function the dispatch would then call with a shuttle. A `Map`
 * holds what was put in it and nothing else, so the word that names no verb
 * has no answer to give rather than one that has to be guarded against.
 */
const VERBS: ReadonlyMap<string, VerbEntry> = new Map<string, VerbEntry>([
  ["cd", {
    run: cd,
    arity: { operands: "required", names: "a place to move to" },
    usage: "cd <ref>",
    summary: "Moves the place, which fills in what a reference omits.",
    detail:
      "The operand is a relative segment, `..` for one level up, `-` for " +
      "the\nprevious place, `/` for the space root, a scope-only `@scope`, " +
      "a rooted\nor complete reference, a slug, or a `#name` entry " +
      "point.\n\nA target carrying `#argument` is refused: a place roots at " +
      "a result, and\n`get <ref>#argument` is how an operand reads a " +
      "piece's arguments cell.",
  }],
  ["get", {
    run: get,
    arity: { operands: "optional" },
    usage: "get [<ref>]",
    summary: "Reads the value at a cell, defaulting to where you stand.",
    detail: "The operand takes everything `cd` takes, plus the `#argument` " +
      "suffix\n`cd` turns down, which reads the piece's arguments cell " +
      "rather than its\nresult. A `#name` entry point is the one spelling " +
      "it does not take,\n`wish` being the verb that reads one.\n\nA space " +
      "root and a facet hold no value of their own and are refused;\n`ls` " +
      "lists what stands inside them.",
  }],
  ["help", {
    run: help,
    arity: { operands: "optional" },
    usage: "help [<verb>]",
    summary: "Lists the verbs, or writes the page of the one named.",
    detail: "`<verb> --help` writes the same page, and every verb takes that " +
      "option.",
  }],
  ["ls", {
    run: ls,
    arity: { operands: "none" },
    usage: "ls",
    summary: "Lists what stands where shuttle stands.",
    detail: "A space root lists its facets, `slugs/` the names the space's " +
      "index\nrecords, `pieces/` the space's pieces, and a cell the keys " +
      "directly\nunder it. A row that failed on its own account is still a " +
      "row and\ncarries what went wrong, where a read that failed outright " +
      "is no\nlisting at all and is reported as the failure it is.",
  }],
  ["pwd", {
    run: pwd,
    arity: { operands: "none" },
    usage: "pwd",
    summary: "Writes the complete address of the place, both dimensions.",
    detail:
      "It writes the scope even where it is the base, so what it prints " +
      "denotes\none cell wherever it is read. The prompt is the short " +
      "surface, and this\nis what to copy.",
  }],
  ["where", {
    run: where,
    arity: { operands: "none" },
    usage: "where",
    summary: "Writes the whole ambient record: connection and place.",
    detail:
      "Every dimension this process holds prints, one to a line: what it " +
      "connects\nas, and the two halves of the place `pwd` prints. Nothing " +
      "here reads, so\na shuttle whose connection will not open still says " +
      "what it was launched\nas and where it stands.",
  }],
  ["wish", {
    run: wish,
    arity: {
      operands: "required",
      names: "the target to resolve, as in `wish #favorites`",
    },
    usage: "wish <#name>",
    summary: "Resolves a named entry point, as `cf wish` does.",
    detail: "The resolution is the fabric's own, so a target this answers is " +
      "one\n`cf wish` answers. A target that resolved in another space is " +
      "answered\nrather than refused: reading across spaces costs nothing, " +
      "where\nstanding in one is what a single connection cannot do.",
  }],
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
  const connected = pieces.getSpaceName() ?? "";
  const asked = name;
  if (pieces.getSpaceName() === undefined) {
    return refuse(
      `This shuttle names its space by DID, so it cannot say whether ` +
        `\`${asked}\` is that space. One connection serves one space, and a ` +
        `shuttle started against \`${asked}\` by name is what reaches that ` +
        `cell.`,
    );
  }
  if (pieces.getSpaceName() !== name) {
    return refuse(
      `\`${asked}\` is not the space this shuttle is connected to, which is ` +
        `\`${connected}\`. One connection serves one space, so reaching ` +
        `that cell means a shuttle started against \`${asked}\`.`,
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
 * Helper for {@link runLine}, which refuses `operands` where a verb called
 * `verb` was given a number of them its `arity` does not take, and returns
 * nothing where it was given a number it does.
 *
 * The arms are written out one each and closed by a `never`, so an arm added
 * to {@link Arity} reds the type checker here rather than falling through to
 * a sentence written for a different one.
 */
function wrongOperandCount(
  verb: string,
  arity: Arity,
  operands: readonly string[],
): Outcome | undefined {
  const given = operands.length;
  switch (arity.operands) {
    case "none":
      return given === 0 ? undefined : tooMany(verb, "no operand", given);
    case "optional":
      return given <= 1 ? undefined : tooMany(verb, "one operand", given);
    case "required":
      if (given === 1) return undefined;
      return given === 0
        ? refuse(`\`${verb}\` takes ${arity.names}.`)
        : tooMany(verb, "one operand", given);
    default: {
      const unreached: never = arity;
      return unreached;
    }
  }
}

/**
 * Helper for {@link wrongOperandCount}, which refuses `given` operands for a
 * verb called `verb` that takes what `takes` names.
 */
function tooMany(verb: string, takes: string, given: number): Outcome {
  return refuse(`\`${verb}\` takes ${takes}, and was given ${given}.`);
}

/**
 * Helper for {@link runLine} and {@link help}, which is the reason `word`
 * names no verb, listing the words that do.
 *
 * One sentence for both doors, because they ask one question of a word: the
 * dispatch reads the first token of a line and `help` reads its operand, and
 * what is wrong with a word that names no verb is the same either way.
 */
function notAVerb(word: string): string {
  return `\`${word}\` is not a verb. The verbs are ` +
    `${listed([...VERBS.keys()])}.`;
}

/**
 * Helper for {@link notAVerb}, which writes `words` as the English list a
 * refusal reads them in.
 */
function listed(words: readonly string[]): string {
  const marked = words.map((word) => `\`${word}\``);
  const last = marked.pop();
  return marked.length === 0 ? `${last}` : `${marked.join(", ")}, and ${last}`;
}

/**
 * Helper for the verbs, which builds a refusal carrying `reason`.
 *
 * A reason is free to hold text the fabric wrote — a wish's error, an address
 * a target resolved to, the space that address named — none of which passed a
 * door. Holding it to the class a terminal acts on is the prompt's, at the one
 * point a reason becomes a line (`report`, `prompt.ts`), because a refusal
 * built as a literal rather than through here is still a refusal and reaches
 * the same place.
 */
function refuse(reason: string): Refusal {
  return { kind: "refused", reason };
}
