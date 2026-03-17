import type { JSONSchema } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { isArrayIndexPropertyName } from "@commontools/memory/storable-value";
import {
  joinConfidentialityLabels,
  normalizeConfidentialityLabel,
  type CfcConfidentialityLabel,
} from "./label-algebra.ts";

export function collectSchemaConfidentiality(
  schema: JSONSchema | undefined,
  fullSchema: JSONSchema = schema ?? true,
  cycleTracker: Set<string> = new Set(),
): CfcConfidentialityLabel | undefined {
  if (schema === undefined || typeof schema === "boolean") {
    return undefined;
  }

  const key = JSON.stringify(schema);
  if (cycleTracker.has(key)) {
    return undefined;
  }
  cycleTracker.add(key);

  let classification = normalizeConfidentialityLabel(schema.ifc?.classification);

  const joinChild = (child: JSONSchema | undefined) => {
    classification = joinConfidentialityLabels(
      classification,
      collectSchemaConfidentiality(child, fullSchema, cycleTracker),
    );
  };

  if (schema.properties && typeof schema.properties === "object") {
    for (const child of Object.values(schema.properties)) {
      joinChild(child);
    }
  }
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  ) {
    joinChild(schema.additionalProperties);
  }
  if (schema.items && typeof schema.items === "object") {
    joinChild(schema.items);
  }
  if (Array.isArray(schema.prefixItems)) {
    for (const child of schema.prefixItems) {
      joinChild(child);
    }
  }
  for (const composed of [schema.anyOf, schema.oneOf, schema.allOf]) {
    if (!Array.isArray(composed)) {
      continue;
    }
    for (const child of composed) {
      joinChild(child);
    }
  }
  if (schema.$ref) {
    const resolved = ContextualFlowControl.resolveSchemaRefs(schema, fullSchema);
    if (resolved && resolved !== schema) {
      joinChild(resolved);
    }
  }

  return classification;
}

export function schemaConfidentialityAtPath(
  schema: JSONSchema,
  path: readonly string[],
): CfcConfidentialityLabel | undefined {
  const readLocalClassification = (
    node: JSONSchema | undefined,
  ): CfcConfidentialityLabel | undefined => {
    if (!node || typeof node === "boolean") {
      return undefined;
    }
    return normalizeConfidentialityLabel(node.ifc?.classification);
  };

  const resolveNode = (
    node: JSONSchema,
    fullSchema: JSONSchema,
  ): JSONSchema | undefined => {
    if (
      typeof node !== "object" || node === null || Array.isArray(node) ||
      !("$ref" in node)
    ) {
      return node;
    }
    return ContextualFlowControl.resolveSchemaRefs(node, fullSchema);
  };

  let cursor: JSONSchema | undefined = schema;
  let current = readLocalClassification(schema);

  for (const part of path) {
    if (cursor === undefined || typeof cursor === "boolean") {
      return current;
    }
    const resolved = resolveNode(cursor, schema);
    if (!resolved || typeof resolved === "boolean") {
      return current;
    }
    cursor = resolved;

    if (cursor.type === "object") {
      if (cursor.properties && part in cursor.properties) {
        const properties = cursor.properties as Record<string, JSONSchema>;
        cursor = properties[part];
      } else if (cursor.additionalProperties !== undefined) {
        cursor = cursor.additionalProperties;
      } else {
        return current;
      }
      current = joinConfidentialityLabels(current, readLocalClassification(cursor));
      continue;
    }

    if (cursor.type === "array") {
      if (!isArrayIndexPropertyName(part)) {
        return current;
      }
      const index = Number(part);
      if (cursor.prefixItems && index < cursor.prefixItems.length) {
        cursor = cursor.prefixItems[index];
      } else {
        cursor = cursor.items ?? true;
      }
      current = joinConfidentialityLabels(current, readLocalClassification(cursor));
      continue;
    }

    return current;
  }

  return current;
}

export function schemaWithConfidentiality(
  schema: JSONSchema,
  classification: CfcConfidentialityLabel,
): JSONSchema {
  const schemaObj = ContextualFlowControl.toSchemaObj(schema);
  const joined = joinConfidentialityLabels(
    classification,
    schemaObj.ifc?.classification,
  );
  if (!joined) {
    return schema;
  }
  return {
    ...schemaObj,
    ifc: { ...(schemaObj.ifc ?? {}), classification: joined },
  };
}
