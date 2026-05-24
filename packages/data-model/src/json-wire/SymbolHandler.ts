import type { FabricValue, ReconstructionContext } from "../interface.ts";
import { TAGS } from "../fabric-type-tags.ts";
import type {
  JsonWireValue,
  TypeHandler,
  TypeHandlerCodec,
} from "./interface.ts";
import { makeProblematic } from "./makeProblematic.ts";

/**
 * Handler for registry-interned symbols. Serializes the registry key as a
 * JSON string. Wire format: `{ "/Symbol@1": "<key>" }`. On deserialize,
 * `Symbol.for(key)` retrieves (or creates) the registry symbol with the
 * matching key, so the result is `===` to any other `Symbol.for(key)` in
 * the same realm.
 *
 * Unique symbols (`Symbol(desc)`, where `Symbol.keyFor()` returns
 * `undefined`) have no portable representation; `canSerialize()` returns
 * `false` for them, which routes them to the registry's "unhandled value"
 * path instead of being silently coerced to a registry symbol.
 */
export const SymbolHandler: TypeHandler = {
  tag: TAGS.Symbol,

  canSerialize(value: FabricValue): boolean {
    return typeof value === "symbol" && Symbol.keyFor(value) !== undefined;
  },

  serialize(
    value: FabricValue,
    codec: TypeHandlerCodec,
    _recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    // `canSerialize()` already verified the symbol has a registry key.
    const key = Symbol.keyFor(value as symbol)!;
    return codec.wrapTag(TAGS.Symbol, key);
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    if (typeof state !== "string") {
      return makeProblematic(
        TAGS.Symbol,
        state,
        `Symbol: expected string state, got ${typeof state}`,
      );
    }
    return Symbol.for(state);
  },
};
