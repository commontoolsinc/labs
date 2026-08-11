import type { FabricValue } from "@/interface.ts";
import type {
  MatchedCodec,
  NonterminalCodec,
  RegistrableCodec,
  TerminalCodec,
} from "./interface.ts";
import { BaseNonterminalCodec } from "./BaseNonterminalCodec.ts";
import { BaseTerminalCodec } from "./BaseTerminalCodec.ts";
import type { Constructor } from "@commonfabric/utils/types";

/**
 * Sentinel returned by {@link CodecRegistry#codecFromValue} for a
 * self-representing value -- one that is its own wire form (encoded as-is, with
 * no codec and no tag).
 */
export const SELF_REP = "self-rep" as const;

/**
 * The primitive `type` keys the registry accepts: the `typeof` results that are
 * encodable `FabricValue` primitives, plus `"null"` for the `null` value.
 * `"object"` and `"function"` are deliberately excluded -- object values are
 * matched by class via {@link CodecRegistry#register}.
 */
export type PrimitiveTypeName =
  | "null"
  | "undefined"
  | "boolean"
  | "number"
  | "bigint"
  | "string"
  | "symbol";

/**
 * Gets the constructor function ("class") of the given value, if any, for
 * class-based codec lookup.
 */
function constructorOf(
  value: FabricValue,
): Constructor | undefined {
  if (typeof value === "object") {
    if (value === null) {
      return undefined;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto === null) {
      return undefined;
    }

    return proto.constructor;
  } else if (value !== undefined) {
    // This gets the pseudo-constructor of a primitive. **Note:** `function` is
    // not included in the `FabricValue` union.
    return value.constructor as Constructor;
  } else {
    return undefined;
  }
}

/**
 * Registry of codecs. Provides tag-based lookup for decoding, and
 * primitive-type and class matching for encoding.
 *
 * An instance is mutable while it is being built and immutable once
 * `Object.freeze()`d: every mutator refuses on a frozen instance. Freezing is
 * how a registry becomes safe to hand out, since a codec holds the registry it
 * was constructed with and would otherwise see a later registration. Use
 * {@link #extend} to build on one that is already frozen.
 */
export class CodecRegistry<Encoded> {
  /** Tag -> codec map for O(1) decode dispatch. */
  readonly #tagMap = new Map<string, MatchedCodec<Encoded>>();

  /** Class -> codec map for O(1) encode dispatch on object values. */
  readonly #classMap = new Map<Constructor, MatchedCodec<Encoded>>();

  /** Primitive `type` -> codec map for O(1) encode dispatch on primitives. */
  readonly #primitiveCodecs = new Map<
    PrimitiveTypeName,
    MatchedCodec<Encoded>
  >();

  /** Primitive `type`s that are self-representing (encoded as-is). */
  readonly #selfRepTypes = new Set<PrimitiveTypeName>();

  /**
   * Registers a codec, indexing it by its `recognizedTypeTag` (for decode) and
   * its `uniqueHandledClass` (for encode dispatch). Either may be `undefined`,
   * in which case the codec is left unindexed for the corresponding lookup;
   * note that a codec with no `uniqueHandledClass` is unreachable for encoding.
   */
  register(codec: RegistrableCodec<Encoded>): void {
    this.#assertNotFrozen();

    const matched = CodecRegistry.#matched<Encoded>(codec);

    const uniqueClass = codec.uniqueHandledClass;
    if (uniqueClass !== undefined) {
      this.#classMap.set(uniqueClass, matched);
    }

    const tag = codec.recognizedTypeTag;
    if (tag !== undefined) {
      this.#tagMap.set(tag, matched);
    }
  }

  /**
   * Registers a codec for a primitive `type` (see {@link PrimitiveTypeName}).
   * Indexes the codec by its `recognizedTypeTag` (for decode) and by `type`
   * (for O(1) encode dispatch on primitives).
   */
  registerPrimitive(
    type: PrimitiveTypeName,
    codec: RegistrableCodec<Encoded>,
  ): void {
    this.#assertNotFrozen();

    const matched = CodecRegistry.#matched<Encoded>(codec);

    this.#primitiveCodecs.set(type, matched);

    const tag = codec.recognizedTypeTag;
    if (tag !== undefined) {
      this.#tagMap.set(tag, matched);
    }
  }

  /**
   * Registers a primitive `type` (see {@link PrimitiveTypeName}) as
   * self-representing: a value of that type is its own wire form, so
   * {@link #codecFromValue} returns {@link SELF_REP} for it. A type may be both
   * self-representing and have a {@link #registerPrimitive} codec (e.g.
   * `"number"`: finite numbers are self-representing, special ones go through a
   * codec); the codec is tried first.
   */
  registerSelfRep(type: PrimitiveTypeName): void {
    this.#assertNotFrozen();

    this.#selfRepTypes.add(type);
  }

