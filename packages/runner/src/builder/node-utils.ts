import { isRecord } from "@commonfabric/utils/types";
import { type FactoryInput, type JSONSchema, type NodeRef } from "./types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { traverseValue } from "./traverse-utils.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";
import { isCell } from "../cell.ts";
import { closureCaptureErrorMessage } from "./closure-capture-diagnostic.ts";
import { resolveLocationFromFunctionSource } from "./module.ts";

export function connectInputAndOutputs(node: NodeRef) {
  function connect(value: any): any {
    if (isCellResultForDereferencing(value)) value = getCellOrThrow(value);
    if (isCell(value)) {
      const exported = value.export();
      if (exported.frame !== node.frame) {
        const implementation = isRecord(node.module)
          ? node.module.implementation
          : undefined;
        const sourceLocation = typeof implementation === "function"
          ? resolveLocationFromFunctionSource(
            implementation as (...args: unknown[]) => unknown,
            node.frame,
          )
          : null;
        throw new Error(
          closureCaptureErrorMessage({
            capturedCell: {
              path: exported.path,
              scope: exported.scope,
              name: exported.name,
            },
            sourceLocation,
          }),
        );
      }
      value.connect(node);
    }
    return undefined;
  }

  node.inputs = traverseValue(node.inputs, connect);
  node.outputs = traverseValue(node.outputs, connect);

  // We will also apply ifc tags from inputs to outputs, unless the module has
  // precise built-in flow handling for its result.
  if (!isRecord(node.module) || node.module.propagateInputIfc !== false) {
    applyInputIfcToOutput(node.inputs, node.outputs);
  }
}

export function applyArgumentIfcToResult(
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
): JSONSchema | undefined {
  if (argumentSchema !== undefined) {
    const cfc = new ContextualFlowControl();
    const joined = new Set<unknown>();
    ContextualFlowControl.joinSchema(joined, argumentSchema);
    return (joined.size !== 0)
      ? cfc.schemaWithLub(resultSchema ?? true, cfc.lub(joined))
      : resultSchema;
  }
  return resultSchema;
}

// If our inputs had any ifc tags, carry them through to our outputs
export function applyInputIfcToOutput<T, R>(
  inputs: FactoryInput<T>,
  outputs: FactoryInput<R>,
) {
  const collectedClassifications = new Set<unknown>();
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

// Attach ifc confidentiality to Reactive objects reachable
// from the outputs without descending into Reactive objects
// TODO(@ubik2) Investigate: can we have cycles here?
function attachCfcToOutputs(
  outputs: unknown,
  cfc: ContextualFlowControl,
  lubConfidentiality: readonly unknown[],
) {
  if (isCell(outputs)) {
    const exported = outputs.export();
    const outputSchema = exported.schema ?? true;
    // we may have fields in the output schema, so incorporate those
    const joined = new Set<unknown>(lubConfidentiality);
    ContextualFlowControl.joinSchema(joined, outputSchema);
    const ifc = (isRecord(outputSchema) && outputSchema.ifc !== undefined)
      ? { ...outputSchema.ifc }
      : {};
    ifc.confidentiality = cfc.lub(joined);
    const outpuSchemaObj = (outputSchema === true || outputSchema === undefined)
      ? {}
      : outputSchema === false
      ? { not: true }
      : outputSchema;
    const cfcSchema: JSONSchema = {
      ...outpuSchemaObj,
      ifc,
    };
    try {
      outputs.setSchema(cfcSchema);
    } catch {
      // Cell already has a cause (computed/derived output) — its schema was
      // set during construction, so we cannot override it here.
    }
    return;
  } else if (isRecord(outputs)) {
    // Descend into objects and arrays
    // TODO(danfuzz): This `isRecord`-gated `Object.entries` descent has no
    // `FabricSpecialObject` guard; a `FabricPrimitive` output is decomposed
    // (its state is private) and a `FabricInstance` is walked by internal
    // slots, so CFC labels are not attached to the special object's actual
    // contents.
    for (const [_, value] of Object.entries(outputs)) {
      attachCfcToOutputs(value, cfc, lubConfidentiality);
    }
  }
}
