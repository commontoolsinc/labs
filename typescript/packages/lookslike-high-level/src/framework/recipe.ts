export type Value<T> =
  | T
  | CellProxy<T>
  | { [K in keyof T]: Value<T[K]> }
  | Array<Value<T extends Array<infer U> ? U : never>>;

// A cell proxy that supports nested values and .set() and .get() methods
export type CellProxy<T> = CellProxyMethods<T> & {
  [K in keyof T]: CellProxy<T[K]>;
};

export type CellProxyMethods<T> = {
  get(): CellProxy<T>;
  set(value: Value<T>): void;
  setDefault(value: Value<T>): void;
  connect(node: NodeProxy): void;
  [getCellForRecipe](): {
    path: (string | number | symbol)[];
    value?: Value<T>;
    defaultValue?: Value<T>;
    nodes: Set<NodeProxy>;
  };
};

type NodeProxy = {
  module: Module | Recipe | CellProxy<Module | Recipe>;
  inputs: Value<any>;
  outputs: CellProxy<any>;
};

// Module<T> takes either (...T) or T as paremeter and returns Cell<R>
export type NodeFactory<T, R> = ((inputs: Value<T>) => Value<R>) &
  (Module | Recipe);

// A cell factory that creates a future cell with an optional default value.
//
// It's a proxy object representing a future cell that will eventually be
// created. It supports nested values and .set(), .get() and .setDefault()
// methods.
// - .set(value) sets the value of the proxy cell. This must be a bound data
//   structure, and internally creates a data node.
// - .get() just returns the cell itself, a proxy for the cell carrying the
//   value.
// - .setDefault(value) sets the default value of the cell.
//
// The proxy yields another proxy for each nested value, but still allows the
// methods to be called. Setters just call .set() on the nested cell.
export function cell<T>(
  defaultValue?: Value<T>,
  path: (string | symbol)[] = [],
  target: any = {}
): CellProxy<T> {
  let value: Value<T> | undefined = defaultValue;
  const nodes = new Set<NodeProxy>();

  function subCell(next: string | symbol, target?: any): CellProxy<T> {
    return cell(defaultValue, [...path, next], target);
  }

  const cellMethods: CellProxyMethods<T> = {
    get: () => newCell,
    set: (newValue: Value<T>) => (value = newValue),
    // TODO: Fix to make work on path.
    setDefault: (newValue: Value<T>) => (defaultValue ??= newValue),
    connect: (node: NodeProxy) => nodes.add(node),
    [getCellForRecipe]: () => ({ path, defaultValue, value, nodes }),
  };

  const newCell = new Proxy(target, {
    get(_, prop) {
      // Suppoert `get`, `set`, etc as path elements and methods
      if (prop in cellMethods)
        return subCell(prop, Reflect.get(cellMethods, prop));
      else return subCell(prop);
    },
    set(_, prop, value: any) {
      subCell(prop).set(value);
      return true;
    },
  });

  return newCell;
}

const getCellForRecipe = Symbol("getCellForRecipe");

export function isCell(value: any): value is CellProxy<any> {
  return value && typeof value[getCellForRecipe] === "function";
}

/** Declare a module
 *
 * @param implementation A function that takes an input and returns a result
 *
 * @returns A module node factory that also serializes as module.
 */
export function lift<T, R>(implementation: (input: T) => R): NodeFactory<T, R> {
  const module: Module = { type: "javascript", implementation };

  return Object.assign((inputs: Value<T>): CellProxy<R> => {
    const outputs = cell<R>();
    const node: NodeProxy = { module, inputs, outputs };

    traverseValue(inputs, (value) => isCell(value) && value.connect(node));
    outputs.connect(node);

    return outputs;
  }, module);
}

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
        value[getCellForRecipe]().nodes.forEach((node) => nodes.add(node));
        collectCellsAndNodes(value[getCellForRecipe]().value);
      }
    });
  collectCellsAndNodes(state);

  // Then assign paths on the recipe cell for all cells. For now we just assign
  // incremental counters, since we don't have access to the original variable
  // names. Later we might do something more clever by analyzing the code (we'll
  // want that anyway for extracting schemas from TypeScript).
  const paths = new Map<CellProxy<any>, (string | number)[]>();
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

function traverseValue(value: Value<any>, fn: (value: any) => any) {
  if (Array.isArray(value)) value.map(fn);
  else if (typeof value === "object") for (const key in value) fn(value[key]);
  else fn(value);
}

function setValueAtPath(obj: any, path: (string | number)[], value: any) {
  let parent = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (typeof parent[key] !== "object")
      parent[key] = typeof path[i + 1] === "number" ? [] : {};
    parent = parent[key];
  }
  parent[path[path.length - 1]] = value;
}

function toJSONWithReferences(
  value: Value<any>,
  paths: Map<CellProxy<any>, (string | number)[]>,
  key: string = ""
): JSONValue {
  if (isCell(value)) {
    const path = paths.get(value);
    if (path) return { $ref: path };
    else throw "Cell not found in paths";
  }

  if (Array.isArray(value))
    // Escape `$ref` that are arrays by prefixing with an empty array
    return (key === "$ref" ? [[], ...value] : value).map((value) =>
      toJSONWithReferences(value, paths)
    );
  if (typeof value === "object") {
    const result: any = {};
    for (const key in value)
      result[key] = toJSONWithReferences(value[key], paths, key);
    return result;
  }
  return value;
}

function createJsonSchema(defaultValues: any, referenceValues: any): JSON {
  function analyzeType(value: any, defaultValue: any): JSON {
    const type = typeof value;
    const schema: any = { type };

    switch (type) {
      case "object":
        if (Array.isArray(value)) {
          schema.type = "array";
          if (value.length > 0) {
            schema.items = analyzeType(value[0], defaultValue?.[0]);
          }
        } else if (value !== null) {
          schema.type = "object";
          schema.properties = {};
          for (const key in value) {
            schema.properties[key] = analyzeType(
              value[key],
              defaultValue?.[key]
            );
          }
        } else {
          schema.type = "null";
        }
        break;
      case "number":
        if (Number.isInteger(value)) {
          schema.type = "integer";
        }
        break;
    }

    if (defaultValue !== undefined) {
      schema.default = defaultValue;
    }

    return schema;
  }

  return analyzeType(referenceValues, defaultValues);
}

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

export type JSON = JSONValue | { [key: string]: JSONValue };

export type Reference = {
  /** Path to value, in recipe space, from root.
   *
   * Only a valid path, if it's an array of strings. If first entry is an empty
   * array, treat the rest as literal, i.e. as if original data had a key "$ref"
   * and the rest of the array as value (non-arrays don't need escaping).
   */
  $ref: (string | number)[] | [[], ...any];
};

export function isReference(value: any): value is Reference {
  return !!(value && value.$ref && Array.isArray(value.$ref));
}

export type Module = {
  type: "javascript" | "recipe" | "value";
  // schema: JSON;
  implementation?: Function | Recipe | JSON;
};

export function isModule(value: any): value is Module {
  return !!(value && value.implementation);
}

export type Node = {
  description?: string;
  module: Module | Recipe | Reference;
  inputs: JSON;
  outputs: JSON; // TODO: Destructure to cell references
};

export type Recipe = {
  /** Schema for recipe cell, contains default values and descriptions */
  schema: JSON;
  /** Initial values */
  initial: JSON;
  /** Nodes */
  nodes: Node[];
};

export function isRecipe(value: any): value is Recipe {
  return !!(value && value.schema && value.nodes && Array.isArray(value.nodes));
}