  /**
   * Creates a frozen copy of this instance with the given codecs additionally
   * registered. This instance is left untouched, so a shared registry can be
   * built on without being altered, and the result is frozen so that it in
   * turn can be shared.
   *
   * This is the intended way to add to a registry someone else assembled:
   * extending what a factory returns is what keeps a caller from omitting, by
   * accident, everything that factory put there.
   *
   * It takes codecs rather than the classes carrying them, because which
   * symbol a class binds its codec to is the caller's business: a
   * `FabricPrimitive` binds one per wire format, a `FabricInstance` binds one
   * for all of them. A caller therefore reads the symbol it means and passes
   * the result, which is what lets this module stay format-agnostic.
   *
   * Arguments are taken as `Array.concat()` takes them -- any number, each
   * either a codec or a list of them -- so that a caller combining rosters
   * need not splice them into one array first.
   *
   * @param codecs The codecs to register in addition, individually or in
   *   lists.
   */
  extend(
    ...codecs: readonly (
      | RegistrableCodec<Encoded>
      | readonly RegistrableCodec<Encoded>[]
    )[]
  ): CodecRegistry<Encoded> {
    const result = new CodecRegistry<Encoded>();

    for (const [key, value] of this.#tagMap) result.#tagMap.set(key, value);
    for (const [key, value] of this.#classMap) result.#classMap.set(key, value);
    for (const [key, value] of this.#primitiveCodecs) {
      result.#primitiveCodecs.set(key, value);
    }
    for (const type of this.#selfRepTypes) result.#selfRepTypes.add(type);

    for (const arg of codecs) {
      if (Array.isArray(arg)) {
        for (const codec of arg) {
          result.register(codec);
        }
      } else {
        result.register(arg as RegistrableCodec<Encoded>);
      }
    }

    // Frozen as a statement rather than by returning `Object.freeze()`'s
    // result, whose `Readonly<CodecRegistry>` type drops the private-field
    // brand and so is not assignable back to `CodecRegistry`.
    Object.freeze(result);
    return result;
  }

  /**
   * Guards a mutator against a frozen instance.
   *
   * @throws If this instance is frozen.
   */
  #assertNotFrozen(): void {
    if (Object.isFrozen(this)) {
      throw new Error("Cannot modify frozen `CodecRegistry`");
    }
  }

  /**
   * Finds how to encode the given value: a matched codec that can encode it,
   * {@link SELF_REP} if it is a self-representing primitive, or `undefined` if
   * neither matches (the caller falls through to structural handling for
   * arrays and plain objects, or fails for an unencodable value).
   */
  codecFromValue(
    value: FabricValue,
  ): MatchedCodec<Encoded> | typeof SELF_REP | undefined {
    // Primitive dispatch on the value's primitive `type` key (its `typeof`, or
    // `"null"`). The type's codec is tried first, then self-representation.
    let type: PrimitiveTypeName | undefined;
    const valueType = typeof value;
    switch (valueType) {
      case "bigint":
      case "boolean":
      case "number":
      case "string":
      case "symbol":
      case "undefined": {
        type = valueType;
        break;
      }

      case "object": {
        if (value === null) {
          type = "null";
        }
        break;
      }

      case "function": {
        // Not a `FabricValue`; nothing can encode it.
        return undefined;
      }
    }

    if (type !== undefined) {
      const matched = this.#primitiveCodecs.get(type);
      if (matched && CodecRegistry.#codecOfMatch(matched).canEncode(value)) {
        return matched;
      }
      if (this.#selfRepTypes.has(type)) {
        return SELF_REP;
      }
      // No primitive match -- fall through to the class lookup below.
    }

    // Match by the value's exact constructor.
    const constructorFn = constructorOf(value);
    if (constructorFn) {
      const matched = this.#classMap.get(constructorFn);
      if (matched && CodecRegistry.#codecOfMatch(matched).canEncode(value)) {
        return matched;
      }
    }

    return undefined;
  }

  /** Looks up a codec by tag for decoding. */
  codecFromTag(typeTag: string): MatchedCodec<Encoded> | undefined {
    return this.#tagMap.get(typeTag);
  }

  //
  // Static members
  //

  /**
   * Pairs a codec with its kind. The kind comes from which base class the
   * codec extends, which is the same declaration that fixed its `encode()` and
   * `decode()` signatures, so the two cannot disagree.
   *
   * That makes extending one of the two bases a requirement, which the
   * parameter type does not express: it names the interfaces, and an object
   * satisfying one of those without extending anything has no kind to read.
   * Uses "death before confusion" on that case rather than picking a default,
   * because a codec silently taken for the kind it is not would have its state
   * expanded, or left unexpanded, in whole-value encodings far from here.
   *
   * @throws If `codec` extends neither base class.
   */
  static #matched<Encoded>(
    codec: RegistrableCodec<Encoded>,
  ): MatchedCodec<Encoded> {
    if (codec instanceof BaseTerminalCodec) {
      return { terminal: codec as TerminalCodec<Encoded> };
    } else if (codec instanceof BaseNonterminalCodec) {
      return { nonterminal: codec as NonterminalCodec };
    }

    throw new Error(
      "Shouldn't happen: codec extends neither `BaseNonterminalCodec` nor " +
        "`BaseTerminalCodec`, so it declares no kind: " +
        `\`${codec.constructor.name}\``,
    );
  }

  /** Gets the codec out of a match, for the parts that need only dispatch. */
  static #codecOfMatch<Encoded>(
    matched: MatchedCodec<Encoded>,
  ): RegistrableCodec<Encoded> {
    return ("terminal" in matched) ? matched.terminal : matched.nonterminal;
  }
}
