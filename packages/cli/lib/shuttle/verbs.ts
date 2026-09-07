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
 * Three spellings come back off a `cd` unsettled, because settling each is a
 * read: a `#name` target, which the fabric resolves to an address; a space
 * written as a name, which the connection is asked about; and a place standing
 * on a piece, which the fabric is asked to resolve and to find. Settling each
 * and asking the place again is what this module adds to `place.ts`, which
 * decides everything about a place that a value can decide and stops exactly
 * there.
 *
 * The last of those is what makes `cd` worth its name. A shell's `cd` is the
 * one verb whose success says something, so the slug, the handle and the path
 * are each asked about before the place moves, and each refused in shuttle's
 * own words rather than left for the next verb to report in the runtime's.
 * What the prompt promises after it is exactly those three answers; the one
 * that can come back unanswered is the handle lookup, against a server that
 * does not advertise it. `get` waits on nothing: where an operand points is the
 * operand's own fact, and a read of a cell that is not there says so.
 */

import { isDID } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  resolvePieceReference,
  SlugResolutionError,
} from "@commonfabric/piece";

import { keysOf } from "../cell-listing.ts";
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
  type Aimed,
  CurrentPlace,
  type FacetPosition,
  messageOf,
  type Move,
  type PathSegment,
  type PendingMove,
  type PiecePlace,
  type PiecePosition,
  type Place,
  type ResolvedPlace,
  type ResolvedTarget,
  scopeMoveHint,
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
  | { readonly kind: "refused"; readonly reason: string }
  | Interruption;

/**
 * What a line that was cancelled comes back as: it stopped where it was, and
 * whatever it had not done yet it did not do.
 *
 * It is neither a refusal nor a failure. A refusal is a fact about the line —
 * it would have been wrong whenever it ran — and a failure is a fact about the
 * read; this is a fact about the person, who stopped waiting.
 */
export type Interruption = { readonly kind: "interrupted" };

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

  /**
   * Resolves the piece and path an operand named, which is what `cd` settles.
   * It is the resolution a read makes too (`pieceReferenceResolver`,
   * `lib/piece.ts`), so the two verbs reach the same cell for one reference.
   */
  readonly resolvePieceReference?: typeof resolvePieceReference;

  /** The reads `ls` composes. */
  readonly listing?: ListingDeps;

  /**
   * Cancels the line, which the prompt aborts on `ctrl-c`.
   *
   * What it can stop is what has not started, and the rule that makes that
   * a property rather than a list is: **every read has a check in front of
   * it with nothing awaited in between**, and so does every adoption. An
   * await between the two is a window the cancel lands in and the read goes
   * out of anyway, which is why the settle asks the holder for its
   * connection once and hands it down rather than asking again before each
   * read.
   *
   * The rule is what a caller can check, and it is checked: a case cancels
   * from inside each read there is and at each line's first suspension, and
   * asserts that nothing was read afterwards (`shuttle-verbs.test.ts`). That
   * observes the property instead of enumerating the boundaries, so a
   * boundary nobody thought of fails it too.
   *
   * What it cannot stop is a read already sent: the runtime's reads take no
   * signal, so one in flight finishes and its answer is dropped, and the
   * checks are what stop it taking effect on the way back.
   */
  readonly signal?: AbortSignal;
}

/**
 * Whether the line running under `deps` has been cancelled, as the outcome
 * that says so.
 *
 * A cancelled line's phases are checked rather than raced, so what comes back
 * from a verb is always something the verb actually decided. Racing is the
 * prompt's to do and it does it one layer up, where abandoning a line costs
 * nothing that a place could later be moved by.
 */
function stopped(deps: VerbDeps): Interruption | undefined {
  return deps.signal?.aborted === true ? { kind: "interrupted" } : undefined;
}

/** What an act guarded against a cancel did, where it was allowed to run. */
type Ran<T> = { readonly kind: "ran"; readonly answer: T };

