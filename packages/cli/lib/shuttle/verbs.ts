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
 * What a verb writes is bounded to one page (`page.ts`), and what did not fit
 * waits on the session beside the place for `more` (`session.ts`). Two verbs
 * write enough to need it — a listing of a populated space and the result of
 * a piece are each larger than a screen — and they take the same bound, so
 * `more` continues either without knowing which it is continuing.
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

import { ValidationError } from "@cliffy/command";
import type { CellScope } from "@commonfabric/api";
import { FabricSpecialObject } from "@commonfabric/data-model";
import { isDID } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  resolvePieceReference,
  SlugResolutionError,
} from "@commonfabric/piece";

import {
  callFromCommand,
  type PieceCallCLIOptions,
  pieceDescribeLines,
  verbListingNotes,
} from "../../commands/piece.ts";
import { keysOf } from "../cell-listing.ts";
import {
  type CellSelection,
  CellSelectionError,
  LINK_MARKER_KEY,
  parseCellSelectionOptions,
} from "../cell-selection.ts";
import { normalizeLLMFriendlyRef } from "../llm-friendly-ref.ts";
import {
  describePiece,
  executePieceCallable,
  getCellValue,
  linkPieces,
  LinkValidationError,
  listPieceCallables,
  partitionVerbListing,
  type PieceCallableListing,
  type PieceConfig,
  setCellValue,
  type SpaceConfig,
  warmPiece,
} from "../piece.ts";
import { projectWishValue, readWish } from "../wish.ts";
import { type Announce } from "./announce.ts";
import { connectionEntries, type HeldConnection } from "./connection.ts";
import { type Editing } from "./editor.ts";
import { resolveHandle } from "./handles.ts";
import { renderVerbList, renderVerbPage, type VerbHelp } from "./help.ts";
import { splitLine } from "./line.ts";
import { quoteToken } from "./line.ts";
import {
  type ListingDeps,
  type ListingHandles,
  listingLines,
  type ListingRow,
  listPlace,
  numbered,
  oneLine,
} from "./listing.ts";
import {
  optionFlag,
  optionNumber,
  optionString,
  readOptions,
  readsAsOption,
  type VerbOption,
  type VerbOptions,
} from "./options.ts";
import {
  ASSUMED_COLUMNS,
  ASSUMED_ROWS,
  heightFit,
  marker,
  type Page,
  type PageBound,
  pageOf,
  statusLine,
  wrapped,
} from "./page.ts";
import {
  type Aimed,
  CurrentPlace,
  escapeControlCharacters,
  escapeControlCharactersInJson,
  type FacetPosition,
  type HandleMove,
  holdsControlCharacter,
  messageOf,
  type Move,
  type PathSegment,
  type PendingMove,
  type PiecePlace,
  type PiecePosition,
  type Place,
  referenceForPlace,
  type ResolvedPlace,
  type ResolvedTarget,
  scopeMoveHint,
  type SpaceRootPosition,
} from "./place.ts";
import { renderRecord } from "./record.ts";
import { ShuttleSession } from "./session.ts";
import { renderValue } from "./value.ts";

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

  /**
   * What the lines before this one left behind: the handles the last listing
   * numbered, what `more` writes next, and which pieces this run has started.
   * It stands beside the place because `cd` neither resets nor carries any of
   * them (`session.ts`).
   */
  readonly session: ShuttleSession;

  /**
   * The session every call this run makes is invoked under, minted once at
   * startup and passed rather than derived.
   *
   * It is what makes an invocation id replayable, and one shuttle is one run —
   * exactly the span over which repeating an id should mean repeating a call.
   * A call that minted its own would be its own session, which is the same
   * thing as having none.
   */
  readonly invocationSession: string;
}

/**
 * What a verb reads through. A caller supplies its own to drive this module
 * with nothing behind it.
 */
export interface VerbDeps {
  /** Reads the value at a cell path, which is what `get` returns. */
  readonly getCellValue?: typeof getCellValue;

  /** Writes a value at a cell path, which is what `set` and `edit` do. */
  readonly setCellValue?: typeof setCellValue;

  /** Writes a reference at a cell path, which is what `link` does. */
  readonly linkPieces?: typeof linkPieces;

  /**
   * Starts the piece a verb is about to act on, which is reaching in warms
   * (decision 10). It is a read like the ones beside it: it resolves the
   * piece and syncs it, and it is what makes a computed value a verb reads
   * the value a running pattern holds.
   */
  readonly warmPiece?: typeof warmPiece;

  /** Lists a piece's callables, which is what `verbs` writes. */
  readonly listPieceCallables?: typeof listPieceCallables;

  /** Describes a piece, which is what `describe` writes. */
  readonly describePiece?: typeof describePiece;

  /**
   * Runs a call, which is `cf piece call`'s own action taken as a function.
   * What it contributes past intake is what `call` would otherwise write
   * again: the grammar of a callable's section, the invocation identity, the
   * wait control, the settlement bound, and the outcome rendering
   * (`docs/plans/shuttle/runtime-integration.md`).
   */
  readonly callFromCommand?: typeof callFromCommand;

  /**
   * Dispatches the callable the call resolved, which rides inside
   * {@link VerbDeps.callFromCommand} rather than beside it: it is where the
   * connection this process holds is handed down, and where the standard
   * input a prompt is reading keys off is refused.
   */
  readonly executePieceCallable?: typeof executePieceCallable;

  /**
   * Opens the person's editor on a value and returns what they saved, which
   * is the whole of what `edit` does that no other verb does.
   *
   * A caller that supplies none has no editor, and `edit` says so rather than
   * guessing at one: what runs an editor has to take the terminal's raw mode
   * off around it and put it back after, and only what opened the terminal
   * can (`run.ts`).
   */
  readonly editText?: (text: string) => Promise<Editing>;

  /**
   * Where a line's out-of-band writing goes: what a call publishes while it
   * is still in flight, which happens before there is an outcome to carry it.
   *
   * It is the sink a connection's own output already goes to (`announce.ts`),
   * so a call's dispatch announcement and a pattern's console reach one place
   * in the order they happened. A caller that supplies none drops them, which
   * is what a caller with no screen has to do with a line written above a
   * prompt that is not there.
   */
  readonly announce?: Announce;

  /** Resolves a named entry point, for `wish` and for `cd` into one. */
  readonly readWish?: typeof readWish;

  /**
   * Reads the projection options a data verb takes, which is the parser
   * `cf cell get` reads its own through (`lib/cell-selection.ts`).
   *
   * It is a seam like the reads beside it rather than a call, because what a
   * verb does with what it throws is a decision worth driving: a selection
   * this parser refuses is a fact about the line, and anything else it throws
   * is a fault, which `get` raises rather than turning into a refusal.
   */
  readonly parseCellSelectionOptions?: typeof parseCellSelectionOptions;

  /**
   * Resolves the piece and path an operand named, which is what `cd` settles.
   * It is the resolution a read makes too (`pieceReferenceResolver`,
   * `lib/piece.ts`), so the two verbs reach the same cell for one reference.
   */
  readonly resolvePieceReference?: typeof resolvePieceReference;

  /** The reads `ls` composes. */
  readonly listing?: ListingDeps;

  /**
   * How many rows the terminal shows, which is half of what bounds a page a
   * verb writes (`page.ts`). It is a function rather than a number so that a
   * window resized between two lines bounds the second one at the size it has
   * now, and it is a dep rather than a field of the shuttle because the screen
   * is something a verb writes to rather than part of where shuttle stands.
   *
   * A caller that supplies none gets {@link ASSUMED_ROWS}, which is what a
   * terminal that will not measure itself gets too, so a verb driven with
   * nothing behind it still bounds what it writes.
   */
  readonly rows?: () => number;

  /**
   * How many columns it shows, which is the other half: a line wider than the
   * terminal wraps, so what a page has to count is rows and what it is handed
   * is lines. A bound that took the width for granted would let one long value
   * fill the screen without ever reaching it.
   *
   * A caller that supplies none gets {@link ASSUMED_COLUMNS}, on the terms
   * {@link VerbDeps.rows} takes its assumption on.
   */
  readonly columns?: () => number;

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
export type Ran<T> = { readonly kind: "ran"; readonly answer: T };

/**
 * Performs `act` over `args` unless the line has been cancelled, and is what
 * it answered where it was allowed to.
 *
 * Every read a line sends and every move it adopts goes through here — this
 * module's, and the completion's beside it (`completion.ts`) — and the reason
 * is that the rule they are held to is not one discipline can keep. The rule is that **nothing is awaited between the check and the act
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
 * There are two checks and not one, and the second is what a caller relies on
 * without knowing it. The first stops the act; the second stops its *answer*,
 * because an act that was already in flight when the cancel arrived finishes
 * anyway — the runtime's reads take no signal — and everything a caller then
 * does with what it returned is an adoption. A `ran` therefore means the line
 * was live when the answer arrived, which is the reading the next author will
 * take from the name whether or not it were true; where it is false the
 * interruption comes back and the answer is dropped.
 *
 * What is left to the caller is which arm it returns, and the arms are the
 * outcome's own, so a cancelled act is handed back rather than tested for.
 * What it does *not* say is which of the two checks stopped an act — a caller
 * that has something to undo where the act ran needs that, and the one there
 * is spells the pair out itself ({@link edit}).
 */
export async function guarded<A extends readonly unknown[], T>(
  deps: VerbDeps,
  act: (...args: A) => T | Promise<T>,
  ...args: A
): Promise<Ran<T> | Interruption> {
  // One expression, so that the check and the act it guards have no statement
  // position between them here either. This is the one place the rule lives
  // now, which is the point of it living somewhere rather than at every site.
  const before = stopped(deps);
  if (before !== undefined) return before;
  const answer = await act(...args);
  // And one after, which is what makes `ran` mean live. Everything a caller
  // does with an answer is an adoption, and an adoption is exactly what a
  // cancel must stop; a caller holding a `ran` that had gone stale while the
  // act was in flight would write it into the session anyway.
  return stopped(deps) ?? { kind: "ran", answer };
}

/**
 * Runs `line` against `shuttle` and returns what that did.
 *
 * The line splits by `splitLine`, its first token names a verb, and the tokens
 * after it are divided by `readOptions` against the table that verb declares:
 * one opening with `-` is an option up to a bare `--`, and every other one is
 * an operand the verb reads. A line
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
  const reading = readOptions(
    word,
    tokens,
    entry.options,
    entry.arity.operands === "section",
  );
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
        await entry.run(shuttle, {
          options: reading.options,
          operands: reading.operands,
          ...(reading.section === undefined
            ? {}
            : { section: reading.section }),
        }, deps);
    }
  }
}

/**
 * What a completion offers where a token may stand.
 *
 * Three arms and no fourth, since what a v1 verb reads an operand as is a
 * reference or a verb name, and everything else is a word only the fabric
 * could supply: a `#name` entry point is resolved by a read of its own rather
 * than listed, so `wish` declares `nothing` and says so where it declares it.
 */
export type Candidates =
  /** The words that name a verb. */
  | "verbs"
  /** The children of the place, as the operands `cd` takes to reach them. */
  | "children"
  /** Nothing: no token this can name stands there. */
  | "nothing";

/**
 * How many operands a verb takes, what one that needs an operand calls the
 * one it needs, and what a completion offers for it.
 *
 * The noun phrase rides the arity because the refusal for a missing operand is
 * the verb's own sentence and the count is the dispatch's rule: declaring them
 * together is what lets one reader enforce every verb's arity without every
 * verb's refusal collapsing into one wording. What a completion offers rides
 * it for the tighter reason that it is the same slot: it is spellable on every
 * arm that has an operand and unspellable on the arm that has none, so a verb
 * taking operands cannot be written without deciding what completes them, and
 * one taking none cannot be given a decision that would never fire.
 *
 * `completes` is that decision, one candidate per operand position this
 * dispatch reads, in the order the operands are written. The list is as long
 * as the arm takes operands, so a two-operand verb cannot be declared with one
 * answer any more than it can be declared with none — which is what keeps the
 * rule a rule as arms are added, rather than one that held while every verb
 * took a single operand. A position past the end of the list takes nothing,
 * and a `section`'s tail is the only such position: it belongs to a grammar
 * this dispatch does not read, so there is nothing here to offer from.
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
  | {
    readonly operands: "optional";
    readonly completes: readonly [Candidates];
  }
  /** One, needed, `names` being what the refusal for none calls it. */
  | {
    readonly operands: "required";
    readonly names: string;
    readonly completes: readonly [Candidates];
  }
  /** Two, both needed, `names` being what a refusal calls the pair. */
  | {
    readonly operands: "pair";
    readonly names: string;
    readonly completes: readonly [Candidates, Candidates];
  }
  /**
   * `least` of them, needed, and then a tail this dispatch does not count.
   *
   * It is the arm for a verb whose operands run on into somebody else's
   * grammar: a `call` line carries the callable's own section, which is as
   * many words as that callable takes and no number this table could state.
   * What is still counted is the verb's own operands, which is what `least`
   * names, and `names` is what the refusal for too few calls them.
   *
   * A verb declaring it also reads its options this way — the parse stops at
   * the verb's first operand, and the bare `--` closes the section rather than
   * quoting an operand (`readOptions`, `options.ts`). The two go together
   * because they are one fact about the line: the words past the verb's own
   * operands are not this dispatch's to read. That is why `completes` names
   * the verb's own two positions and stops: the section past them is read by
   * the callable's schema, and this table has nothing to offer for it.
   */
  | {
    readonly operands: "section";
    readonly least: number;
    readonly names: string;
    readonly completes: readonly [Candidates, Candidates];
  };

/**
 * What a line said past the verb that named it: the options it set, by the
 * names the verb declared, and the operands after them.
 *
 * The two halves arrive together because they are one reading — `readOptions`
 * divides a line into exactly this pair — and because a verb that reads one
 * usually reads the other. Handing them over as one value is what keeps a
 * verb's signature still while verbs gain flags: `ls` grew an option without
 * `pwd` growing a parameter, and the call section a `call` will carry
 * (`docs/plans/shuttle/grammar.md`) is a third member of this rather than a
 * fourth argument.
 */
export interface VerbLine {
  /** What the line's options set, by name. */
  readonly options: VerbOptions;

