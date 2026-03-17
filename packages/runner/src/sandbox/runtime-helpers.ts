import {
  createVerifiedHandlerFactory,
  lift,
} from "../builder/module.ts";
import { pattern } from "../builder/pattern.ts";
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
  tagMetadata(callback as T & VerifiedMetadataCarrier, itemId, kind);
  const wrapped = kind === "lift"
    ? lift(callback as unknown as (input: unknown) => unknown)
    : kind === "handler"
    ? createVerifiedHandlerFactory(callback as unknown as (
      event: unknown,
      props: unknown,
    ) => unknown)
    : pattern(callback as unknown as (input: unknown) => unknown);
  return tagMetadata(
    wrapped as unknown as T & VerifiedMetadataCarrier,
    itemId,
    kind,
  );
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
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return freezeVerifiedPlainData(value) as T & VerifiedMetadataCarrier;
  }

  const tagged = tagMetadata(
    value as T & VerifiedMetadataCarrier,
    itemId,
    "data",
    captureIds,
  );
  return freezeVerifiedPlainData(tagged) as T & VerifiedMetadataCarrier;
}

function tagAndFreeze<T extends Function>(
  value: T,
  itemId: string,
  kind: VerifiedWrapperKind,
  captureIds: readonly string[] = [],
): T & VerifiedMetadataCarrier {
  tagMetadata(value as T & VerifiedMetadataCarrier, itemId, kind, captureIds);
  return Object.freeze(value) as T & VerifiedMetadataCarrier;
}

function tagMetadata<T extends VerifiedMetadataCarrier>(
  value: T,
  itemId: string,
  kind: VerifiedWrapperKind,
  captureIds: readonly string[] = [],
): T {
  defineMetadata(value, CT_IMPLEMENTATION_REF, itemId);
  defineMetadata(value, CT_ITEM_ID, itemId);
  defineMetadata(value, CT_WRAPPER_KIND, kind);
  defineMetadata(value, CT_CAPTURE_IDS, Object.freeze([...captureIds]));

  if (
    value && typeof value === "function" &&
    "implementationRef" in (value as Record<string, unknown>)
  ) {
    (value as Record<string, unknown>).implementationRef = itemId;
  }

  return value;
}

function defineMetadata<T>(
  value: object,
  key: symbol,
  metadata: T,
): void {
  Object.defineProperty(value, key, {
    value: metadata,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function assertCallable(value: unknown): asserts value is Function {
  if (typeof value !== "function") {
    throw new Error("Expected a callable wrapper target");
  }
}
