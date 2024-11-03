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
  isOpaqueRef,
  isStreamAlias,
  popFrame,
  recipeFromFrame,
  pushFrameFromCause,
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
  deepCopy,
} from "./utils.js";
import { getModuleByRef } from "./module.js";
import { type AddCancel, type Cancel, useCancelGroup } from "./cancel.js";
import "./builtins/index.js";
import init, {
  CommonRuntime,
  JavaScriptModuleDefinition,
  JavaScriptValueMap,
} from "@commontools/common-runtime";
import { getRecipe } from "./recipe-map.js";

export const cancels = new WeakMap<CellImpl<any>, Cancel>();

/**
 * Run a recipe.
 *
 * When called with a result cell, it'll read from the cell and update the
 * instance if appropriate. This can be used to rehydrate an instance.
 *
 * When called without a result cell, or the result cell is empty, a new
 * instance is created.
 *
 * @param recipeFactory - A function that takes parameters and returns a recipe.
 * @param parameters - The parameters to pass to the recipe. Can be static data
 * and/or cell references, including cell value proxies and regular cells.
 * @param resultCell - Optional cell to run the recipe into. If not given, a new
 * cell is created.
 * @returns The result cell.
 */
export function run<T, R>(
  recipeFactory?: RecipeFactory<T, R>,
  parameters?: T,
  resultCell?: CellImpl<R>,
): CellImpl<R>;
export function run<T, R = any>(
  recipe?: Recipe,
  parameters?: T,
  resultCell?: CellImpl<R>,
): CellImpl<R>;
export function run<T, R = any>(
  recipe?: Recipe,
  parameters?: T,
  resultCell?: CellImpl<R>,
): CellImpl<R> {
  if (resultCell) {
    if (cancels.has(resultCell)) {
      // If it's already running and no new recipe or parameters are given,
      // we are just returning the result cell
      if (recipe === undefined && parameters === undefined) return resultCell;

      // Otherwise stop execution of the old recipe. TODO: Await, but this will
      // make all this async.
      stop(resultCell);
    }
  } else {
    resultCell = cell<R>();
  }

  // Keep track of subscriptions to cancel them later
  const [cancel, addCancel] = useCancelGroup();
  cancels.set(resultCell, cancel);

  let processCell: CellImpl<{
    [TYPE]: string;
    parameters?: T;
    internal?: { [key: string]: any };
  }>;

  if (resultCell.sourceCell !== undefined) {
    processCell = resultCell.sourceCell;
    // TODO: Allow updating of parameters, even if there were previous ones
    parameters = (processCell.get()?.parameters as T) ?? parameters;
  } else {
    processCell = cell();
    resultCell.sourceCell = processCell;
  }

  if (!recipe && processCell.get()?.[TYPE]) {
    recipe = getRecipe(processCell.get()[TYPE]);
    if (!recipe) throw new Error(`Unknown recipe: ${processCell.get()[TYPE]}`);
  } else if (!recipe) {
    console.warn(
      "No recipe provided and no recipe found in process cell. Not running.",
    );
    return resultCell;
  }

  // Walk the recipe's schema and extract all default values
  const defaults = extractDefaultValues(recipe.schema);

  // If the bindings are a cell or cell reference, convert them to an object
  // where each property is a cell reference.
  // TODO: If new keys are added after first load, this won't work.
  if (isCell(parameters) || isCellReference(parameters)) {
    // If it's a cell, turn it into a cell reference
    const ref = isCellReference(parameters)
      ? parameters
      : ({ cell: parameters, path: [] } satisfies CellReference);

    // Get value, but just to get the keys. Throw if it isn't an object.
    const value = ref.cell.getAsQueryResult(ref.path);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // Create aliases for all the top level keys in the object
      parameters = Object.fromEntries(
        Object.keys(value).map((key) => [
          key,
          { $alias: { cell: ref.cell, path: [...ref.path, key] } },
        ]),
      ) as T;
    } else {
      // Otherwise we just alias the whole thing
      parameters = { $alias: ref } as T;
    }
  }

  // TODO: Add a causal relationship. For example a recipe that only transforms
  // data from a fixed source could have an idea that depends on that source
  // alone, as any instance of the recipe will do the same thing. The trouble is
  // though that we support the recipe to change over time, and such a change
  // might change this condition and we'd need distinct ideas for different
  // instances of this recipe again.
  if (!resultCell.entityId) resultCell.generateEntityId();
  if (!processCell.entityId) processCell.generateEntityId(resultCell.entityId);

  const internal =
    processCell.get()?.internal ??
    (recipe.initial as { internal: any })?.internal;

  // Ensure static data is converted to cell references, e.g. for arrays
  parameters = staticDataToNestedCells(parameters, undefined, resultCell);

  // TODO: Move up, only do this if it's not from the sourceCell
  if (defaults) parameters = mergeObjects(parameters, defaults);

  processCell.send({
    [TYPE]:
      (recipe.schema as { description: string })?.description ?? "unknown",
    parameters,
    ...(internal ? { internal: deepCopy(internal) } : {}),
  });

  // Send "query" to results to the result cell
  resultCell.send(mapBindingsToCell<R>(recipe.result as R, processCell));

  // Now start the recipe
  for (const node of recipe.nodes) {
    // Generate causal IDs for all cells read and written to by this node, if
    // they don't have any yet.
    [node.inputs, node.outputs].forEach((bindings) =>
      findAllAliasedCells(bindings, processCell).forEach(({ cell, path }) => {
        if (!cell.entityId) cell.generateEntityId({ cell: processCell, path });
      }),
    );
    instantiateNode(
      node.module,
      node.inputs,
      node.outputs,
      processCell,
      addCancel,
    );
  }

  return resultCell;
}

