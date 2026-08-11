import type { Constructor } from "@commonfabric/utils/types";

import type { FabricInstance, FabricValue } from "@/interface.ts";

/** Well-known symbol for binding the getter `FabricClassWithCodec[CODEC]`. */
export const CODEC: unique symbol = Symbol("data-model.codec");

/**
 * The value-matching half of a codec: everything the codec system consults to
 * decide _whether_ a codec applies and _what tag_ to write, as opposed to the
 * transformation itself. Both kinds of codec supply it identically, which is
 * why it is factored out rather than written twice.
 */
export interface CodecDispatch {
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
   * the codec system uses it to mark state produced by `encode()` and (by
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
}

/**
 * Interface for codecs (encoder-decoder objects) that **decompose**. These are
 * objects which can extract "essential state" out of values (objects per se or
 * otherwise) and also take such "essential state" and produce values that are
 * equivalent (in a context-dependent sense) to the values that state was
 * extracted from.
 *
 * The state is itself made of fabric values, which the walker goes on to
 * encode in turn. So a codec of this kind settles nothing about how those
 * values are ultimately written down, and one instance serves every wire
 * format. `FabricError` is the clearest case: its state carries `cause` and
 * every `extraEntries()` pair, so it can hold arbitrary nested values, and
 * only the walker can know what to do with them.
 *
 * Its counterpart is {@link TerminalCodec}.
 */
export interface DecomposingCodec extends CodecDispatch {
  /**
   * Decodes a value from the given essential state, which is (alleged /
   * supposed) to be a value that was produced by an earlier call to
   * {@link #encode} on a compatible class to this one. The result is expected
   * to be a _shallow_ decoding. The codec system handles recursively
   * converting `state` contents as necessary.
   *
   * The given `typeTag` is what was associated with the given `state` and does
   * not necessarily correspond to {@link #recognizedTypeTag} (depending on how
   * an instance of this class got hooked up).
   */
  decode(
    typeTag: string,
    state: FabricValue,
    context: ReconstructionContext,
  ): FabricValue;

  /**
   * Encodes the given value, returning its essential state. This is only ever
   * called after {@link #canEncode} has confirmed that `value` is encodable by
   * this instance. The result is expected to be a _shallow_ encoding. The codec
   * system handles recursion as necessary.
   */
  encode(value: FabricValue): FabricValue;
}

/**
 * Interface for codecs that **terminate**: their state is already in the
 * domain of one particular wire format, `Encoded`, and the walker passes it
 * through untouched rather than encoding it further.
 *
 * A codec of this kind is therefore bound to a single format, and a class
 * needing one supplies a separate instance per format it participates in.
 * `FabricBytes` is the clearest case: JSON's codec produces a base64url
 * string, where a format that carries bytes natively wants the bytes
 * themselves, and no one codec can answer both.
 *
 * Which of the two kinds a codec is cannot be recovered by examining a state
 * it produced, because the domains overlap -- an all-string record satisfies
 * `FabricValue` and JSON's value type alike. So a codec declares its kind by
 * extending `BaseTerminalCodec` or `BaseFabricCodec`, the same declaration
 * that fixes its `encode()` and `decode()` signatures, and
 * {@link CodecRegistry} reads it once at registration.
 *
 * `Encoded` ranges over the wire formats' own value types, and `FabricValue`
 * is not among them: that is the walker's _input_ domain, so a state of that
 * type means "encode this in turn," which is the opposite of terminating.
 * `TerminalCodec<FabricValue>` accordingly names nothing that should exist,
 * and is not a spelling of {@link DecomposingCodec}.
 */
export interface TerminalCodec<Encoded> extends CodecDispatch {
  /**
   * Decodes a value from the given essential state. Counterpart to
   * {@link DecomposingCodec#decode}, except that `state` arrives exactly as it
   * came off the wire, un-walked.
   *
   * `state` is the format's full value type rather than whatever this codec
   * emits, because decoding is dispatched on a tag read from untrusted input:
   * a payload can carry any state at all under this codec's tag. Rejecting
   * what does not fit is part of the job.
   */
  decode(
    typeTag: string,
    state: Encoded,
    context: ReconstructionContext,
  ): FabricValue;

