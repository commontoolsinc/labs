import {
  Recipe,
  RecipeFactory,
  NodeRef,
  Value,
  OpaqueRef,
  isOpaqueRef,
  Node,
  Module,
  Alias,
  toJSON,
  UI,
  canBeOpaqueRef,
  makeOpaqueRef,
  Frame,
  ShadowRef,
  isShadowRef,
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
 * @returns A recipe node factory that also serializes as recipe.
 */
export function recipe<T extends z.ZodTypeAny>(
  inputSchema: T,
  fn: (input: OpaqueRef<Required<z.infer<T>>>) => any
): RecipeFactory<z.infer<T>, ReturnType<typeof fn>>;
export function recipe<T>(
  inputSchema: string,
  fn: (input: OpaqueRef<Required<T>>) => any
): RecipeFactory<T, ReturnType<typeof fn>>;
export function recipe<T, R>(
  inputSchema: string,
  fn: (input: OpaqueRef<Required<T>>) => Value<R>
): RecipeFactory<T, R>;
export function recipe<T, R>(
  inputSchema: string,
  fn: (input: OpaqueRef<Required<T>>) => Value<R>
): RecipeFactory<T, R> {
  // The recipe graph is created by calling `fn` which populates for `inputs`
  // and `outputs` with Value<> (which containts OpaqueRef<>) and/or default
  // values.

  const frame = pushFrame();
  const inputs = opaqueRef<Required<T>>();
  const outputs = fn(inputs);
  const result = factoryFromRecipe<T, R>(inputSchema, inputs, outputs);
  popFrame(frame);
  return result;
}

// Same as above, but assumes the caller manages the frame
export function recipeFromFrame<T, R>(
  inputSchema: string | z.ZodTypeAny,
  fn: (input: OpaqueRef<Required<T>>) => Value<R>
): RecipeFactory<T, R> {
  const inputs = opaqueRef<Required<T>>();
  const outputs = fn(inputs);
  return factoryFromRecipe<T, R>(inputSchema, inputs, outputs);
}

function factoryFromRecipe<T, R>(
  inputSchema: string | z.ZodTypeAny,
  inputs: OpaqueRef<T>,
  outputs: Value<R>
): RecipeFactory<T, R> {
  // Traverse the value, collect all mentioned nodes and cells
  const cells = new Set<OpaqueRef<any>>();
  const shadows = new Set<ShadowRef>();
  const nodes = new Set<NodeRef>();

  const collectCellsAndNodes = (value: Value<any>) =>
    traverseValue(value, (value) => {
      if (canBeOpaqueRef(value)) value = makeOpaqueRef(value);
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

  // Then assign paths on the recipe cell for all cells. For now we just assign
  // incremental counters, since we don't have access to the original variable
  // names. Later we might do something more clever by analyzing the code (we'll
  // want that anyway for extracting schemas from TypeScript).
  const paths = new Map<OpaqueRef<any> | ShadowRef, PropertyKey[]>();

  // Add the inputs default path
  paths.set(inputs, ["parameters"]);

  // Add paths for all the internal cells
  // TODO: Infer more stable identifiers
  let count = 0;
  cells.forEach((cell: OpaqueRef<any>) => {
    if (paths.has(cell)) return;
    const { cell: top, path } = cell.export();
    if (!paths.has(top)) paths.set(top, ["internal", `__#${count++}`]);
    if (path.length) paths.set(cell, [...paths.get(top)!, ...path]);
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
    true
  )!;

  // Set initial values for all cells, add non-inputs defaults
  const initial: any = {};
  cells.forEach((cell) => {
    // Only process roots of extra cells:
    if (cell === inputs) return;
    const { path, value, defaultValue } = cell.export();
    if (path.length > 0) return;

    const cellPath = paths.get(cell)!;
    if (value) setValueAtPath(initial, cellPath, value);
    if (defaultValue) setValueAtPath(defaults, cellPath, defaultValue);
  });

  // External cells all have to be added to the initial state
  cells.forEach((cell) => {
    const { external } = cell.export();
    if (external) setValueAtPath(initial, paths.get(cell)!, external);
  });

  let schema: {
    properties: { [key: string]: any };
    description: string;
  };

  if (typeof inputSchema === "string") {
    // TODO: initial is likely not needed anymore
    // TODO: But we need a new one for the result
    schema = createJsonSchema(defaults, {}) as {
      properties: { [key: string]: any };
      description: string;
    };
    schema.description = inputSchema;

    delete schema.properties[UI]; // TODO: This should be a schema for views
    if (schema.properties?.internal?.properties)
      for (const key of Object.keys(
        schema.properties.internal.properties as any
      ))
        if (key.startsWith("__#"))
          delete (schema as any).properties.internal.properties[key];
  } else {
    schema = zodToJsonSchema(inputSchema) as {
      properties: { [key: string]: any };
      description: string;
    };
  }

  const serializedNodes = Array.from(nodes).map((node) => {
    const module = isOpaqueRef(node.module)
      ? (toJSONWithAliases(node.module, paths) as Alias)
      : (node.module as Module);
    const inputs = toJSONWithAliases(node.inputs, paths)!;
    const outputs = toJSONWithAliases(node.outputs, paths)!;
    return { module, inputs, outputs } satisfies Node;
  });

  const recipe: Recipe & toJSON = {
    schema,
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

  return Object.assign((inputs: Value<T>): OpaqueRef<R> => {
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
}

const frames: Frame[] = [];

export function pushFrame(frame?: Frame): Frame {
  if (!frame) frame = { parent: getTopFrame() };
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
