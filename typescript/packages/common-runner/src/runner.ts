import {
  TYPE,
  type Recipe,
  type RecipeFactory,
  type Module,
  type Alias,
  type JSON,
  isModule,
  isRecipe,
  isAlias,
  isCellProxy,
  isStreamAlias,
  pushFrame,
  popFrame,
  recipeFromFrame,
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
import { getModuleByRef } from "./module.js";
import { type AddCancel, type Cancel, useCancelGroup } from "./cancel.js";
import "./builtins/index.js";
import init, {
  CommonRuntime,
  JavaScriptModuleDefinition,
  JavaScriptValueMap,
} from "@commontools/common-runtime";

export const cancels = new WeakMap<CellImpl<any>, Cancel>();

export function run<T, R>(
  recipeFactory: RecipeFactory<T, R>,
  bindings: T,
  recipeCell?: CellImpl<R>
): CellImpl<R>;
export function run<T, R = any>(
  recipe: Recipe,
  bindings: T,
  recipeCell?: CellImpl<R>
): CellImpl<R>;
export function run<T, R = any>(
  recipe: Recipe,
  bindings?: T,
  recipeCell?: CellImpl<R>
): CellImpl<R> {
  if (recipeCell) {
    // If we already have a recipe cell, we are stopping and restarting
    // the recipe, so we need to stop the old one first.
    stop(recipeCell);
  }

  // Walk the recipe's schema and extract all default values
  const defaults = extractDefaultValues(recipe.schema);

  // Ensure static data is converted to cell references, e.g. for arrays
  bindings = staticDataToNestedCells(bindings);

  // If the bindings are a cell or cell reference, convert them to an object
  // where each property is a cell reference.
  // TODO: If new keys are added after first load, this won't work.
  if (isCell(bindings) || isCellReference(bindings)) {
    // If it's a cell, turn it into a cell reference
    const ref = isCellReference(bindings)
      ? bindings
      : ({ cell: bindings, path: [] } satisfies CellReference);

    // Get value, but just to get the keys. Throw if it isn't an object.
    const value = ref.cell.getAsProxy(ref.path);
    if (typeof value !== "object" || value === null)
      throw new Error(`Invalid bindings: Must be an object`);

    // Create aliases for all the top level keys in the object
    bindings = Object.fromEntries(
      Object.keys(value).map((key) => [
        key,
        { $alias: { cell: ref.cell, path: [...ref.path, key] } },
      ])
    ) as T;
  }

  // Create a new recipe cell if it doesn't exist. Assign a random UUID for now.
  // Eventually this should be something more causal.
  if (!recipeCell) {
    recipeCell = cell<R>();
    recipeCell.entityId = crypto.randomUUID();
  }

  // Generate recipe cell using defaults, bindings, and initial values
  recipeCell.send(
    mergeObjects(
      recipeCell.get(),
      {
        [TYPE]:
          (recipe.schema as { description: string })?.description ?? "unknown",
      },
      recipe.initial,
      bindings,
      defaults
    )
  );

  const [cancel, addCancel] = useCancelGroup();
  cancels.set(recipeCell, cancel);

  for (const node of recipe.nodes) {
    instantiateNode(
      node.module,
      node.inputs,
      node.outputs,
      recipeCell,
      addCancel
    );
  }

  return recipeCell;
}

export function stop(recipeCell: CellImpl<any>) {
  cancels.get(recipeCell)?.();
  cancels.delete(recipeCell);
}

function instantiateNode(
  module: Module | Alias,
  inputBindings: JSON,
  outputBindings: JSON,
  recipeCell: CellImpl<any>,
  addCancel: AddCancel
) {
  if (isModule(module)) {
    switch (module.type) {
      case "ref":
        instantiateNode(
          getModuleByRef(module.implementation as string),
          inputBindings,
          outputBindings,
          recipeCell,
          addCancel
        );
        break;
      case "javascript":
        instantiateJavaScriptNode(
          module,
          inputBindings,
          outputBindings,
          recipeCell,
          addCancel
        );
        break;
      case "raw":
        instantiateRawNode(
          module,
          inputBindings,
          outputBindings,
          recipeCell,
          addCancel
        );
        break;
      case "passthrough":
        instantiatePassthroughNode(
          module,
          inputBindings,
          outputBindings,
          recipeCell,
          addCancel
        );
        break;
      case "isolated":
        instantiateIsolatedNode(
          module,
          inputBindings,
          outputBindings,
          recipeCell,
          addCancel
        );
        break;
      case "recipe":
        instantiateRecipeNode(
          module,
          inputBindings,
          outputBindings,
          recipeCell,
          addCancel
        );
        break;
      default:
        throw new Error(`Unknown module type: ${module.type}`);
    }
  } else if (isAlias(module)) {
    // TODO: Implement, a dynamic node
  } else {
    throw new Error(`Unknown module type: ${module}`);
  }
}

function instantiateJavaScriptNode(
  module: Module,
  inputBindings: JSON,
  outputBindings: JSON,
  recipeCell: CellImpl<any>,
  addCancel: AddCancel
) {
  const inputs = mapBindingsToCell(
    inputBindings as { [key: string]: any },
    recipeCell
  );

  // TODO: This isn't correct, as module can write into passed cells. We
  // should look at the schema to find out what cells are read and
  // written.
  const reads = findAllAliasedCells(inputs, recipeCell);

  const outputs = mapBindingsToCell(outputBindings, recipeCell);
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

      const frame = pushFrame();
      const result = fn(inputsCell.getAsProxy([]));

      // If handler returns a graph created by builder, run it
      // TODO: Handle case where the result is a structure with possibly
      // multiple such nodes
      if (isCellProxy(result)) {
        const resultNode = result;

        // Recipe that assigns the result of the returned node to "result"
        const resultRecipe = recipeFromFrame("event handler result", () => ({
          result: resultNode,
        }));

        const resultCell = run(resultRecipe, {});
        addCancel(cancels.get(resultCell));
      }

      popFrame(frame);
    };

    addCancel(addEventHandler(handler, stream));
  } else {
    // Schedule the action to run when the inputs change

    const inputsCell = cell(inputs);
    inputsCell.freeze(); // Freezes the bindings, not aliased cells.

    const action: Action = (log: ReactivityLog) => {
      const inputsProxy = inputsCell.getAsProxy([], log);
      const result = fn(inputsProxy);
      sendValueToBinding(recipeCell, outputs, result, log);
    };

    addCancel(schedule(action, { reads, writes } satisfies ReactivityLog));
  }
}

