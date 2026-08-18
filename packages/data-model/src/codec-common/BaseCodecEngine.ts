import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject, isUnsafeObjectKey } from "@commonfabric/utils/types";

import { FabricSpecialObject, type FabricValue } from "@/interface.ts";
import { toCompactDebugString } from "@/value-debug.ts";
import { deepFreeze } from "@/deep-freeze.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import type {
  CodecForFormat,
  LiveEnvironment,
  NonterminalCodec,
  TerminalCodec,
} from "@/codec-interface/interface.ts";
import { type CodecRegistry, SELF_REP } from "./CodecRegistry.ts";
import { DecodeAct } from "./DecodeAct.ts";
import { EncodeAct } from "./EncodeAct.ts";
import type { CodecEngineConfig } from "./CodecEngineConfig.ts";
import { isCodecTypeTag } from "./isCodecTypeTag.ts";
import { ProblematicStateError } from "./ProblematicStateError.ts";
import { ProblematicValue } from "./ProblematicValue.ts";
import { UnknownValue } from "./UnknownValue.ts";
import { NULL_LIVE_ENVIRONMENT } from "@/codec-interface/NullLiveEnvironment.ts";

/**
 * Base class for a whole-value codec: the object that walks a fabric value
 * into one wire format's transport tree and back. What lives here is the part
 * that consults the codec registry and acts on what it says; what a subclass
 * supplies is everything specific to how its format writes a container down.
 *
 * Four type parameters, of which a format states as many as it needs.
 *
 * The first two are about the wire, and are two because a format's transport
 * tree is not necessarily what crosses its public boundary. `Encoded` is the
 * tree the walk and the codecs work in; `SerializedForm` is what `encode()`
 * returns and `decode()` accepts. JSON's differ -- a `JsonCodecValue` tree,
 * reduced to a `string` by a stringify step -- and a format whose tree is
 * what crosses leaves the second to default to the first.
 *
 * The other two are the acts of encoding and decoding themselves, and
 * default to the base classes, so a format needing no more than the walk's
 * own bookkeeping names neither. A format that does -- one whose tagged
 * form carries a marker minted per call, say -- subclasses an act and binds
 * it here. Its overrides then receive the narrowed type by
 * construction: the signatures match exactly, so nothing needs a cast.
 *
 * The division is between what a format decides and what it must not:
 *
 * * A self-representing value is emitted as it stands, and a value matching no
 *   codec is either a container or an error.
 * * A terminal codec's state is final and a nonterminal codec's is walked
 *   again -- read off the codec's base class, on both sides of the trip.
 * * A tag comes from `tagForValue()` rather than from the value.
 * * An unrecognized tag becomes an `UnknownValue`, and one that is not a tag
 *   at all an error, per Section 9 of the formal spec.
 * * A codec's `decode()` result is deep-frozen, and a throw from one is
 *   re-raised or wrapped according to `lenient`.
 *
 * None of those is a property of a wire format, and every one of them is a
 * decision a walker could quietly get wrong: a state expanded when it should
 * have been passed through, or the reverse, surfaces far from the dispatch
 * that decided it, and where a state is a record of strings the two choices
 * emit byte-identical output. Holding them in one place is worth more than the
 * lines it saves.
 *
 * What a subclass owns is everything about containers, and that is where a
 * format is entitled to differ: whether keys are ordered, whether a key can
 * collide with the tag form and so needs escaping, and how an absent array
 * index is written down. A format that answers those differently is not
 * varying an implementation detail; it is being a different format.
 */
export abstract class BaseCodecEngine<
  Encoded,
  SerializedForm = Encoded,
  EncAct extends EncodeAct = EncodeAct,
  DecAct extends DecodeAct = DecodeAct,
