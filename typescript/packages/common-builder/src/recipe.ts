import {
  Recipe,
  RecipeFactory,
  NodeRef,
  Opaque,
  OpaqueRef,
  isOpaqueRef,
  Node,
  Module,
  toJSON,
  JSONSchema,
  UI,
  canBeOpaqueRef,
  makeOpaqueRef,
  Frame,
  ShadowRef,
  isShadowRef,
  UnsafeBinding,
} from "./types.js";
import { createShadowRef, opaqueRef } from "./opaque-ref.js";
import {
  traverseValue,
  setValueAtPath,
  toJSONWithAliases,
  createJsonSchema,
  moduleToJSON,
  recipeToJSON,
  connectInputAndOutputs,
} from "./utils.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/** Declare a recipe
 *
 * @param description A human-readable description of the recipe
 * @param fn A function that creates the recipe graph
 *
 * or
 *
 * @param argumentSchema A schema for the recipe inputs, either JSON or Zod
 * @param fn A function that creates the recipe graph
 *
 * or
 *
 * @param argumentSchema A schema for the recipe inputs, either JSON or Zod
 * @param resultSchema A schema for the recipe outputs, either JSON or Zod
 * @param fn A function that creates the recipe graph
 *
 * @returns A recipe node factory that also serializes as recipe.
 */

export function recipe<T extends z.ZodTypeAny>(
  argumentSchema: T,
  fn: (input: OpaqueRef<Required<z.infer<T>>>) => any,
): RecipeFactory<z.infer<T>, ReturnType<typeof fn>>;
export function recipe<T extends z.ZodTypeAny, R extends z.ZodTypeAny>(
  argumentSchema: T,
  resultSchema: R,
  fn: (input: OpaqueRef<Required<z.infer<T>>>) => Opaque<z.infer<R>>,
): RecipeFactory<z.infer<T>, z.infer<R>>;
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
  argumentSchema: string | JSONSchema | z.ZodTypeAny,
  resultSchema:
    | JSONSchema
    | z.ZodTypeAny
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
  const inputs = opaqueRef<Required<T>>();
  const outputs = fn!(inputs);
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
  argumentSchema: string | JSONSchema | z.ZodTypeAny,
  resultSchema: JSONSchema | z.ZodTypeAny | undefined,
  fn: (input: OpaqueRef<Required<T>>) => Opaque<R>,
): RecipeFactory<T, R> {
  const inputs = opaqueRef<Required<T>>();
  const outputs = fn(inputs);
  return factoryFromRecipe<T, R>(argumentSchema, resultSchema, inputs, outputs);
}

