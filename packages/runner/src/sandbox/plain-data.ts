import { isProxy } from "nodeUtilTypes";
import {
  CT_CAPTURE_IDS,
  CT_IMPLEMENTATION_REF,
  CT_ITEM_ID,
  CT_WRAPPER_KIND,
  type VerifiedMetadataCarrier,
} from "./types.ts";

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const INTERNAL_SYMBOL_KEYS = new Set([
  CT_CAPTURE_IDS,
  CT_IMPLEMENTATION_REF,
  CT_ITEM_ID,
  CT_WRAPPER_KIND,
]);
type MetadataTaggedRecord = Record<string, unknown> & VerifiedMetadataCarrier;

export function assertPlainData(value: unknown): void {
  walkPlainData(value, new Set());
}

export function freezeVerifiedPlainData<T>(value: T): T {
  assertPlainData(value);
  return deepFreeze(value);
}

function walkPlainData(value: unknown, seen: Set<unknown>): void {
  if (
    value === null || value === undefined || typeof value === "boolean" ||
    typeof value === "number" || typeof value === "string" ||
    typeof value === "bigint"
  ) {
    return;
  }

  if (typeof value === "function" || typeof value === "symbol") {
    throw new Error("Unsupported plain-data value");
  }

  if (typeof value !== "object") {
    throw new Error("Unsupported plain-data primitive");
  }

  if (isProxy(value)) {
    throw new Error("Proxy values are not allowed in verified plain data");
  }

  if (seen.has(value)) {
    throw new Error("Cycles are not allowed in verified plain data");
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new Error("Sparse arrays are not allowed in verified plain data");
      }
      const descriptor = getOwnDescriptorOrThrow(value, String(index));
      if (!("value" in descriptor)) {
        throw new Error("Accessors are not allowed in verified plain data");
      }
      walkPlainData(descriptor.value, seen);
    }
    seen.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype && prototype !== null
  ) {
    throw new Error("Only plain object records are allowed");
  }

  const symbolKeys = Object.getOwnPropertySymbols(value);
  if (symbolKeys.some((symbol) => !INTERNAL_SYMBOL_KEYS.has(symbol))) {
    throw new Error("Symbol keys are not allowed in verified plain data");
  }

  for (const key of Object.keys(value)) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error(
        `Reserved key '${key}' is not allowed in verified plain data`,
      );
    }
    const descriptor = getOwnDescriptorOrThrow(value, key);
    if (!("value" in descriptor)) {
      throw new Error("Accessors are not allowed in verified plain data");
    }
    walkPlainData(descriptor.value, seen);
  }

  seen.delete(value);
}

function getOwnDescriptorOrThrow(
  value: object,
  key: string,
): PropertyDescriptor {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      throw new Error(`Missing descriptor for '${key}'`);
    }
    return descriptor;
  } catch (error) {
    throw new Error(
      `Descriptor introspection failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  const entries = Array.isArray(value)
    ? value
    : Object.values(value as MetadataTaggedRecord);
  for (const entry of entries) {
    deepFreeze(entry);
  }
  return value;
}
