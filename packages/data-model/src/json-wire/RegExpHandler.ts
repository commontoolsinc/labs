import type { FabricValue, ReconstructionContext } from "../interface.ts";
import { FabricRegExp } from "../fabric-primitives/FabricRegExp.ts";
import { TAGS } from "../fabric-type-tags.ts";
import type {
  JsonWireValue,
  TypeHandler,
  TypeHandlerCodec,
} from "./interface.ts";
import { makeProblematic } from "./makeProblematic.ts";

/**
 * Handler for `FabricRegExp`. Serializes the essential state
 * `{ source, flags, flavor }` under the `RegExp@1` tag. Wire format:
 * `{ "/RegExp@1": { "flags": "<flags>", "flavor": "<flavor>", "source": "<source>" } }`.
 * `FabricRegExp` is a direct member of `FabricValue` (via `FabricPrimitive`),
 * so this handler uses `instanceof` directly. The state object is a plain
 * record of strings (no nested `FabricValue`s), so it is recursed through the
 * serializer like any other object.
 */
export const RegExpHandler: TypeHandler = {
  tag: TAGS.RegExp,

  canSerialize(value: FabricValue): boolean {
    return value instanceof FabricRegExp;
  },

  serialize(
    value: FabricValue,
    codec: TypeHandlerCodec,
    recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    const fab = value as FabricRegExp;
    const state = {
      source: fab.source,
      flags: fab.flags,
      flavor: fab.flavor,
    } as FabricValue;
    return codec.wrapTag(TAGS.RegExp, recurse(state));
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    const decoded = recurse(state);
    if (decoded === null || typeof decoded !== "object") {
      return makeProblematic(
        TAGS.RegExp,
        state,
        `RegExp: expected object state, got ${typeof decoded}`,
      );
    }
    try {
      return FabricRegExp.fromState(
        decoded as Record<string, unknown>,
      ) as unknown as FabricValue;
    } catch (e) {
      return makeProblematic(
        TAGS.RegExp,
        state,
        `RegExp: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};
