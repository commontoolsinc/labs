import {
  type Alias,
  isAlias,
  isModule,
  isRecipe,
  isStreamAlias,
  type JSONValue,
  type Module,
  type NodeFactory,
  popFrame,
  pushFrameFromCause,
  type Recipe,
  recipeFromFrame,
  TYPE,
  unsafe_materializeFactory,
  unsafe_originalRecipe,
  type UnsafeBinding,
} from "@commontools/builder";
import { type DocImpl, getDoc, isDoc } from "./doc.ts";
import {
  Action,
  addEventHandler,
  type ReactivityLog,
  schedule,
} from "./scheduler.ts";
import {
  containsOpaqueRef,
  deepCopy,
  diffAndUpdate,
  extractDefaultValues,
  findAllAliasedDocs,
  followAliases,
  maybeUnwrapProxy,
  mergeObjects,
  sendValueToBinding,
  unsafe_noteParentOnRecipes,
  unwrapOneLevelAndBindtoDoc,
} from "./utils.ts";
import { getModuleByRef } from "./module.ts";
import { type AddCancel, type Cancel, useCancelGroup } from "./cancel.ts";
import "./builtins/index.ts";
import {
  getRecipe,
  getRecipeId,
  registerNewRecipe,
  registerRecipe,
} from "./recipe-map.ts";
import { type CellLink, isCell, isCellLink } from "./cell.ts";
import { isQueryResultForDereferencing } from "./query-result-proxy.ts";
import { getCellLinkOrThrow } from "./query-result-proxy.ts";

export const cancels = new WeakMap<DocImpl<any>, Cancel>();

/**
 * Run a recipe.
 *
 * resultCell is required and should have an id. processCell is created if not
 * already set.
 *
 * If no recipe is provided, the previous one is used, and the recipe is started
 * if it isn't already started.
 *
 * If no argument is provided, the previous one is used, and the recipe is
 * started if it isn't already running.
 *
 * If a new recipe or any argument value is provided, a currently running recipe
 * is stopped, the recipe and argument replaced and the recipe restarted.
 *
 * @param recipeFactory - Function that takes the argument and returns a recipe.
 * @param argument - The argument to pass to the recipe. Can be static data
 * and/or cell references, including cell value proxies, docs and regular cells.
 * @param resultDoc - Doc to run the recipe off.
 * @returns The result cell.
 */
