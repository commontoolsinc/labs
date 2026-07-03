import type { Constructor } from "@commonfabric/utils/types";

import type { FabricValue } from "@/interface.ts";
import { BaseFabricCodec } from "@/codec-common/BaseFabricCodec.ts";
import type { ReconstructionContext } from "@/codec-common/interface.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";

/**
 * Codec for registry-interned symbols. Encodes the registry key as a JSON
 * string. Wire format: `{ "/Symbol@1": "<key>" }`. On decode, `Symbol.for(key)`
 * retrieves (or creates) the registry symbol with the matching key, so the
 * result is `===` to any other `Symbol.for(key)` in the same realm.
 *
 * Unique symbols (`Symbol(desc)`, where `Symbol.keyFor()` returns `undefined`)
 * have no portable representation; `canEncode()` returns `false` for them,
 * which routes them to the registry's "unhandled value" path instead of being
 * silently coerced to a registry symbol.
 *
 * `Symbol` is a non-`new`-able pseudo-constructor, so the class fast path uses
 * a local type that carries both its callable shape and the constructor slot
 * the registry uses for lookup.
 */
type SymbolPseudoConstructor = typeof Symbol & Constructor;
const SYMBOL_PSEUDO_CONSTRUCTOR = Symbol as SymbolPseudoConstructor;

export class SymbolCodec extends BaseFabricCodec {
  constructor() {
    super(CODEC_TYPE_TAGS.Symbol, SYMBOL_PSEUDO_CONSTRUCTOR);
  }

  /** @inheritDoc */
  override canEncode(value: FabricValue): boolean {
    return typeof value === "symbol" && Symbol.keyFor(value) !== undefined;
  }

  /** @inheritDoc */
  encode(value: symbol): FabricValue {
    // `canEncode()` already verified the symbol has a registry key.
    return Symbol.keyFor(value)!;
  }

  /** @inheritDoc */
  decode(
    typeTag: string,
    state: FabricValue,
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
