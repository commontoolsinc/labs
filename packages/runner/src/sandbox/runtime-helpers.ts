import { createVerifiedHandlerFactory, lift } from "../builder/module.ts";
import { pattern } from "../builder/pattern.ts";
import type { JSONSchema, Pattern } from "../builder/types.ts";
import {
  freezeVerifiedPlainData,
  normalizeVerifiedPlainData,
} from "./plain-data.ts";
import {
  CT_CAPTURE_IDS,
  CT_IMPLEMENTATION_REF,
  CT_ITEM_ID,
  CT_WRAPPER_KIND,
  type VerifiedCallable,
  type VerifiedMetadataCarrier,
  type VerifiedWrapperKind,
} from "./types.ts";

export function createBuilderWrapper<T extends VerifiedCallable>(
  kind: "pattern" | "lift" | "handler",
  itemId: string,
  callback: T,
): T & VerifiedMetadataCarrier {
  assertCallable(callback);
  tagMetadata(callback as T & VerifiedMetadataCarrier, itemId, kind);
  const wrapped = kind === "lift"
    ? lift(callback as unknown as (input: unknown) => unknown)
    : kind === "handler"
    ? createVerifiedHandlerFactory(
      callback as unknown as (
        event: unknown,
        props: unknown,
      ) => unknown,
    )
    : pattern(callback as unknown as (input: unknown) => unknown);
  if (kind === "pattern") {
    installPatternResultSchemaNormalizer(
      wrapped as unknown as Pattern & { resultSchema?: JSONSchema },
    );
  }
  return tagMetadata(
    wrapped as unknown as T & VerifiedMetadataCarrier,
    itemId,
    kind,
  );
}

export function createFunctionWrapper<T extends VerifiedCallable>(
  itemId: string,
  fn: T,
): T & VerifiedMetadataCarrier {
  assertCallable(fn);
  return tagAndFreeze(fn, itemId, "fn");
}

export function createPureFunctionWrapper<T extends VerifiedCallable>(
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
  if (
    value === null || (typeof value !== "object" && typeof value !== "function")
  ) {
    return freezeVerifiedPlainData(value) as T & VerifiedMetadataCarrier;
  }

  const normalized = normalizeVerifiedPlainData(value);
  const tagged = tagMetadata(
    normalized as T & VerifiedMetadataCarrier,
    itemId,
    "data",
    captureIds,
  );
  return freezeVerifiedPlainData(tagged) as T & VerifiedMetadataCarrier;
}

function tagAndFreeze<T extends VerifiedCallable>(
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

function assertCallable(value: unknown): asserts value is VerifiedCallable {
  if (typeof value !== "function") {
    throw new Error("Expected a callable wrapper target");
  }
}

function installPatternResultSchemaNormalizer(
  patternFactory: Pattern & { resultSchema?: JSONSchema },
): void {
  let resultSchema = normalizePatternResultSchema(
    patternFactory.result,
    patternFactory.resultSchema,
  );

  Object.defineProperty(patternFactory, "resultSchema", {
    enumerable: true,
    configurable: true,
    get: () => resultSchema,
    set: (value: JSONSchema | undefined) => {
      resultSchema = normalizePatternResultSchema(patternFactory.result, value);
    },
  });
}

function normalizePatternResultSchema(
  binding: unknown,
  schema: JSONSchema | undefined,
): JSONSchema | undefined {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (isAliasBinding(binding) && schema.asCell && !schema.asStream) {
    const normalized = { ...(schema as Record<string, unknown>) };
    delete normalized.asCell;
    normalized.asOpaque = true;
    return normalized as JSONSchema;
  }

  if (Array.isArray(binding)) {
    if (!schema.items || typeof schema.items !== "object") {
      return schema;
    }

    const normalizedItems = normalizePatternResultSchema(
      binding[0],
      schema.items,
    );
    if (normalizedItems === schema.items) {
      return schema;
    }

    return { ...schema, items: normalizedItems };
  }

  if (
    !isRecord(binding) || !schema.properties ||
    typeof schema.properties !== "object"
  ) {
    return schema;
  }

  let changed = false;
  const properties: Record<string, JSONSchema> = { ...schema.properties };
  for (const [key, value] of Object.entries(binding)) {
    const current = schema.properties[key];
    const normalized = normalizePatternResultSchema(value, current);
    if (normalized !== current && normalized !== undefined) {
      properties[key] = normalized;
      changed = true;
    }
  }

  return changed ? { ...schema, properties } : schema;
}

function isAliasBinding(
  value: unknown,
): value is { $alias: { path?: unknown } } {
  return !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "$alias" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
