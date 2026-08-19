import { type FabricValue } from "@/interface.ts";
import type { LiveEnvironment } from "@/codec-interface/interface.ts";
import { type CodecRegistry } from "./CodecRegistry.ts";
import { BaseDecodeAct } from "./BaseDecodeAct.ts";
import { BaseEncodeAct } from "./BaseEncodeAct.ts";
import type { CodecEngineConfig } from "./CodecEngineConfig.ts";
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
  EncAct extends BaseEncodeAct<Encoded, SerializedForm> = BaseEncodeAct<
    Encoded,
    SerializedForm
  >,
  DecAct extends BaseDecodeAct<Encoded, SerializedForm> = BaseDecodeAct<
    Encoded,
    SerializedForm
  >,
> implements CodecEngineConfig<Encoded> {
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
  get registry(): CodecRegistry<Encoded> {
    return this.#registry;
  }

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

    return act.serializedFromEncoded(act.encodeValue(value));
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
      return act.decodeValue(act.encodedFromSerializedForm(data));
    } catch (e) {
      return act.settleThrown(e);
    }
  }
}
