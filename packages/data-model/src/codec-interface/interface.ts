/**
 * The codec layer's contracts, written without naming any wire format: what a
 * codec is, the two things its state can mean to a walker, and what an
 * encode or a decode carries alongside the data.
 *
 * The distinction running through all of it is that a codec's type does not
 * say what its state is for. Every codec has the same members whatever domain
 * it works in, and the domains overlap, so which kind a codec is has to be
 * declared by the base class it extends rather than inferred from its
 * signature. Everything downstream -- what a registry will accept, how a
 * walker dispatches -- reads that declaration.
 */

import type { Constructor } from "@commonfabric/utils/types";

import type { FabricInstance, FabricValue } from "@/interface.ts";

/**
 * Well-known symbol for binding the getter
 * `FabricClassWithNonterminalCodec[CODEC]`.
 */
export const CODEC: unique symbol = Symbol("data-model.codec");

/**
 * Well-known symbol for binding the static getter `[JSON_CODEC]` on a
 * `FabricPrimitive` class.
 *
 * No interface declares that obligation, and none can: {@link CodecRegistry}
 * reads a per-format codec through a symbol _variable_, so it must type a
 * class as `Partial<Record<symbol, ...>>`, which no fixed-symbol interface
 * satisfies. The obligation is enforced when a registry is built instead --
 * `registerClass()` throws for a class supplying no codec for the format in
 * play. {@link FabricClassWithNonterminalCodec} can exist only because
 * {@link CODEC} is statically known.
 *
 * A `FabricPrimitive`'s codec is bound per wire format, not once for all of
 * them, because these classes are where the formats disagree. `FabricBytes`
 * encodes to a base64url string, which is JSON's answer and nobody else's: a
 * format that carries bytes natively wants a different codec, or none, and
 * says so by looking up a different symbol.
 *
 * What differs can be the _kind_ of codec and not merely the state it
 * produces, which is why the binding is per format rather than a property of
 * the class. `FabricRegExp` expands into a record of strings under JSON,
 * which has no pattern type of its own to terminate into.
 *
 * That is what separates these from a `FabricInstance`'s codec, bound to the
 * generic `[CODEC]`: an instance's codec only expands an instance into other
 * `FabricValue`s and leaves every terminal decision to whatever walks the
 * result, so one binding serves every format.
 */
export const JSON_CODEC: unique symbol = Symbol("data-model.jsonCodecEngine");

/**
 * Interface for codecs (encoder-decoder objects). These are objects which can
 * extract "essential state" out of values (objects per se or otherwise) and
 * also take such "essential state" and produce values that are equivalent (in
 * a context-dependent sense) to the values that state was extracted from.
 *
 * `Encoded` is the domain that essential state lives in. Every codec has the
 * same shape whatever that domain is -- the same matching members, the same
 * pair of transformations -- and the domain is the only thing that varies.
 * {@link NonterminalCodec} and {@link TerminalCodec} name the two ways it is
 * instantiated in practice, and are where the consequences are written down.
 *
 * The domain does not by itself say what the codec system should do with a
 * state, and it cannot: the domains overlap, in that an all-string record
 * satisfies `FabricValue` and JSON's value type alike. That is settled instead
 * by which base class a codec extends, which is where it stays: a registry
 * refuses a codec extending neither and otherwise stores it unaltered, and a
 * walker reads the class when it dispatches.
 */
export interface FabricCodec<Encoded> {
  /**
   * The unique _direct_ class of instances, if any, that is associated with the
   * format this instance encodes. The codec system uses this to make a quick
   * determination about value compatibility before calling {@link #canEncode}
   * to confirm.
   */
  get uniqueHandledClass(): Constructor | undefined;

  /**
   * The unique wire format tag that is associated with the format this instance
   * decodes from, or `undefined` for a codec with no single tag. When defined,
   * the codec system uses it to mark state produced by {@link #encode} and (by
   * default) routes state so marked back to this instance (or an equivalent)
   * for decoding; a codec with no tag is not registered for tag-based decode
   * dispatch.
   */
  get recognizedTypeTag(): string | undefined;

  /** Returns `true` if this handler can encode the state of the given value. */
  canEncode(value: FabricValue): boolean;

  /**
   * Returns the wire type tag to use when encoding the given value. Only ever
   * called on a value for which {@link #canEncode} has returned `true`. Unlike
   * {@link #recognizedTypeTag} -- the codec's single recognized tag, if it has
   * one -- this is the concrete tag for a _specific_ value; a codec whose
   * instances each carry their own per-instance tag reads it from the value.
   */
  tagForValue(value: FabricValue): string;

  /**
   * Decodes a value from the given essential state, which is (alleged /
   * supposed) to be a value that was produced by an earlier call to
   * {@link #encode} on a compatible class to this one. The result is expected
   * to be a _shallow_ decoding; the codec system handles recursively
   * converting `state` contents as necessary.
   *
   * The given `typeTag` is what was associated with the given `state` and does
   * not necessarily correspond to {@link #recognizedTypeTag} (depending on how
   * an instance of this class got hooked up).
   *
   * `state` is the whole of `Encoded` rather than the narrower thing
   * {@link #encode} emits, because decoding is dispatched on a tag read from
   * untrusted input: a payload can carry any state at all under this codec's
   * tag. Rejecting what does not fit is part of the job.
   */
  decode(
    typeTag: string,
    state: Encoded,
    context: LiveEnvironment,
  ): FabricValue;