> implements CodecEngineConfig {
  readonly #lenient: boolean;
  readonly #registry: CodecRegistry<Encoded>;

  /**
   * Constructs an instance. `options.registry` supplies the codecs this
   * instance encodes and decodes with, and so decides which classes it can
   * carry; there is no default, because which classes participate is a
   * question this class has no standing to answer. `options.lenient` makes a
   * failed `decode()` produce a `ProblematicValue` instead of throwing.
   */
  constructor(
    options: { registry: CodecRegistry<Encoded>; lenient?: boolean },
  ) {
    this.#lenient = options.lenient ?? false;
    this.#registry = options.registry;
  }

  //
  // Subclass contract
  //

  /**
   * Encodes a fabric value into this format's serialized form, ready to cross
   * whatever boundary the format exists for.
   *
   * Whether the result identifies itself is the format's to decide, and the
   * decision follows from its boundary. A form that is persisted, or that
   * shares a channel with values this system did not write, needs a marker so
   * a receiver can tell one of these from anything else arriving; a form
   * constructed, handed straight to a transport and decoded on the far side
   * has nothing for a marker to distinguish it from. A format that carries one
   * says what it is, and one that does not says why not.
   *
   * `env` is what a codec would reach the running system through, and is
   * carried on the act this call mints. A caller that names none gets
   * `NULL_LIVE_ENVIRONMENT`, so a codec asking such an environment for a
   * cell fails by name rather than on `undefined`.
   *
   * @throws If `value` holds something the format cannot carry: a
   *   `FabricSpecialObject` whose class no codec in the registry claims, a
   *   cycle, or an object that is no kind of `FabricValue` at all.
   */
  encode(
    value: FabricValue,
    env: LiveEnvironment = NULL_LIVE_ENVIRONMENT,
  ): SerializedForm {
    const act = this.newEncodeAct(env);

    return this.serializedFromEncoded(this.encodeValue(value, act), act);
  }

  /**
   * Decodes this format's serialized form back into a fabric value.
   *
   * `env` supplies what decoding needs beyond the data itself,
   * chiefly the ability to resolve a cell reference.
   *
   * A codec rejects a state it will not accept in one of two ways, by
   * throwing or by returning a `ProblematicValue`, and which one it picks is
   * the codec author's business. {@link #lenient} decides what a caller sees,
   * settling both into the same answer: strictly, either form of rejection
   * raises; leniently, either becomes a `ProblematicValue` in the result.
   *
   * A tag no codec in the registry claims is a different matter, and becomes
   * an `UnknownValue` under both settings. That is not a rejection: it is how
   * a value survives a round trip through a reader that does not know the
   * type.
   *
   * @throws If `data` is not this format's serialized form -- which a format
   *   carrying a marker can tell from the marker alone, and one without can
   *   only tell from finding something it never emits -- or if a codec rejects
   *   a state and this instance is not lenient.
   */
  decode(
    data: SerializedForm,
    env: LiveEnvironment = NULL_LIVE_ENVIRONMENT,
  ): FabricValue {
    const act = this.newDecodeAct(env, data);

    try {
      return this.decodeValue(this.encodedFromSerializedForm(data), act);
    } catch (e) {
      return act.settleSyntacticRefusal(e);
    }
  }

  /**
   * Converts the walk's finished tree into this format's serialized form --
   * a stringify step, an envelope, or nothing at all for a format whose tree
   * is what crosses.
   *
   * `act` is the act the tree was built by, for a format whose serialized form
   * carries something minted per call.
   */
  protected abstract serializedFromEncoded(
    encoded: Encoded,
    act: EncAct,
  ): SerializedForm;

  /**
   * Converts this format's serialized form into the tree the walk decodes,
   * which is where a format checks that what it was handed is its own: a parse
   * step, an envelope check, or nothing at all.
   *
   * What arrives is data off a channel and is not to be assumed well-formed. A
   * form that is not this format's is refused by throwing
   * `ProblematicStateError`, which {@link #decode} settles against
   * {@link #lenient} -- so a lenient decode returns a `ProblematicValue` for
   * a syntactic fault, exactly as it does for a fault found further in.
   *
   * Takes no act. What a format needs out of the form for the act it is
   * about to run, it takes in {@link #newDecodeAct}, which sees the same
   * form; this step is the conversion and nothing else.
   */
  protected abstract encodedFromSerializedForm(
    data: SerializedForm,
  ): Encoded;

  /**
   * Encodes an array, which is this format's business entirely.
   *
   * An implementation owes `act` one thing, the same thing the decode side
   * owes it: the container goes in through `act.enter()` and comes back out
   * through `act.leave()` however the descent ends, a throw included. The
   * act outlives a throw, belonging to the call rather than to the node, so
   * an entry left behind makes a later visit to the same value report a
   * cycle that is not there.
   */
  protected abstract encodeArray(
    value: readonly FabricValue[],
    act: EncAct,
  ): Encoded;

  /**
   * Encodes a plain object, which is this format's business entirely. Owes
   * `act` the same enter/leave discipline {@link #encodeArray} states.
   */
  protected abstract encodePlainObject(
    value: Record<string, FabricValue>,
    act: EncAct,
  ): Encoded;

  /**
   * Wraps a tag and state into this format's tagged wire form.
   *
   * `act` is the act of encoding this form belongs to, for a format whose
   * tagged form carries something minted per call.
   */
  protected abstract wrapTag(
    tag: string,
    state: Encoded,
    act: EncAct,
  ): Encoded;

  /**
   * Decodes a transport tree back into fabric values.
   *
   * `act` carries the live environment and the nodes whose decoding is in
   * progress, so that a cycle arriving on a channel is caught rather than
   * followed. Whether cycles are guarded at all is the format's decision,
   * made by whether this method enters a node: a format whose input it
   * parses for itself cannot be handed a cycle, so it enters none and its
   * act allocates no set.
   *
   * An implementation that does guard owes the act one thing: every
   * object it is about to descend through goes through
   * {@link #enterOrReport} first, and comes back out through `act.leave()`
   * however the descent ends. That means the tagged
   * form as much as a container -- a format whose transport can carry a graph
   * can close a cycle through tagged nodes alone. Here rather than in
   * {@link #decodeTagged}, because this method is the one that visits every
   * node, and entering in both places would enter a state twice and report a
   * cycle that is not there.
   */
  protected abstract decodeValue(
    data: Encoded,
    act: DecAct,
  ): FabricValue;

  /**
   * Constructs one act of encoding, around the live
   * environment the caller gave. Called once per `encode()`, and the hook by
   * which a format carries more through its walk than the base class knows
   * about.
   */
  protected abstract newEncodeAct(env: LiveEnvironment): EncAct;

  /**
   * Constructs one act of decoding, around the live
   * environment the caller gave and the form about to be decoded. Called
   * once per `decode()`.
   *
   * `data` is here so that a format whose walk needs something carried in
   * the form itself -- a marker read off an envelope, say -- can take it
   * now. It **sniffs rather than validates**: this runs before anything
   * has checked that `data` is this format's at all, so an implementation
   * reads defensively and leaves the refusing to
   * {@link #encodedFromSerializedForm}.
   */
  protected abstract newDecodeAct(
    env: LiveEnvironment,
    data: SerializedForm,
  ): DecAct;

  //
  // Instance members
  //

  /**
   * Whether a failed `decode()` produces a `ProblematicValue` instead of
   * throwing.
   */
  get lenient(): boolean {
    return this.#lenient;
  }

  /** Registry consulted for per-type encoding and decoding. */
  protected get registry(): CodecRegistry<Encoded> {
    return this.#registry;
  }

  /**
   * Encodes a fabric value into the transport tree, dispatching on what the
   * registry says about it and handing a container to this format's own arms.
   *
   * `act` carries the values whose encoding is in progress, so that a cycle
   * is caught rather than followed. Its set is created on the first value
   * entered rather than up front, so that encoding a lone self-representing
   * value -- much the commonest case, and the one where a fixed cost shows up
   * most -- allocates nothing beyond the act.
   */
  protected encodeValue(value: FabricValue, act: EncAct): Encoded {
    const matched = this.registry.codecFromValue(value);

    if (matched === SELF_REP) {
      // A self-representing primitive is its own wire form.
      return value as Encoded;
    } else if (matched) {
      // `value` matched from the registry as either a non-self-representing
      // primitive or a `FabricSpecialObject`.
      return this.#encodeTagged(value, matched, act);
    } else if (Array.isArray(value)) {
      return this.encodeArray(value, act);
    } else if (isPlainObject(value)) {
      // Note: `isPlainObject()` means what it says; notably, it returns `false`
      // for `FabricSpecialObject`s.
      return this.encodePlainObject(value, act);
    }

    // At this point, we know `value` can't be encoded. We just need to figure
    // out the right error message.

    if (value instanceof FabricSpecialObject) {
      throw new Error(
        `No codec registered for \`FabricSpecialObject\` subclass ${
          backtickQuote(value.constructor.name)
        }.`,
      );
    } else {
      // `value` is a primitive, a function, or a non-`FabricSpecialObject`
      // instance (non-plain object). Distinguish them in the error message. The
      // notable primitive case here is uninterned symbols (which are forbidden
      // by the data model but cannot be forbidden in the type system). The
      // instance and function cases are all almost certainly due to something
      // upstream lying about the type of `value`.
      const typeName = typeof value;
      const label = (typeName === "object") ? "instance" : typeName;
      throw new Error(
        `Cannot encode ${label} ${
          backtickQuote(toCompactDebugString(value, 50))
        }: no applicable codec.`,
      );
    }
  }

  /**
   * Decodes one tagged value, dispatching on the tag through the registry. A
   * subclass calls this once it has recognized a tagged form and taken off
   * whatever meta-tags this format defines for itself.
   *
   * The tag's syntax is checked here rather than by each caller: `tag` is
   * whatever a format found in tag position, of whatever type, and a subclass
   * is not expected to know what a tag may look like.
   *
   * Frozen-ness contract: a value returned through the codec arm here is
   * deep-frozen, so callers do not each have to freeze. The unknown-tag
   * fallback is a separate arm and is intentionally NOT covered by it.
   *
   * Three of the arms below walk the state again -- a nonterminal codec's, an
   * unknown tag's, and a malformed tag's -- and each carries `act` into that
   * walk. Entering the state is not this method's business: it is
   * {@link #decodeValue} that visits every node of the tree, the tagged form
   * included, and entering there is what keeps one node from being entered
   * twice.
   */
  protected decodeTagged(
    tag: any,
    rawState: Encoded,
    act: DecAct,
  ): FabricValue {
    if (!isCodecTypeTag(tag)) {
      // Anything that is not a tag syntactically is an encoding error whatever
      // follows it, per Section 9 of the formal spec, and is reported rather
      // than preserved as an `UnknownValue`: that form exists to round-trip a
      // tag no codec claims, which presupposes a tag. Reported over the
      // decoded state, so that a lenient result carries what arrived.
      return act.reportMalformed(
        tag,
        this.decodeValue(rawState, act),
        `tagged value has a malformed tag: ${
          backtickQuote(toCompactDebugString(tag, 30))
        }`,
      );
    }

    const matched = this.registry.codecFromTag(tag);

    if (matched === undefined) {
      // A tag this registry does not carry, kept in the unknown form so that
      // it round-trips. Not covered by the deep-frozen contract the codec arm
      // below states.
      return new UnknownValue(tag, this.decodeValue(rawState, act));
    }

    // A terminal codec takes the state exactly as it arrived; a nonterminal
    // one takes it expanded. The casts restate what `instanceof` just
    // established, which TypeScript drops on a generic class.
    const terminal = matched instanceof BaseTerminalCodec;
    const state = terminal ? rawState : this.decodeValue(rawState, act);

    let decoded: FabricValue;

    try {
      decoded = terminal
        ? (matched as TerminalCodec<Encoded>).decode(tag, rawState, act.env)
        : (matched as NonterminalCodec).decode(
          tag,
          state as FabricValue,
          act.env,
        );
    } catch (e: any) {
      if (!this.lenient) {
        // Normalized rather than rethrown: what a codec throws is not
        // guaranteed to be an `Error`, let alone one naming the state it
        // choked on. `fromThrown()` returns one that does -- the thrown
        // value itself where it already qualifies, and otherwise a fresh one
        // holding it as `cause`.
        throw ProblematicStateError.fromThrown(tag, state, e);
      }

      // Report over the state the codec was actually handed, so that it says
      // what the codec choked on.
      return act.reportMalformed(
        tag,
        state,
        e instanceof Error ? e.message : String(e),
      );
    }

    if (
      !this.lenient && (decoded instanceof ProblematicValue) &&
      (matched.uniqueHandledClass !== ProblematicValue)
    ) {
      // The two ways a codec reports a state it will not accept -- throwing,
      // and returning one of these -- are the codec author's choice and say
      // nothing about what a caller wants. `lenient` is what says that, so
      // this instance settles both into the same answer: a strict decode
      // fails, whichever way the codec reported it.
      //
      // `ProblematicValue`'s own codec is exempt, because for that one a
      // `ProblematicValue` is the successful product rather than a refusal.
      // A payload under `Problematic@1` is a well-formed record of a past
      // failure, and reading one is not a failure of this decode; without the
      // exemption a strict reader could never read such a record back, which
      // is most of what preserving one is for.
      throw new ProblematicStateError(tag, decoded.state, decoded.error);
    }

    // A codec's `decode()` promises deep-frozen results rather than relying on
    // every caller to freeze. That covers the codec's own product -- a
    // `FabricPrimitive` is already frozen, making it an O(1) cache hit -- and
    // the lenient fallback above alike.
    return deepFreeze(decoded);
  }

  /** Encodes one value through the codec the registry matched to it. */
  #encodeTagged(
    value: FabricValue,
    matched: CodecForFormat<Encoded>,
    act: EncAct,
  ): Encoded {
    const isObject = (value !== null) && (typeof value === "object");

    if (isObject) {
      act.enter(value as object);
    }

    // `tagForValue()` rather than any direct property of `value`, because the
    // value need not know which codec is being used for it: the tag is the
    // codec's determination, not the value's.
    //
    // A terminal codec's state is already in this format's domain, so it is
    // final; a nonterminal codec's is made of fabric values, which this walk
    // has yet to expand.
    let tag: string;
    let state: Encoded;

    try {
      tag = matched.tagForValue(value);
      state = (matched instanceof BaseTerminalCodec)
        ? (matched as TerminalCodec<Encoded>).encode(value)
        : this.encodeValue((matched as NonterminalCodec).encode(value), act);
    } finally {
      // Left in a `finally` because `tagForValue()` and a codec's
      // `encode()` can both throw. The act outlives a throw -- it belongs
      // to the call, not to this node -- so an entry left behind would make a
      // later visit to the same value report a cycle that is not there.
      if (isObject) {
        act.leave(value as object);
      }
    }

    return this.wrapTag(tag, state, act);
  }

  //
  // Static members
  //

  /**
   * Refuses a key this runtime reserves on the way out.
   *
   * Encoding one cannot be made faithful. A rebuild by assignment drops
   * `__proto__` where the host routes it through an inherited setter, and
   * where it does not, the result is text a decoder refuses on the way back --
   * so a value carrying one is either quietly damaged or written and never
   * readable. Both are worse than a refusal, and the caller is local code
   * whose value this is, rather than a channel handing over data.
   *
   * @throws If `key` is one this runtime reserves.
   */
  protected static assertEncodableKey(key: string): void {
    if (isUnsafeObjectKey(key)) {
      throw new Error(
        `Cannot encode an object with a key this runtime reserves: ${
          backtickQuote(key)
        }`,
      );
    }
  }
}
