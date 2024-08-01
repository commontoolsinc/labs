import { Recipe, isModule, isRecipe, isAlias } from "../builder/index.js";
import { cell, CellImpl, ReactivityLog } from "./cell.js";
import { Action, schedule } from "./scheduler.js";
import {
  extractDefaultValues,
  mapBindingsToCell,
  findAllAliasedCells,
  mergeObjects,
  sendValueToBinding,
} from "./utils.js";

export function runRecipe<T>(recipe: Recipe, bindings: T): CellImpl<T> {
  // Walk the recipe's schema and extract all default values
  const defaults = extractDefaultValues(recipe.schema);

  // Generate recipe cell using defaults, bindings, and initial values
  // TODO: Some initial values can be aliases to outside cells
  const recipeCell = cell(mergeObjects(defaults, bindings, recipe.initial));

  console.log(recipeCell.get());

  for (const node of recipe.nodes) {
    if (isModule(node.module)) {
      switch (node.module.type) {
        case "javascript": {
          const inputs = mapBindingsToCell(node.inputs, recipeCell);
          const inputsCell = cell(inputs);
          inputsCell.freeze(); // Freezes the bindings, not aliased cells.
          // TODO: This isn't correct, as module can write into passed cells. We
          // should look at the schema to find out what cells are read and
          // written.
          const reads = findAllAliasedCells(inputs);

          const outputs = mapBindingsToCell(node.outputs, recipeCell);
          const writes = findAllAliasedCells(outputs);

          const fn = (
            typeof node.module.implementation === "string"
              ? eval(node.module.implementation)
              : node.module.implementation
          ) as (inputs: any) => any;

          const action: Action = (log: ReactivityLog) => {
            const inputsProxy = inputsCell.getAsProxy([], log);
            const result = fn(inputsProxy);
            sendValueToBinding(recipeCell, outputs, result, log);
          };

          schedule(action, { reads, writes } satisfies ReactivityLog);
          break;
        }
        case "passthrough": {
          const inputs = mapBindingsToCell(node.inputs, recipeCell);
          const reads = findAllAliasedCells(inputs);

          const outputs = mapBindingsToCell(node.outputs, recipeCell);
          const writes = findAllAliasedCells(outputs);

          const action: Action = (log: ReactivityLog) => {
            sendValueToBinding(recipeCell, node.outputs, node.inputs, log);
          };

          schedule(action, { reads, writes } satisfies ReactivityLog);
          break;
        }
        case "recipe": {
          if (!isRecipe(node.module.implementation))
            throw new Error(`Invalid recipe`);
          const inputs = mapBindingsToCell(
            mergeObjects(node.inputs, node.outputs),
            recipeCell
          );
          runRecipe(node.module.implementation, inputs);
          break;
        }
      }
    } else if (isAlias(node.module)) {
      // TODO: Implement
    } else {
      throw new Error(`Unknown module type: ${node.module}`);
    }
  }

  return recipeCell;
}