export function run<T, R>(
  recipeFactory: NodeFactory<T, R>,
  argument: T,
  resultCell: DocImpl<R>,
): DocImpl<R>;
export function run<T, R = any>(
  recipe: Recipe | Module | undefined,
  argument: T,
  resultCell: DocImpl<R>,
): DocImpl<R>;
export function run<T, R = any>(
  recipeOrModule: Recipe | Module | undefined,
  argument: T,
  resultCell: DocImpl<R>,
): DocImpl<R> {
  let processCell: DocImpl<{
    [TYPE]: string;
    argument?: T;
    internal?: { [key: string]: any };
    resultRef: { cell: DocImpl<R>; path: PropertyKey[] };
  }>;

  if (resultCell.sourceCell !== undefined) {
    processCell = resultCell.sourceCell;
  } else {
    processCell = getDoc(
      undefined,
      { cell: resultCell, path: [] },
      resultCell.space,
    ) as any;
    resultCell.sourceCell = processCell;
  }

  let recipeId: string | undefined;

  if (!recipeOrModule && processCell.get()?.[TYPE]) {
    recipeId = processCell.get()[TYPE];
    recipeOrModule = getRecipe(recipeId);
    if (!recipeOrModule) throw new Error(`Unknown recipe: ${recipeId}`);
  } else if (!recipeOrModule) {
    console.warn(
      "No recipe provided and no recipe found in process doc. Not running.",
    );
    return resultCell;
  }

  let recipe: Recipe;

  // If this is a module, not a recipe, wrap it in a recipe that just runs,
  // passing arguments in unmodified and passing all results through as is
  if (isModule(recipeOrModule)) {
    const module = recipeOrModule as Module;
    recipeId ??= getRecipeId(module);

    recipe = {
      argumentSchema: module.argumentSchema ?? {},
      resultSchema: module.resultSchema ?? {},
      result: { $alias: { path: ["internal"] } },
      nodes: [
        {
          module,
          inputs: { $alias: { path: ["argument"] } },
          outputs: { $alias: { path: ["internal"] } },
        },
      ],
    } satisfies Recipe;
  } else {
    recipe = recipeOrModule as Recipe;
  }

  recipeId ??= registerNewRecipe(recipe);

  if (cancels.has(resultCell)) {
    // If it's already running and no new recipe or argument are given,
    // we are just returning the result doc
    if (argument === undefined && recipeId === processCell.get()?.[TYPE]) {
      return resultCell;
    }

    // TODO(seefeld): If recipe is the same, but argument is different, just update the argument without stopping

    // Otherwise stop execution of the old recipe. TODO: Await, but this will
    // make all this async.
    stop(resultCell);
  }

  // Keep track of subscriptions to cancel them later
  const [cancel, addCancel] = useCancelGroup();
  cancels.set(resultCell, cancel);

  // If the bindings are a cell, doc or doc link, convert them to an object
  // where each property is a doc link.
  // TODO(seefeld): If new keys are added after first load, this won't work.
  // TODO(seefeld): Note why we need this. Is it still needed?
  if (
    isDoc(argument) ||
    isCellLink(argument) ||
    isCell(argument) ||
    isQueryResultForDereferencing(argument)
  ) {
    // If it's a cell, turn it into a cell reference
    const ref = isCellLink(argument)
      ? argument
      : isCell(argument)
      ? argument.getAsCellLink()
      : isQueryResultForDereferencing(argument)
      ? getCellLinkOrThrow(argument)
      : ({ cell: argument, path: [] } satisfies CellLink);

    // Get value, but just to get the keys. Throw if it isn't an object.
    const value = ref.cell.getAsQueryResult(ref.path);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // Create aliases for all the top level keys in the object
      argument = Object.fromEntries(
        Object.keys(value).map((key) => [
          key,
          { $alias: { cell: ref.cell, path: [...ref.path, key] } },
        ]),
      ) as T;
    } else {
      // Otherwise we just alias the whole thing
      argument = { $alias: ref } as T;
    }
  }

  // Walk the recipe's schema and extract all default values
  const defaults = extractDefaultValues(recipe.argumentSchema);

  const internal = {
    ...(deepCopy(defaults) as { internal: any })?.internal,
    ...(recipe.initial as { internal: any } | void)?.internal,
    ...processCell.get()?.internal,
  };

  // Still necessary until we consistently use schema for defaults.
  // Only do it on first load.
  if (!processCell.get()?.argument) {
    argument = mergeObjects(argument, defaults);
  }

  processCell.send({
    ...processCell.get(),
    [TYPE]: recipeId,
    resultRef: { cell: resultCell, path: [] },
    internal,
  });
  if (argument) {
    diffAndUpdate(
      { cell: processCell, path: ["argument"] },
      argument,
      undefined,
      processCell,
    );
  }

  // Send "query" to results to the result doc
  resultCell.send(
    unwrapOneLevelAndBindtoDoc<R>(recipe.result as R, processCell),
  );

  // [unsafe closures:] For recipes from closures, add a materialize factory
  if (recipe[unsafe_originalRecipe]) {
    recipe[unsafe_materializeFactory] = (log: any) => (path: PropertyKey[]) =>
      processCell.getAsQueryResult(path, log);
  }

  for (const node of recipe.nodes) {
    instantiateNode(
      node.module,
      node.inputs,
      node.outputs,
      processCell,
      addCancel,
      recipe,
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
 * @param resultCell - The result doc to stop.
 */
export function stop(resultCell: DocImpl<any>) {
  cancels.get(resultCell)?.();
  cancels.delete(resultCell);
}

function instantiateNode(
  module: Module | Alias,
  inputBindings: JSONValue,
  outputBindings: JSONValue,
  processCell: DocImpl<any>,
  addCancel: AddCancel,
  recipe: Recipe,
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
          recipe,
        );
        break;
      case "javascript":
        instantiateJavaScriptNode(
          module,
          inputBindings,
          outputBindings,
          processCell,
          addCancel,
          recipe,
        );
        break;
      case "raw":
        instantiateRawNode(
          module,
          inputBindings,
          outputBindings,
          processCell,
          addCancel,
          recipe,
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
    // TODO(seefeld): Implement, a dynamic node
  } else {
    throw new Error(`Unknown module type: ${module}`);
  }
}

function instantiateJavaScriptNode(
  module: Module,
  inputBindings: JSONValue,
  outputBindings: JSONValue,
  processCell: DocImpl<any>,
  addCancel: AddCancel,
  recipe: Recipe,
) {
  const inputs = unwrapOneLevelAndBindtoDoc(
    inputBindings as { [key: string]: any },
    processCell,
  );

  // TODO(seefeld): This isn't correct, as module can write into passed docs. We
  // should look at the schema to find out what docs are read and
  // written.
  const reads = findAllAliasedDocs(inputs, processCell);

  const outputs = unwrapOneLevelAndBindtoDoc(outputBindings, processCell);
  const writes = findAllAliasedDocs(outputs, processCell);

  let fn = (
    typeof module.implementation === "string"
      ? eval(module.implementation) // TODO(all): Add sandboxing :)
      : module.implementation
  ) as (inputs: any) => any;

  if (module.wrapper && module.wrapper in moduleWrappers) {
    fn = moduleWrappers[module.wrapper](fn);
  }

  // Check if any of the read cells is a stream alias
  let streamRef: CellLink | undefined = undefined;
  for (const key in inputs) {
    let doc = processCell;
    let path: PropertyKey[] = [key];
    let value = inputs[key];
    while (isAlias(value)) {
      const ref = followAliases(value, processCell);
      doc = ref.cell;
      path = ref.path;
      value = doc.getAtPath(path);
    }
    if (isStreamAlias(value)) {
      streamRef = { cell: doc, path };
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
          cause[key] = crypto.randomUUID(); // TODO(seefeld): Track this ID for integrity
        }
      }

      const inputsCell = getDoc(eventInputs, cause, processCell.space);
      inputsCell.freeze(); // Freezes the bindings, not aliased cells.

      const frame = pushFrameFromCause(cause, {
        recipe,
        materialize: (path: PropertyKey[]) =>
          processCell.getAsQueryResult(path),
      });

      const argument = module.argumentSchema
        ? inputsCell.asCell([], undefined, module.argumentSchema).get()
        : inputsCell.getAsQueryResult([], undefined);
      const result = fn(argument);

      // If handler returns a graph created by builder, run it
      if (containsOpaqueRef(result)) {
        const resultRecipe = recipeFromFrame(
          "event handler result",
          undefined,
          () => result,
        );

        const resultCell = run(
          resultRecipe,
          undefined,
          getDoc(undefined, { resultFor: cause }, processCell.space),
        );
        addCancel(cancels.get(resultCell));
      }

      popFrame(frame);
    };

    addCancel(addEventHandler(handler, stream));
  } else {
    // Schedule the action to run when the inputs change

    const inputsCell = getDoc(inputs, { immutable: inputs }, processCell.space);
    inputsCell.freeze(); // Freezes the bindings, not aliased cells.

    let resultCell: DocImpl<any> | undefined;

    const action: Action = (log: ReactivityLog) => {
      const argument = module.argumentSchema
        ? inputsCell.asCell([], log, module.argumentSchema).get()
        : inputsCell.getAsQueryResult([], log);

      const frame = pushFrameFromCause(
        { inputs, outputs, fn: fn.toString() },
        {
          recipe,
          materialize: (path: PropertyKey[]) =>
            processCell.getAsQueryResult(path, log),
        } satisfies UnsafeBinding,
      );
      const result = fn(argument);

      if (containsOpaqueRef(result)) {
        const resultRecipe = recipeFromFrame(
          "action result",
          undefined,
          () => result,
        );

        resultCell = run(
          resultRecipe,
          undefined,
          resultCell ??
            getDoc(
              undefined,
              { resultFor: { inputs, outputs, fn: fn.toString() } },
              processCell.space,
            ),
        );
        addCancel(cancels.get(resultCell));

        sendValueToBinding(
          processCell,
          outputs,
          { cell: resultCell, path: [] },
          log,
        );
      } else {
        sendValueToBinding(processCell, outputs, result, log);
      }

      popFrame(frame);
    };

    addCancel(schedule(action, { reads, writes } satisfies ReactivityLog));
  }
}