/**
 * Stop a recipe. This will cancel the recipe and all its children.
 *
 * TODO: This isn't a good strategy, as other instances might depend on behavior
 * provided here, even if the user might no longer care about e.g. the UI here.
 * A better strategy would be to schedule based on effects and unregister the
 * effects driving execution, e.g. the UI.
 *
 * @param resultCell - The result cell to stop.
 */
export function stop(resultCell: CellImpl<any>) {
  cancels.get(resultCell)?.();
  cancels.delete(resultCell);
}

function instantiateNode(
  module: Module | Alias,
  inputBindings: JSON,
  outputBindings: JSON,
  processCell: CellImpl<any>,
  addCancel: AddCancel,
) {
  if (isModule(module)) {
    switch (module.type) {
      case "ref":
        instantiateNode(
          getModuleByRef(module.implementation as string),
          inputBindings,
          outputBindings,
          processCell,
          addCancel,
        );
        break;
      case "javascript":
        instantiateJavaScriptNode(
          module,
          inputBindings,
          outputBindings,
          processCell,
          addCancel,
        );
        break;
      case "raw":
        instantiateRawNode(
          module,
          inputBindings,
          outputBindings,
          processCell,
          addCancel,
        );
        break;
      case "passthrough":
        instantiatePassthroughNode(
          module,
          inputBindings,
          outputBindings,
          processCell,
          addCancel,
        );
        break;
      case "isolated":
        instantiateIsolatedNode(
          module,
          inputBindings,
          outputBindings,
          processCell,
          addCancel,
        );
        break;
      case "recipe":
        instantiateRecipeNode(
          module,
          inputBindings,
          outputBindings,
          processCell,
          addCancel,
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
  processCell: CellImpl<any>,
  addCancel: AddCancel,
) {
  const inputs = mapBindingsToCell(
    inputBindings as { [key: string]: any },
    processCell,
  );

  // TODO: This isn't correct, as module can write into passed cells. We
  // should look at the schema to find out what cells are read and
  // written.
  const reads = findAllAliasedCells(inputs, processCell);

  const outputs = mapBindingsToCell(outputBindings, processCell);
  const writes = findAllAliasedCells(outputs, processCell);

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
    let cell = processCell;
    let path: PropertyKey[] = [key];
    let value = inputs[key];
    while (isAlias(value)) {
      const ref = followAliases(value, processCell);
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
      const cause = { ...inputs };
      for (const key in eventInputs) {
        if (
          isAlias(eventInputs[key]) &&
          eventInputs[key].$alias.cell === stream.cell &&
          eventInputs[key].$alias.path.length === stream.path.length &&
          eventInputs[key].$alias.path.every(
            (value: PropertyKey, index: number) => value === stream.path[index],
          )
        ) {
          eventInputs[key] = event;
          cause[key] = crypto.randomUUID(); // TODO: Track this ID for integrity
        }
      }

      const inputsCell = cell(eventInputs, cause);
      inputsCell.freeze(); // Freezes the bindings, not aliased cells.

      const frame = pushFrameFromCause(cause);
      const result = fn(inputsCell.getAsQueryResult([]));

      // If handler returns a graph created by builder, run it
      // TODO: Handle case where the result is a structure with possibly
      // multiple such nodes
      if (isOpaqueRef(result)) {
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
      const inputsProxy = inputsCell.getAsQueryResult([], log);

      const frame = pushFrameFromCause({ inputs, outputs, fn: fn.toString() });
      const result = fn(inputsProxy);
      popFrame(frame);

      sendValueToBinding(processCell, outputs, result, log);
    };

    addCancel(schedule(action, { reads, writes } satisfies ReactivityLog));
  }
}

function instantiateRawNode(
  module: Module,
  inputBindings: JSON,
  outputBindings: JSON,
  processCell: CellImpl<any>,
  addCancel: AddCancel,
) {
  if (typeof module.implementation !== "function")
    throw new Error(
      `Raw module is not a function, got: ${module.implementation}`,
    );

  // Built-ins can define their own scheduling logic, so they'll
  // implement parts of the above themselves.

  const mappedInputBindings = mapBindingsToCell(inputBindings, processCell);
  const mappedOutputBindings = mapBindingsToCell(outputBindings, processCell);

  const inputCells = findAllAliasedCells(mappedInputBindings, processCell);
  const outputCells = findAllAliasedCells(mappedOutputBindings, processCell);

  const action = module.implementation(
    cell(mappedInputBindings),
    (result: any) =>
      sendValueToBinding(processCell, mappedOutputBindings, result),
    addCancel,
    inputCells, // cause
  );

  addCancel(schedule(action, { reads: inputCells, writes: outputCells }));
}

function instantiatePassthroughNode(
  _: Module,
  inputBindings: JSON,
  outputBindings: JSON,
  processCell: CellImpl<any>,
  addCancel: AddCancel,
) {
  const inputs = mapBindingsToCell(inputBindings, processCell);
  const inputsCell = cell(inputs);
  const reads = findAllAliasedCells(inputs, processCell);

  const outputs = mapBindingsToCell(outputBindings, processCell);
  const writes = findAllAliasedCells(outputs, processCell);

  const action: Action = (log: ReactivityLog) => {
    const inputsProxy = inputsCell.getAsQueryResult([], log);
    sendValueToBinding(processCell, outputBindings, inputsProxy, log);
  };

  addCancel(schedule(action, { reads, writes } satisfies ReactivityLog));
}

function instantiateIsolatedNode(
  module: Module,
  inputBindings: JSON,
  outputBindings: JSON,
  processCell: CellImpl<any>,
  addCancel: AddCancel,
) {
  const inputs = mapBindingsToCell(inputBindings, processCell);
  const reads = findAllAliasedCells(inputs, processCell);
  const inputsCell = cell(inputs);
  inputsCell.freeze();

  const outputs = mapBindingsToCell(outputBindings, processCell);
  const writes = findAllAliasedCells(outputs, processCell);

  if (!isJavaScriptModuleDefinition(module.implementation))
    throw new Error(`Invalid module definition`);

  // Initialize web runtime wasm artifact.
  // Needed only once.
  runtime ||= (init as unknown as () => Promise<any>)().then(
    () => new CommonRuntime(COMMON_RUNTIME_URL),
  );

  const fnPromise = runtime.then((rt) =>
    rt.instantiate(
      module.implementation as unknown as JavaScriptModuleDefinition,
    ),
  );

  const action: Action = async (log: ReactivityLog) => {
    const inputsProxy = inputsCell.getAsQueryResult([], log);
    if (typeof inputsProxy !== "object")
      throw new Error(`Invalid inputs: Must be an object`);

    const fn = await fnPromise;
    const fnOutput = await fn.run(inputsProxy as unknown as JavaScriptValueMap);

    const result: any = Object.fromEntries(
      Object.entries(fnOutput).map(([key, value]) => [key, value.val]),
    );

    sendValueToBinding(processCell, outputBindings, result, log);
  };

  addCancel(schedule(action, { reads, writes } satisfies ReactivityLog));
}

let runtime: Promise<CommonRuntime> | undefined;
const COMMON_RUNTIME_URL = "http://localhost:8081";

// This should be in common-runtime
function isJavaScriptModuleDefinition(
  module: any,
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
  processCell: CellImpl<any>,
  addCancel: AddCancel,
) {
  if (!isRecipe(module.implementation)) throw new Error(`Invalid recipe`);
  const inputs = mapBindingsToCell(inputBindings, processCell);
  const result = run(module.implementation, inputs);
  sendValueToBinding(processCell, outputBindings, result);
  // TODO: Make sure to not cancel after a recipe is elevated to a charm, e.g.
  // via navigateTo. Nothing is cancelling right now, so leaving this as TODO.
  addCancel(cancels.get(result.sourceCell!));
}

const moduleWrappers = {
  handler: (fn: (event: any, ...props: any[]) => any) => (props: any) =>
    fn(props.$event, props),
};