/**
 * Performs `act` over `args` unless the line has been cancelled, and is what
 * it answered where it was allowed to.
 *
 * Every read this module sends and every move it adopts goes through here,
 * and the reason is that the rule they are held to is not one discipline can
 * keep. The rule is that **nothing is awaited between the check and the act
 * it guards** — an await there is a window the cancel lands in and the act
 * happens anyway — and a rule of that shape is invisible: the code reads
 * correctly whether or not the window is there, no case can see it, and the
 * next author to insert a line between two statements has no way to know
 * which two they are.
 *
 * So the two are one expression here instead. The arguments are evaluated
 * before this is entered, so a caller that awaits while composing them still
 * has the check on the far side of its own await; and there is no statement
 * position between the check and the call for an await to occupy, because
 * there are no statements between them. Passing `act` and its arguments
 * separately rather than as a closure is what leaves nowhere to hide one: a
 * closure has a body, and a body can await.
 *
 * What that is worth, stated at its actual size: it stops an await written as
 * a *statement*, which is how one gets written. It does not stop every
 * insertion an expression admits — `await (await something(), act(...args))`
 * reopens the window inside this very line, and nothing here would notice.
 * So this is a guarantee against the edit somebody makes, not against the
 * edit somebody constructs, and the cases are what cover the second: a line
 * cancelled at its first suspension reaches this function before its read,
 * and every verb that reads has such a case (`shuttle-verbs.test.ts`).
 *
 * What is left to the caller is which arm it returns, and the arms are the
 * outcome's own, so a cancelled act is handed back rather than tested for.
 */