function instantiateRawNode(
  module: Module,
  inputBindings: JSONValue,
  outputBindings: JSONValue,
  processCell: DocImpl<any>,
  addCancel: AddCancel,
  recipe: Recipe,
) {
  if (typeof module.implementation !== "function") {
    throw new Error(
      `Raw module is not a function, got: ${module.implementation}`,
    );
  }

  // Built-ins can define their own scheduling logic, so they'll
  // implement parts of the above themselves.

  const mappedInputBindings = unwrapOneLevelAndBindtoDoc(
    inputBindings,
    processCell,
  );
  const mappedOutputBindings = unwrapOneLevelAndBindtoDoc(
    outputBindings,
    processCell,
  );

  // For `map` and future other node types that take closures, we need to
  // note the parent recipe on the closure recipes.
  unsafe_noteParentOnRecipes(recipe, mappedInputBindings);

  const inputCells = findAllAliasedDocs(mappedInputBindings, processCell);
  const outputCells = findAllAliasedDocs(mappedOutputBindings, processCell);

  const action = module.implementation(
    getDoc(
      mappedInputBindings,
      { immutable: mappedInputBindings },
      processCell.space,
    ),
    (result: any) =>
      sendValueToBinding(processCell, mappedOutputBindings, result),
    addCancel,
    inputCells, // cause
    processCell,
  );

  addCancel(schedule(action, { reads: inputCells, writes: outputCells }));
}

