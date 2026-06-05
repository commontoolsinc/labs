import type { FabricValue, ReconstructionContext } from "../interface.ts";
import { FabricRegExp } from "../fabric-primitives/FabricRegExp.ts";
import { WIRE_TYPE_TAGS } from "../wire-common/wire-type-tags.ts";
import type {
  JsonWireValue,
  TypeHandler,
  TypeHandlerCodec,
} from "./interface.ts";
import { ProblematicValue } from "../fabric-instances/ProblematicValue.ts";

/**
 * Handler for `FabricRegExp`. Serializes the essential state
 * `{ source, flags, flavor }` under the `RegExp@1` tag. Wire format:
 * `{ "/RegExp@1": { "flags": "<flags>", "flavor": "<flavor>", "source": "<source>" } }`.
 */
export const RegExpHandler: TypeHandler = {
  /** @inheritDoc */
  get classSource() {
    return RegExp;
  },

  /** @inheritDoc */
  get wireTypeTag() {
    return WIRE_TYPE_TAGS.RegExp;
  },

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
    return codec.wrapTag(WIRE_TYPE_TAGS.RegExp, recurse(state));
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    const decoded = recurse(state);
    if (decoded === null || typeof decoded !== "object") {
      return new ProblematicValue(
        WIRE_TYPE_TAGS.RegExp,
        state,
        `RegExp: expected object state, got ${typeof decoded}`,
      );
    }
    const s = decoded as Record<string, unknown>;
    const flavor = (s.flavor as string) ?? "es2025";
    const source = (s.source as string) ?? "";
    const flags = (s.flags as string) ?? "";
    try {
      return new FabricRegExp(flavor, source, flags) as unknown as FabricValue;
    } catch (e) {
      return new ProblematicValue(
        WIRE_TYPE_TAGS.RegExp,
        state,
        `RegExp: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};