async function guarded<A extends readonly unknown[], T>(
  deps: VerbDeps,
  act: (...args: A) => T | Promise<T>,
  ...args: A
): Promise<Ran<T> | Interruption> {
  // One expression, so that the check and the act it guards have no statement
  // position between them here either. This is the one place the rule lives
  // now, which is the point of it living somewhere rather than at every site.
  return stopped(deps) ?? { kind: "ran", answer: await act(...args) };
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
 * declared, an operand a place will not take, a target that resolves
 * elsewhere, a place the fabric does not hold — and every one carries the
 * reason. A read that failed is a different fact and is not one of these: it
 * raises, so that a server that cannot be reached is told apart from a line
 * that was wrong.
 *
 * A line cancelled through `deps.signal` comes back interrupted, which is a
 * third fact and not either of those. What that arm promises is what a check
 * can promise: nothing further was sent, and nothing was adopted. A read
 * already in flight is outside it and finishes into nothing.
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
      // A line already cancelled does not start. Everything above this is a
      // decision about the words, which is worth making either way — a line
      // that named no verb, or gave one the wrong number of operands, is not
      // a verb that was interrupted.
      return wrong ?? stopped(deps) ??
        await entry.run(shuttle, reading.operands, deps);
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
 * The operand is `place.ts`'s to read, and the spellings it hands back
 * unsettled are settled here: a `#name` target resolves against the fabric, a
 * space written as a name is held against the name the connection was opened
 * under, and a place standing on a piece is asked of the fabric before it is
 * adopted — the slug resolved to the handle the place then holds, and the path
 * found or refused with the keys that are there.
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
  if (at.kind !== "place") return at;
  return await read(shuttle, at.place, aim.input, deps);
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
  const listed = await guarded(
    deps,
    listPlace,
    shuttle.config,
    shuttle.place.place,
    shuttle.connection,
    deps.listing,
  );
  return listed.kind !== "ran"
    ? listed
    : { kind: "text", text: renderListing(listed.answer) };
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
  const answered = await guarded(deps, deps.readWish ?? readWish, {
    ...shuttle.config,
    query: target,
  }, { loadPieces: () => shuttle.connection.pieces() });
  if (answered.kind !== "ran") return answered;
  const { result, error } = answered.answer;
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
      "the\nprevious place, `/` for the space root, `.` for where you " +
      "stand, `./<ref>`\nfor a member and `.@scope` for the scope, " +
      "a rooted\nor complete reference, a slug, or a `#name` entry " +
      "point.\n\nA move onto a piece is read before it is taken: the slug " +
      "resolved, the\nhandle looked up in the space's index, and the path " +
      "found. A slug that\nnames nothing, a handle the index says the space " +
      "does not hold, and a path\nthat is not there are each refused here " +
      "rather than one command later, the\npath with the keys that are. A " +
      "server that does not answer the handle\nlookup leaves that one " +
      "unsettled.\n\nA target carrying `#argument` is refused: a place " +
      "roots at a result, and\n`get <ref>#argument` is how an operand reads " +
      "a piece's arguments cell.",
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
 * A landing and a refusal are the answer already. The arms only a read can
 * settle are settled and the place asked again, which answers or hands back
 * the one arm a settled one can still reach: a resolved target lands or
 * refuses, and a settled space name is a place standing on a piece, which is
 * settled the way any other is. A confirmed piece lands or refuses, so this
 * calls itself twice at most, and a space named by name is the operand that
 * takes both.
 *
 * The cancellation check on each arm comes before the adoption, and that is
 * the order that matters: adopting is what makes a `cd` a promise, so a line
 * the person stopped waiting for leaves the place where it was, however far
 * its reads had got. On the pending arm it is the check *after the settle's
 * own last read* — the walk of the path, which nothing inside {@link
 * settlePiece} follows — so it is the one a cancel arriving there meets, and
 * the earlier reads are stopped by the settle's own checks before they ever
 * reach here.
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
      if (resolved.kind !== "target") return resolved;
      const entered = await guarded(
        deps,
        shuttle.place.enter.bind(shuttle.place),
        resolved.target,
        move.target,
      );
      return entered.kind !== "ran"
        ? entered
        : await landing(shuttle, entered.answer, deps);
    }
    case "space-by-name": {
      const named = await connectedSpace(shuttle, move.name);
      if (named.kind === "refused") return named;
      const settled = await guarded(
        deps,
        shuttle.place.settle.bind(shuttle.place),
        move,
        named.space,
      );
      return settled.kind !== "ran"
        ? settled
        : await landing(shuttle, settled.answer, deps);
    }
    case "pending": {
      const settled = await settlePiece(shuttle, move, deps);
      if (settled.kind !== "settled") return settled;
      const confirmed = await guarded(
        deps,
        shuttle.place.confirm.bind(shuttle.place),
        move,
        settled.place,
      );
      return confirmed.kind !== "ran"
        ? confirmed
        : await landing(shuttle, confirmed.answer, deps);
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
  | Refusal
  | Interruption;

/** What settling a place against the fabric produced. */
type Settling =
  /** The fabric holds the place, as `place` resolved it. */
  | { readonly kind: "settled"; readonly place: ResolvedPlace }
  | Refusal
  | Interruption;

/** What the piece and path a pending move spelled turned out to be. */
type Resolved =
  | {
    /** Names this arm of {@link Resolved}. */
    readonly kind: "piece";

    /** Where the move lands, as the resolution answered it. */
    readonly place: ResolvedPlace;

    /**
     * Whether reaching it proved the space holds it. A slug reached its piece
     * through the index and a place already stood on one was settled before,
     * so both are held; a handle is a spelling and proves nothing on its own.
     */
    readonly held: boolean;
  }
  | Refusal
  | Interruption;

/**
 * Helper for {@link landing}, which asks the fabric whether it holds the place
 * `move` reached, and is the handle its piece resolved to where it does.
 *
 * Two questions, and each is asked only where there is one. The piece is
 * {@link resolvedPiece}'s. Then the path: one read of the cell at the deepest
 * level already stood at, walked segment by segment through the value it
 * returned, which names the first segment that is not there and the keys that
 * are — and no read at all where the move added no segment to a level already
 * confirmed, there being nothing left to look for.
 *
 * The read is the level above, never the destination, and that is what makes
 * every miss a refusal rather than a throw. A read aimed at a path the fabric
 * does not hold raises — that is what `get` reports and what tells a server
 * that went away from a line that was wrong — so a check aimed there would
 * report a wrong operand as a failed read. Aimed one level up it reads a cell
 * that is there, and what it finds is data rather than an error.
 *
 * A piece the resolution reached without proving — a handle, which is a
 * spelling and not a lookup — is looked up. `entityIdExists`
 * (`PiecesController`) tests one identifier against the space's own index
 * without selecting a stored value, which is what makes it affordable here,
 * and it is the same call `packages/fuse` asks before it projects an entity a
 * path named. A value read cannot stand in for it: a piece the space does not
 * hold reads as `undefined`, which is what an empty one reads as too.
 *
 * The lookup is a server capability and answers `undefined` where the server
 * does not advertise it (`entityIdLookup`, `packages/memory/v2.ts`). Then
 * nothing was learned and the move goes on, which is the one case left where
 * a handle the space does not hold is adopted — the bound `grammar.md`
 * records.
 *
 * Three reads means two boundaries between them, and a cancelled line is
 * checked at both: after the resolution, and after the lookup that only a
 * piece the resolution did not prove goes through. What each check promises
 * is what a check can — the read after it was never sent — and the walk, being
 * last, is followed by {@link landing}'s check instead, so a cancel arriving
 * during it stops the move rather than a read.
 *
 * @throws Whatever the read throws — an unreachable server, an identity that
 * will not load. A slug that names nothing is not one of those: it is a fact
 * about the line, so it comes back as a refusal.
 */
async function settlePiece(
  shuttle: Shuttle,
  move: PendingMove,
  deps: VerbDeps,
): Promise<Settling> {
  // The connection is asked for once and handed down, so that every read
  // below has a check in front of it with nothing awaited in between. Asking
  // twice would put an await between a check and the read it guards, which is
  // a window a cancel can land in — and the second ask answers off the
  // holder's memo anyway, the connection having been opened before the prompt
  // read its first line (`run.ts`).
  const pieces = await shuttle.connection.pieces();
  const resolved = await resolvedPiece(pieces, shuttle, move, deps);
  if (resolved.kind !== "piece") return resolved;
  const place = resolved.place;
  const settled: Settling = { kind: "settled", place };
  if (!resolved.held) {
    const held = await guarded(
      deps,
      pieces.entityIdExists.bind(pieces),
      place.piece,
    );
    if (held.kind !== "ran") return held;
    if (held.answer === false) {
      return refuse(
        `\`${move.operand}\` reaches no piece: this space holds none by the ` +
          `handle \`${place.piece}\`.`,
      );
    }
  }
  const path = place.path;
  const scope = place.scope ?? move.place.scope;
  const from = alreadyStoodAt(shuttle.place.place, {
    position: { ...move.place.position, piece: place.piece, path },
    scope,
  });
  if (from.length === path.length) return settled;
  const walked = await guarded(
    deps,
    deps.getCellValue ?? getCellValue,
    { ...shuttle.config, piece: place.piece, pieceScope: scope },
    [...from],
    {},
    { loadPieces: () => shuttle.connection.pieces() },
  );
  if (walked.kind !== "ran") return walked;
  let level = walked.answer;
  for (const segment of path.slice(from.length).map(String)) {
    const keys = keysOf(level);
    if (!keys.includes(segment)) {
      return refuse(noSuchKey(move.operand, segment, keys));
    }
    level = (level as Record<string, unknown>)[segment];
  }
  return settled;
}

/**
 * Helper for {@link settlePiece}, which is the piece `move` reached.
 *
 * A move that reaches the cell shuttle already stands at has no piece to
 * resolve, and none to look up either: that piece came through a settle of its
 * own. What counts as the same cell is {@link sameCell}'s, so the scope bears
 * on it as much as the id — a move to the same id under another scope is a
 * document nothing has asked about, and it resolves and looks up like any
 * other. A move spelling that same cell again, a key under it or a reference
 * naming it, moves the path and leaves the piece where it was.
 *
 * What the skip saves is a question rather than a round trip, and the
 * difference is worth stating because the cost argument for settling at all
 * was a read per `cd`. `resolvePieceReference` reads nothing for a handle: a
 * slug is a token with no colon in it, so the resolution hands a handle
 * straight back without reaching the runtime (`packages/piece/src/slugs.ts`).
 * The saving is that the seam is not reached where it has nothing to do —
 * which is a fact a caller standing its own resolution in can see, and one
 * this module should not make such a caller work around.
 *
 * Every other move resolves: a slug is a name the space's index holds, and
 * `resolvePieceReference` is what turns one into the piece it points at, given
 * the path so a slug naming a collection reaches its member — the resolution
 * every read here already makes per command, made once at the move instead, so
 * that what the place adopts is a piece the index cannot repoint underneath
 * it.
 */
async function resolvedPiece(
  pieces: Awaited<ReturnType<HeldConnection["pieces"]>>,
  shuttle: Shuttle,
  move: PendingMove,
  deps: VerbDeps,
): Promise<Resolved> {
  const spelled = move.place.position.piece;
  const path = move.place.position.path;
  const standing = shuttle.place.place;
  if (
    standing.position.kind === "piece" &&
    sameCell({ position: standing.position, scope: standing.scope }, move.place)
  ) {
    return { kind: "piece", place: { piece: spelled, path }, held: true };
  }
  let resolved;
  try {
    resolved = await guarded(
      deps,
      deps.resolvePieceReference ?? resolvePieceReference,
      pieces,
      spelled,
      path,
    );
  } catch (thrown) {
    if (!(thrown instanceof SlugResolutionError)) throw thrown;
    return refuse(
      `\`${move.operand}\` reaches no piece: ${messageOf(thrown)}`,
    );
  }
  if (resolved.kind !== "ran") return resolved;
  const reference = resolved.answer;
  return {
    kind: "piece",
    place: {
      piece: reference.piece,
      path: reference.pathAfter,
      ...(reference.scope === undefined ? {} : { scope: reference.scope }),
    },
    // The two differ exactly where a slug resolved, a handle being handed back
    // as it stands — so what the resolution reached is also what it proved.
    held: reference.piece !== spelled,
  };
}

/**
 * How one field of a place bears on whether a read has already confirmed it.
 *
 * Three roles rather than two, because the settle asks two questions of one
 * key and they divide the fields differently: whether the destination is the
 * *same cell* shuttle stands at, which decides that its piece needs no lookup,
 * and how much of its *path* is already read, which decides where the read
 * starts. A field is classified once and both questions pick it up.
 */
type Bearing =
  /** Equal, or the two are different cells. */
  | "same"
  /** The standing one must be a prefix of the destination's. */
  | "prefix"
  /** Neither: two places differing only here are one place. */
  | "neither";

/**
 * Which parts of a place decide that a read has already confirmed it.
 *
 * Every field of a piece position is classified here and the `satisfies` is
 * what makes that exhaustive: a field added to {@link PiecePosition} without a
 * line here does not compile. A key naming fewer fields than the decision
 * rests on calls two different places one, and the skip it drives then hands
 * back a place nothing read — which is the failure this whole settle exists to
 * end. Classifying one `false` is a decision a reviewer sees rather than an
 * absence nobody notices.
 *
 * - `kind` — a container is no place a piece's path descends from.
 * - `space` — one connection fixes it for a run, and every door refuses a
 *   position outside it, so a comparison could only ever hold.
 * - `piece` — which piece the path is inside. Two ids are two documents.
 * - `name` — not a level. A piece reached by slug and the same piece reached
 *   by handle are one cell, which is what resolving before adopting is for.
 * - `path` — how far in. This is the one field the comparison reads as a
 *   prefix rather than for equality, the destination being truncated to the
 *   standing depth before the two keys are built.
 */
const CONFIRMED_BY_POSITION = {
  kind: "same",
  space: "neither",
  piece: "same",
  name: "neither",
  path: "prefix",
} satisfies Record<keyof Required<PiecePosition>, Bearing>;

/**
 * The same classification for the place around the position, closed the same
 * way against {@link Place}.
 *
 * - `position` — expanded by {@link CONFIRMED_BY_POSITION}.
 * - `scope` — which document the piece's id names. One id at `@space` and the
 *   same id at `@session` are two, so a place confirmed at one is not
 *   confirmed at the other and the read has to happen again.
 */
const CONFIRMED_BY_PLACE = {
  position: "byField",
  scope: "same",
} satisfies Record<keyof Place, Bearing | "byField">;

/**
 * Helper for {@link settlePiece}, which is the deepest path a read may start
 * from: where shuttle stands, where `reached` extends it, and the piece's own
 * root otherwise.
 *
 * Where shuttle stands is a place a read already confirmed — every position
 * came through one — so the levels it names need no second read, and a `cd`
 * one key deeper reads that key's own level rather than the whole piece. A
 * move to another piece, to another scope, or one that went up before it came
 * down has nothing confirmed under it and starts at the root, which is where a
 * rooted reference has to start anyway.
 *
 * The prefix is tested by truncating the destination to the standing depth and
 * comparing the two keys, so every part of the decision is one the projections
 * classify and none of it is a comparison written out beside them.
 */
function alreadyStoodAt(
  standing: Place,
  reached: PiecePlace,
): readonly PathSegment[] {
  const from = standing.position;
  if (from.kind !== "piece") return [];
  const stood: PiecePlace = { position: from, scope: standing.scope };
  if (!sameCell(stood, reached)) return [];
  // The `prefix` fields. A standing longer than the destination's meets an
  // `undefined` where a segment would be, and no segment is one.
  const prefix = (Object.keys(CONFIRMED_BY_POSITION) as PositionField[])
    .filter((field) => CONFIRMED_BY_POSITION[field] === "prefix")
    .every((field) => {
      const one = from[field] as readonly PathSegment[];
      const other = reached.position[field] as readonly PathSegment[];
      return one.length <= other.length &&
        one.every((segment, index) => segment === other[index]);
    });
  return prefix ? from.path : [];
}

/**
 * Helper for {@link settlePiece} and {@link alreadyStoodAt}, which is whether
 * two places are the same cell by the fields the projections mark `same`.
 *
 * It is the question the piece's own lookup rests on. A destination that is
 * the cell shuttle already stands at was settled when shuttle arrived, so its
 * piece needs no second lookup; one that differs anywhere the projections call
 * decisive — the piece, the scope — is a document nothing has asked about.
 */
function sameCell(standing: PiecePlace, reached: PiecePlace): boolean {
  return confirmedKey(standing) === confirmedKey(reached);
}

/** The fields {@link CONFIRMED_BY_POSITION} classifies. */
type PositionField = keyof Required<PiecePosition>;

/**
 * Helper for {@link sameCell}, which is `place` reduced to the parts the
 * projections mark `same`, in a fixed order.
 */
function confirmedKey(place: PiecePlace): string {
  const parts: unknown[] = [];
  if (CONFIRMED_BY_PLACE.position === "byField") {
    const position = place.position;
    parts.push(
      (Object.keys(CONFIRMED_BY_POSITION) as PositionField[])
        .sort()
        .filter((field) => CONFIRMED_BY_POSITION[field] === "same")
        .map((field) => [field, position[field]]),
    );
  }
  if (CONFIRMED_BY_PLACE.scope === "same") parts.push(place.scope);
  return JSON.stringify(parts);
}

/**
 * Helper for {@link settlePiece}, which is the reason `segment` reaches no
 * cell, `keys` being what the level above it holds.
 *
 * Shuttle's own sentence rather than the runtime's, which the read one level
 * further down would have raised. What it says is what the runtime's says —
 * the key is not there, and here is what is — in the words the rest of the
 * shell refuses a line in, and as a refusal rather than as a failure, because
 * a place that is not there is a fact about the operand.
 */
function noSuchKey(
  operand: string,
  segment: string,
  keys: readonly string[],
): string {
  return `\`${operand}\` reaches no cell: \`${segment}\` is no key of the ` +
    `cell above it, ` +
    (keys.length === 0
      ? `which holds no keys at all.`
      : `whose keys are ${listed(keys)}.`) +
    scopeMoveHint(operand);
}

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
  move: Aimed,
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
  const answered = await guarded(
    deps,
    deps.getCellValue ?? getCellValue,
    pieceConfig,
    [...position.path],
    { input },
    { loadPieces: () => shuttle.connection.pieces() },
  );
  return answered.kind !== "ran"
    ? answered
    : { kind: "value", value: answered.answer };
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
  const answered = await guarded(deps, deps.readWish ?? readWish, {
    ...shuttle.config,
    query: target,
    selection,
  }, { loadPieces: () => shuttle.connection.pieces() });
  if (answered.kind !== "ran") return answered;
  const { result, error } = answered.answer;
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
    ? `an \`@${reference.scope}\` qualifier`
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