  /**
   * Encodes the given value, returning its essential state. This is only ever
   * called after {@link #canEncode} has confirmed that `value` is encodable by
   * this instance. The result is expected to be a _shallow_ encoding; the
   * codec system handles recursion as necessary.
   */
  encode(value: FabricValue): Encoded;
}

/**
 * A codec whose essential state is **nonterminal**: it is itself made of
 * fabric values, which the walker goes on to expand in turn. The sense is the
 * one formal grammars give the word -- a state that arrives here is not an
 * answer but something that must be rewritten further before it is one.
 *
 * Instantiating {@link FabricCodec} at `FabricValue` is what says so, because
 * that is the walker's own input domain: handing the walker a state of that
 * type is handing it more work of exactly the kind it already does. A codec of
 * this kind therefore settles nothing about how those values are ultimately
 * written down, and one instance serves every wire format.
 *
 * `FabricError` is the clearest case. Its state carries `cause` and every
 * `extraEntries()` pair, so it can hold arbitrary nested values -- including
 * other instances -- and only the walker can know what to do with them.
 */
export type NonterminalCodec = FabricCodec<FabricValue>;

/**
 * A codec whose essential state is **terminal**: it is already in the domain
 * of one particular wire format, and the walker passes it through rather than
 * expanding it further.
 *
 * Instantiating {@link FabricCodec} at a format's own value type is what says
 * so. Such a codec is bound to that one format, and a class needing one
 * supplies a separate instance per format it participates in.
 *
 * `FabricBytes` is the clearest case: JSON's codec produces a base64url
 * string, where a format that carries bytes natively wants the bytes
 * themselves, and no one codec can answer both.
 *
 * The difference between the two kinds is not in the shape of a codec -- both
 * have the same members -- but in what its state means to the walker. A class
 * declares which it is by the base class it extends, and that declaration is
 * the only record of it.
 *
 * `Encoded` ranges over the wire formats' own value types. `FabricValue` is
 * not among them, and instantiating at it is unsound; see
 * {@link BaseTerminalCodec}.
 */
export type TerminalCodec<Encoded> = FabricCodec<Encoded>;

/**
 * A codec usable for the wire format whose value type is `Encoded`: either
 * kind serves. A terminal codec serves that format alone, a nonterminal one
 * serves every format, and both are "for" this one. This is what a mixed
 * roster holds, what {@link CodecRegistry} stores, and what it hands back.
 *
 * Writing the union out is unavoidable. {@link FabricCodec} is invariant in
 * `Encoded` -- the parameter sits in both an argument and a return position --
 * so a `NonterminalCodec` is assignable to no format's instantiation, and the
 * two arms have to be named separately.
 */
export type CodecForFormat<Encoded> =
  | NonterminalCodec
  | TerminalCodec<Encoded>;

/**
 * A wire format, as {@link CodecRegistry} needs to know one: the type its
 * encoded states live in, and the symbol under which a class binds its codec
 * for this format.
 *
 * The two travel together because they name the same format, and a registry
 * given one of each separately could be given a mismatched pair. `Encoded`
 * appears in no member, so a descriptor is written with its type stated rather
 * than inferred from its contents.
 *
 * The symbol arrives as data rather than being known here, which is what keeps
 * this module from naming any particular format.
 */
export interface WireFormat<Encoded> {
  /**
   * Symbol under which a class binds the codec it supplies for this format.
   * Consulted only when the class binds no format-neutral `[CODEC]`, which
   * wins where a class has both.
   */
  readonly codecSymbol: symbol;
}

/**
 * Interface for classes that provide a `NonterminalCodec` which is guaranteed
 * to operate on instances of the class. Binding here is the claim that one
 * codec serves every wire format. A class the formats want to treat
 * differently -- in the state produced, in the kind of codec, or both -- binds
 * one per format under that format's own symbol instead.
 */
export interface FabricClassWithNonterminalCodec {
  /** The codec instance to use for instances of this class. */
  get [CODEC](): NonterminalCodec;
}

/**
 * The minimal interface that codec `decode()` implementations may depend on.
 * Provided by the `Runtime` in practice, but defined as an interface here to
 * avoid a circular dependency between the fabric protocol and the runner.
 * See Section 2.5 of the formal spec.
 */
export interface LiveEnvironment {
  /**
   * Resolves a cell reference, for a type that needs to intern or look up an
   * existing instance during decoding.
   */
  getCell(
    ref: { id: string; path: string[]; space: string },
  ): FabricInstance;

  /**
   * Signals whether a decode call should produce a deep-frozen
   * result: `true` means the decoded value should be deep-frozen,
   * `false` means a mutable result is acceptable. Same contract as `frozen`
   * passed to `cloneIfNecessary()` (see `value-clone.ts`):
   * `shouldDeepFreeze === true` corresponds to
   * `cloneIfNecessary(value, { frozen: true })`.
   *
   * Required (not optional): every live environment declares it, and gets it
   * for free by extending `BaseLiveEnvironment`, which centralizes the
   * getter; the `cloneIfNecessary`-style `true` default lives there.
   *
   * Enforcement: each codec's `decode()` queries this and abides by it,
   * producing a deep-frozen result when it is `true`.
   */
  get shouldDeepFreeze(): boolean;
}

/**
 * Public boundary interface for encoding a fabric value into a serialized
 * form, ready to cross whatever boundary the format exists for. The type
 * parameter `SerializedForm` is the boundary type: `string` for JSON,
 * `Uint8Array` for a binary format.
 *
 * Internal tree-walking machinery is private to the implementation.
 */
export interface EncodeContext<SerializedForm = unknown> {
  /** Encodes a fabric value into serialized form for boundary crossing. */
  encode(value: FabricValue): SerializedForm;
}
