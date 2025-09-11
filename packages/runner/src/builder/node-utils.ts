import { isObject, isRecord } from "@commontools/utils/types";
import { createShadowRef } from "./opaque-ref.ts";
import {
  canBeOpaqueRef,
  isOpaqueRef,
  type JSONSchema,
  makeOpaqueRef,
  type NodeRef,
  type Opaque,
  type OpaqueRef,
} from "./types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { traverseValue } from "./traverse-utils.ts";

export function connectInputAndOutputs(node: NodeRef) {
  function connect(value: any): any {
    if (canBeOpaqueRef(value)) value = makeOpaqueRef(value);
    if (isOpaqueRef(value)) {
      // Return shadow ref it this is a parent opaque ref. Note: No need to
      // connect to the cell. The connection is there to traverse the graph to
      // find all other nodes, but this points to the parent graph instead.
      if (value.export().frame !== node.frame) return createShadowRef(value);
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
    ContextualFlowControl.joinSchema(joined, argumentSchema, argumentSchema);
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
    if (isOpaqueRef(item)) {
      const { schema: inputSchema, rootSchema } = (item as OpaqueRef<T>)
        .export();
      if (inputSchema !== undefined) {
        ContextualFlowControl.joinSchema(
          collectedClassifications,
          inputSchema,
          rootSchema ?? inputSchema,
        );
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
  if (isOpaqueRef(outputs)) {
    const exported = (outputs as OpaqueRef<T>).export();
    const outputSchema = exported.schema ?? true;
    // we may have fields in the output schema, so incorporate those
    const joined = new Set<string>([lubClassification]);
    ContextualFlowControl.joinSchema(joined, outputSchema, outputSchema);
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
    (outputs as OpaqueRef<T>).setSchema(cfcSchema);
    return;
  } else if (isRecord(outputs)) {
    // Descend into objects and arrays
    for (const [key, value] of Object.entries(outputs)) {
      attachCfcToOutputs(value, cfc, lubClassification);
    }
  }
}
