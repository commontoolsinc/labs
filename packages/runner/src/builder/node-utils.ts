import { isRecord } from "@commonfabric/utils/types";
import type { CfcConfClause } from "../cfc/clause.ts";
import { type FactoryInput, type JSONSchema, type NodeRef } from "./types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { FabricInstance } from "@commonfabric/data-model/fabric-value";
import { refuseFabricInstance } from "../fabric-special-object.ts";
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
            implementation as (...args: any[]) => unknown,
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
    const joined = new Set<unknown>();
    ContextualFlowControl.joinSchema(joined, argumentSchema);
    return (joined.size !== 0)
      ? ContextualFlowControl.schemaWithLub(
        resultSchema ?? true,
        ContextualFlowControl.lub(joined),
      )
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
  traverseValue(inputs, (item: unknown) => {
    if (isCell(item)) {
      const { schema: inputSchema } = item.export();
      if (inputSchema !== undefined) {
        ContextualFlowControl.joinSchema(collectedClassifications, inputSchema);
      }
    }
  });
  if (collectedClassifications.size !== 0) {
    attachCfcToOutputs(
      outputs,
      ContextualFlowControl.lub(collectedClassifications),
    );
  }
}

// Attach ifc confidentiality to Reactive objects reachable
// from the outputs without descending into Reactive objects
// TODO(@ubik2) Investigate: can we have cycles here?
function attachCfcToOutputs(
  outputs: unknown,
  lubConfidentiality: readonly CfcConfClause[],
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
    ifc.confidentiality = ContextualFlowControl.lub(joined);
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
    // Descend into objects and arrays.
    //
    // A `FabricPrimitive` among them is inert here and correctly so: it has
    // zero enumerable own properties, so the descent ends at it, and a leaf
    // holds no cell to label.
    //
    // A `FabricInstance` is refused. Its codec contents can hold a `Cell`,
    // unreachable by property name, so passing one through leaves that cell
    // UNLABELLED while its plain siblings are labelled -- confidentiality
    // silently not applied, which is the unsafe direction, unlike the
    // policy-input walks in `runner.ts` whose equivalent gap fails closed.
    //
    // Nothing reaches this in production today, de facto rather than by
    // construction: a `FabricError` is ungated and exposed to pattern authors,
    // so what keeps this safe is that no pattern yet returns one holding a
    // cell.
    //
    // TODO(danfuzz): descend by codec-mediated traversal into instance state,
    // at which point this becomes a walk rather than a refusal.
    if (outputs instanceof FabricInstance) {
      refuseFabricInstance(outputs, "when attaching CFC labels to outputs");
    }

    for (const [_, value] of Object.entries(outputs)) {
      attachCfcToOutputs(value, lubConfidentiality);
    }
  }
}
