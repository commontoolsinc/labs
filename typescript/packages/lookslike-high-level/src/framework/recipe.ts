import {
  Recipe,
  NodeFactory,
  NodeProxy,
  Value,
  CellProxy,
  isCell,
  Node,
  Module,
  getCellForRecipe,
  Reference,
} from "./types.js";
import { cell } from "./cell-proxy.js";
import {
  traverseValue,
  setValueAtPath,
  toJSONWithReferences,
  createJsonSchema,
} from "./utils.js";

/** Declare a recipe
 *
 * @param description A human-readable description of the recipe
 * @param fn A function that creates the recipe graph
 *
 * @returns A recipe node factory that also serializes as recipe.
 */
export function recipe<T, R>(
  description: string,
  fn: (input: Value<T>) => Value<R>
): NodeFactory<T, R> {
  // The recipe graph is created by calling `fn` which populates for `inputs`
  // and `outputs` with Value<> (which containts CellProxy<>) and/or default
  // values.
  const state = cell<T & R>();
  let outputs: CellProxy<R> = fn(state) as CellProxy<R>;
  if (!isCell(outputs)) outputs = cell<R>(outputs);

  // Next we need to traverse the inputs and outputs serialize the graph.

  // First, assign the outputs to the state cell.
  // TOOD: We assume no default values for top-level output for now.
  const outputValues = outputs[getCellForRecipe]();
  if (typeof outputValues.value === "object")
    state.set({
      ...state[getCellForRecipe]().value,
      ...outputValues.value,
    } as Value<T & R>);
  outputValues.nodes.forEach((node) => state.connect(node));

  // Then traverse the value, collect all mentioned nodes and cells
  const cells = new Set<CellProxy<any>>();
  const nodes = new Set<NodeProxy>();

  const collectCellsAndNodes = (value: Value<any>) =>
    traverseValue(value, (value) => {
      if (isCell(value)) {
        cells.add(value);
        value[getCellForRecipe]().nodes.forEach((node) => {
          if (!nodes.has(node)) {
            nodes.add(node);
            collectCellsAndNodes(node.inputs);
            collectCellsAndNodes(node.outputs);
          }
        });
        collectCellsAndNodes(value[getCellForRecipe]().value);
      }
    });
  collectCellsAndNodes(state);

  // Then assign paths on the recipe cell for all cells. For now we just assign
  // incremental counters, since we don't have access to the original variable
  // names. Later we might do something more clever by analyzing the code (we'll
  // want that anyway for extracting schemas from TypeScript).
  const paths = new Map<CellProxy<any>, PropertyKey[]>();
  let count = 0;
  cells.forEach((cell) => {
    if (cell === state) paths.set(cell, []);
    else paths.set(cell, [`__#${count++}`]);
  });

  // Now serialize the defaults and initial values, copying them from other
  // cells into the primary cell.
  const { value, defaultValue } = state[getCellForRecipe]();
  const initial = toJSONWithReferences(value, paths);
  const defaults = toJSONWithReferences(defaultValue, paths);

  cells.forEach((cell) => {
    if (cell === state) return;
    const path = [...paths.get(cell)!];
    const { value, defaultValue } = cell[getCellForRecipe]();
    if (value) setValueAtPath(initial, path, value);
    if (defaultValue) setValueAtPath(defaults, path, defaultValue);
  });

  const schema = createJsonSchema(defaults, initial);
  (schema as { description: string }).description = description;

  const serializedNodes = Array.from(nodes).map((node) => {
    const module = isCell(node.module)
      ? (toJSONWithReferences(node.module, paths) as Reference)
      : (node.module as Module);
    const inputs = toJSONWithReferences(node.inputs, paths);
    const outputs = toJSONWithReferences(node.outputs, paths);
    return { module, inputs, outputs } satisfies Node;
  });

  const recipe: Recipe = { schema, initial, nodes: serializedNodes };
  const module: Module = { type: "recipe", implementation: recipe };

  return Object.assign((inputs: Value<T>): Value<R> => {
    const outputs = cell<R>();
    const node: NodeProxy = { module, inputs, outputs };

    traverseValue(inputs, (value) => isCell(value) && value.connect(node));
    outputs.connect(node);

    return outputs;
  }, recipe) satisfies NodeFactory<T, R>;
}
