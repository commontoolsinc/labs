import {
  Recipe,
  RecipeFactory,
  NodeProxy,
  Value,
  CellProxy,
  isCellProxy,
  Node,
  Module,
  Alias,
  toJSON,
  UI,
  canBeCellProxy,
  makeCellProxy,
  Frame,
} from "./types.js";
import { cell } from "./cell-proxy.js";
import {
  traverseValue,
  setValueAtPath,
  toJSONWithAliases,
  createJsonSchema,
  moduleToJSON,
  recipeToJSON,
  connectInputAndOutputs,
} from "./utils.js";

/** Declare a recipe
 *
 * @param description A human-readable description of the recipe
 * @param fn A function that creates the recipe graph
 *
 * @returns A recipe node factory that also serializes as recipe.
 */
export function recipe<T>(
  description: string,
  fn: (input: CellProxy<Required<T>>) => any
): RecipeFactory<T, ReturnType<typeof fn>>;
export function recipe<T, R>(
  description: string,
  fn: (input: CellProxy<Required<T>>) => Value<R>
): RecipeFactory<T, R>;
export function recipe<T, R>(
  description: string,
  fn: (input: CellProxy<Required<T>>) => Value<R>
): RecipeFactory<T, R> {
  // The recipe graph is created by calling `fn` which populates for `inputs`
  // and `outputs` with Value<> (which containts CellProxy<>) and/or default
  // values.

  const frame = pushFrame();
  const inputs = cell<Required<T>>();
  const outputs = fn(inputs);
  const result = factoryFromRecipe<T, R>(description, inputs, outputs);
  popFrame(frame);
  return result;
}

// Same as above, but assumes the caller manages the frame
export function recipeFromFrame<T, R>(
  description: string,
  fn: (input: CellProxy<Required<T>>) => Value<R>
): RecipeFactory<T, R> {
  const inputs = cell<Required<T>>();
  const outputs = fn(inputs);
  return factoryFromRecipe<T, R>(description, inputs, outputs);
}

function factoryFromRecipe<T, R>(
  description: string,
  inputs: CellProxy<T>,
  outputs: Value<R>
): RecipeFactory<T, R> {
  // Traverse the value, collect all mentioned nodes and cells
  const cells = new Set<CellProxy<any>>();
  const nodes = new Set<NodeProxy>();

  const collectCellsAndNodes = (value: Value<any>) =>
    traverseValue(value, (value) => {
      if (canBeCellProxy(value)) value = makeCellProxy(value);
      if (isCellProxy(value) && !cells.has(value)) {
        cells.add(value);
        value.export().nodes.forEach((node: NodeProxy) => {
          if (!nodes.has(node)) {
            nodes.add(node);
            collectCellsAndNodes(node.inputs);
            collectCellsAndNodes(node.outputs);
          }
        });
        collectCellsAndNodes(value.export().value);
      }
    });
  collectCellsAndNodes(inputs);
  collectCellsAndNodes(outputs);

  // Then assign paths on the recipe cell for all cells. For now we just assign
  // incremental counters, since we don't have access to the original variable
  // names. Later we might do something more clever by analyzing the code (we'll
  // want that anyway for extracting schemas from TypeScript).
  const paths = new Map<CellProxy<any>, PropertyKey[]>();

  // Add the inputs default path
  paths.set(inputs, ["parameters"]);

  // Add paths for all the internal cells
  // TODO: Infer more stable identifiers
  let count = 0;
  cells.forEach((cell: CellProxy<any>) => {
    if (paths.has(cell)) return;
    const { cell: top, path } = cell.export();
    if (!paths.has(top)) paths.set(top, ["internal", `__#${count++}`]);
    if (path.length) paths.set(cell, [...paths.get(top)!, ...path]);
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

  // TODO: initial is likely not needed anymore
  // TODO: But we need a new one for the result
  const schema = createJsonSchema(defaults, initial) as {
    properties: { [key: string]: any };
    description: string;
  };
  schema.description = description;

  delete schema.properties[UI]; // TODO: This should be a schema for views
  if (schema.properties?.internal?.properties) {
    for (const key of Object.keys(
      (schema as any).properties.internal.properties
    )) {
      if (key.startsWith("__#")) {
        delete (schema as any).properties.internal.properties[key];
      }
    }
  }

  const serializedNodes = Array.from(nodes).map((node) => {
    const module = isCellProxy(node.module)
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

  return Object.assign((inputs: Value<T>): CellProxy<R> => {
    const outputs = cell<R>();
    const node: NodeProxy = { module, inputs, outputs };

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