function factoryFromRecipe<T, R>(
  argumentSchemaArg: string | JSONSchema | z.ZodTypeAny,
  resultSchemaArg: JSONSchema | z.ZodTypeAny | undefined,
  inputs: OpaqueRef<T>,
  outputs: Opaque<R>,
): RecipeFactory<T, R> {
  // Traverse the value, collect all mentioned nodes and cells
  const cells = new Set<OpaqueRef<any>>();
  const shadows = new Set<ShadowRef>();
  const nodes = new Set<NodeRef>();

  const collectCellsAndNodes = (value: Opaque<any>) =>
    traverseValue(value, value => {
      if (canBeOpaqueRef(value)) value = makeOpaqueRef(value);
      if (isOpaqueRef(value)) value = value.unsafe_getExternal();
      if (
        (isOpaqueRef(value) || isShadowRef(value)) &&
        !cells.has(value) &&
        !shadows.has(value)
      ) {
        if (isOpaqueRef(value) && value.export().frame !== getTopFrame())
          value = createShadowRef(value.export().value);
        if (isShadowRef(value)) {
          shadows.add(value);
          if (
            isOpaqueRef(value.shadowOf) &&
            value.shadowOf.export().frame === getTopFrame()
          )
            cells.add(value.shadowOf);
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

  // Fill in reasonable names for all cells, where possible:

  // First from results
  if (typeof outputs === "object" && outputs !== null)
    Object.entries(outputs).forEach(([key, value]) => {
      if (
        isOpaqueRef(value) &&
        !value.export().path.length &&
        !value.export().name
      )
        value.setName(key);
    });

  // Then from assignments in nodes
  cells.forEach(cell => {
    if (cell.export().path.length) return;
    cell.export().nodes.forEach((node: NodeRef) => {
      if (typeof node.inputs === "object" && node.inputs !== null)
        Object.entries(node.inputs).forEach(([key, input]) => {
          if (isOpaqueRef(input) && input.cell === cell && !cell.export().name)
            cell.setName(key);
        });
    });
  });

  // [For unsafe bindings] Also collect otherwise disconnected cells and nodes,
  // since they might only be mentioned via a code closure in a lifted function.
  getTopFrame()?.opaqueRefs.forEach(ref => collectCellsAndNodes(ref));

  // Then assign paths on the recipe cell for all cells. For now we just assign
  // incremental counters, since we don't have access to the original variable
  // names. Later we might do something more clever by analyzing the code (we'll
  // want that anyway for extracting schemas from TypeScript).
  const paths = new Map<OpaqueRef<any> | ShadowRef, PropertyKey[]>();

  // Add the inputs default path
  paths.set(inputs, ["argument"]);

  // Add paths for all the internal cells
  // TODO: Infer more stable identifiers
  let count = 0;
  cells.forEach((cell: OpaqueRef<any>) => {
    if (paths.has(cell)) return;
    const { cell: top, path, name } = cell.export();
    if (!paths.has(top)) paths.set(top, ["internal", name ?? `__#${count++}`]);
    if (path.length) paths.set(cell, [...paths.get(top)!, ...path]);
  });
  shadows.forEach(shadow => {
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
  cells.forEach(cell => {
    // Only process roots of extra cells:
    if (cell === inputs) return;
    const { path, value, defaultValue } = cell.export();
    if (path.length > 0) return;

    const cellPath = paths.get(cell)!;
    if (value) setValueAtPath(initial, cellPath, value);
    if (defaultValue) setValueAtPath(defaults, cellPath, defaultValue);
  });

  // External cells all have to be added to the initial state
  cells.forEach(cell => {
    const { external } = cell.export();
    if (external) setValueAtPath(initial, paths.get(cell)!, external);
  });

  let argumentSchema: JSONSchema;

  if (typeof argumentSchemaArg === "string") {
    // TODO: initial is likely not needed anymore
    // TODO: But we need a new one for the result
    argumentSchema = createJsonSchema(defaults, {});
    argumentSchema.description = argumentSchemaArg;

    delete argumentSchema.properties?.[UI]; // TODO: This should be a schema for views
    if (argumentSchema.properties?.internal?.properties)
      for (const key of Object.keys(
        argumentSchema.properties.internal.properties as any,
      ))
        if (key.startsWith("__#"))
          delete (argumentSchema as any).properties.internal.properties[key];
  } else if (argumentSchemaArg instanceof z.ZodType) {
    argumentSchema = zodToJsonSchema(argumentSchemaArg) as JSONSchema;
  } else {
    argumentSchema = argumentSchemaArg as unknown as JSONSchema;
  }

  const resultSchema: JSONSchema =
    resultSchemaArg instanceof z.ZodType
      ? (zodToJsonSchema(resultSchemaArg) as JSONSchema)
      : resultSchemaArg ?? ({} as JSONSchema);

  const serializedNodes = Array.from(nodes).map(node => {
    const module = toJSONWithAliases(node.module, paths) as Module;
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
  // TODO: Does OpaqueRef cause issues here?
  [...cells]
    .filter(cell => !cell.export().path.length) // Only bind root cells
    .forEach(cell =>
      cell.unsafe_bindToRecipeAndPath(recipeFactory, paths.get(cell)!),
    );

  return recipeFactory;
}

const frames: Frame[] = [];

export function pushFrame(frame?: Frame): Frame {
  if (!frame) frame = { parent: getTopFrame(), opaqueRefs: new Set() };
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
