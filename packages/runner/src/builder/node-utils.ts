import { isObject, isRecord } from "@commontools/utils/types";
import { type JSONSchema, type NodeRef, type Opaque } from "./types.ts";
import { ContextualFlowControl } from "../cfc.ts";
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

export function applyArgumentIfcToResult(
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
): JSONSchema | undefined {
  if (argumentSchema !== undefined) {
    const cfc = new ContextualFlowControl();
    const joined = new Set<string>();
    ContextualFlowControl.joinSchema(joined, argumentSchema);
    return (joined.size !== 0)
      ? cfc.schemaWithLub(resultSchema ?? true, cfc.lub(joined))
      : resultSchema;
  }
  return resultSchema;
}

// If our inputs had any ifc tags, carry them through to our outputs
export function applyInputIfcToOutput<T, R>(
  inputs: Opaque<T>,
  outputs: Opaque<R>,
) {
  const collectedClassifications = new Set<string>();
  const cfc = new ContextualFlowControl();
  traverseValue(inputs, (item: unknown) => {
    if (isCell(item)) {
      const { schema: inputSchema } = item.export();
      if (inputSchema !== undefined) {
        ContextualFlowControl.joinSchema(collectedClassifications, inputSchema);
      }
    }
  });
  if (collectedClassifications.size !== 0) {
    attachCfcToOutputs(outputs, cfc, cfc.lub(collectedClassifications));
  }
}

// Attach ifc classification to OpaqueRef objects reachable
// from the outputs without descending into OpaqueRef objects
// TODO(@ubik2) Investigate: can we have cycles here?
function attachCfcToOutputs<T, R>(
  outputs: Opaque<R>,
  cfc: ContextualFlowControl,
  lubClassification: string,
) {
  if (isCell(outputs)) {
    const exported = outputs.export();
    const outputSchema = exported.schema ?? true;
    // we may have fields in the output schema, so incorporate those
    const joined = new Set<string>([lubClassification]);
    ContextualFlowControl.joinSchema(joined, outputSchema);
    const ifc = (isObject(outputSchema) && outputSchema.ifc !== undefined)
      ? { ...outputSchema.ifc }
      : {};
    ifc.classification = [cfc.lub(joined)];
    const outpuSchemaObj = (outputSchema === true || outputSchema === undefined)
      ? {}
      : outputSchema === false
      ? { not: true }
      : outputSchema;
    const cfcSchema: JSONSchema = {
      ...outpuSchemaObj,
      ifc,
    };
    outputs.setSchema(cfcSchema);
    return;
  } else if (isRecord(outputs)) {
    // Descend into objects and arrays
    for (const [_, value] of Object.entries(outputs)) {
      attachCfcToOutputs(value, cfc, lubClassification);
    }
  }
}
