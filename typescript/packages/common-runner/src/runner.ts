import {
  ID,
  TYPE,
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
        { cell: ref.cell, path: [...ref.path, key] },
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
    if (isModule(node.module)) {
      switch (node.module.type) {
        case "javascript": {
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
            typeof node.module.implementation === "string"
              ? eval(node.module.implementation)
              : node.module.implementation
          ) as (inputs: any) => any;

          if (node.module.wrapper && node.module.wrapper in moduleWrappers)
            fn = moduleWrappers[node.module.wrapper](fn);

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
                    (value: PropertyKey, index: number) =>
                      value === stream.path[index]
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

          break;
        }
        case "builtin": {
          // TODO: Factor out javascript and passthrough types to built-ins.
          // Then rationalize "node.type" vs the builtin type.
          if (typeof node.module.implementation !== "string")
            throw new Error(`Builtin is not a string`);
          if (!(node.module.implementation in builtins))
            throw new Error(`Unknown builtin: ${node.module.implementation}`);

          // Built-ins can define their own scheduling logic, so they'll
          // implement parts of the above themselves.
          builtins[node.module.implementation](recipeCell, node);
          break;
        }
        case "passthrough": {
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
          break;
        }
        case "isolated": {
          const inputs = mapBindingsToCell(node.inputs, recipeCell);
          const reads = findAllAliasedCells(inputs, recipeCell);
          const inputsCell = cell(inputs);
          inputsCell.freeze();

          const outputs = mapBindingsToCell(node.outputs, recipeCell);
          const writes = findAllAliasedCells(outputs, recipeCell);

          if (!isJavaScriptModuleDefinition(node.module.implementation))
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
            const fnOutput = await fn.run(
              inputsProxy as unknown as JavaScriptValueMap
            );

            const result: any = Object.fromEntries(
              Object.entries(fnOutput).map(([key, value]) => [key, value.val])
            );

            sendValueToBinding(recipeCell, node.outputs, result, log);
          };

          schedule(action, { reads, writes } satisfies ReactivityLog);
          break;
        }
        case "recipe": {
          if (!isRecipe(node.module.implementation))
            throw new Error(`Invalid recipe`);
          const inputs = mapBindingsToCell(node.inputs, recipeCell);
          const result = run(node.module.implementation, inputs);
          if (isAlias(node.outputs))
            sendValueToBinding(recipeCell, node.outputs, result);
          else
            result.sink((value) =>
              sendValueToBinding(recipeCell, node.outputs, value)
            );
          break;
        }
      }
    } else if (isAlias(node.module)) {
      // TODO: Implement, a dynamic node
    } else {
      throw new Error(`Unknown module type: ${node.module}`);
    }
  }

  return recipeCell;
}

const moduleWrappers = {
  handler: (fn: (event: any, ...props: any[]) => any) => (props: any) =>
    fn(props.$event, props),
};
