import { isObject } from "@commontools/utils/types";
import { ContextualFlowControl } from "../cfc.ts";
import type { JSONSchema } from "../builder/types.ts";
import type { ICfcReadAnnotations } from "../storage/interface.ts";
import { normalizeIntegrityLabel } from "./label-algebra.ts";
import type { ReadObservationOp } from "./read-observation.ts";

export function readIfcInputAnnotations(
  schema: JSONSchema | undefined,
): ICfcReadAnnotations | undefined {
  if (!schema || !isObject(schema)) {
    return undefined;
  }
  const resolvedSchema = typeof schema.$ref === "string"
    ? ContextualFlowControl.resolveSchemaRefs(schema)
    : schema;
  const schemaWithIfc = isObject(resolvedSchema) && isObject(resolvedSchema.ifc)
    ? resolvedSchema
    : isObject(schema) && isObject(schema.ifc)
    ? schema
    : undefined;
  if (!schemaWithIfc) {
    return undefined;
  }
  const rawMaxConfidentiality = (schemaWithIfc.ifc as Record<string, unknown>)
    .maxConfidentiality;
  const maxConfidentiality = Array.isArray(rawMaxConfidentiality)
    ? rawMaxConfidentiality.filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    )
    : [];
  const rawRequiredIntegrity = (schemaWithIfc.ifc as Record<string, unknown>)
    .requiredIntegrity;
  const requiredIntegrity = normalizeIntegrityLabel(rawRequiredIntegrity) ?? [];
  if (maxConfidentiality.length === 0 && requiredIntegrity.length === 0) {
    return undefined;
  }
  return {
    ...(maxConfidentiality.length > 0 ? { maxConfidentiality } : {}),
    ...(requiredIntegrity.length > 0 ? { requiredIntegrity } : {}),
  };
}

export function withReadObservationOp(
  annotations: ICfcReadAnnotations | undefined,
  op: ReadObservationOp,
): ICfcReadAnnotations {
  return annotations ? { ...annotations, op } : { op };
}
