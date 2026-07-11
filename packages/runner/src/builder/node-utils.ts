import { isRecord } from "@commonfabric/utils/types";
import {
  factoryStateOf,
  isAdmittedFabricFactory,
  mapFactoryStateValues,
} from "@commonfabric/data-model/fabric-factory";
import { FabricSpecialObject } from "@commonfabric/data-model/fabric-value";
import {
  type Cell,
  type FactoryInput,
  isPattern,
  isReactive,
  type JSONSchema,
  type NodeRef,
} from "./types.ts";
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
  visitGraphCells(inputs, (item) => {
    const { schema: inputSchema } = item.export();
    if (inputSchema !== undefined) {
      ContextualFlowControl.joinSchema(collectedClassifications, inputSchema);
    }
  });
  if (collectedClassifications.size !== 0) {
    const confidentiality = cfc.lub(collectedClassifications);
    visitGraphCells(outputs, (output) => {
      attachCfcToOutput(output, cfc, confidentiality);
    });
  }
}

/**
 * Visit Cells in the same semantic graph view used by factory serialization:
 * factory params and space selectors are traversed, while the callable itself
 * and Fabric-special values remain atomic.
 */
function visitGraphCells(
  unprocessedValue: unknown,
  visit: (cell: Cell<unknown>) => void,
  seen: Set<object> = new Set(),
  insideFactoryState = false,
): void {
  let value = unprocessedValue;
  if (isCellResultForDereferencing(value)) value = getCellOrThrow(value);
  if (isCell(value)) {
    visit(value);
    return;
  }

  if (isAdmittedFabricFactory(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    mapFactoryStateValues(factoryStateOf(value), (nested) => {
      visitGraphCells(nested, visit, seen, true);
      return nested;
    });
    return;
  }

  if (typeof value === "function") {
    if (insideFactoryState) {
      throw new TypeError(
        "Arbitrary functions are not valid factory state values",
      );
    }
    return;
  }
  if (
    value === null || typeof value !== "object" || Boolean(isReactive(value)) ||
    value instanceof FabricSpecialObject
  ) {
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const nested of value) visitGraphCells(nested, visit, seen);
  } else if (isRecord(value) || isPattern(value)) {
    for (const nested of Object.values(value)) {
      visitGraphCells(nested, visit, seen, insideFactoryState);
    }
  }
}

function attachCfcToOutput(
  output: Cell<unknown>,
  cfc: ContextualFlowControl,
  lubConfidentiality: readonly unknown[],
): void {
  const exported = output.export();
  const outputSchema = exported.schema ?? true;
  // We may have fields in the output schema, so incorporate those.
  const joined = new Set<unknown>(lubConfidentiality);
  ContextualFlowControl.joinSchema(joined, outputSchema);
  const ifc = (isRecord(outputSchema) && outputSchema.ifc !== undefined)
    ? { ...outputSchema.ifc }
    : {};
  ifc.confidentiality = cfc.lub(joined);
  const outputSchemaObject = outputSchema === true
    ? {}
    : outputSchema === false
    ? { not: true }
    : outputSchema;
  const cfcSchema: JSONSchema = {
    ...outputSchemaObject,
    ifc,
  };
  try {
    output.setSchema(cfcSchema);
  } catch {
    // Cell already has a cause (computed/derived output) — its schema was set
    // during construction, so we cannot override it here.
  }
}
