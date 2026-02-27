import type { JSONSchema } from "../builder/types.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IStorageTransaction,
} from "../storage/interface.ts";
import { isArrayIndexPropertyName } from "@commontools/memory/storable-value";
import { cfcEntityKey } from "./shared.ts";

type SchemaContextEntry = {
  schema: JSONSchema;
  pathLength: number;
};

const schemaContextByTx = new WeakMap<
  IStorageTransaction,
  Map<string, SchemaContextEntry>
>();

function isSchemaObject(schema: unknown): schema is Record<string, unknown> {
  return typeof schema === "object" && schema !== null &&
    !Array.isArray(schema);
}

function projectSchemaToEntityRoot(
  schema: JSONSchema,
  path: readonly string[],
): JSONSchema {
  if (path.length === 0) {
    return schema;
  }

  const defs = isSchemaObject(schema) ? schema.$defs : undefined;
  const definitions = isSchemaObject(schema) ? schema.definitions : undefined;
  let projected: JSONSchema = schema;
  for (let index = path.length - 1; index >= 0; index--) {
    const segment = path[index];
    projected = isArrayIndexPropertyName(segment)
      ? {
        type: "array",
        items: projected,
      }
      : {
        type: "object",
        properties: {
          [segment]: projected,
        },
      };
  }

  if (!isSchemaObject(projected)) {
    return projected;
  }
  return {
    ...projected,
    ...(defs ? { $defs: defs } : {}),
    ...(definitions ? { definitions } : {}),
  };
}

function mergeProjectedSchemas(
  left: JSONSchema,
  right: JSONSchema,
): JSONSchema {
  if (left === false || right === true) {
    return right;
  }
  if (right === false || left === true) {
    return left;
  }
  if (!isSchemaObject(left) || !isSchemaObject(right)) {
    return right;
  }

  const leftDefs = left.$defs;
  const rightDefs = right.$defs;
  const leftDefinitions = left.definitions;
  const rightDefinitions = right.definitions;
  const mergedDefs = (leftDefs || rightDefs)
    ? { ...(leftDefs ?? {}), ...(rightDefs ?? {}) }
    : undefined;
  const mergedDefinitions = (leftDefinitions || rightDefinitions)
    ? { ...(leftDefinitions ?? {}), ...(rightDefinitions ?? {}) }
    : undefined;

  if (left.type === "object" && right.type === "object") {
    const leftProperties = isSchemaObject(left.properties)
      ? left.properties as Record<string, JSONSchema>
      : {};
    const rightProperties = isSchemaObject(right.properties)
      ? right.properties as Record<string, JSONSchema>
      : {};
    const mergedProperties: Record<string, JSONSchema> = {};

    for (
      const key of new Set([
        ...Object.keys(leftProperties),
        ...Object.keys(rightProperties),
      ])
    ) {
      if (key in leftProperties && key in rightProperties) {
        mergedProperties[key] = mergeProjectedSchemas(
          leftProperties[key],
          rightProperties[key],
        );
      } else if (key in rightProperties) {
        mergedProperties[key] = rightProperties[key];
      } else {
        mergedProperties[key] = leftProperties[key];
      }
    }

    return {
      ...left,
      ...right,
      ...(Object.keys(mergedProperties).length > 0
        ? { properties: mergedProperties }
        : {}),
      ...(mergedDefs ? { $defs: mergedDefs } : {}),
      ...(mergedDefinitions ? { definitions: mergedDefinitions } : {}),
    };
  }

  if (left.type === "array" && right.type === "array") {
    return {
      ...left,
      ...right,
      ...(left.items !== undefined && right.items !== undefined
        ? {
          items: mergeProjectedSchemas(
            left.items as JSONSchema,
            right.items as JSONSchema,
          ),
        }
        : {}),
      ...(mergedDefs ? { $defs: mergedDefs } : {}),
      ...(mergedDefinitions ? { definitions: mergedDefinitions } : {}),
    };
  }

  return {
    ...left,
    ...right,
    ...(mergedDefs ? { $defs: mergedDefs } : {}),
    ...(mergedDefinitions ? { definitions: mergedDefinitions } : {}),
  };
}

function getOrCreateTxSchemaContext(
  tx: IExtendedStorageTransaction,
): Map<string, SchemaContextEntry> {
  let context = schemaContextByTx.get(tx.tx);
  if (!context) {
    context = new Map();
    schemaContextByTx.set(tx.tx, context);
  }
  return context;
}

export function recordCfcWriteSchemaContext(
  tx: IExtendedStorageTransaction,
  address: IMemorySpaceAddress,
  schema: JSONSchema | undefined,
): void {
  if (schema === undefined) {
    return;
  }

  const context = getOrCreateTxSchemaContext(tx);
  const key = cfcEntityKey(address);
  const existing = context.get(key);
  const pathLength = address.path.length;
  const projectedSchema = projectSchemaToEntityRoot(schema, address.path);

  // Keep the shortest-path schema we saw for this entity in the attempt.
  if (!existing || pathLength < existing.pathLength) {
    context.set(key, { schema: projectedSchema, pathLength });
    return;
  }

  if (pathLength === existing.pathLength) {
    context.set(key, {
      schema: mergeProjectedSchemas(existing.schema, projectedSchema),
      pathLength,
    });
  }
}

export function getCfcWriteSchemaContext(
  tx: IExtendedStorageTransaction,
  address: IMemorySpaceAddress,
): JSONSchema | undefined {
  const context = schemaContextByTx.get(tx.tx);
  const key = cfcEntityKey(address);
  return context?.get(key)?.schema;
}
