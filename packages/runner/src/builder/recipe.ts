import { isRecord } from "@commontools/utils/types";
import {
  canBeOpaqueRef,
  type Frame,
  isOpaqueRef,
  isShadowRef,
  type JSONSchema,
  type JSONSchemaMutable,
  makeOpaqueRef,
  type Module,
  type Node,
  type NodeRef,
  type Opaque,
  type OpaqueRef,
  type Recipe,
  type RecipeFactory,
  type SchemaWithoutCell,
  type ShadowRef,
  type toJSON,
  UI,
  type UnsafeBinding,
} from "./types.ts";
import { createShadowRef, opaqueRef } from "./opaque-ref.ts";
import {
  applyArgumentIfcToResult,
  applyInputIfcToOutput,
  connectInputAndOutputs,
} from "./node-utils.ts";
import {
  createJsonSchema,
  moduleToJSON,
  recipeToJSON,
  toJSONWithAliases,
} from "./json-utils.ts";
import { setValueAtPath } from "../path-utils.ts";
import { traverseValue } from "../traverse-utils.ts";

/** Declare a recipe
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
  fn: (input: OpaqueRef<Required<SchemaWithoutCell<S>>>) => any,
): RecipeFactory<SchemaWithoutCell<S>, ReturnType<typeof fn>>;
export function recipe<S extends JSONSchema, R>(
  argumentSchema: S,
  fn: (input: OpaqueRef<Required<SchemaWithoutCell<S>>>) => Opaque<R>,
): RecipeFactory<SchemaWithoutCell<S>, R>;
export function recipe<S extends JSONSchema, RS extends JSONSchema>(
  argumentSchema: S,
  resultSchema: RS,
  fn: (
    input: OpaqueRef<Required<SchemaWithoutCell<S>>>,
  ) => Opaque<SchemaWithoutCell<RS>>,
): RecipeFactory<SchemaWithoutCell<S>, SchemaWithoutCell<RS>>;
export function recipe<T>(
  argumentSchema: string | JSONSchema,
  fn: (input: OpaqueRef<Required<T>>) => any,
): RecipeFactory<T, ReturnType<typeof fn>>;
export function recipe<T, R>(
  argumentSchema: string | JSONSchema,
  fn: (input: OpaqueRef<Required<T>>) => Opaque<R>,
): RecipeFactory<T, R>;
export function recipe<T, R>(
  argumentSchema: string | JSONSchema,
  resultSchema: JSONSchema,
  fn: (input: OpaqueRef<Required<T>>) => Opaque<R>,
): RecipeFactory<T, R>;
export function recipe<T, R>(
  argumentSchema: string | JSONSchema,
  resultSchema:
    | JSONSchema
    | undefined
    | ((input: OpaqueRef<Required<T>>) => Opaque<R>),
  fn?: (input: OpaqueRef<Required<T>>) => Opaque<R>,
): RecipeFactory<T, R> {
  // Cover the overload that just provides input schema
  if (typeof resultSchema === "function") {
    fn = resultSchema;
    resultSchema = undefined;
  }

  // The recipe graph is created by calling `fn` which populates for `inputs`
  // and `outputs` with Value<> (which containts OpaqueRef<>) and/or default
  // values.
  const frame = pushFrame();

  const inputs = opaqueRef<Required<T>>(
    undefined,
    typeof argumentSchema === "string"
      ? undefined
      : argumentSchema as JSONSchema | undefined,
  );

  const outputs = fn!(inputs);

  applyInputIfcToOutput(inputs, outputs);

  const result = factoryFromRecipe<T, R>(
    argumentSchema,
    resultSchema,
    inputs,
    outputs,
  );
  popFrame(frame);
  return result;
}

// Same as above, but assumes the caller manages the frame
export function recipeFromFrame<T, R>(
  argumentSchema: string | JSONSchema,
  resultSchema: JSONSchema | undefined,
  fn: (input: OpaqueRef<Required<T>>) => Opaque<R>,
): RecipeFactory<T, R> {
  const inputs = opaqueRef<Required<T>>(
    undefined,
    typeof argumentSchema === "string"
      ? undefined
      : argumentSchema as JSONSchema | undefined,
  );
  const outputs = fn(inputs);
  return factoryFromRecipe<T, R>(argumentSchema, resultSchema, inputs, outputs);
}

function factoryFromRecipe<T, R>(
  argumentSchemaArg: string | JSONSchema,
  resultSchemaArg: JSONSchema | undefined,
  inputs: OpaqueRef<T>,
  outputs: Opaque<R>,
): RecipeFactory<T, R> {
  // Traverse the value, collect all mentioned nodes and cells
  const cells = new Set<OpaqueRef<any>>();
  const shadows = new Set<ShadowRef>();
  const nodes = new Set<NodeRef>();

  const collectCellsAndNodes = (value: Opaque<any>) =>
    traverseValue(value, (value) => {
      if (canBeOpaqueRef(value)) value = makeOpaqueRef(value);
      if (isOpaqueRef(value)) value = value.unsafe_getExternal();
      if (
        (isOpaqueRef(value) || isShadowRef(value)) && !cells.has(value) &&
        !shadows.has(value)
      ) {
        if (isOpaqueRef(value) && value.export().frame !== getTopFrame()) {
          value = createShadowRef(value.export().value);
        }
        if (isShadowRef(value)) {
          shadows.add(value);
          if (
            isOpaqueRef(value.shadowOf) &&
            value.shadowOf.export().frame === getTopFrame()
          ) {
            cells.add(value.shadowOf);
          }
        } else if (isOpaqueRef(value)) {
          cells.add(value);
          value.export().nodes.forEach((node: NodeRef) => {
            if (!nodes.has(node)) {
              nodes.add(node);
              node.inputs = collectCellsAndNodes(node.inputs);
              node.outputs = collectCellsAndNodes(node.outputs);
            }
          });
          value.set(collectCellsAndNodes(value.export().value));
        }
      }
      return value;
    });
  inputs = collectCellsAndNodes(inputs);
  outputs = collectCellsAndNodes(outputs);

  applyInputIfcToOutput(inputs, outputs);

  // Fill in reasonable names for all cells, where possible:

  // First from results
  if (isRecord(outputs)) {
    Object.entries(outputs).forEach(([key, value]: [string, unknown]) => {
      if (isOpaqueRef(value)) {
        const ref = value; // Typescript needs this to avoid type errors
        if (!ref.export().path.length && !ref.export().name) ref.setName(key);
      }
    });
  }

  // Then from assignments in nodes
  cells.forEach((cell) => {
    if (cell.export().path.length) return;
    cell.export().nodes.forEach((node: NodeRef) => {
      if (isRecord(node.inputs)) {
        Object.entries(node.inputs).forEach(([key, input]) => {
          if (
            isOpaqueRef(input) && input.cell === cell && !cell.export().name
          ) {
            cell.setName(key);
          }
        });
      }
    });
  });

  // [For unsafe bindings] Also collect otherwise disconnected cells and nodes,
  // since they might only be mentioned via a code closure in a lifted function.
  getTopFrame()?.opaqueRefs.forEach((ref) => collectCellsAndNodes(ref));

  // Then assign paths on the recipe cell for all cells. For now we just assign
  // incremental counters, since we don't have access to the original variable
  // names. Later we might do something more clever by analyzing the code (we'll
  // want that anyway for extracting schemas from TypeScript).
  const paths = new Map<OpaqueRef<any> | ShadowRef, PropertyKey[]>();

  // Add the inputs default path
  paths.set(inputs, ["argument"]);

  // Add paths for all the internal cells
  // TODO(seefeld): Infer more stable identifiers
  let count = 0;
  cells.forEach((cell: OpaqueRef<any>) => {
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
  shadows.forEach((shadow) => {
    if (paths.has(shadow)) return;
    paths.set(shadow, []);
  });

  // Creates a query (i.e. aliases) into the cells for the result
  const result = toJSONWithAliases(outputs ?? {}, paths, true)!;

  // Collect default values for the inputs
  const defaults = toJSONWithAliases(
    inputs.export().defaultValue ?? {},
    paths,
    true,
  )!;

  // Set initial values for all cells, add non-inputs defaults
  const initial: any = {};
  cells.forEach((cell) => {
    // Only process roots of extra cells:
    if (cell === inputs) return;
    const { path, value, defaultValue, external } = cell.export();
    if (path.length > 0 || external) return;

    const cellPath = paths.get(cell)!;
    if (value) setValueAtPath(initial, cellPath, value);
    if (defaultValue) setValueAtPath(defaults, cellPath, defaultValue);
  });

  let argumentSchema: JSONSchema;

  if (typeof argumentSchemaArg === "string") {
    // Create a writable schema
    const writableSchema: JSONSchemaMutable = createJsonSchema(defaults, true);
    writableSchema.description = argumentSchemaArg;

    delete (writableSchema.properties as any)?.[UI]; // TODO(seefeld): This should be a schema for views
    if (writableSchema.properties?.internal?.properties) {
      for (
        const key of Object.keys(
          writableSchema.properties.internal.properties as any,
        )
      ) {
        if (key.startsWith("__#")) {
          delete (writableSchema as any).properties.internal.properties[key];
        }
      }
    }
    argumentSchema = writableSchema;
  } else {
    argumentSchema = argumentSchemaArg;
  }

  const resultSchema =
    applyArgumentIfcToResult(argumentSchema, resultSchemaArg) || {};

  const serializedNodes = Array.from(nodes).map((node) => {
    const module = toJSONWithAliases(node.module, paths) as unknown as Module;
    const inputs = toJSONWithAliases(node.inputs, paths)!;
    const outputs = toJSONWithAliases(node.outputs, paths)!;
    return { module, inputs, outputs } satisfies Node;
  });

  const recipe: Recipe & toJSON = {
    argumentSchema,
    resultSchema,
    initial,
    result,
    nodes: serializedNodes,
    toJSON: () => recipeToJSON(recipe),
  };

  const module: Module & toJSON = {
    type: "recipe",
    implementation: recipe,
    toJSON: () => moduleToJSON(module),
  };

  const recipeFactory = Object.assign((inputs: Opaque<T>): OpaqueRef<R> => {
    const outputs = opaqueRef<R>();
    const node: NodeRef = {
      module,
      inputs,
      outputs,
      frame: getTopFrame(),
    };

    connectInputAndOutputs(node);
    outputs.connect(node);

    return outputs;
  }, recipe) satisfies RecipeFactory<T, R>;

  // Bind all cells to the recipe
  // TODO(seefeld): Does OpaqueRef cause issues here?
  [...cells]
    // Only bind root cells that are not external
    .filter((cell) => !cell.export().path.length && !cell.export().external)
    .forEach((cell) =>
      cell.unsafe_bindToRecipeAndPath(recipeFactory, paths.get(cell)!)
    );

  return recipeFactory;
}

const frames: Frame[] = [];

export function pushFrame(frame?: Frame): Frame {
  if (!frame) {
    frame = {
      parent: getTopFrame(),
      opaqueRefs: new Set(),
      generatedIdCounter: 0,
    };
  }
  frames.push(frame);
  return frame;
}

export function pushFrameFromCause(
  cause: any,
  unsafe_binding?: UnsafeBinding,
): Frame {
  const frame = {
    parent: getTopFrame(),
    cause,
    generatedIdCounter: 0,
    opaqueRefs: new Set(),
    ...(unsafe_binding ? { unsafe_binding } : {}),
  };
  frames.push(frame);
  return frame;
}

export function popFrame(frame?: Frame): void {
  if (frame && getTopFrame() !== frame) throw new Error("Frame mismatch");
  frames.pop();
}

export function getTopFrame(): Frame | undefined {
  return frames.length ? frames[frames.length - 1] : undefined;
}