  /** The operands after them, in the order they were written. */
  readonly operands: readonly string[];

  /**
   * The words past the bare `--`, for a verb that opens a section, and absent
   * for a verb that does not.
   *
   * Absent is the claim that the verb reads no section, so a verb that opens
   * one and was written no `--` carries an empty array instead: the two are
   * different lines, and only the second is a call whose section ran to the
   * end of what was typed.
   */
  readonly section?: readonly string[];
}

/** What a verb does with the line written after its name. */
type Verb = (
  shuttle: Shuttle,
  line: VerbLine,
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
  line: VerbLine,
  deps: VerbDeps,
): Promise<Outcome> {
  // `cd ''` is one operand, so the dispatch passes it on and the place is what
  // answers it — in the sentence the dispatch composes for no operand at all,
  // so the two spellings read alike. That guard is `movePlace`'s own and
  // stands for the callers this one is not.
  const moved = await landing(
    shuttle,
    shuttle.place.cd(line.operands[0]),
    deps,
  );
  // Nothing warms here. A move that reaches a piece warms on the way, inside
  // the settle and before the read that judges its path (`settlePiece`), and
  // the moves that land without a settle are the ones that return to a place
  // this run has already stood at — `..`, `-`, and a walk that ended where it
  // began — which the settle warmed when it first arrived.
  return moved;
}

/**
 * Reads the value at the cell `line` names, which is where shuttle stands
 * where it names nothing, and writes as much of it as a page holds.
 *
 * The operand is read through the door `cd` reads one through, plus the
 * `#argument` suffix that door turns down: standing in an arguments cell is
 * what a result-rooted place cannot do, and reading one is a different act
 * that `cf cell get` performs too.
 *
 * A container is refused rather than read: a space root and a facet are lists
 * of what stands inside them and hold no value of their own.
 *
 * The projection options are `cf cell get`'s, parsed by that command's own
 * parser and handed to that command's own read, so `--filter`, `--select` and
 * `--schema` mean here exactly what they mean there (decision 7). A projection
 * that will not parse is a fact about the line and is refused; one the value
 * will not take is a fact about the data and raises, which is the division
 * `cf` draws too.
 */
async function get(
  shuttle: Shuttle,
  line: VerbLine,
  deps: VerbDeps,
): Promise<Outcome> {
  let selection: CellSelection | undefined;
  try {
    selection = await (deps.parseCellSelectionOptions ??
      parseCellSelectionOptions)({
        filter: optionString(line.options, "filter"),
        select: optionString(line.options, "select"),
        schema: optionString(line.options, "schema"),
      });
  } catch (thrown) {
    if (!(thrown instanceof CellSelectionError)) throw thrown;
    return refuse(messageOf(thrown));
  }
  const operand = line.operands[0];
  const at = operand === undefined
    ? { kind: "place" as const, place: shuttle.place.place, input: false }
    : await aimed(shuttle, operand, deps);
  if (at.kind === "refused") return at;
  // Before the read and not after it, which is the whole point of warming: the
  // value a read serves is what a running pattern holds, so the pattern runs
  // first or the read serves what was last committed.
  const warmed = await warmAt(shuttle, at.place, deps);
  if (warmed !== undefined) return warmed;
  const value = await read(shuttle, at.place, at.input, selection, deps);
  if (value.kind !== "value") return value;
  // Writing what `more` continues is an adoption too, so it goes through the
  // guard rather than behind a check of its own: a line the person stopped
  // waiting for leaves the session to whichever line owns it now.
  const shown = await guarded(
    deps,
    written,
    shuttle,
    value,
    selection,
    optionFlag(line.options, "json"),
    deps,
  );
  return shown.kind !== "ran" ? shown : shown.answer;
}

/**
 * Helper for {@link ls} and {@link listVerbs}, which is the act of numbering a
 * listing's rows.
 *
 * Named rather than written inline at each caller so that the two number a
 * listing the same way, and called directly rather than through `guarded`:
 * it follows the check its caller's read already made, with nothing awaited
 * in between, which is the condition that check was making.
 */
function numbering(session: ShuttleSession, handles: ListingHandles): void {
  session.listed(handles);
}

/**
 * Helper for {@link get}, which is where `operand` points, read from where
 * shuttle stands and settling nothing.
 */
async function aimed(
  shuttle: Shuttle,
  operand: string,
  deps: VerbDeps,
): Promise<Aiming> {
  const aim = shuttle.place.aim(operand);
  const at = await reading(shuttle, aim.move, deps);
  return at.kind === "refused" ? at : { ...at, input: aim.input };
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
function help(_shuttle: Shuttle, line: VerbLine): Outcome {
  const word = line.operands[0];
  if (word === undefined) {
    return { kind: "text", text: renderVerbList([...VERBS.values()]) };
  }
  const entry = VERBS.get(word);
  return entry === undefined
    ? refuse(notAVerb(word))
    : { kind: "text", text: renderVerbPage(entry) };
}

/**
 * Lists what stands where shuttle stands, numbering the rows and writing one
 * page of them.
 *
 * Every row is numbered and every row's handle is recorded, page or no page:
 * what a page decides is how many of them are on the screen at once, and
 * `more` writes the rest under the numbers they already carry. So `%39` names
 * the same row whether it was written by the `ls` or by the `more` after it,
 * which is what decision 24 asks of a run's handles.
 *
 * `--limit` overrides the height rather than capping it, because a person who
 * asked for forty rows on a screen that shows twenty asked for forty.
 */
async function ls(
  shuttle: Shuttle,
  line: VerbLine,
  deps: VerbDeps,
): Promise<Outcome> {
  const limit = optionNumber(line.options, "limit");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return refuse(
      `\`ls --limit\` takes a whole number of rows above zero, and was ` +
        `given ${limit}.`,
    );
  }
  const place = shuttle.place.place;
  const warmed = await warmAt(shuttle, place, deps);
  if (warmed !== undefined) return warmed;
  const listed = await guarded(
    deps,
    listPlace,
    shuttle.config,
    place,
    shuttle.connection,
    deps.listing,
  );
  if (listed.kind !== "ran") return listed;
  // Everything from here is adoption — the numbering `%3` reads against, and
  // the continuation `more` writes next — and the check in front of it is the
  // one the read above already made on the way back. Nothing is awaited
  // between that check and these, which is the whole of the rule `guarded`
  // exists to keep; a second guard here would be the same check twice with no
  // suspension between them for a cancel to arrive in.
  numbering(shuttle.session, { place, rows: listed.answer.rows });
  const rendering = listingLines(listed.answer);
  return paged(
    shuttle,
    rendering.bound === undefined ? [] : [rendering.bound],
    rendering.rows,
    // A limit names rows of the listing, so it bounds the rows and nothing
    // else: the screen stops bounding the page, the person having asked for
    // that many rows rather than for that much screen, and the bound line and
    // the status line come out of neither — they are not rows of the listing.
    limit === undefined ? screenFit(deps) : {
      columns: measured(deps.columns?.(), ASSUMED_COLUMNS),
      entries: limit,
    },
  );
}

/**
 * Writes the next page of whatever did not fit on the last one.
 *
 * It continues a listing and its numbering, and a read's value just as
 * readily: what a page held back is lines either way, and the line that says
 * how many are left is the same line. What it never continues is the line
 * before last — a rendering that fit whole says so, and clears what was
 * waiting.
 *
 * It awaits nothing, so it needs no guard: the dispatch's own check is the
 * last thing before it and there is no suspension after that for a cancel to
 * arrive in.
 */
function more(
  shuttle: Shuttle,
  _line: VerbLine,
  deps: VerbDeps,
): Outcome {
  const continuation = shuttle.session.continuation;
  if (continuation === undefined) {
    return refuse(
      "`more` writes the rest of a listing or a value that did not fit on " +
        "one page, and nothing is waiting.",
    );
  }
  return paged(
    shuttle,
    [],
    continuation.lines,
    screenFit(deps),
    continuation.hint,
  );
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
  line: VerbLine,
  deps: VerbDeps,
): Promise<Outcome> {
  const target = line.operands[0];
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
 * Writes the value the line's second operand spells at the cell its first
 * names, and says where it landed.
 *
 * The path is read through the door `get` reads one through, the `#argument`
 * suffix included, so `set title#argument x` writes the arguments cell exactly
 * as `--input` does for `cf cell set`.
 *
 * The write refuses to land on a whole cell. Only resolution can decide that —
 * an address naming a collection spends its leading segments reaching the
 * member, so a path can still resolve to a piece's root — so the refusal is
 * the seam's, in the seam's own words.
 */
async function set(
  shuttle: Shuttle,
  line: VerbLine,
  deps: VerbDeps,
): Promise<Outcome> {
  // The dispatch holds this verb to two operands before it runs
  // (`wrongOperandCount`), so both are there. Saying so is what keeps a value
  // from being invented for a line that cannot reach here: the empty operand
  // means something of its own, and standing it in for a missing one would
  // aim the write at a key nobody named.
  const [path, written] = line.operands as [string, string];
  const value = valueOf(written);
  if (value.kind === "refused") return value;
  const at = await writable(shuttle, path, "set", deps);
  if (at.kind !== "aimed") return at;
  const warmed = await warm(shuttle, at.place, deps);
  if (warmed !== undefined) return warmed;
  const position = at.place.position;
  const config = pieceConfigOf(shuttle, position, at.place.scope);
  let landed;
  try {
    const wrote = await guarded(
      deps,
      deps.setCellValue ?? setCellValue,
      config,
      [...position.path],
      value.value,
      { input: at.input, refuseRootWrite: true },
      { loadPieces: () => shuttle.connection.pieces() },
    );
    if (wrote.kind !== "ran") return wrote;
    landed = wrote.answer;
  } catch (thrown) {
    if (thrown instanceof ValidationError) return refuse(messageOf(thrown));
    throw thrown;
  }
  return wroteAt(landed, at.input);
}

/**
 * Opens the value at the cell the line's operand names — where shuttle stands
 * where it names none — in the person's editor, and writes back what they
 * saved.
 *
 * The value goes out as JSON and comes back as JSON, so what is edited is what
 * a write takes. That is a different question from what `get` prints, and the
 * two have different answers on purpose: the prompt writes `undefined` as a
 * word and a `bigint` as a marked object, neither of which parses back as the
 * value it names.
 *
 * A value JSON cannot carry is refused before the editor opens, and that is
 * the whole of what stands between this and a destructive write. A cell holds
 * things JSON does not: an explicit `undefined` under a key, which the runtime
 * keeps and holds distinct from a removed key
 * (`packages/runner/test/undefined-values.test.ts`), an array hole, a
 * registry-interned symbol and a `bigint`, both of which survive a commit and
 * a cold replica
 * (`packages/runner/test/action-result-fabric-values.test.ts`). Serializing
 * and parsing back drops the first and the fourth, turns the second and the
 * third into `null`, and throws on the fifth — so a round trip through JSON
 * would write a value the person never typed and report it as a success.
 * {@link unwritableInJson} finds all of them first.
 *
 * What it does not do is invent a lossless spelling. Tagging those values so
 * they survive would change what `edit` writes for a value that legitimately
 * holds the tag, which is the question issue #6944 carries for `get` and is
 * not this verb's to settle.
 *
 * Four things stop the write, and each leaves the cell as it was. A value JSON
 * cannot carry is refused above. An editor that did not finish is the editor's
 * own refusal, carried through. Text that came back unchanged is nothing to
 * write, and says so. Text that will not parse is refused with the parse error
 * and the file it is still in.
 *
 * What decides the file's fate is not which of those happened but whether the
 * cell took the text: the file is removed exactly where it holds nothing the
 * cell does not. So a write that landed removes it, and so does a cancel the
 * write outran, the cell holding the text either way; a parse that failed, a
 * write the seam turned down, and a cancel that arrived before the write all
 * keep it, being the arms where the only copy of the work is the file. Text
 * that came back unchanged removes it too, there being no work in it.
 */
async function edit(
  shuttle: Shuttle,
  line: VerbLine,
  deps: VerbDeps,
): Promise<Outcome> {
  const editText = deps.editText;
  if (editText === undefined) {
    return refuse(
      "No editor is reachable from here, so there is nothing to open the " +
        "value in.",
    );
  }
  const at = await writable(shuttle, line.operands[0], "edit", deps);
  if (at.kind !== "aimed") return at;
  const warmed = await warm(shuttle, at.place, deps);
  if (warmed !== undefined) return warmed;
  const position = at.place.position;
  const config = pieceConfigOf(shuttle, position, at.place.scope);
  const held = await guarded(
    deps,
    deps.getCellValue ?? getCellValue,
    config,
    [...position.path],
    { input: at.input },
    { loadPieces: () => shuttle.connection.pieces() },
  );
  if (held.kind !== "ran") return held;
  const unwritable = unwritableInJson(held.answer);
  if (unwritable !== undefined) {
    return refuse(
      `The cell holds ${unwritable.what} at ${unwritable.at}, and JSON has ` +
        `no way to write it. Opening the value would write back one JSON ` +
        `can carry, which is a different value: \`set\` the path you mean, ` +
        `or edit a path under this one.`,
    );
  }
  const opened = JSON.stringify(held.answer, null, 2)!;
  // Opening an editor is an adoption rather than a read — it takes the screen
  // and the person's attention — and the check in front of it is the one the
  // read above made on the way back. Nothing is awaited between that check and
  // this call, so a second guard here would be the same check twice with no
  // suspension between them for a cancel to arrive in.
  const editing = await editText(opened);
  if (editing.kind === "refused") return editing;
  if (editing.text === opened) {
    await editing.discard();
    return { kind: "text", text: "Nothing changed, so nothing was written." };
  }
  let parsed;
  try {
    parsed = JSON.parse(editing.text);
  } catch (thrown) {
    return refuse(
      `What the editor saved is not JSON: ${messageOf(thrown)}. Nothing was ` +
        `written, and the text is in \`${editing.file}\`.`,
    );
  }
  // The one site that spells `guarded`'s pair out rather than calling it, and
  // the reason is the file. Which of the two checks stops a line decides
  // whether the text reached the cell, and so whether the file is a leftover
  // or the only copy of somebody's work — a difference `guarded` does not
  // report, and one no other caller has to make.
  //
  // The rule it keeps is the same: nothing is awaited between this check and
  // the write it guards.
  const before = stopped(deps);
  if (before !== undefined) return before;
  let landed;
  try {
    landed = await (deps.setCellValue ?? setCellValue)(
      config,
      [...position.path],
      parsed,
      { input: at.input, refuseRootWrite: true },
      { loadPieces: () => shuttle.connection.pieces() },
    );
  } catch (thrown) {
    if (thrown instanceof ValidationError) return refuse(messageOf(thrown));
    throw thrown;
  }
  // The write landed, so the cell holds the text and the file holds nothing
  // the cell does not — whatever the person did while it was in flight.
  await editing.discard();
  return stopped(deps) ?? wroteAt(landed, at.input);
}

/**
 * Writes a reference at the cell the line's second operand names, pointing at
 * the cell its first names, so that the second reads the first rather than
 * holding a copy of what it said.
 *
 * The order is `ln -s`'s and the FUSE layout's: what is pointed at comes
 * first, and where the pointer lands comes second.
 *
 * Neither endpoint takes the `#argument` suffix, which is `parseLink`'s rule
 * and not a second one — a link endpoint is a cell of a piece's result, and
 * the suffix selects between a piece's two cells rather than naming a position
 * inside one.
 */
async function link(
  shuttle: Shuttle,
  line: VerbLine,
  deps: VerbDeps,
): Promise<Outcome> {
  // Both are there, on {@link set}'s terms.
  const [from, to] = line.operands as [string, string];
  const source = await endpoint(shuttle, from, deps);
  if (source.kind !== "aimed") return source;
  const target = await endpoint(shuttle, to, deps);
  if (target.kind !== "aimed") return target;
  const warmedSource = await warm(shuttle, source.place, deps);
  if (warmedSource !== undefined) return warmedSource;
  const warmedTarget = await warm(shuttle, target.place, deps);
  if (warmedTarget !== undefined) return warmedTarget;
  const at = source.place.position;
  const onto = target.place.position;
  try {
    const wrote = await guarded(
      deps,
      deps.linkPieces ?? linkPieces,
      shuttle.config,
      at.piece,
      [...at.path],
      onto.piece,
      [...onto.path],
      { sourceScope: source.place.scope, targetScope: target.place.scope },
      { loadPieces: () => shuttle.connection.pieces() },
    );
    if (wrote.kind !== "ran") return wrote;
  } catch (thrown) {
    if (
      thrown instanceof LinkValidationError || thrown instanceof ValidationError
    ) {
      return refuse(messageOf(thrown));
    }
    throw thrown;
  }
  return {
    kind: "text",
    text: `Wrote a reference at \`${escapeControlCharacters(to)}\` naming ` +
      `\`${escapeControlCharacters(from)}\`.`,
  };
}

/**
 * Invokes what the line names, and returns everything the call published.
 *
 * The receiver comes first in every spelling, and what follows it depends on a
 * kind known before the line is read: a reference or a piece handle takes the
 * verb name in the next operand, and a callable handle carries the name, so
 * the operands after it are the verb's own input. A typed path ending in a
 * callable is therefore refused rather than resolved — the refusal names the
 * receiver-and-name form to write instead.
 *
 * What comes back is what the call published, in the order it published it:
 * the outcome, and the next steps. What it published *while it ran* went out
 * of band as it happened (`announce.ts`), which is where a line that has not
 * settled yet has to write.
 *
 * @throws Whatever the dispatch throws that is not a reported failure — an
 * unreachable server among them.
 */
async function call(
  shuttle: Shuttle,
  line: VerbLine,
  deps: VerbDeps,
): Promise<Outcome> {
  const made = await dispatched(shuttle, line, deps);
  if (made.kind !== "call") return made;
  const warmed = await warm(shuttle, made.receiver, deps);
  if (warmed !== undefined) return warmed;
  return await invoke(shuttle, made, deps);
}

/**
 * Lists the callables of the piece the line names — where shuttle stands where
 * it names none — and numbers each row, so `call %4` invokes what the row
 * showed.
 *
 * A row's handle carries the receiver and the verb name rather than a path,
 * which is what keeps every spelling of `call` on the one resolution
 * `resolvePieceCallable` performs (`docs/plans/shuttle/grammar.md`). The
 * receiver is the place the listing was read at, which is what a numbered row
 * already stands inside, so the row records the name and nothing else.
 *
 * The default view withholds the rows a listing's own marks hide — a wrapper,
 * a deprecated verb — and says how many; `--all` shows them. Each is callable
 * either way: a mark is a display default rather than a capability boundary,
 * which is `listPieceCallables`' rule and not a second one.
 */
async function listVerbs(
  shuttle: Shuttle,
  line: VerbLine,
  deps: VerbDeps,
): Promise<Outcome> {
  const all = optionFlag(line.options, "all");
  const at = await receiver(shuttle, line.operands[0], "verbs", deps);
  if (at.kind !== "receiver") return at;
  const warmed = await warm(shuttle, at.place, deps);
  if (warmed !== undefined) return warmed;
  let listing;
  try {
    const read = await guarded(
      deps,
      deps.listPieceCallables ?? listPieceCallables,
      pieceConfigAt(shuttle, at.place),
      { loadPieces: () => shuttle.connection.pieces() },
    );
    if (read.kind !== "ran") return read;
    listing = read.answer;
  } catch (thrown) {
    if (thrown instanceof ValidationError) return refuse(messageOf(thrown));
    throw thrown;
  }
  const partition = partitionVerbListing(listing.verbs);
  const shown = all ? listing.verbs : partition.shown;
  const rows: readonly ListingRow[] = shown.map((verb) => ({
    name: verb.name,
    kind: "callable",
  }));
  // Adopted on the near side of the read's own check, as `ls` adopts its
  // numbering: nothing is awaited between the two, so the check that let this
  // line past the read is the check that lets it write.
  numbering(shuttle.session, { place: at.place, rows });
  const notes = verbListingNotes(listing, partition, all);
  return paged(
    shuttle,
    notes.length === 0 ? [] : [marker(oneLine(notes.join("; ")))],
    numbered(shown.map(callableLine)),
    screenFit(deps),
  );
}

/**
 * Returns the page `cf piece describe` writes for the piece the line names —
 * where shuttle stands where it names none.
 *
 * It is a page rather than a listing: a name, a pattern identity, the author's
 * prose, the fields, and the verbs, with sections that appear only where the
 * pattern declares something for them. So it numbers nothing and mints no
 * handle, and `verbs` beside it is what a `call %n` reads against.
 */
async function describe(
  shuttle: Shuttle,
  line: VerbLine,
  deps: VerbDeps,
): Promise<Outcome> {
  const all = optionFlag(line.options, "all");
  const at = await receiver(shuttle, line.operands[0], "describe", deps);
  if (at.kind !== "receiver") return at;
  const warmed = await warm(shuttle, at.place, deps);
  if (warmed !== undefined) return warmed;
  let description;
  try {
    const read = await guarded(
      deps,
      deps.describePiece ?? describePiece,
      pieceConfigAt(shuttle, at.place),
      { loadPieces: () => shuttle.connection.pieces() },
    );
    if (read.kind !== "ran") return read;
    description = read.answer;
  } catch (thrown) {
    if (thrown instanceof ValidationError) return refuse(messageOf(thrown));
    throw thrown;
  }
  return paged(
    shuttle,
    [],
    pieceDescribeLines(description, all).flatMap((written) =>
      written.split("\n")
    ).map(escapeControlCharacters),
    screenFit(deps),
  );
}

/**
 * The read and projection options a data verb takes, which decision 7 makes
 * the ones `cf` takes: same names, same values, same refusal for a value the
 * parser will not take, and the same pair of spellings for one projection with
 * the same conflict between them. `parseCellSelectionOptions`
 * (`lib/cell-selection.ts`) is what reads them, which is what `cf cell get`
 * reads its own through, so what a flag means is settled in one place for both
 * surfaces.
 *
 * What is shuttle's own is the wording: a page here speaks about the place a
 * verb reads from, where `cf`'s speaks about `--cell` and a path positional.
 *
 * `--json` is the machine-readable form. A value is written as JSON either
 * way, but what a person reads is a rendering — cut to a page, broken at the
 * width, with a piece's `$UI` node stood in for — and every one of those is a
 * rewrite that a program reading the output would have to undo, or could not.
 * So the flag turns all three off and hands back the value whole. That is what
 * `cf cell get --json` hands back, and decision 7 makes the flag mean here
 * what it means there: the same spelling, and the same thing arriving.
 */
const READ_OPTIONS: readonly VerbOption[] = [
  {
    name: "filter",
    type: "string",
    placeholder: "predicate",
    description: "Return the array elements a predicate matches.",
  },
  {
    name: "select",
    type: "string",
    placeholder: "fields",
    description: "Return these field paths, `@` after one for its address.",
  },
  {
    name: "schema",
    type: "string",
    placeholder: "schema",
    // Both flags carry the one projection, so a line naming both has not said
    // which shape it wants. Refuse before the read rather than pick, which is
    // the declaration `cf cell get` gives the same pair.
    conflicts: ["select"],
    description: "Return what a JSON Schema, `@file`, or field list says.",
  },
  {
    name: "json",
    description: "Write the value whole, for a program to read.",
  },
];

/** The options `ls` takes, which bound what one page of a listing writes. */
const LIST_OPTIONS: readonly VerbOption[] = [
  {
    name: "limit",
    type: "number",
    placeholder: "rows",
    description: "Write this many rows instead of one screenful.",
  },
];

/**
 * The refusal a `call` naming no verb gets, which names all three spellings
 * because which one a person meant is exactly what the line does not say.
 */
const CALL_TAKES = "the piece to call on and the verb to call, as in " +
  "`call topics/3 add-reply`. A piece handle stands where the reference " +
  "does, and a callable handle off `verbs` carries the name already, as in " +
  "`call %4`";

/**
 * The option `verbs` and `describe` share: show what the listing's own marks
 * hide.
 *
 * One declaration for both, because it is one option — the marks are
 * `listPieceCallables`' and mean the same thing on either page, and a verb
 * hidden from one listing and shown in the other would be two rules where the
 * fabric has one.
 */
const ALL_OPTIONS: readonly VerbOption[] = [
  {
    name: "all",
    description: "Show the rows a listing's marks hide, wrappers and " +
      "deprecated verbs among them.",
  },
];

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
  ["call", {
    run: call,
    arity: {
      operands: "section",
      least: 1,
      names: CALL_TAKES,
      // The receiver is a place, so the first position completes as any other
      // reference does. The name after it does not, and the reason is which
      // place it is a row of: a callable belongs to the receiver the line
      // names, not to the place shuttle stands at, so offering one means
      // reading a place the line has not moved to — which `completion.ts`
      // holds to be a completion of its own rather than a rule against this
      // one. A `Candidates` arm for it would be that completion's to add.
      completes: ["children", "nothing"],
    },
    usage: "call <ref> <name> [input…]",
    summary: "Invokes a piece's verb, and writes what the call published.",
    detail: "Three spellings and no fourth. The typed form is the receiver, " +
      "the verb\nname, and an optional input; a piece handle stands where " +
      "the reference\nstands, taking the name after it; and a callable " +
      "handle off `verbs` carries\nthe name already, so `call %4` is the " +
      "whole line.\n\nThe verb name opens the callable's own section, so " +
      "the flags its schema\nderives follow bare — `call topics/3 search " +
      "--query milk` — and a bare `--`\ncloses it. Nothing shuttle declares " +
      "is read after that name; `call --help`\nwrites this page, and " +
      "`--help` after the name is the callable's.\n\nA typed path ending " +
      "in a callable is refused: a verb is interface\nvocabulary rather " +
      "than a data path, so the receiver and the name are\nwritten apart. " +
      "Input is inline JSON or the verb's own flags; `-` is refused,\n" +
      "standard input being the keyboard the prompt reads.",
  }],
  ["cd", {
    run: cd,
    arity: {
      operands: "required",
      names: "a place to move to",
      completes: ["children"],
    },
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
  ["describe", {
    run: describe,
    arity: { operands: "optional", completes: ["children"] },
    options: ALL_OPTIONS,
    usage: "describe [<ref>]",
    summary: "Writes a piece's whole page: what it is, and what it takes.",
    detail: "The operand names the piece, defaulting to the one shuttle " +
      "stands on or\ninside. It is `cf piece describe`'s page — the name, " +
      "the pattern, the\nauthor's prose, the fields and the verbs — with " +
      "the sections a pattern\ndeclares nothing for left out.\n\nIt " +
      "numbers nothing. `verbs` is the listing that mints the handles " +
      "`call %n`\nreads.",
  }],
  ["edit", {
    run: edit,
    arity: { operands: "optional", completes: ["children"] },
    usage: "edit [<ref>]",
    summary: "Opens a cell's value in `$EDITOR` and writes back what you save.",
    detail: "The value goes out as JSON and comes back as JSON, so what is " +
      "edited is\nwhat a write takes rather than what `get` prints.\n\n" +
      "Four things stop the write, and each leaves the cell as it was: a " +
      "value\nJSON cannot carry, which is refused before the editor opens; " +
      "an editor that\ndid not finish; text that came back unchanged; and " +
      "text that will not\nparse, which is refused with the file it is " +
      "still in.\n\nIt is the one write with no `cf` equivalent behind it.",
  }],
  ["get", {
    run: get,
    arity: { operands: "optional", completes: ["children"] },
    options: READ_OPTIONS,
    usage: "get [<ref>]",
    summary: "Reads the value at a cell, defaulting to where you stand.",
    detail: "The operand takes everything `cd` takes, plus the `#argument` " +
      "suffix\n`cd` turns down, which reads the piece's arguments cell " +
      "rather than its\nresult. A `#name` entry point is the one spelling " +
      "it does not take,\n`wish` being the verb that reads one.\n\nA space " +
      "root and a facet hold no value of their own and are refused;\n`ls` " +
      "lists what stands inside them.\n\nThe value is written as JSON, one " +
      "page of it, and `more` writes the rest.\nA piece's `$UI` node is " +
      "stood in for unless the line names the fields it\nwants: it is the " +
      "piece's picture of itself rather than state to debug\nhere, and " +
      "`--select '$UI'` reads it.\n\nThe projection options are `cf cell " +
      "get`'s. `--select` takes a\ncomma-separated field list, `--schema` a " +
      "JSON Schema or an `@file`, and a\n`@` written after a field path asks " +
      "for that position's address rather\nthan its value.",
  }],
  ["help", {
    run: help,
    arity: { operands: "optional", completes: ["verbs"] },
    usage: "help [<verb>]",
    summary: "Lists the verbs, or writes the page of the one named.",
    detail: "`<verb> --help` writes the same page, and every verb takes that " +
      "option.",
  }],
  ["link", {
    run: link,
    arity: {
      operands: "pair",
      names: "the cell to point at and the path to write it at, as in " +
        "`link topics/3 latest`",
      // Both operands are places, read the way `cd` reads one, so a row of
      // the listing stands at either. The second is a path being written
      // rather than one being read, and it completes all the same: what is
      // offered is a cell that is there, and writing a reference at one is
      // what this verb is for.
      completes: ["children", "children"],
    },
    usage: "link <ref> <ref>",
    summary: "Writes a reference at the second cell, naming the first.",
    detail: "The order is `ln -s`'s and the FUSE layout's: what is pointed " +
      "at comes\nfirst, and where the pointer lands comes second.\n\nIt " +
      "is the one spelling that makes a cell read another cell. `set` and " +
      "`edit`\ncopy a value, and which of the three a line is doing is " +
      "visible on the\nline.\n\nNeither endpoint takes the `#argument` " +
      "suffix: a link endpoint is a cell of\na piece's result, and the " +
      "suffix selects between a piece's two cells.",
  }],
  ["ls", {
    run: ls,
    arity: { operands: "none" },
    options: LIST_OPTIONS,
    usage: "ls",
    summary: "Lists what stands where shuttle stands.",
    detail: "A space root lists its facets, `slugs/` the names the space's " +
      "index\nrecords, `pieces/` the space's pieces, and a cell the keys " +
      "directly\nunder it. A row that failed on its own account is still a " +
      "row and\ncarries what went wrong, where a read that failed outright " +
      "is no\nlisting at all and is reported as the failure it is.\n\nEvery " +
      "row is numbered from `%1`, and a row that is one of the piece's\n" +
      "callables says so. One screenful is written and `more` writes the " +
      "rest\nunder the numbers it already gave them.",
  }],
  ["more", {
    run: more,
    arity: { operands: "none" },
    usage: "more",
    summary: "Writes the next page of what did not fit on the last one.",
    detail: "A listing continues under the numbers it already gave its " +
      "rows, and a\nvalue continues where it left off. A rendering that fit " +
      "whole leaves\nnothing to continue, and this says so rather than " +
      "writing the tail of\nthe one before it.",
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
  ["set", {
    run: set,
    arity: {
      operands: "pair",
      names: "the path to write and the value to write there, as in " +
        "`set title '\"a\"'`",
      // The path is a place like `cd`'s and `get`'s. The value is JSON, which
      // nothing enumerates: there is no set of values a cell will take that
      // this could read, and offering the words already in the cell would be
      // offering the person back what they are replacing.
      completes: ["children", "nothing"],
    },
    usage: "set <ref> <value>",
    summary: "Writes a value at a cell, which copies rather than links.",
    detail: "The path takes everything `get` takes, the `#argument` suffix " +
      "included, so\n`set title#argument x` writes the arguments cell as " +
      "`--input` does for\n`cf cell set`.\n\nThe value is JSON, and a " +
      "bare word is the string it spells: `set title milk`\nwrites " +
      '`"milk"`. A value opening the way JSON opens one and then ' +
      "failing to\nparse is refused with the parser's reason rather than " +
      "written as a string.\n`-` is refused, standard input being the " +
      "keyboard the prompt reads.\n\nA write onto a whole piece is " +
      "refused. `link` is what writes a reference.",
  }],
  ["verbs", {
    run: listVerbs,
    arity: { operands: "optional", completes: ["children"] },
    options: ALL_OPTIONS,
    usage: "verbs [<ref>]",
    summary:
      "Lists a piece's callables, numbering each so `call %n` invokes it.",
    detail: "The operand names the piece, defaulting to the one shuttle " +
      "stands on or\ninside. Every row is numbered from `%1`, and a row's " +
      "handle carries the\nreceiver and the verb name, so `call %4` needs " +
      "neither again.\n\nThe rows a listing's marks hide — a wrapper, a " +
      "deprecated verb — are\nwithheld and counted; `--all` shows them. " +
      "Each is callable either way: a\nmark is a display default rather " +
      "than a capability boundary.",
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
      // A target is a name the fabric holds rather than a row of the place,
      // and what would list them is a read of a different index; `wish`
      // completes nothing until one exists to read.
      completes: ["nothing"],
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
 * Every verb, by the word that names one, read for what it says about itself
 * rather than for what running it does.
 *
 * It is {@link VERBS} under the half of its type a reader outside the dispatch
 * needs. `tasks/check-command-docs.ts` is that reader: it holds each verb to a
 * live document naming it, and a gate that could reach `run` could call one.
 * Every verb is here because it is the same map — a verb added to the table is
 * a verb the gate asks about, with no second list to keep in step.
 */
export const VERB_HELP: ReadonlyMap<string, VerbHelp> = VERBS;

/**
 * The words that name a verb, in the order the table declares them.
 *
 * Derived from the table rather than written beside it, so it is the same set
 * the dispatch takes, `help` lists and a refusal names — a verb added is a
 * verb a completion offers, with nothing to remember.
 */
export const VERB_WORDS: readonly string[] = [...VERBS.keys()];

/**
 * What a completion offers for the token standing after `tokens` on a line.
 *
 * The tokens are the whole ones written before it, so the question is the one
 * the dispatch asks of a line and it is answered the same way: the first
 * token names a verb, the rest go to that verb's own option reading, and what
 * is left is the operands the line has already given it. A completion is
 * offered where the verb takes another operand and nowhere else, which is
 * what keeps a completion to a token the line takes — a second operand for a
 * verb that takes one, or any for a verb that takes none, is a token the
 * dispatch would refuse.
 *
 * Four lines answer `nothing` and each is a different fact: no verb by that
 * word, so nothing is known about what follows it; a reading the parser
 * refused, whose last token is an option's value rather than an operand; a
 * verb with its operands already given; and a verb whose operand is a name
 * only the fabric could supply.
 *
 * A line asking for a verb's page is among the refused readings rather than
 * beside them: `--help` takes the whole reading and carries no operands, so
 * there is no operand position for a completion to stand in.
 */
export function candidatesAfter(tokens: readonly string[]): Candidates {
  const [word, ...rest] = tokens;
  if (word === undefined) return "verbs";
  const entry = VERBS.get(word);
  if (entry === undefined) return "nothing";
  const reading = readOptions(word, rest, entry.options);
  if (reading.kind !== "read") return "nothing";
  return afterOperands(entry.arity, reading.operands.length);
}

/**
 * Helper for {@link candidatesAfter}, which is what `arity` offers where
 * `given` operands have already been written.
 *
 * One rule and no arms: a verb that takes no operand offers nothing without
 * having declared anything, and every other verb offers what it declared for
 * the position the line has reached. A position it declared nothing for is
 * past the end of its list, which is a token the dispatch would refuse or a
 * word in somebody else's grammar.
 *
 * The list is read with `at` rather than an index, because a tuple read at a
 * number types as its element union however far out the number is: an index
 * would have this return a `Candidates` the list does not hold, and the empty
 * answer for a `section`'s tail would be a value the type says cannot be
 * there.
 */
function afterOperands(arity: Arity, given: number): Candidates {
  if (arity.operands === "none") return "nothing";
  return arity.completes.at(given) ?? "nothing";
}

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
    case "handle": {
      const row = rowFor(shuttle, move);
      if (row.kind === "refused") return row;
      const reached = await guarded(
        deps,
        shuttle.place.reach.bind(shuttle.place),
        move,
        row.at,
        row.toward,
      );
      return reached.kind !== "ran"
        ? reached
        : await landing(shuttle, reached.answer, deps);
    }
  }
}

/** Where a handle's row stands, or the reason it stands nowhere. */
type Rowed =
  | {
    /** Names this arm of {@link Rowed}. */
    readonly kind: "row";

    /** The place the listing that minted the handle was read at. */
    readonly at: Place;

    /** The operand that reaches the row from there. */
    readonly toward: string;
  }
  | Refusal;

/**
 * Helper for {@link landing} and {@link reading}, which is the row `move`
 * names and the operand that reaches it, or the reason it reaches nothing.
 *
 * It reads the session rather than the fabric, so it is not a read and needs
 * no guard: what the last listing numbered is a value this process already
 * holds.
 *
 * A row with no operand is a row no place stands at, and the refusal says that
 * rather than that the handle named nothing — the handle named a row, and the
 * row is the part that is not somewhere to go. A callable is the row that is
 * always so, and it is the row `call` reads through a door of its own.
 */
function rowFor(shuttle: Shuttle, move: HandleMove): Rowed {
  const bound = resolveHandle(shuttle.session.handles, move.handle);
  if (bound.kind === "refused") return bound;
  const toward = bound.row.operand;
  return toward === undefined
    ? refuse(
      `\`${move.handle}\` names a row no place stands at${
        bound.row.kind === "callable"
          ? ", it being one of the piece's callables. `call` is what invokes " +
            "one"
          : ""
      }.`,
    )
    : { kind: "row", at: bound.at, toward };
}

/** A refusal, which is an arm of every outcome this module has. */
type Refusal = { readonly kind: "refused"; readonly reason: string };

/** Where an operand names, or the reason it names nothing to read. */
type Reading =
  /** The operand names `place`. */
  | { readonly kind: "place"; readonly place: Place }
  | Refusal;

/**
 * Where an operand points and which of the piece's two cells it names, or the
 * reason it names nothing to read.
 */
type Aiming =
  | {
    readonly kind: "place";
    readonly place: Place;
    /** The arguments cell rather than the result, which `#argument` spells. */
    readonly input: boolean;
  }
  | Refusal;

/** What a cell read produced, or the reason there was nothing to read. */
type Held =
  /** The cell holds `value`, which is what the read returned. */
  | { readonly kind: "value"; readonly value: unknown }
  | Refusal
  | Interruption;

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
  // Warmed here, which is after the resolution has said which piece this is
  // and before the read that judges its path. The judgement is the reason:
  // the walk below asks whether the fabric holds the path, and a walk against
  // a piece that is not running asks it of what was last committed — so a `cd`
  // could refuse a path the running piece has. Decision 10 is that reaching in
  // starts the piece, and a move onto one is reaching in.
  //
  // The piece is the resolved one, so the warm pays no resolution of its own,
  // and it sits behind the connection ask like every read here: the checks in
  // front of them are what a cancel meets.
  const warmed = await warm(shuttle, {
    position: { ...move.place.position, piece: place.piece, path },
    scope,
  }, deps);
  if (warmed !== undefined) return warmed;
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
    case "handle": {
      const row = rowFor(shuttle, move);
      return row.kind === "refused" ? row : await reading(
        shuttle,
        shuttle.place.resolveHandle(move, row.at, row.toward),
        deps,
      );
    }
  }
}

/**
 * Helper for {@link get}, which is the value at `place`, in the piece's
 * arguments cell where `input` says so and in its result otherwise, projected
 * by `selection` where the line wrote one.
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
  selection: CellSelection | undefined,
  deps: VerbDeps,
): Promise<Held> {
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
    { input, ...(selection === undefined ? {} : { selection }) },
    { loadPieces: () => shuttle.connection.pieces() },
  );
  return answered.kind !== "ran"
    ? answered
    : { kind: "value", value: answered.answer };
}

/**
 * What `--select` is offered as, where a page could not write the whole of
 * what a read returned. It is offered beside `more` rather than instead of it,
 * because the two answer different questions: `more` writes the rest of what
 * was read, and a projection reads less.
 */
const NARROWS_THE_READ = "--select narrows the read";

/**
 * Helper for {@link get}, which is `held` written for whoever asked for it.
 *
 * There are two readers and they want different things, which is what `json`
 * picks between. A person gets a rendering: cut to one page with what did not
 * fit left for `more`, broken at the width so the page has somewhere to cut,
 * and with a piece's `$UI` node stood in for. A program gets the value —
 * whole, unbroken, and with every key it holds.
 *
 * Every one of those is a rewrite of the text, and that is the point. Counting
 * rows is one act and inserting breaks is another: a terminal wraps a long
 * line by itself and the bytes are unchanged, where a break this module writes
 * is a character that was not in the value. Inside a JSON string it is not
 * even legal — `JSON.parse` refuses a raw newline there — so a form something
 * parses may carry none of it. `cf cell get --json` hands back parseable
 * output, and decision 7 makes that flag mean here what it means there, which
 * reaches past how it is spelled to what it hands over.
 *
 * The elision goes with them for the same reason: it writes a string where an
 * object was, which reads back as a value the fabric does not hold. So a
 * person's rendering elides unless the line asked for fields by name — a
 * projection is what asking looks like, `--select '$UI'` names that key and
 * gets what it holds, and a `--filter` alone is not asking, since it says
 * which elements come back rather than what each holds — and a program's form
 * elides nothing at all.
 */
function written(
  shuttle: Shuttle,
  held: { readonly value: unknown },
  selection: CellSelection | undefined,
  json: boolean,
  deps: VerbDeps,
): Outcome {
  const text = renderValue(held.value, {
    ui: json || selection?.projection !== undefined,
  });
  if (json) {
    // Nothing is held back, so nothing may be waiting: a `more` after this
    // would otherwise continue the line before it.
    shuttle.session.holding();
    return { kind: "text", text };
  }
  // Broken at the width before the page sees it, because a page cuts between
  // entries and a value the fabric holds as one long string is one entry: a
  // piece result written as a single line is one line and a screenful of rows,
  // and unbroken it is shown whole with nothing left for `more` to continue.
  const bound = screenFit(deps);
  return paged(
    shuttle,
    [],
    wrapped(text.split("\n"), bound.columns),
    bound,
    NARROWS_THE_READ,
  );
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
 * Helper for the writes and the calls, which starts the piece `place` stands
 * on unless this run already has.
 *
 * Reaching in warms (decision 10, `docs/plans/shuttle/grammar.md`): every read
 * shuttle serves is live, so there is no unlabeled stored-state path and a
 * computed value a write makes stale is recomputed by a pattern running in
 * this process rather than left for a later `--step` to notice.
 *
 * It is a read, so it is guarded like one and the memo is written only where
 * the start actually happened: a line the person stopped waiting for leaves
 * the set saying what is true, which is that this piece was not started.
 *
 * What comes back is the interruption where one arrived, and nothing where the
 * piece is running. A warm that fails raises, as the read it is: a piece that
 * will not start is not a fact about the line.
 */
async function warm(
  shuttle: Shuttle,
  place: PiecePlace,
  deps: VerbDeps,
): Promise<Interruption | undefined> {
  // Asked of the place's own piece before anything is sent. For a place
  // shuttle stands at that is the piece a read resolved
  // ({@link PiecePosition}), so a second reach at the same place answers here
  // and pays neither the resolution nor the sync. For a place that says where
  // an operand *points* it is the operand's own spelling and usually misses,
  // which costs a resolution and is what the question inside the warm is for.
  if (shuttle.session.hasWarmed(place.position.piece, place.scope)) {
    return undefined;
  }
  const started = await guarded(
    deps,
    deps.warmPiece ?? warmPiece,
    pieceConfigOf(shuttle, place.position, place.scope),
    [...place.position.path],
    {
      loadPieces: () => shuttle.connection.pieces(),
      // Asked with the piece the resolution reached rather than the one the
      // operand spelled, which is the only form of the question the memo can
      // answer: a path decides which piece runs by being resolved, and this
      // is asked on the far side of that.
      alreadyRunning: (piece: string) =>
        shuttle.session.hasWarmed(piece, place.scope),
    },
  );
  if (started.kind !== "ran") return started;
  shuttle.session.warmed(started.answer.piece, place.scope);
  return undefined;
}

/**
 * Helper for the verbs that touch a place rather than a piece, which warms
 * where that place stands on one and does nothing where it does not.
 *
 * A space root and a facet are lists of what stands inside them, and a listing
 * of one starts nothing: there is no pattern behind a facet to run. So the
 * absence of a warm here is the same claim the position makes, rather than a
 * verb deciding it reaches in less than another one does.
 */
async function warmAt(
  shuttle: Shuttle,
  place: Place,
  deps: VerbDeps,
): Promise<Interruption | undefined> {
  const position = place.position;
  return position.kind === "piece"
    ? await warm(shuttle, { ...place, position }, deps)
    : undefined;
}

/**
 * Helper for the verbs that reach a piece, which is the config a read or a
 * write of `position` at `scope` rides: what this process connects as, plus
 * the piece and the scope the place holds.
 *
 * The piece goes over as the place holds it, which is the handle where a read
 * resolved one and the operand's own spelling where the place is where an
 * operand *points* rather than where shuttle stands ({@link PiecePosition}).
 * Either way the resolution is the seam's own, which is what makes a name
 * typed back off a listing reach its piece.
 */
function pieceConfigOf(
  shuttle: Shuttle,
  position: PiecePosition,
  scope: CellScope,
): PieceConfig {
  return { ...shuttle.config, piece: position.piece, pieceScope: scope };
}

/**
 * Helper for {@link listVerbs} and {@link describe}, which is
 * {@link pieceConfigOf} with the path carried as `piecePath`.
 *
 * That is what lets a place standing inside a collection holder describe the
 * member it reaches: the seam spends what the walk needs and refuses whatever
 * is left, in the words it refuses a cell path on a piece-only command with.
 */
function pieceConfigAt(shuttle: Shuttle, place: PiecePlace): PieceConfig {
  return {
    ...pieceConfigOf(shuttle, place.position, place.scope),
    piecePath: [...place.position.path],
  };
}

/**
 * Helper for {@link set} and {@link edit}, which says where a write landed.
 *
 * The piece and the path are the seam's own, which are what the walk reached
 * rather than what the operand said: an operand naming a collection's member
 * spends its leading segments getting there, and only the piece it reached
 * says what was written. Both are written for a reader rather than as an
 * operand — a path is joined with the separator, which a key holding one would
 * be indistinguishable from — and both are held to the class a terminal acts
 * on, neither having passed a door.
 */
function wroteAt(
  landed: { readonly piece: string; readonly path: (string | number)[] },
  input: boolean,
): Outcome {
  return {
    kind: "text",
    text: `Wrote \`${escapeControlCharacters(landed.path.join("/"))}\` on ` +
      `\`${escapeControlCharacters(landed.piece)}${
        input ? ARGUMENT_SUFFIX : ""
      }\`.`,
  };
}

/** What an operand writes to select a piece's arguments cell. */
const ARGUMENT_SUFFIX = "#argument";

/** Where a write is aimed: a cell of a piece, and which of the piece's two. */
type Writable =
  | {
    /** Names this arm of {@link Writable}. */
    readonly kind: "aimed";

    /** The cell the write lands on. */
    readonly place: PiecePlace;

    /** True where the operand selected the piece's arguments cell. */
    readonly input: boolean;
  }
  | Refusal
  | Interruption;

/**
 * Helper for the writes, which is where `operand` aims once a container is
 * ruled out, `verb` naming the verb for the refusal to open with.
 *
 * A space root and a facet are lists of what stands inside them and hold no
 * value, so neither is somewhere a write can land. The refusal is the one
 * `get` gives for reading one, in the same words, because it is the same fact
 * about the same position.
 */
async function writable(
  shuttle: Shuttle,
  operand: string | undefined,
  verb: string,
  deps: VerbDeps,
): Promise<Writable> {
  const at = operand === undefined
    ? { kind: "place" as const, place: shuttle.place.place, input: false }
    : await aimed(shuttle, operand, deps);
  if (at.kind === "refused") return at;
  const position = at.place.position;
  if (position.kind !== "piece") {
    return refuse(
      `${container(position)} is a list of what stands inside it rather than ` +
        `a cell, so \`${verb}\` has nothing to write there.`,
    );
  }
  return {
    kind: "aimed",
    place: { ...at.place, position },
    input: at.input,
  };
}

/**
 * Helper for {@link link}, which is the endpoint `operand` names.
 *
 * It is {@link writable} plus the suffix refusal, which is `link`'s alone: a
 * link endpoint is a cell of a piece's result, so the selection between a
 * piece's two cells has nothing to select there.
 */
async function endpoint(
  shuttle: Shuttle,
  operand: string,
  deps: VerbDeps,
): Promise<Writable> {
  const at = await writable(shuttle, operand, "link", deps);
  if (at.kind !== "aimed") return at;
  return at.input
    ? refuse(
      `\`${escapeControlCharacters(operand)}\` selects a piece's arguments ` +
        `cell, and a link endpoint is a cell of a piece's result. Write the ` +
        `endpoint without the \`${ARGUMENT_SUFFIX}\` suffix.`,
    )
    : at;
}

/** What JSON cannot carry, and where in a value it sits. */
interface Unwritable {
  /** The thing found, as a noun phrase. */
  readonly what: string;

  /** Where it sits, as a phrase completing "at". */
  readonly at: string;
}

/** What {@link unwritableInJson} calls the whole value it was handed. */
const THE_VALUE_ITSELF = "the value itself";

/**
 * Helper for {@link edit}, which is the first thing in `value` that JSON
 * cannot carry, and nothing where JSON carries all of it.
 *
 * What it looks for is what a serialize-and-parse round trip would change
 * rather than a list of types: a value that is `undefined`, a symbol, a
 * `bigint`, a function, an array hole, or a cycle. Each of the first four is
 * dropped or throws; a hole and a missing property come back as `null` and as
 * a removed key, which the runtime holds distinct from what was there.
 *
 * The walk is its own rather than a comparison against
 * `JSON.parse(JSON.stringify(value))`, because two of the losses are invisible
 * to a comparison of what comes back: a dropped key and a key that was never
 * there are the same object afterwards, and a structural comparison of a hole
 * against a `null` has to be told they differ. Walking finds each of them
 * where it is, which is also what lets the refusal say where.
 *
 * What makes the list closed is that it is read off the admission test rather
 * than composed beside it. `isValidFabricValueLayer`
 * (`packages/data-model/src/type-check.ts`) switches on `typeof` and, for an
 * `object`, branches four ways; this walk answers the same arms:
 *
 * - `undefined`, `bigint` and a registry-interned `symbol` are admitted and
 *   have no JSON spelling at all.
 * - `number` is admitted unconditionally, and four of them do not survive
 *   ({@link unwritableNumber}). This is the arm a walk over types alone
 *   misses, every number looking alike to `typeof`.
 * - `boolean`, `string` and `null` survive whole.
 * - Among objects: a `FabricSpecialObject` — every `FabricBytes`,
 *   `FabricLink`, `FabricRegExp` and the rest — keeps its state where a
 *   serializer cannot see it and writes as `{}`, so its content is gone and
 *   the check is on the base class the admission test itself branches on,
 *   which is what covers a subclass added later. An array is walked for holes
 *   and a plain object for its keys. Everything else — a `Date`, a `Map`, an
 *   `Array` subclass, a null-prototype object — the admission test refuses
 *   outright, so no cell holds one.
 *
 * That leaves nothing for a `toJSON()` method to do here. It arrives on a
 * prototype, and a value carrying one is a class instance the admission test
 * has already refused unless it is a `FabricSpecialObject`, which this refuses
 * above.
 *
 * The bound on it is the object: what it finds is what the walk reaches, and
 * the walk reaches what a serializer reaches. It says nothing about a value
 * whose losses are outside the walk — a getter that answers differently the
 * second time is the shape to keep in mind.
 */
function unwritableInJson(
  value: unknown,
  at: string = THE_VALUE_ITSELF,
  seen: Set<object> = new Set(),
): Unwritable | undefined {
  if (value === undefined) return { what: "an `undefined`", at };
  if (typeof value === "symbol") return { what: "a symbol", at };
  if (typeof value === "bigint") return { what: "a `bigint`", at };
  if (typeof value === "function") return { what: "a function", at };
  if (typeof value === "number" && unwritableNumber(value)) {
    return { what: numberIs(value), at };
  }
  if (value === null || typeof value !== "object") return undefined;
  if (value instanceof FabricSpecialObject) {
    return { what: `a \`${classOf(value)}\``, at };
  }
  if (seen.has(value)) return { what: "a cycle", at };
  const inside = new Set(seen).add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const where = under(at, String(index));
      if (!(index in value)) return { what: "a hole", at: where };
      const found = unwritableInJson(value[index], where, inside);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  // What `Object.entries` leaves out is exactly what `JSON.stringify` leaves
  // out — a symbol-keyed or non-enumerable property — so a walk over the
  // entries alone would agree with the serializer and miss the loss. Counting
  // the own keys is what notices one. The fabric refuses such an object as a
  // layer of its own, so this is the layer below one it admitted rather than a
  // value a cell root can hold.
  if (Reflect.ownKeys(value).length !== Object.keys(value).length) {
    return { what: "a property JSON does not write", at };
  }
  for (const [key, held] of Object.entries(value)) {
    const found = unwritableInJson(
      held,
      under(at, escapeControlCharacters(key)),
      inside,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Helper for {@link unwritableInJson}, which is what a fabric value calls
 * itself, for the refusal to name what the cell holds.
 *
 * Read off the prototype rather than the value, as the fabric's own refusals
 * read it: an own `constructor` property is ordinary data, so a value could
 * otherwise choose the name it is refused under. A class that will not say
 * what it is called — a class expression with no name — is named for what it
 * is instead.
 */
function classOf(value: object): string {
  const named = Object.getPrototypeOf(value)?.constructor?.name;
  return typeof named === "string" && named !== "" ? named : "fabric value";
}

/**
 * Helper for {@link unwritableInJson}, which is whether JSON writes `value`
 * back as the number it was handed.
 *
 * Four numbers it does not, and they divide in two. `NaN`, `Infinity` and
 * `-Infinity` have no JSON spelling at all and are written as `null`; `-0` has
 * one and is written as `0`, which is a different number under `Object.is` and
 * the one a reader of the cell would see. The fabric admits all four —
 * `isValidFabricValueLayer` admits by `typeof`, so every `number` — which is
 * what makes them a cell's to hold and this walk's to refuse.
 *
 * The predicate is the round trip's own answer rather than a list: a number
 * survives exactly when it is finite and is not negative zero, which was
 * checked against `Object.is(n, JSON.parse(JSON.stringify(n)))` over the
 * ordinary values, both zeroes, the three non-finite ones, and the range's
 * edges — `MAX_VALUE`, `MIN_VALUE`, `EPSILON` and both safe-integer bounds.
 */
function unwritableNumber(value: number): boolean {
  return !Number.isFinite(value) || Object.is(value, -0);
}

/**
 * Helper for {@link unwritableInJson}, which names the number `value` is, for
 * the refusal to say what the cell holds.
 *
 * Each is written as a person would type it back, so the sentence names a
 * value rather than a category: what `set` would have to be given to put it
 * there again is the useful thing to print.
 */
function numberIs(value: number): string {
  if (Number.isNaN(value)) return "a `NaN`";
  if (Object.is(value, -0)) return "a negative zero";
  return value > 0 ? "an `Infinity`" : "a `-Infinity`";
}

/**
 * Helper for {@link unwritableInJson}, which is where `key` sits inside `at`.
 *
 * The whole value has no path in front of it, so a key directly under it is
 * written on its own rather than after a separator that would name a key
 * called the empty string.
 */
function under(at: string, key: string): string {
  return at === THE_VALUE_ITSELF ? key : `${at}/${key}`;
}

/**
 * The characters JSON opens a value with. A token starting with one of them
 * that will not parse is broken JSON rather than a word, so it is refused with
 * the parse error instead of being read as the string it spells.
 */
const JSON_OPENERS = /^[{["\-0-9]/;

/** The operand that would read a value from standard input. */
const STDIN = "-";

/**
 * Helper for {@link set}, which is the value `token` writes.
 *
 * The value is JSON, and a bare word is the string it spells: a token JSON
 * would not have opened a value with is a word rather than a mistake, so
 * `set title milk` writes the string. A token that opens the way JSON opens a
 * value and then will not parse is broken JSON, and is refused with the
 * parser's own reason rather than written as a string nobody meant.
 *
 * The stdin sentinel is refused here rather than read. Standard input is the
 * keyboard the prompt is reading its keys off, and two readers of one keyboard
 * would each take some of the keys and neither would see them all.
 */
function valueOf(
  token: string,
): { readonly kind: "value"; readonly value: unknown } | Refusal {
  if (token === STDIN) {
    return refuse(
      "`-` reads the value from standard input, which the prompt is reading " +
        "keys from. Write the value on the line, or open the cell with " +
        "`edit`.",
    );
  }
  try {
    return { kind: "value", value: JSON.parse(token) };
  } catch (thrown) {
    return JSON_OPENERS.test(token)
      ? refuse(
        `\`${escapeControlCharacters(token)}\` is not JSON: ` +
          `${messageOf(thrown)}. A value opening with \`{\`, \`[\`, \`"\`, ` +
          `\`-\` or a digit is read as JSON; anything else is the string it ` +
          `spells.`,
      )
      : { kind: "value", value: token };
  }
}

/** Where a receiver stands, or the reason an operand named none. */
type Receiving =
  | {
    /** Names this arm of {@link Receiving}. */
    readonly kind: "receiver";

    /** The piece a verb is called on, or listed and described. */
    readonly place: PiecePlace;
  }
  | Refusal
  | Interruption;

/**
 * Helper for the three verbs that act on a piece, which is the piece `operand`
 * names, `verb` naming the verb for the refusals to open with.
 *
 * A container holds no callables and no value, so it is refused; and the
 * `#argument` suffix is refused because a piece's callables are the piece's
 * rather than one of its two cells'.
 */
async function receiver(
  shuttle: Shuttle,
  operand: string | undefined,
  verb: string,
  deps: VerbDeps,
): Promise<Receiving> {
  const at = operand === undefined
    ? { kind: "place" as const, place: shuttle.place.place, input: false }
    : await aimed(shuttle, operand, deps);
  if (at.kind === "refused") return at;
  if (at.input) {
    return refuse(
      `\`${ARGUMENT_SUFFIX}\` selects one of a piece's two cells, and a verb ` +
        `belongs to the piece rather than to either of them. Write the piece ` +
        `without the suffix.`,
    );
  }
  return pieceAt(at.place, verb);
}

/**
 * Helper for {@link receiver} and {@link dispatched}, which is `place` where
 * it stands on a piece and the refusal for `verb` where it does not.
 *
 * It is the one narrowing rather than a test at each door, so a receiver
 * reached by aiming an operand and one carried by a callable handle are
 * refused in the same words when they are no piece.
 */
function pieceAt(place: Place, verb: string): Receiving {
  const position = place.position;
  return position.kind === "piece"
    ? { kind: "receiver", place: { ...place, position } }
    : refuse(
      `${container(position)} is a list of what stands inside it rather ` +
        `than a piece, and \`${verb}\` acts on a piece.`,
    );
}

/**
 * How the mount a call goes through names itself, which is the word a person
 * writes after `cf` to make the same call from outside the shell.
 *
 * The seam prints it in the corrected line a grammar refusal ends with, and a
 * corrected line is only worth printing where it can be run. `cf piece call`
 * can be; a word naming shuttle could not, this being a prompt rather than a
 * command line.
 */
const SPELLING = "piece call";

/** What the seam's own `exit` throws, so that a failed call is a value. */
const EXITED = Symbol("a call that ended the caller");

/** The reason a call may not read standard input. */
const READS_THE_KEYBOARD =
  "`-` reads the input from standard input, which the prompt is reading " +
  "keys from. Write the input on the line, as inline JSON or as the verb's " +
  "own flags.";

/**
 * What a call is told about standard input: that it is a terminal, and that
 * nothing may read it.
 *
 * Standard input is the keyboard the prompt is reading its keys off, and two
 * readers of one keyboard would each take some of the keys and neither would
 * see them all (`terminal.ts`) — a read that never reaches end of input wedges
 * the shell rather than failing. `set <path> -` is refused for exactly this
 * reason, and a call reaches the same stream by more spellings than a refusal
 * over the line could enumerate: a lone `-` operand, which `pieceCallRawArgs`
 * rewrites to `--json-file -`; `--json -` and `--json=-`; and `--json-file -`
 * and `--json-file=-`. Substituting the reader closes the set by construction
 * instead, since every one of them arrives at `readTextInput`
 * (`resolveParsedExecInput`, `lib/exec-schema.ts`).
 *
 * `isStdinTerminal` answers `true` rather than being left to the process, and
 * it is not a convenience: it is what stops the *implicit* piped-input path
 * from reading. That path consults the probe and returns without touching the
 * stream when it says terminal, and inside a running shuttle the answer is
 * always yes — `withPromptTerminal` refuses to start unless both standard
 * input and standard output are terminals — so stating it is stating a fact
 * this process has already established rather than asserting one.
 *
 * A throw here reaches the caller as a failed call rather than as a wedge,
 * which is the whole of what this buys. What it does not cover is
 * `--json-file <path>` naming a real file: that reads a local file rather than
 * this stream, and whether shuttle's rule that a local file is always spelled
 * `file:` reaches inside a callable's own section is a question the externals
 * milestone owns.
 */
const STDIN_IS_THE_KEYBOARD = {
  isStdinTerminal: () => true,
  readTextInput: (): Promise<string> => {
    throw new Error(READS_THE_KEYBOARD);
  },
  readJsonInput: (): Promise<unknown> => {
    throw new Error(READS_THE_KEYBOARD);
  },
};

/** A call the line settled: the receiver, the verb, and the words after it. */
type Called =
  | {
    /** Names this arm of {@link Called}. */
    readonly kind: "call";

    /** The piece the verb is called on. */
    readonly receiver: PiecePlace;

    /** The verb's name, which opens its own section. */
    readonly name: string;

    /** The words in that section, before the `--` that closes it. */
    readonly tail: readonly string[];

    /** The words after that `--`, which the read step parses. */
    readonly section: readonly string[];
  }
  | Refusal
  | Interruption;

/**
 * Helper for {@link call}, which settles which operand is the receiver and
 * which is the verb name.
 *
 * A callable handle is the one spelling that carries the name already, and its
 * kind was recorded when the listing minted it, so nothing here reads to find
 * out: the operands after such a handle are the verb's own input. Every other
 * spelling — a typed reference, a relative operand, a handle naming anything
 * else — takes the name in the next operand, and is aimed through the door the
 * other two piece verbs aim through.
 */
async function dispatched(
  shuttle: Shuttle,
  line: VerbLine,
  deps: VerbDeps,
): Promise<Called> {
  const section = line.section ?? [];
  // The receiver is there, on {@link set}'s terms: the arity holds `call` to
  // at least one operand of its own. What follows it is the callable's, and
  // how many of those there are is nothing this dispatch counts.
  const [first] = line.operands as [string, ...string[]];
  // Asked of the operand grammar rather than tested here, so `%4` and
  // `%4/deeper` are told apart by the reading that already tells them apart
  // everywhere else. Only a bare handle can carry a name: a walk written after
  // one ends at a cell inside the row, and a cell is a receiver rather than a
  // verb, so it takes the name in the next operand like any other reference.
  const aim = shuttle.place.aim(first).move;
  const carried = aim.kind === "handle" && aim.rest === ""
    ? carriedName(shuttle, aim.handle)
    : undefined;
  if (carried?.kind === "refused") return carried;
  if (carried?.name !== undefined) {
    const at = pieceAt(carried.at, "call");
    return at.kind !== "receiver" ? at : {
      kind: "call",
      receiver: at.place,
      name: carried.name,
      tail: line.operands.slice(1),
      section,
    };
  }
  const at = await receiver(shuttle, first, "call", deps);
  if (at.kind !== "receiver") return at;
  const name = line.operands[1];
  if (name === undefined) {
    return refuse(
      `\`${escapeControlCharacters(first)}\` names the piece to call on, and ` +
        `the verb to call follows it, as in \`call ${
          escapeControlCharacters(first)
        } add-reply\`. A path ending in a callable names no cell: a verb is ` +
        `interface vocabulary rather than a data path.`,
    );
  }
  if (readsAsOption(name)) return refuse(notAVerbName(name));
  return {
    kind: "call",
    receiver: at.place,
    name,
    tail: line.operands.slice(2),
    section,
  };
}

/**
 * Helper for {@link dispatched}, which is the reason `word` names no verb of
 * the receiver's.
 *
 * A verb name in the shape an option is written in is a name nobody can type:
 * the option grammar reads such a token as an option wherever it stands, and
 * the one place it does not — after the verb name, inside the callable's own
 * section — is a place a *name* cannot be. So the shape is refused here rather
 * than resolved, which is what stops `call topics/3 --help` reaching the
 * fabric as a callable called `--help` and coming back as a piece that has no
 * such verb.
 *
 * `--help` and `-h` get the extra sentence because they are the two a person
 * writes on purpose. What they are reaching for is one of two things and the
 * refusal names both: `verbs` lists what a piece can be asked to do, and
 * `call --help` is this verb's own page.
 */
function notAVerbName(word: string): string {
  const asking = word === "--help" || word === "-h";
  return `\`${escapeControlCharacters(word)}\` names no verb: a verb name is ` +
    `interface vocabulary, and a token opening with \`-\` is read as an ` +
    `option wherever one may be written.${
      asking
        ? " `verbs` lists what this piece can be asked to do, and `call " +
          "--help` writes this verb's own page."
        : ""
    }`;
}

/**
 * What a handle carried: a verb's name where the row is a callable, and the
 * place the listing was read at either way.
 *
 * An operand that is no handle carries neither, and is no value of this type
 * at all — the place a typed reference names is what aiming it answers, and
 * inventing one here would put a value nobody reads beside the one that is
 * read.
 */
type Carried =
  | {
    /** Names this arm of {@link Carried}. */
    readonly kind: "named";

    /** The verb's name, and nothing where the row is no callable. */
    readonly name?: string;

    /** The place the listing was read at, which is the receiver. */
    readonly at: Place;
  }
  | Refusal;

/**
 * Helper for {@link dispatched}, which is what the handle `token` carries.
 *
 * A callable row is the whole of what carries a name. Every other row is a
 * place, and a place is a receiver the operand after it names a verb on, which
 * is the typed form with the receiver already in hand.
 */
function carriedName(shuttle: Shuttle, token: string): Carried {
  const bound = resolveHandle(shuttle.session.handles, token);
  if (bound.kind === "refused") return bound;
  return {
    kind: "named",
    ...(bound.row.kind === "callable" ? { name: bound.row.name } : {}),
    at: bound.at,
  };
}

/**
 * Helper for {@link call}, which runs the seam over `made` and is everything
 * it published.
 *
 * The argv the seam is handed is the line a person could have run outside the
 * shell, which is what a grammar refusal quotes back: a corrected line is only
 * useful where it can be run, and the address is what makes this one runnable.
 *
 * Four sinks stand in for the process's, and what each carries decides where
 * it lands. What the call published while it was still in flight goes out of
 * band as it happens, which is where a line with no outcome yet has to write.
 * The outcome and the next steps are what the line answers with. A failure's
 * report joins them in a refusal instead: the seam's `exit` is a throw here,
 * so a failed call arrives as a value rather than ending the run.
 *
 * The dispatch is bound to the connection this process holds, which is the one
 * thing the seam cannot do for itself — it would otherwise open a runtime, a
 * storage manager and a socket per call.
 */
async function invoke(
  shuttle: Shuttle,
  made: Called & { readonly kind: "call" },
  deps: VerbDeps,
): Promise<Outcome> {
  const rendered: string[] = [];
  const hinted: string[] = [];
  const printed: string[] = [];
  const announce = deps.announce ?? NOWHERE;
  const address = referenceForPlace(made.receiver);
  const options: PieceCallCLIOptions = {
    apiUrl: shuttle.config.apiUrl,
    identity: shuttle.config.identity,
    space: shuttle.config.space,
    cell: address,
    invocationSession: shuttle.invocationSession,
  };
  const raw = [
    "--cell",
    address,
    made.name,
    ...made.tail,
    ...(made.section.length === 0 ? [] : ["--", ...made.section]),
  ];
  try {
    const ran = await guarded(
      deps,
      deps.callFromCommand ?? callFromCommand,
      options,
      SPELLING,
      made.name,
      [...made.tail],
      raw,
      [...made.section],
      {
        executePieceCallable: (config, name, args, callableDeps = {}) =>
          (deps.executePieceCallable ?? executePieceCallable)(
            config,
            name,
            args,
            {
              ...callableDeps,
              loadPieces: () => shuttle.connection.pieces(),
              ...STDIN_IS_THE_KEYBOARD,
            },
          ),
        render: (text: unknown) => {
          rendered.push(String(text));
        },
        hint: (text: string) => {
          hinted.push(text);
        },
        printError: (text: string) => {
          printed.push(text);
        },
        announce,
        exit: (): never => {
          throw EXITED;
        },
      },
    );
    if (ran.kind !== "ran") return ran;
  } catch (thrown) {
    if (thrown === EXITED) {
      return refuse([...said(printed), ...served(rendered)].join("\n"));
    }
    if (thrown instanceof ValidationError) {
      return refuse(
        [...said(printed), ...said([messageOf(thrown)])].join("\n"),
      );
    }
    throw thrown;
  }
  return {
    kind: "text",
    text: [...served(rendered), ...said(hinted)].join("\n"),
  };
}

/** Where an out-of-band line goes for a caller that offered nowhere. */
const NOWHERE: Announce = () => {};
/**
 * Helper for {@link invoke}, which is prose a person reads, fit to be read on
 * a terminal: every character survives, and each one a terminal would act on
 * survives as the picture of itself.
 *
 * It is what the next steps and a failure's report get. Neither passed a door
 * — each is text the seam or the fabric wrote — and both are read rather
 * than parsed.
 */
function said(from: readonly string[]): string[] {
  return from.flatMap((line) => line.split("\n"))
    .map(escapeControlCharacters);
}

/**
 * Helper for {@link invoke}, which is what the call *returned*, escaped in
 * JSON's own spelling rather than shown as glyphs.
 *
 * The two conventions are not interchangeable, and which one a stream gets
 * turns on what a person does with it (`place.ts`). A glyph is one character
 * standing for another, which is right for prose and wrong for a value:
 * `\u001b` written as a glyph no longer parses back as the value the fabric
 * holds, and this stream is the one somebody pastes.
 *
 * The stream is mixed, and that is why the value convention wins rather than
 * losing. `renderPieceCallOutcome` puts four things on it — a help page, a
 * tool's serialized result, the Invocation JSON, and a one-line confirmation
 * — and `exitPieceCallFailure` a fifth, the Invocation JSON an expired wait
 * reports. Two of the five are values. The JSON escape is merely uglier on the
 * three that are prose, where the glyph is destructive on the two that are
 * not, so the convention that is safe on both is the one to run the whole
 * stream through.
 *
 * The line feed is left alone, as it is wherever this convention is used: a
 * pretty-printed value's own line breaks are its formatting, and escaping them
 * would fold it onto one line.
 */
function served(from: readonly string[]): string[] {
  return from.flatMap((line) => line.split("\n"))
    .map(escapeControlCharactersInJson);
}

/**
 * Helper for {@link listVerbs}, which is the line `verb` prints as, without
 * the number {@link numbered} puts in front of it.
 *
 * Everything on the line that is not the verb's name is written between angle
 * brackets, the listing convention: what it is and where it lives, then the
 * marks the listing carries, then the author's own prose flattened to a line.
 * Prose is a message rather than a name, so it is escaped rather than
 * described — every character survives and each one a terminal would act on
 * arrives as the picture of itself.
 */
function callableLine(verb: PieceCallableListing): string {
  const marks = [
    ...(verb.tier === "wrapper" ? ["wrapper"] : []),
    ...(verb.deprecated === true ? ["deprecated"] : []),
  ];
  return [
    verbNameToken(verb.name),
    marker(
      `${verb.kind} on ${verb.on}${
        marks.length === 0 ? "" : `, ${marks.join(", ")}`
      }`,
    ),
    ...(verb.description === undefined
      ? []
      : [marker(oneLine(verb.description))]),
  ].join(" ");
}

/**
 * Helper for {@link callableLine}, which is how a verb's name prints.
 *
 * A name is typed back — `call topics/3 <name>` is the typed spelling — so
 * it is written as a token rather than escaped, exactly as a listing's names
 * are. A name holding a character a terminal acts on is the one that cannot
 * be: writing it would put on the screen what every door refuses to let
 * through, and a rewritten one is no longer the name. It is described instead,
 * and the number the row was minted under is what still reaches the verb —
 * which is the same trade a listing makes for a row it has no name for.
 */
function verbNameToken(name: string): string {
  return holdsControlCharacter(name)
    ? marker("no name: a verb name holding a control character")
    : quoteToken(name);
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
    case "pair":
      if (given === 2) return undefined;
      return given < 2
        ? refuse(`\`${verb}\` takes ${arity.names}.`)
        : tooMany(verb, "two operands", given);
    case "section":
      // No maximum, and none is missing: the words past the verb's own
      // operands are the section, which is as long as the callable takes.
      return given >= arity.least
        ? undefined
        : refuse(`\`${verb}\` takes ${arity.names}.`);
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
    `${listed(VERB_WORDS)}.`;
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
 * Helper for the verbs that write a rendering, which is one page of `lines`
 * within `bound`, with the rest left on the session for `more`.
 *
 * `hint` is what the status line offers beside `more`, and it rides the
 * continuation so that every page of one rendering makes the same offer: a
 * `get` whose value ran to four pages says `--select` on all four, because it
 * is as true on the fourth as on the first.
 *
 * Every rendering passes through here, including one that fit whole, which is
 * what clears a continuation the line before it left: `more` after a listing
 * that fit is `more` with nothing waiting, not `more` writing the tail of the
 * listing before it.
 */
function paged(
  shuttle: Shuttle,
  header: readonly string[],
  entries: readonly string[],
  bound: PageBound,
  hint?: string,
): Outcome {
  const page: Page = pageOf(
    header,
    entries,
    bound,
    (left, overran) => statusLine(left, hint, overran),
  );
  shuttle.session.holding(
    page.rest.length === 0
      ? undefined
      : { lines: page.rest, ...(hint === undefined ? {} : { hint }) },
  );
  return { kind: "text", text: page.text };
}

/**
 * Helper for {@link paged}'s callers, which is the bound the screen puts on a
 * page: both of its dimensions, each what the deps say and each assumed where
 * they say nothing.
 */
function screenFit(deps: VerbDeps): PageBound {
  return heightFit(
    measured(deps.rows?.(), ASSUMED_ROWS),
    measured(deps.columns?.(), ASSUMED_COLUMNS),
  );
}

/**
 * Helper for {@link screenFit}, which is `reported` where it is a usable count
 * and `assumed` where it is not.
 *
 * A terminal that cannot measure itself reports a dimension that is no count
 * at all, and a caller driving a verb with nothing behind it reports none.
 * Both mean the same thing here — nothing said how big the screen is — so both
 * take the assumption rather than one of them reaching arithmetic over it.
 */
function measured(reported: number | undefined, assumed: number): number {
  return reported !== undefined && Number.isFinite(reported) && reported > 0
    ? reported
    : assumed;
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
