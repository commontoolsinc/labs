import type { Constructor } from "@commonfabric/utils/types";

import type { FabricValue } from "@/interface.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import type { RealmCodecValue } from "./interface.ts";
import type { ReconstructionContext } from "@/codec-interface/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";

/**
 * Codec for registry-interned symbols. Encodes the registry key as a string,
 * and decodes with `Symbol.for()`.
 *
 * This format carries `bigint`, `undefined` and the special numbers as
 * themselves, so a symbol is the one JavaScript primitive it has to encode at
 * all: structured cloning refuses one outright, interned or not.
 *
 * Unique symbols (`Symbol(desc)`, where `Symbol.keyFor()` returns `undefined`)
 * have no portable representation; `canEncode()` returns `false` for them,
 * which routes them to the registry's "unhandled value" path rather than
 * silently coercing one to a registry symbol.
 *
 * `Symbol` is a non-`new`-able pseudo-constructor, so it is cast to
 * `Constructor` (a "white lie") to seed the class fast-path; `canEncode()`
 * confirms via `typeof`.
 *
 * **What crosses is internedness**, and that is the whole of the promise: a
 * decoded symbol is interned under the key the encoded one was interned
 * under, which is as interned as a symbol on the far side can be.
 *
 * Whether it is the *same* symbol is not a question this format answers, and
 * not because the answer is unfavorable. Comparing two symbols means holding
 * both in one realm, and a realm boundary is what makes that not generally
 * arrangeable; whether `Symbol.for()` on the two sides reaches one registry
 * is a fact about how those realms are related rather than about this format.
 * A promise resting on it would be a promise about someone else's topology.
 */
export class SymbolCodec extends BaseTerminalCodec<RealmCodecValue> {
  /** Constructs an instance. */
  constructor() {
    super(CODEC_TYPE_TAGS.Symbol, Symbol as unknown as Constructor);
  }

  /** @inheritDoc */
  override canEncode(value: FabricValue): boolean {
    return typeof value === "symbol" && Symbol.keyFor(value) !== undefined;
  }

  /** @inheritDoc */
  encode(value: symbol): RealmCodecValue {
    // `canEncode()` already verified the symbol has a registry key.
    return Symbol.keyFor(value)!;
  }

  /**
   * @inheritDoc
   *
   * Reports a bad state by returning a `ProblematicValue`, as this format's
   * other codecs and this codec's JSON counterpart do. The two ways a codec
   * can reject -- this and throwing -- are equivalent to a caller, the engine
   * settling them against `lenient`, so what decides between them is
   * consistency across the codecs a reader meets together.
   */
  decode(
    typeTag: string,
    state: RealmCodecValue,
    _context: ReconstructionContext,
  ): FabricValue {
    if (typeof state !== "string") {
      return new ProblematicValue(
        typeTag,
        state,
        `Symbol: expected string state, got ${typeof state}`,
      );
    }

    return Symbol.for(state);
  }
}