function instantiatePassthroughNode(
  _: Module,
  inputBindings: JSONValue,
  outputBindings: JSONValue,
  processCell: DocImpl<any>,
  addCancel: AddCancel,
) {
  const inputs = unwrapOneLevelAndBindtoDoc(inputBindings, processCell);
  const inputsCell = getDoc(inputs, { immutable: inputs }, processCell.space);
  const reads = findAllAliasedDocs(inputs, processCell);

  const outputs = unwrapOneLevelAndBindtoDoc(outputBindings, processCell);
  const writes = findAllAliasedDocs(outputs, processCell);

  const action: Action = (log: ReactivityLog) => {
    const inputsProxy = inputsCell.getAsQueryResult([], log);
    sendValueToBinding(processCell, outputBindings, inputsProxy, log);
  };

  addCancel(schedule(action, { reads, writes } satisfies ReactivityLog));
}

function instantiateRecipeNode(
  module: Module,
  inputBindings: JSONValue,
  outputBindings: JSONValue,
  processCell: DocImpl<any>,
  addCancel: AddCancel,
) {
  if (!isRecipe(module.implementation)) throw new Error(`Invalid recipe`);
  const recipe = unwrapOneLevelAndBindtoDoc(
    module.implementation,
    processCell,
  );
  const inputs = unwrapOneLevelAndBindtoDoc(inputBindings, processCell);
  const resultCell = getDoc(
    undefined,
    {
      recipe: module.implementation,
      parent: processCell,
      inputBindings,
      outputBindings,
    },
    processCell.space,
  );
  run(recipe, inputs, resultCell);
  sendValueToBinding(processCell, outputBindings, {
    cell: resultCell,
    path: [],
  });
  // TODO(seefeld): Make sure to not cancel after a recipe is elevated to a charm, e.g.
  // via navigateTo. Nothing is cancelling right now, so leaving this as TODO.
  addCancel(cancels.get(resultCell.sourceCell!));
}

const moduleWrappers = {
  handler: (fn: (event: any, ...props: any[]) => any) => (props: any) =>
    fn.bind(props)(props.$event, props),
};
