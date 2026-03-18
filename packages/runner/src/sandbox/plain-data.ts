import { isProxy } from "nodeUtilTypes";
import {
  CT_CAPTURE_IDS,
  CT_IMPLEMENTATION_REF,
  CT_ITEM_ID,
  CT_WRAPPER_KIND,
} from "./types.ts";

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const INTERNAL_SYMBOL_KEYS = new Set([
  CT_CAPTURE_IDS,
  CT_IMPLEMENTATION_REF,
  CT_ITEM_ID,
  CT_WRAPPER_KIND,
]);

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

  assertAllowedSymbolKeys(value);

  if (Array.isArray(value)) {
    const ownKeys = Object.getOwnPropertyNames(value);
    for (const key of ownKeys) {
      if (key === "length") {
        continue;
      }
      if (!isCanonicalArrayIndexKey(key)) {
        throw new Error(
          "Arrays may not have extra own properties in verified plain data",
        );
      }
    }
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

  for (const key of Object.getOwnPropertyNames(value)) {
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

function assertAllowedSymbolKeys(value: object): void {
  const symbolKeys = Object.getOwnPropertySymbols(value);
  if (symbolKeys.some((symbol) => !INTERNAL_SYMBOL_KEYS.has(symbol))) {
    throw new Error("Symbol keys are not allowed in verified plain data");
  }
}

function isCanonicalArrayIndexKey(key: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) {
    return false;
  }
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index <= 0xFFFFFFFE &&
    String(index) === key;
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

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      continue;
    }
    deepFreeze(descriptor.value);
  }

  return Object.freeze(value);
}
