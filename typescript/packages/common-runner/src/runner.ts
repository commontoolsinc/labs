import {
  ID,
  TYPE,
  Node,
  Recipe,
  RecipeFactory,
  Module,
  isModule,
  isRecipe,
  isAlias,
  isStreamAlias,
} from "@commontools/common-builder";
import {
  cell,
  CellImpl,
  ReactivityLog,
  CellReference,
  isCell,
  isCellReference,
} from "./cell.js";
import { Action, schedule, addEventHandler } from "./scheduler.js";
import {
  extractDefaultValues,
  mapBindingsToCell,
  findAllAliasedCells,
  followAliases,
  mergeObjects,
  sendValueToBinding,
  staticDataToNestedCells,
} from "./utils.js";
import { builtins } from "./builtins/index.js";
import init, {
  CommonRuntime,
  JavaScriptModuleDefinition,
  JavaScriptValueMap,
} from "@commontools/common-runtime";

let runtime: Promise<CommonRuntime> | undefined;
const COMMON_RUNTIME_URL = "http://localhost:8081";

// This should be in common-runtime
function isJavaScriptModuleDefinition(
  module: any
): module is JavaScriptModuleDefinition {
  return (
    typeof module === "object" &&
    module !== null &&
    typeof module.body === "string" &&
    typeof module.inputs === "object" &&
    typeof module.outputs === "object"
  );
}

export const charmById = new Map<number, CellImpl<any>>();
let nextCharmId = 0;

export function run<T, R>(
  recipeFactory: RecipeFactory<T, R>,
  bindings: T
): CellImpl<R>;
export function run<T, R = any>(recipe: Recipe, bindings: T): CellImpl<R>;
export function run<T, R = any>(recipe: Recipe, bindings: T): CellImpl<R> {
  // Walk the recipe's schema and extract all default values
  const defaults = extractDefaultValues(recipe.schema);

  // Ensure static data is converted to cell references, e.g. for arrays
  bindings = staticDataToNestedCells(bindings);

  // If the bindings are a cell or cell reference, convert them to an object
  // where each property is a cell reference.
  // TODO: If new keys are added after first load, this won't work.
  if (isCell(bindings) || isCellReference(bindings)) {
    const ref = isCellReference(bindings)
      ? bindings
      : ({ cell: bindings, path: [] } satisfies CellReference);
    const value = ref.cell.getAsProxy(ref.path);
    if (typeof value !== "object" || value === null)
      throw new Error(`Invalid bindings: Must be an object`);
    bindings = Object.fromEntries(
      Object.entries(value).map(([key]) => [
        key,
        { $alias: { cell: ref.cell, path: [...ref.path, key] } },
      ])
    ) as T;
  }

  // Generate recipe cell using defaults, bindings, and initial values
  // TODO: Some initial values can be aliases to outside cells
  const id = nextCharmId++;
  const recipeCell = cell<R>();
  recipeCell.send(
    mergeObjects(
      {
        [ID]: id,
        [TYPE]:
          (recipe.schema as { description: string })?.description ?? "unknown",
      },
      recipe.initial,
      staticDataToNestedCells(bindings),
      defaults
    )
  );
  charmById.set(id, recipeCell);

  for (const node of recipe.nodes) {
    instantiateNode(node, recipeCell);
  }

  return recipeCell;
}

export function instantiateNode(node: Node, recipeCell: CellImpl<any>) {
  if (isModule(node.module)) {
    switch (node.module.type) {
      case "javascript":
        instantiateJavaScriptNode(node, recipeCell);
        break;
      case "builtin":
        instantiateBuiltinNode(node, recipeCell);
        break;
      case "passthrough":
        instantiatePassthroughNode(node, recipeCell);
        break;
      case "isolated":
        instantiateIsolatedNode(node, recipeCell);
        break;
      case "recipe":
        instantiateRecipeNode(node, recipeCell);
        break;
      default:
        throw new Error(`Unknown module type: ${node.module.type}`);
    }
  } else if (isAlias(node.module)) {
    // TODO: Implement, a dynamic node
  } else {
    throw new Error(`Unknown module type: ${node.module}`);
  }
}

