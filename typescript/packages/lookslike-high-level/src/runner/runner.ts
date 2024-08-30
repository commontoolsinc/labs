import {
  Recipe,
  RecipeFactory,
  isModule,
  isRecipe,
  isAlias,
  isStreamAlias,
} from "../builder/index.js";
import { cell, CellImpl, ReactivityLog, CellReference } from "./cell.js";
import { Action, schedule, addEventHandler } from "./scheduler.js";
import {
  extractDefaultValues,
  mapBindingsToCell,
  findAllAliasedCells,
  mergeObjects,
  sendValueToBinding,
} from "./utils.js";
import { builtins } from "./builtins/index.js";

export function run<T, R>(
  recipeFactory: RecipeFactory<T, R>,
  bindings: T
): CellImpl<R>;
export function run<T, R = any>(recipe: Recipe, bindings: T): CellImpl<R>;
export function run<T, R = any>(recipe: Recipe, bindings: T): CellImpl<R> {
  // Walk the recipe's schema and extract all default values
  const defaults = extractDefaultValues(recipe.schema);

  // Generate recipe cell using defaults, bindings, and initial values
  // TODO: Some initial values can be aliases to outside cells
  const recipeCell = cell(mergeObjects(recipe.initial, bindings, defaults));

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
          for (const ref of reads) {
            const { cell, path } = ref;
            if (isStreamAlias(cell.getAtPath(path))) {
              streamRef = ref;
              break;
            }
          }

          if (streamRef) {
            // Register as event handler for the stream. Replace alias to
            // streamref with the event.
            const handler = (event: any) => {
              const eventInputs = { ...inputs };
              for (const key in eventInputs) {
                if (
                  isAlias(eventInputs[key]) &&
                  eventInputs[key].$alias.cell === streamRef.cell &&
                  eventInputs[key].$alias.path.length ===
                    streamRef.path.length &&
                  eventInputs[key].$alias.path.every(
                    (value, index) => value === streamRef.path[index]
                  )
                ) {
                  eventInputs[key] = event;
                }
              }

              const inputsCell = cell(eventInputs);
              inputsCell.freeze(); // Freezes the bindings, not aliased cells.

              return fn(inputsCell.getAsProxy([]));
            };
            addEventHandler(handler, streamRef);
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
  handler:
    (fn: (event: any, ...props: any[]) => any) =>
    ({ $event, ...props }: any) =>
      fn($event, props),
};