function instantiateRawNode(
  module: Module,
  inputBindings: JSON,
  outputBindings: JSON,
  recipeCell: CellImpl<any>,
  addCancel: AddCancel
) {
  if (typeof module.implementation !== "function")
    throw new Error(
      `Raw module is not a function, got: ${module.implementation}`
    );

  // Built-ins can define their own scheduling logic, so they'll
  // implement parts of the above themselves.

  const mappedInputBindings = mapBindingsToCell(inputBindings, recipeCell);
  const mappedOutputBindings = mapBindingsToCell(outputBindings, recipeCell);

  const action = module.implementation(
    cell(mappedInputBindings),
    (result: any) =>
      sendValueToBinding(recipeCell, mappedOutputBindings, result),
    addCancel
  );

  addCancel(
    schedule(action, {
      reads: findAllAliasedCells(mappedInputBindings, recipeCell),
      writes: findAllAliasedCells(mappedOutputBindings, recipeCell),
    } satisfies ReactivityLog)
  );
}

function instantiatePassthroughNode(
  _: Module,
  inputBindings: JSON,
  outputBindings: JSON,
  recipeCell: CellImpl<any>,
  addCancel: AddCancel
) {
  const inputs = mapBindingsToCell(inputBindings, recipeCell);
  const inputsCell = cell(inputs);
  const reads = findAllAliasedCells(inputs, recipeCell);

  const outputs = mapBindingsToCell(outputBindings, recipeCell);
  const writes = findAllAliasedCells(outputs, recipeCell);

  const action: Action = (log: ReactivityLog) => {
    const inputsProxy = inputsCell.getAsProxy([], log);
    sendValueToBinding(recipeCell, outputBindings, inputsProxy, log);
  };

  addCancel(schedule(action, { reads, writes } satisfies ReactivityLog));
}

function instantiateIsolatedNode(
  module: Module,
  inputBindings: JSON,
  outputBindings: JSON,
  recipeCell: CellImpl<any>,
  addCancel: AddCancel
) {
  const inputs = mapBindingsToCell(inputBindings, recipeCell);
  const reads = findAllAliasedCells(inputs, recipeCell);
  const inputsCell = cell(inputs);
  inputsCell.freeze();

  const outputs = mapBindingsToCell(outputBindings, recipeCell);
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
      module.implementation as unknown as JavaScriptModuleDefinition
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

    sendValueToBinding(recipeCell, outputBindings, result, log);
  };

  addCancel(schedule(action, { reads, writes } satisfies ReactivityLog));
}

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

function instantiateRecipeNode(
  module: Module,
  inputBindings: JSON,
  outputBindings: JSON,
  recipeCell: CellImpl<any>,
  addCancel: AddCancel
) {
  if (!isRecipe(module.implementation)) throw new Error(`Invalid recipe`);
  const inputs = mapBindingsToCell(inputBindings, recipeCell);
  const result = run(module.implementation, inputs);
  if (isAlias(outputBindings))
    sendValueToBinding(recipeCell, outputBindings, result);
  else
    result.sink((value) =>
      sendValueToBinding(recipeCell, outputBindings, value)
    );
  addCancel(cancels.get(recipeCell));
}

const moduleWrappers = {
  handler: (fn: (event: any, ...props: any[]) => any) => (props: any) =>
    fn(props.$event, props),
};
