import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { isAdmittedFabricFactory } from "@commonfabric/data-model/fabric-factory";
import {
  jsonFromValue,
  valueFromJson,
} from "@commonfabric/data-model/codec-json";

import type { FabricValueIPCEncoding, JSONValue } from "./protocol/types.ts";

export const FABRIC_VALUE_IPC_ENCODING =
  "fabric-json" as const satisfies FabricValueIPCEncoding;

export interface FactoryAwareIPCValue {
  value: JSONValue | undefined;
  valueEncoding?: FabricValueIPCEncoding;
}

function containsFabricFactory(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): boolean {
  if (isAdmittedFabricFactory(value)) return true;
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    return Object.values(value).some((nested) =>
      containsFabricFactory(nested, seen)
    );
  } finally {
    seen.delete(value);
  }
}

/**
 * Project a factory-bearing cell value through the canonical Fabric JSON
 * codec before it crosses structured-clone IPC.
 *
 * The encoding discriminator lives beside the value, not inside authored
 * data, so an ordinary `fvj1:` string is never reinterpreted as a codec
 * envelope. Values without factories keep the existing plain JSON path.
 */
export function encodeFactoryAwareIPCValue(
  value: unknown,
): FactoryAwareIPCValue {
  if (!containsFabricFactory(value)) {
    return { value: value as JSONValue | undefined };
  }
  return {
    value: jsonFromValue(value as FabricValue),
    valueEncoding: FABRIC_VALUE_IPC_ENCODING,
  };
}

/** Context-free decode; Factory@1 leaves become inert callable shells. */
export function decodeFactoryAwareIPCValue(
  value: JSONValue | undefined,
  encoding: FabricValueIPCEncoding | undefined,
): unknown {
  if (encoding === undefined) return value;
  if (encoding !== FABRIC_VALUE_IPC_ENCODING || typeof value !== "string") {
    throw new TypeError("Invalid Fabric value IPC encoding");
  }
  return valueFromJson(value);
}
