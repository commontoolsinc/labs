import { backtickQuote } from "@commonfabric/utils/markdown";
import { isPlainObject } from "@commonfabric/utils/types";

import { FabricSpecialObject, type FabricValue } from "@/interface.ts";
import { toCompactDebugString } from "@/value-debug.ts";
import { deepFreeze } from "@/deep-freeze.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import type {
  CodecForFormat,
  NonterminalCodec,
  ReconstructionContext,
  SerializationContext,
  TerminalCodec,
} from "@/codec-interface/interface.ts";
import { type CodecRegistry, SELF_REP } from "./CodecRegistry.ts";
import { ProblematicValue } from "./ProblematicValue.ts";
import { UnknownValue } from "./UnknownValue.ts";

/**
 * Base class for a whole-value codec: the object that walks a fabric value
 * into one wire format's transport tree and back. What lives here is the part
 * that consults the codec registry and acts on what it says; what a subclass
 * supplies is everything specific to how its format writes a container down.
 *
 * Two type parameters, because a format's transport tree is not necessarily
 * what crosses its public boundary. `Encoded` is the tree the walk and the
 * codecs work in; `SerializedForm` is what `encode()` returns and `decode()`
 * accepts. JSON's differ -- a `JsonCodecValue` tree, reduced to a `string` by
 * a stringify step -- and a format whose tree is what crosses leaves the
 * second parameter to default to the first.
 *
 * The division is between what a format decides and what it must not:
 *
 * * A self-representing value is emitted as it stands, and a value matching no
 *   codec is either a container or an error.
 * * A terminal codec's state is final and a nonterminal codec's is walked
 *   again -- read off the codec's base class, on both sides of the trip.
 * * A tag comes from `tagForValue()` rather than from the value.
 * * An unrecognized tag becomes an `UnknownValue`, and an empty one an error,
 *   per Section 9 of the formal spec.
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
export abstract class BaseCodecEngine<Encoded, SerializedForm = Encoded>
  implements SerializationContext<SerializedForm> {
  /**
   * Whether a failed reconstruction produces a `ProblematicValue` instead of
   * throwing.
   */
  readonly lenient: boolean;

  /** Registry consulted for per-type encoding and decoding. */
  protected readonly registry: CodecRegistry<Encoded>;

  /**
   * Constructs an instance. `options.registry` supplies the codecs this
   * instance encodes and decodes with, and so decides which classes it can
   * carry; there is no default, because which classes participate is a
   * question this class has no standing to answer. `options.lenient` makes a
   * failed reconstruction produce a `ProblematicValue` instead of throwing.
   */
  constructor(
    options: { registry: CodecRegistry<Encoded>; lenient?: boolean },
  ) {
    this.lenient = options.lenient ?? false;
    this.registry = options.registry;
  }

  //
  // Instance members
  //

  /**
   * Encodes a fabric value into this format's serialized form, ready to cross
   * whatever boundary the format exists for.
   *
   * The result carries a marker identifying the format, so that a receiver can
   * tell one of these from an arbitrary value arriving on the same channel.
   * What that marker is belongs to the format.
   *
   * @throws If `value` holds something the format cannot carry: a
   *   `FabricSpecialObject` whose class no codec in the registry claims, a
   *   cycle, or an object that is no kind of `FabricValue` at all.
   */
  abstract encode(value: FabricValue): SerializedForm;

  /**
   * Decodes this format's serialized form back into a fabric value.
   *
   * `context` supplies what reconstruction needs beyond the data itself,
   * chiefly the ability to resolve a cell reference.
   *
   * A codec that rejects the state it is handed either throws or is wrapped in
   * a `ProblematicValue`, according to {@link #lenient}. A tag no codec in the
   * registry claims becomes an `UnknownValue`, which is not a failure: it is
   * how a value survives a round trip through a reader that does not know the
   * type.
   *
   * @throws If `data` does not carry this format's marker, or if a codec
   *   rejects a state and this instance is not lenient.
   */
  abstract decode(
    data: SerializedForm,
    context: ReconstructionContext,
  ): FabricValue;

  /**
   * Encodes a fabric value into the transport tree, dispatching on what the
   * registry says about it and handing a container to this format's own arms.
   *
   * `seen` carries the values whose encoding is in progress, so that a cycle
   * is caught rather than followed. It is created on the first arm that needs
   * one rather than up front, so that encoding a lone self-representing value
   * -- much the commonest case, and the one where a fixed cost shows up most
   * -- allocates nothing.
   */
  protected encodeValue(value: FabricValue, seen?: Set<object>): Encoded {
    const matched = this.registry.codecFromValue(value);

    if (matched === SELF_REP) {
      // A self-representing primitive is its own wire form.
      return value as Encoded;
    } else if (matched) {
      return this.#encodeTagged(value, matched, seen ?? new Set());
    }

    // Self-representing primitives returned above, so `value` is an object
    // from here on, and the two container arms are what an ordinary one takes.
    // Neither can claim a `FabricSpecialObject`: `isPlainObject()` tests the
    // prototype, and one of those has a class.

    if (Array.isArray(value)) {
      return this.encodeArray(value, seen ?? new Set());
    } else if (isPlainObject(value)) {
      return this.encodePlainObject(value, seen ?? new Set());
    } else if (value instanceof FabricSpecialObject) {
      // Every `FabricSpecialObject` has to be recognized by a registered
      // codec. Nothing matched above, so this one is not carried.
      throw new Error(
        `No codec registered for \`FabricSpecialObject\` subclass ${
          backtickQuote(value.constructor.name)
        }.`,
      );
    }

    // Every `FabricValue` object case is handled above, so what is left is
    // always an error -- generally traceable to a type-system lie somewhere
    // upstream.
    throw new Error(
      `Cannot encode ${
        backtickQuote(toCompactDebugString(value, 50))
      }: no applicable codec.`,
    );
  }

  /** Encodes one value through the codec the registry matched to it. */
  #encodeTagged(
    value: FabricValue,
    matched: CodecForFormat<Encoded>,
    seen: Set<object>,
  ): Encoded {
    const isObject = (value !== null) && (typeof value === "object");

    if (isObject) {
      BaseCodecEngine.enterOrThrow(seen, value as object);
    }

    // `tagForValue()` rather than any direct property of `value`, because the
    // value need not know which codec is being used for it: the tag is the
    // codec's determination, not the value's.
    //
    // A terminal codec's state is already in this format's domain, so it is
    // final; a nonterminal codec's is made of fabric values, which this walk
    // has yet to expand.
    const tag = matched.tagForValue(value);
    const state = (matched instanceof BaseTerminalCodec)
      ? (matched as TerminalCodec<Encoded>).encode(value)
      : this.encodeValue((matched as NonterminalCodec).encode(value), seen);

    if (isObject) {
      seen.delete(value as object);
    }

    return this.wrapTag(tag, state);
  }

  /**
   * Decodes one tagged value, dispatching on the tag through the registry. A
   * subclass calls this once it has recognized a tagged form and taken off
   * whatever meta-tags this format defines for itself.
   *
   * Frozen-ness contract: a value returned through the codec arm here is
   * deep-frozen, so callers do not each have to freeze. The unknown-tag
   * fallback is a separate arm and is intentionally NOT covered by it.
   */
  protected decodeTagged(
    tag: string,
    rawState: Encoded,
    context: ReconstructionContext,
  ): FabricValue {
    const matched = this.registry.codecFromTag(tag);

    if (matched === undefined) {
      const state = this.decodeValue(rawState, context);

      // An empty tag is an encoding error whatever follows it, per Section 9
      // of the formal spec, so it is reported rather than preserved as an
      // `UnknownValue` with no name. Otherwise the tag is simply one this
      // registry does not carry, and the unknown form is kept so that it
      // round-trips. Neither of these is covered by the deep-frozen contract
      // the codec arm below states.
      return (tag === "")
        ? new ProblematicValue(tag, state, "tagged value has an empty tag")
        : new UnknownValue(tag, state);
    }

    // A terminal codec takes the state exactly as it arrived; a nonterminal
    // one takes it expanded. The casts restate what `instanceof` just
    // established, which TypeScript drops on a generic class.
    const terminal = matched instanceof BaseTerminalCodec;
    const state = terminal ? rawState : this.decodeValue(rawState, context);

    try {
      // A codec's `decode()` promises deep-frozen results rather than relying
      // on every caller to freeze, so both returns here pass through
      // `deepFreeze()`. That covers the codec's own product -- a
      // `FabricPrimitive` is already frozen, making it an O(1) cache hit --
      // and the lenient fallback alike.
      return deepFreeze(
        terminal
          ? (matched as TerminalCodec<Encoded>).decode(tag, rawState, context)
          : (matched as NonterminalCodec).decode(
            tag,
            state as FabricValue,
            context,
          ),
      );
    } catch (e: unknown) {
      if (!this.lenient) {
        throw e;
      }

      // Report over the state the codec was actually handed, so that it says
      // what the codec choked on.
      return deepFreeze(
        new ProblematicValue(
          tag,
          state as FabricValue,
          e instanceof Error ? e.message : String(e),
        ),
      );
    }
  }

  /** Encodes an array, which is this format's business entirely. */
  protected abstract encodeArray(
    value: readonly FabricValue[],
    seen: Set<object>,
  ): Encoded;

  /** Encodes a plain object, which is this format's business entirely. */
  protected abstract encodePlainObject(
    value: Record<string, FabricValue>,
    seen: Set<object>,
  ): Encoded;

  /** Wraps a tag and state into this format's tagged wire form. */
  protected abstract wrapTag(tag: string, state: Encoded): Encoded;

  /** Decodes a transport tree back into fabric values. */
  protected abstract decodeValue(
    data: Encoded,
    context: ReconstructionContext,
  ): FabricValue;

  //
  // Static members
  //

  /**
   * Adds a value to the in-progress set, refusing a repeat visit.
   *
   * @throws If `value` is already in `seen`.
   */
  protected static enterOrThrow(seen: Set<object>, value: object): void {
    if (seen.has(value)) {
      throw new Error("Circular reference detected during serialization");
    }
    seen.add(value);
  }
}