function instantiateJavaScriptNode(node: Node, recipeCell: CellImpl<any>) {
  const module = node.module as Module;

  const inputs = mapBindingsToCell(
    node.inputs as { [key: string]: any },
    recipeCell
  );

  // TODO: This isn't correct, as module can write into passed cells. We
  // should look at the schema to find out what cells are read and
  // written.
  const reads = findAllAliasedCells(inputs, recipeCell);

  const outputs = mapBindingsToCell(node.outputs, recipeCell);
  const writes = findAllAliasedCells(outputs, recipeCell);

  let fn = (
    typeof module.implementation === "string"
      ? eval(module.implementation)
      : module.implementation
  ) as (inputs: any) => any;

  if (module.wrapper && module.wrapper in moduleWrappers)
    fn = moduleWrappers[module.wrapper](fn);

  // Check if any of the read cells is a stream alias
  let streamRef: CellReference | undefined = undefined;
  for (const key in inputs) {
    let cell = recipeCell;
    let path: PropertyKey[] = [key];
    let value = inputs[key];
    while (isAlias(value)) {
      const ref = followAliases(value, recipeCell);
      cell = ref.cell;
      path = ref.path;
      value = cell.getAtPath(path);
    }
    if (isStreamAlias(value)) {
      streamRef = { cell, path };
      break;
    }
  }

  if (streamRef) {
    // Register as event handler for the stream. Replace alias to
    // stream with the event.

    const stream = { ...streamRef };

    const handler = (event: any) => {
      if (event.preventDefault) event.preventDefault();
      const eventInputs = { ...inputs };
      for (const key in eventInputs) {
        if (
          isAlias(eventInputs[key]) &&
          eventInputs[key].$alias.cell === stream.cell &&
          eventInputs[key].$alias.path.length === stream.path.length &&
          eventInputs[key].$alias.path.every(
            (value: PropertyKey, index: number) => value === stream.path[index]
          )
        ) {
          eventInputs[key] = event;
        }
      }

      const inputsCell = cell(eventInputs);
      inputsCell.freeze(); // Freezes the bindings, not aliased cells.

      return fn(inputsCell.getAsProxy([]));
    };

    addEventHandler(handler, stream);
  } else {
    // Schedule the action to run when the inputs change

    const inputsCell = cell(inputs);
    inputsCell.freeze(); // Freezes the bindings, not aliased cells.

    const action: Action = (log: ReactivityLog) => {
      const inputsProxy = inputsCell.getAsProxy([], log);
      const result = fn(inputsProxy);
      sendValueToBinding(recipeCell, outputs, result, log);
    };

    schedule(action, { reads, writes } satisfies ReactivityLog);
  }
}

function instantiateBuiltinNode(node: Node, recipeCell: CellImpl<any>) {
  const module = node.module as Module;

  if (typeof module.implementation !== "string")
    throw new Error(`Builtin is not a string`);
  if (!(module.implementation in builtins))
    throw new Error(`Unknown builtin: ${module.implementation}`);

  // Built-ins can define their own scheduling logic, so they'll
  // implement parts of the above themselves.
  builtins[module.implementation](recipeCell, node);
}

function instantiatePassthroughNode(node: Node, recipeCell: CellImpl<any>) {
  const inputs = mapBindingsToCell(node.inputs, recipeCell);
  const inputsCell = cell(inputs);
  const reads = findAllAliasedCells(inputs, recipeCell);

  const outputs = mapBindingsToCell(node.outputs, recipeCell);
  const writes = findAllAliasedCells(outputs, recipeCell);

  const action: Action = (log: ReactivityLog) => {
    const inputsProxy = inputsCell.getAsProxy([], log);
    sendValueToBinding(recipeCell, node.outputs, inputsProxy, log);
  };

  schedule(action, { reads, writes } satisfies ReactivityLog);
}

function instantiateIsolatedNode(node: Node, recipeCell: CellImpl<any>) {
  const module = node.module as Module;

  const inputs = mapBindingsToCell(node.inputs, recipeCell);
  const reads = findAllAliasedCells(inputs, recipeCell);
  const inputsCell = cell(inputs);
  inputsCell.freeze();

  const outputs = mapBindingsToCell(node.outputs, recipeCell);
  const writes = findAllAliasedCells(outputs, recipeCell);

  if (!isJavaScriptModuleDefinition(module.implementation))
    throw new Error(`Invalid module definition`);

  // Initialize web runtime wasm artifact.
  // Needed only once.
  runtime ||= (init as unknown as () => Promise<any>)().then(
    () => new CommonRuntime(COMMON_RUNTIME_URL)
  );

  const fnPromise = runtime.then((rt) =>
    rt.instantiate(
      (node.module as Module)
        .implementation as unknown as JavaScriptModuleDefinition
    )
  );

  const action: Action = async (log: ReactivityLog) => {
    const inputsProxy = inputsCell.getAsProxy([], log);
    if (typeof inputsProxy !== "object")
      throw new Error(`Invalid inputs: Must be an object`);

    const fn = await fnPromise;
    const fnOutput = await fn.run(inputsProxy as unknown as JavaScriptValueMap);

    const result: any = Object.fromEntries(
      Object.entries(fnOutput).map(([key, value]) => [key, value.val])
    );

    sendValueToBinding(recipeCell, node.outputs, result, log);
  };

  schedule(action, { reads, writes } satisfies ReactivityLog);
}

function instantiateRecipeNode(node: Node, recipeCell: CellImpl<any>) {
  const module = node.module as Module;

  if (!isRecipe(module.implementation)) throw new Error(`Invalid recipe`);
  const inputs = mapBindingsToCell(node.inputs, recipeCell);
  const result = run(module.implementation, inputs);
  if (isAlias(node.outputs))
    sendValueToBinding(recipeCell, node.outputs, result);
  else
    result.sink((value) => sendValueToBinding(recipeCell, node.outputs, value));
}

const moduleWrappers = {
  handler: (fn: (event: any, ...props: any[]) => any) => (props: any) =>
    fn(props.$event, props),
};
