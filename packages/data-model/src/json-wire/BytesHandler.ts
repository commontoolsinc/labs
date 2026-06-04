import type { FabricValue, ReconstructionContext } from "../interface.ts";
import { FabricBytes } from "../fabric-primitives/FabricBytes.ts";
import { WIRE_TYPE_TAGS } from "../wire-common/wire-type-tags.ts";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import type {
  JsonWireValue,
  TypeHandler,
  TypeHandlerCodec,
} from "./interface.ts";
import { ProblematicValue } from "../fabric-instances/ProblematicValue.ts";

/**
 * Handler for `FabricBytes`. Serializes to a flat base64url string
 * encoding the raw bytes. Wire format: `{ "/Bytes@1": "<base64>" }`.
 * Matches by `instanceof`. Same flat encoding approach as the epoch handlers.
 */
export const BytesHandler: TypeHandler = {
  tag: WIRE_TYPE_TAGS.Bytes,

  canSerialize(value: FabricValue): boolean {
    return value instanceof FabricBytes;
  },

  serialize(
    value: FabricValue,
    codec: TypeHandlerCodec,
    _recurse: (v: FabricValue) => JsonWireValue,
  ): JsonWireValue {
    const fab = value as FabricBytes;
    const b64 = toUnpaddedBase64url(fab.slice());
    return codec.wrapTag(WIRE_TYPE_TAGS.Bytes, b64 as JsonWireValue);
  },

  deserialize(
    state: JsonWireValue,
    _runtime: ReconstructionContext,
    _recurse: (v: JsonWireValue) => FabricValue,
  ): FabricValue {
    if (typeof state !== "string") {
      return new ProblematicValue(
        WIRE_TYPE_TAGS.Bytes,
        state,
        `Bytes: expected string state, got ${typeof state}`,
      );
    }
    try {
      const bytes = fromBase64url(state);
      return new FabricBytes(bytes) as unknown as FabricValue;
    } catch {
      return new ProblematicValue(
        WIRE_TYPE_TAGS.Bytes,
        state,
        `Bytes: invalid base64: ${state}`,
      );
    }
  },
};
