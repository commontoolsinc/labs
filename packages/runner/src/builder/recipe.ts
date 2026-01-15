import { isRecord } from "@commontools/utils/types";
import {
  type Frame,
  type ICell,
  isOpaqueRef,
  type JSONSchema,
  type Module,
  type Node,
  type NodeRef,
  type Opaque,
  type OpaqueCell,
  type OpaqueRef,
  type PatternFunction,
  type Recipe,
  type RecipeFactory,
  type SchemaWithoutCell,
  SELF,
  type toJSON,
  type UnsafeBinding,
} from "./types.ts";
import { opaqueRef } from "./opaque-ref.ts";
import {
  applyArgumentIfcToResult,
  applyInputIfcToOutput,
  connectInputAndOutputs,
} from "./node-utils.ts";
import {
  moduleToJSON,
  recipeToJSON,
  toJSONWithLegacyAliases,
} from "./json-utils.ts";
import { setValueAtPath } from "../path-utils.ts";
import { traverseValue } from "./traverse-utils.ts";
import { sanitizeSchemaForLinks } from "../link-utils.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";
import { isCell } from "../cell.ts";
import { Runtime } from "../runtime.ts";
import {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";

export const pattern: PatternFunction = (
  fn: (input: any) => any,
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
) => {
  const frame = pushFrame();

  const inputs = opaqueRef(undefined, argumentSchema);

  // Create self reference - will be mapped to resultRef path during serialization
  const selfRef = opaqueRef(undefined, resultSchema);

  // Attach SELF to the underlying cell so the proxy can return it
  getCellOrThrow(inputs).setSelfRef(selfRef);

  let result: RecipeFactory<any, any>;
  try {
    const outputs = fn!(inputs);

    applyInputIfcToOutput(inputs, outputs);

    result = factoryFromRecipe(
      argumentSchema,
      resultSchema,
      inputs,
      outputs,
    );
  } finally {
    popFrame(frame);
  }

  return result;
};

/** Declare a recipe
 *
 * @param fn A function that creates the recipe graph
 *
 * or
 *
 * @param description A human-readable description of the recipe
 * @param fn A function that creates the recipe graph
 *
 * or
 *
 * @param argumentSchema A JSONSchema for the recipe inputs
 * @param fn A function that creates the recipe graph
 *
 * or
 *
 * @param argumentSchema A JSONSchema for the recipe inputs
 * @param resultSchema A JSONSchema for the recipe outputs
 * @param fn A function that creates the recipe graph
 *
 * @returns A recipe node factory that also serializes as recipe.
 */

export function recipe<S extends JSONSchema>(
  argumentSchema: S,
  fn: (
    input: OpaqueRef<Required<SchemaWithoutCell<S>>> & {
      [SELF]: OpaqueRef<any>;
    },
  ) => any,
): RecipeFactory<SchemaWithoutCell<S>, ReturnType<typeof fn>>;
export function recipe<S extends JSONSchema, R>(
  argumentSchema: S,
  fn: (
    input: OpaqueRef<Required<SchemaWithoutCell<S>>> & { [SELF]: OpaqueRef<R> },
  ) => Opaque<R>,
): RecipeFactory<SchemaWithoutCell<S>, R>;
export function recipe<S extends JSONSchema, RS extends JSONSchema>(
  argumentSchema: S,
  resultSchema: RS,
  fn: (
    input: OpaqueRef<Required<SchemaWithoutCell<S>>> & {
      [SELF]: OpaqueRef<SchemaWithoutCell<RS>>;
    },
  ) => Opaque<SchemaWithoutCell<RS>>,
): RecipeFactory<SchemaWithoutCell<S>, SchemaWithoutCell<RS>>;
export function recipe<T>(
  argumentSchema: string | JSONSchema,
  fn: (input: OpaqueRef<Required<T>> & { [SELF]: OpaqueRef<any> }) => any,
): RecipeFactory<T, ReturnType<typeof fn>>;
export function recipe<T, R>(
  argumentSchema: string | JSONSchema,
  fn: (
    input: OpaqueRef<Required<T>> & { [SELF]: OpaqueRef<R> },
  ) => Opaque<R>,
): RecipeFactory<T, R>;
export function recipe<T, R>(
  argumentSchema: string | JSONSchema,
  resultSchema: JSONSchema,
  fn: (
    input: OpaqueRef<Required<T>> & { [SELF]: OpaqueRef<R> },
  ) => Opaque<R>,
): RecipeFactory<T, R>;
// Function-only overload - must come after schema-based overloads
export function recipe<T, R>(
  fn: (input: OpaqueRef<Required<T>> & { [SELF]: OpaqueRef<R> }) => Opaque<R>,
): RecipeFactory<T, R>;
export function recipe<T, R>(
  argumentSchema:
    | string
    | JSONSchema
    | ((input: OpaqueRef<Required<T>> & { [SELF]: OpaqueRef<R> }) => Opaque<R>),
  resultSchema?:
    | JSONSchema
    | ((input: OpaqueRef<Required<T>> & { [SELF]: OpaqueRef<R> }) => Opaque<R>),
  fn?: (input: OpaqueRef<Required<T>> & { [SELF]: OpaqueRef<R> }) => Opaque<R>,
): RecipeFactory<T, R> {
  // Cover the overload that just provides a function
  if (typeof argumentSchema === "function") {
    fn = argumentSchema;
    argumentSchema = undefined as any;
    resultSchema = undefined;
  } // Cover the overload that just provides input schema
  else if (typeof resultSchema === "function") {
    fn = resultSchema;
    resultSchema = undefined;
  }

  // The recipe graph is created by calling `fn` which populates for `inputs`
  // and `outputs` with Value<> (which containts OpaqueRef<>) and/or default
  // values.
  const frame = pushFrame();

  const inputs = opaqueRef(
    undefined,
    typeof argumentSchema === "string"
      ? undefined
      : argumentSchema as JSONSchema | undefined,
  );

  // Create self reference - will be mapped to resultRef path during serialization
  const selfRef = opaqueRef(
    undefined,
    resultSchema as JSONSchema | undefined,
  );

  // Attach SELF to the underlying cell so the proxy can return it
  getCellOrThrow(inputs).setSelfRef(selfRef);

  let result;
  try {
    const outputs = fn!(inputs);

    applyInputIfcToOutput(inputs, outputs);

    result = factoryFromRecipe<T, R>(
      argumentSchema as string | JSONSchema | undefined,
      resultSchema as JSONSchema | undefined,
      inputs,
      outputs,
    );
  } finally {
    popFrame(frame);
  }
  return result;
}

// Same as above, but assumes the caller manages the frame
export function recipeFromFrame<T, R>(
  argumentSchema: string | JSONSchema | undefined,
  resultSchema: JSONSchema | undefined,
  fn: (input: OpaqueRef<Required<T>> & { [SELF]: OpaqueRef<R> }) => Opaque<R>,
): RecipeFactory<T, R> {
  const inputs = opaqueRef(
    undefined,
    typeof argumentSchema === "string"
      ? undefined
      : argumentSchema as JSONSchema | undefined,
  );

  // Create self reference - will be mapped to resultRef path during serialization
  const selfRef = opaqueRef(undefined, resultSchema);

  // Attach SELF to the underlying cell so the proxy can return it
  getCellOrThrow(inputs).setSelfRef(selfRef);

  const outputs = fn(inputs);
  return factoryFromRecipe<T, R>(argumentSchema, resultSchema, inputs, outputs);
}

function factoryFromRecipe<T, R>(
  argumentSchemaArg: string | JSONSchema | undefined,
  resultSchemaArg: JSONSchema | undefined,
  inputs: OpaqueRef<Required<T>>,
  outputs: Opaque<R>,
): RecipeFactory<T, R> {
  // Capture selfRef before collectCellsAndNodes transforms inputs from OpaqueRef to Cell
  // (collectCellsAndNodes replaces OpaqueRef proxies with their underlying Cells,
  // and SELF access only works through the OpaqueRef proxy)
  const selfRef = (inputs as unknown as { [SELF]: OpaqueRef<any> })[SELF];

  // Traverse the value, collect all mentioned nodes and cells
  const allCells = new Set<ICell<unknown>>();
  const allNodes = new Set<NodeRef>();

  const collectCellsAndNodes = (value: Opaque<unknown>) =>
    traverseValue(value, (value) => {
      if (isCellResultForDereferencing(value)) value = getCellOrThrow(value);
      if (isCell(value) && !allCells.has(value)) {
        const { frame, nodes } = value.export();
        if (isOpaqueRef(value) && frame !== getTopFrame()) {
          throw new Error(
            "Cannot access cell via closure - reactive dependencies must be explicit parameters\n" +
              "help: use computed() for automatic extraction, or pass cells as parameters to lift()",
          );
        }
        allCells.add(value);
        nodes.forEach((node: NodeRef) => {
          if (!allNodes.has(node)) {
            allNodes.add(node);
            node.inputs = collectCellsAndNodes(node.inputs);
            node.outputs = collectCellsAndNodes(node.outputs);
          }
        });
      }
      return value;
    });
  inputs = collectCellsAndNodes(inputs);
  outputs = collectCellsAndNodes(outputs);

  applyInputIfcToOutput(inputs, outputs);

  // Fill in reasonable names for all cells, where possible:

  const usedNames = new Set<string>();
  allCells.forEach((cell) => {
    const existingName = cell.export().name;
    if (existingName) usedNames.add(existingName);
  });

  // First from results
  if (isRecord(outputs) && !isCell(outputs)) {
    Object.entries(outputs).forEach(([key, value]: [string, unknown]) => {
      if (isCell(value)) {
        const exported = value.export();
        if (
          !exported.path.length &&
          !exported.name &&
          !usedNames.has(key)
        ) {
          value.for(key, true); // allowIfSet=true to not override existing causes
          usedNames.add(key);
        }
      }
    });
  }

  // Then from assignments in nodes
  allCells.forEach((cell) => {
    if (cell.export().path.length) return;
    cell.export().nodes.forEach((node: NodeRef) => {
      if (isRecord(node.inputs)) {
        Object.entries(node.inputs).forEach(([key, input]) => {
          if (
            isOpaqueRef(input) && input.export().cell === cell &&
            !cell.export().name && !usedNames.has(key)
          ) {
            cell.for(key, true); // allowIfSet=true to not override existing causes
            usedNames.add(key);
          }
        });
      }
    });
  });

  // Also collect otherwise disconnected cells and nodes, e.g. those that are
  // assigned to cells via .set or .push and aren't otherwise connected.
  getTopFrame()?.opaqueRefs.forEach((ref) => collectCellsAndNodes(ref));

  // Then assign paths on the recipe cell for all cells. For now we just assign
  // incremental counters, since we don't have access to the original variable
  // names. Later we might do something more clever by analyzing the code (we'll
  // want that anyway for extracting schemas from TypeScript).
  const paths = new Map<OpaqueRef<any>, PropertyKey[]>();

  // Add the inputs default path
  paths.set(inputs, ["argument"]);

  // Add path for self-reference if used in outputs
  // Note: selfRef is an OpaqueRef, but allCells contains Cells (after getCellOrThrow conversion)
  // So we need to get the underlying cell for comparison
  const selfRefCell = getCellOrThrow(selfRef);
  if (allCells.has(selfRefCell)) {
    paths.set(selfRefCell, ["resultRef"]);
  }

  // Add paths for all the internal cells
  // TODO(seefeld): Infer more stable identifiers
  let count = 0;
  allCells.forEach((cell) => {
    if (paths.has(cell)) return;
    const { cell: top, path, value, name, external } = cell.export();
    if (!external) {
      if (!paths.has(top)) {
        // HACK(seefeld): For unnamed cells, we've run into an issue when the
        // order changes that a stream might clobber a previously used
        // non-stream, which means the default value won't be assigned and the
        // cell won't be treated as stream. So we'll namespace those separately.
        const streamMarker = isRecord(value) && value.$stream === true
          ? "stream"
          : "";
        paths.set(top, [
          "internal",
          name ?? `__#${count++}${streamMarker}`,
        ]);
      }
      if (path.length) paths.set(cell, [...paths.get(top)!, ...path]);
    }
  });

  // Creates a query (i.e. aliases) into the cells for the result
  const result = toJSONWithLegacyAliases(outputs ?? {}, paths, true)!;

  // Set initial values for all cells, add non-inputs defaults
  const initial: any = {};
  allCells.forEach((cell) => {
    // Only process roots of extra cells:
    if (cell === (inputs as unknown)) return;
    const { path, value, external } = cell.export();
    if (path.length > 0 || external) return;

    const cellPath = paths.get(cell)!;
    if (value !== undefined) setValueAtPath(initial, cellPath, value);
  });

  let argumentSchema: JSONSchema;

  if (typeof argumentSchemaArg === "string") {
    argumentSchema = { description: argumentSchemaArg };
  } else {
    argumentSchema = argumentSchemaArg ?? true;
  }

  const resultSchema =
    applyArgumentIfcToResult(argumentSchema, resultSchemaArg) || {};

  const serializedNodes = Array.from(allNodes).map((node) => {
    const module = toJSONWithLegacyAliases(
      node.module,
      paths,
    ) as unknown as Module;
    const inputs = toJSONWithLegacyAliases(node.inputs, paths)!;
    const outputs = toJSONWithLegacyAliases(node.outputs, paths)!;
    return { module, inputs, outputs } satisfies Node;
  });

  const recipe: Recipe & toJSON = {
    argumentSchema: sanitizeSchemaForLinks(argumentSchema, {
      keepStreams: true,
    }),
    resultSchema: sanitizeSchemaForLinks(resultSchema, { keepStreams: true }),
    initial,
    result,
    nodes: serializedNodes,
    // Important that this refers to recipeFactory, as .program will be set on
    // recipe afterwards (see factory.ts:exportsCallback)
    toJSON: () => recipeToJSON(recipeFactory),
  };

  const recipeFactory = Object.assign((inputs: Opaque<T>): OpaqueRef<R> => {
    const module: Module & toJSON = {
      type: "recipe",
      implementation: recipeFactory,
      toJSON: () => moduleToJSON(module),
    };

    const outputs = opaqueRef<R>();
    const node: NodeRef = {
      module,
      inputs,
      outputs,
      frame: getTopFrame(),
    };

    connectInputAndOutputs(node);
    (outputs as OpaqueCell<R>).connect(node);

    return outputs;
  }, recipe) satisfies RecipeFactory<T, R>;

  return recipeFactory;
}

const frames: Frame[] = [];

export function pushFrame(frame: Partial<Frame> = {}): Frame {
  const parent = getTopFrame();

  const result = {
    parent,
    opaqueRefs: new Set(),
    generatedIdCounter: 0,
    ...(parent?.runtime && { runtime: parent.runtime }),
    ...(parent?.tx && { tx: parent.tx }),
    ...(parent?.space && { space: parent.space }),
    ...frame,
  };

  frames.push(result);
  return result;
}

export function pushFrameFromCause(
  cause: any,
  props: {
    unsafe_binding?: UnsafeBinding;
    inHandler?: boolean;
    runtime?: Runtime;
    tx?: IExtendedStorageTransaction;
    space?: MemorySpace;
  },
): Frame {
  const parent = getTopFrame();
  const { unsafe_binding, inHandler, runtime, tx, space } = props;

  // If no runtime provided, try to inherit from parent (may be undefined during construction)
  const frameRuntime = runtime ?? parent?.runtime;
  const frameTx = tx ?? unsafe_binding?.tx ?? parent?.tx;
  const frameSpace = space ?? unsafe_binding?.space ?? parent?.space;

  const frame = {
    parent,
    cause,
    generatedIdCounter: 0,
    opaqueRefs: new Set(),
    ...(frameRuntime && { runtime: frameRuntime }),
    ...(frameSpace && { space: frameSpace }),
    ...(frameTx && { tx: frameTx }),
    ...(inHandler && { inHandler: true }),
    ...(unsafe_binding ? { unsafe_binding } : {}),
  };
  frames.push(frame);
  return frame;
}

export function popFrame(frame?: Frame): void {
  if (!frame) {
    frames.pop();
    return;
  }

  // If frame is at top, pop normally
  if (getTopFrame() === frame) {
    frames.pop();
    return;
  }

  // Frame not at top - this can happen during navigation when a new runtime
  // is created before the old one finishes disposing. Find and remove it.
  const index = frames.indexOf(frame);
  if (index !== -1) {
    frames.splice(index, 1);
  }
  // If frame not found, it was already removed - that's fine
}

export function getTopFrame(): Frame | undefined {
  return frames.length ? frames[frames.length - 1] : undefined;
}
