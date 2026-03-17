import { freezeVerifiedPlainData } from "./plain-data.ts";
import {
  CT_CAPTURE_IDS,
  CT_IMPLEMENTATION_REF,
  CT_ITEM_ID,
  CT_WRAPPER_KIND,
  type VerifiedMetadataCarrier,
  type VerifiedWrapperKind,
} from "./types.ts";

export function createBuilderWrapper<T extends Function>(
  kind: "pattern" | "recipe" | "lift" | "handler",
  itemId: string,
  callback: T,
): T & VerifiedMetadataCarrier {
  assertCallable(callback);
  return tagAndFreeze(callback, itemId, kind);
}

export function createFunctionWrapper<T extends Function>(
  itemId: string,
  fn: T,
): T & VerifiedMetadataCarrier {
  assertCallable(fn);
  return tagAndFreeze(fn, itemId, "fn");
}

export function createPureFunctionWrapper<T extends Function>(
  itemId: string,
  captureIds: readonly string[],
  fn: T,
): T & VerifiedMetadataCarrier {
  assertCallable(fn);
  return tagAndFreeze(fn, itemId, "pure-fn", captureIds);
}

export function createDataWrapper<T>(
  itemId: string,
  captureIds: readonly string[],
  value: T,
): T & VerifiedMetadataCarrier {
  const tagged = value as T & VerifiedMetadataCarrier;
  Object.defineProperty(tagged, CT_IMPLEMENTATION_REF, {
    value: itemId,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(tagged, CT_ITEM_ID, {
    value: itemId,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(tagged, CT_WRAPPER_KIND, {
    value: "data",
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(tagged, CT_CAPTURE_IDS, {
    value: Object.freeze([...captureIds]),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return freezeVerifiedPlainData(tagged) as T & VerifiedMetadataCarrier;
}

function tagAndFreeze<T extends Function>(
  value: T,
  itemId: string,
  kind: VerifiedWrapperKind,
  captureIds: readonly string[] = [],
): T & VerifiedMetadataCarrier {
  Object.defineProperty(value, CT_IMPLEMENTATION_REF, {
    value: itemId,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(value, CT_ITEM_ID, {
    value: itemId,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(value, CT_WRAPPER_KIND, {
    value: kind,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(value, CT_CAPTURE_IDS, {
    value: Object.freeze([...captureIds]),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(value) as T & VerifiedMetadataCarrier;
}

function assertCallable(value: unknown): asserts value is Function {
  if (typeof value !== "function") {
    throw new Error("Expected a callable wrapper target");
  }
}