  /**
   * Encodes the given value, returning its essential state, already in the
   * format's own domain. Counterpart to {@link DecomposingCodec#encode}.
   */
  encode(value: FabricValue): Encoded;
}

/**
 * A codec of either kind, for a registry over the wire format whose value type
 * is `Encoded`. This is what a mixed roster holds and what
 * {@link CodecRegistry#extend} accepts, and it is the type to name when a
 * codec's kind is not (yet) distinguished.
 *
 * Nothing narrows it: a codec's kind is settled by which base class it extends,
 * and a holder that needs to act on the difference gets a
 * {@link MatchedCodec} from a registry rather than interrogating a codec.
 */
export type FabricCodec<Encoded> = DecomposingCodec | TerminalCodec<Encoded>;

/**
 * A codec paired with its kind, as {@link CodecRegistry} hands one back. The
 * key names the kind, so a holder narrows with `in` and gets `encode()` /
 * `decode()` signatures that match.
 *
 * This is what lets a walker keep a state and the codec it belongs to in
 * agreement. The two are correlated -- wire-form state goes to a terminal
 * codec, decoded state to a decomposing one -- and a correlation spread across
 * two separate values is not something TypeScript can check. Narrowing one
 * object settles both at once.
 */
export type MatchedCodec<Encoded> =
  | { readonly terminal: TerminalCodec<Encoded> }
  | { readonly decomposing: DecomposingCodec };

/**
 * Interface for classes that provide a `DecomposingCodec` which is guaranteed
 * to operate on instances of the class. Binding here is the claim that one
 * codec serves every wire format. A class the formats want to treat
 * differently -- in the state produced, in the kind of codec, or both -- binds
 * one per format under that format's own symbol instead.
 */
export interface FabricClassWithCodec {
  /** The codec instance to use for instances of this class. */
  get [CODEC](): DecomposingCodec;
}

/**
 * The minimal interface that codec `decode()` implementations may depend on.
 * Provided by the `Runtime` in practice, but defined as an interface here to
 * avoid a circular dependency between the fabric protocol and the runner.
 * See Section 2.5 of the formal spec.
 */
export interface ReconstructionContext {
  /**
   * Resolves a cell reference, for a type that needs to intern or look up an
   * existing instance during reconstruction.
   */
  getCell(
    ref: { id: string; path: string[]; space: string },
  ): FabricInstance;

  /**
   * Signals whether a reconstruction call should produce a deep-frozen
   * result: `true` means the reconstructed value should be deep-frozen,
   * `false` means a mutable result is acceptable. Same contract as `frozen`
   * passed to `cloneIfNecessary()` (see `value-clone.ts`):
   * `shouldDeepFreeze === true` corresponds to
   * `cloneIfNecessary(value, { frozen: true })`.
   *
   * Required (not optional): every context declares it. Contexts get it for
   * free by extending `BaseReconstructionContext`, which centralizes the
   * getter; the `cloneIfNecessary`-style `true` default lives there.
   *
   * Enforcement: each codec's `decode()` queries this and abides by it,
   * producing a deep-frozen result when it is `true`.
   */
  get shouldDeepFreeze(): boolean;
}

/**
 * Public boundary interface for serialization contexts. Encodes fabric
 * values into a serialized form and decodes them back. The type parameter
 * `SerializedForm` is the boundary type: `string` for JSON contexts,
 * `Uint8Array` for binary contexts.
 *
 * This is the only interface external callers need. Internal tree-walking
 * machinery is private to the context implementation.
 */
export interface SerializationContext<SerializedForm = unknown> {
  /**
   * Whether a failed reconstruction produces a `ProblematicValue` instead of
   * throwing.
   *
   * @default false
   */
  readonly lenient: boolean;

  /** Encodes a fabric value into serialized form for boundary crossing. */
  encode(value: FabricValue): SerializedForm;

  /** Decodes a serialized form back into a fabric value. */
  decode(
    data: SerializedForm,
    context: ReconstructionContext,
  ): FabricValue;
}
