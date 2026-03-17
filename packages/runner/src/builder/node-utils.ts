import { isRecord } from "@commontools/utils/types";
import { type JSONSchema, type NodeRef, type Opaque } from "./types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import {
  joinConfidentialityLabels,
  normalizeConfidentialityLabel,
  type CfcConfidentialityLabel,
} from "../cfc/label-algebra.ts";
import { traverseValue } from "./traverse-utils.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";
import { isCell } from "../cell.ts";

export function connectInputAndOutputs(node: NodeRef) {
  function connect(value: any): any {
    if (isCellResultForDereferencing(value)) value = getCellOrThrow(value);
    if (isCell(value)) {
      if (value.export().frame !== node.frame) {
        throw new Error(
          "Reactive reference from outer scope cannot be accessed via closure. Wrap the access in a derive that passes the variable through, or use computed() which handles this automatically.",
        );
      }
      value.connect(node);
    }
    return undefined;
  }

  node.inputs = traverseValue(node.inputs, connect);
  node.outputs = traverseValue(node.outputs, connect);

  // We will also apply ifc tags from inputs to outputs
  applyInputIfcToOutput(node.inputs, node.outputs);
}

function collectSchemaConfidentiality(
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

function schemaWithClassification(
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

export function applyArgumentIfcToResult(
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
): JSONSchema | undefined {
  if (argumentSchema !== undefined) {
    const joined = collectSchemaConfidentiality(argumentSchema);
    return joined
      ? schemaWithClassification(resultSchema ?? true, joined)
      : resultSchema;
  }
  return resultSchema;
}

// If our inputs had any ifc tags, carry them through to our outputs
export function applyInputIfcToOutput<T, R>(
  inputs: Opaque<T>,
  outputs: Opaque<R>,
) {
  let collectedClassification: CfcConfidentialityLabel | undefined;
  traverseValue(inputs, (item: unknown) => {
    if (isCell(item)) {
      const { schema: inputSchema } = item.export();
      if (inputSchema !== undefined) {
        collectedClassification = joinConfidentialityLabels(
          collectedClassification,
          collectSchemaConfidentiality(inputSchema),
        );
      }
    }
  });
  if (collectedClassification) {
    attachCfcToOutputs(outputs, collectedClassification);
  }
}

// Attach ifc classification to OpaqueRef objects reachable
// from the outputs without descending into OpaqueRef objects
// TODO(@ubik2) Investigate: can we have cycles here?
function attachCfcToOutputs<T, R>(
  outputs: Opaque<R>,
  propagatedClassification: CfcConfidentialityLabel,
) {
  if (isCell(outputs)) {
    const exported = outputs.export();
    const outputSchema = exported.schema ?? true;
    const cfcSchema = schemaWithClassification(
      outputSchema,
      propagatedClassification,
    );
    try {
      outputs.setSchema(cfcSchema);
    } catch {
      // Cell already has a cause (computed/derived output) — its schema was
      // set during construction, so we cannot override it here.
    }
    return;
  } else if (isRecord(outputs)) {
    // Descend into objects and arrays
    for (const [_, value] of Object.entries(outputs)) {
      attachCfcToOutputs(value, propagatedClassification);
    }
  }
}
