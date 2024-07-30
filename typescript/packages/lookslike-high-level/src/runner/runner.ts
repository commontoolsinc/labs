import { Recipe, isModule, isRecipe, isReference } from "../builder/index.js";
import { cell, CellReference, CellImpl } from "./cell.js";

export function runRecipe<T>(recipe: Recipe, bindings: T): CellImpl<T> {
  // Walk the recipe's schema and extract all default values
  const defaults = extractDefaultValues(recipe.schema);

  // Generate recipe cell using defaults, bindings, and initial values
  // TODO: Some initial values can be references to outside cells
  const recipeCell = cell(mergeObjects(defaults, bindings, recipe.initial));

  console.log(recipeCell.get());

  for (const node of recipe.nodes) {
    if (isModule(node.module)) {
      switch (node.module.type) {
        case "javascript":
          //node.module.implementation(recipeCell);
          break;
        case "passthrough":
          sendValueToBinding(recipeCell, node.outputs, node.inputs);
          break;
        case "recipe":
          if (!isRecipe(node.module.implementation))
            throw new Error(`Invalid recipe`);
          const inputs = mapBindingsToCell(
            mergeObjects(node.inputs, node.outputs),
            recipeCell
          );
          runRecipe(node.module.implementation, inputs);
          break;
      }
    } else if (isReference(node.module)) {
      // TODO: Implement
    } else if (node.module === "static") {
      // Assign inputs to outputs. Since this is called after input cells are
      // assigned, this can include references to those cells.
      sendValueToBinding(recipeCell, node.outputs, node.inputs);
    } else {
      throw new Error(`Unknown module type: ${node.module}`);
    }
  }

  return recipeCell;
}

export function extractDefaultValues(schema: any): any {
  if (typeof schema !== "object" || schema === null) return undefined;

  if (schema.type === "object") {
    const obj: any = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "properties" && typeof value === "object" && value !== null) {
        for (const [propKey, propValue] of Object.entries(value)) {
          const value = extractDefaultValues(propValue);
          if (value !== undefined) obj[propKey] = value;
        }
      }
    }

    return Object.entries(obj).length > 0 ? obj : undefined;
  }

  return schema.default;
}

// Merges objects into a single object, preferring values from later objects.
// Recursively calls itself for nested objects, passing on any objects that
// matching properties.
export function mergeObjects(...objects: any[]): any {
  objects = objects.filter((obj) => obj !== undefined);
  if (objects.length === 0) return undefined;
  if (objects.length === 1) return objects[0];

  const seen = new Set<PropertyKey>();
  const result: any = {};

  for (const obj of objects) {
    // If we have a literal value, return it. Same for arrays, since we wouldn't
    // know how to merge them. Note that earlier objects take precedence, so if
    // an earlier was e.g. an object, we'll return that instead of the literal.
    if (typeof obj !== "object" || obj === null || Array.isArray(obj))
      return obj;

    // Then merge objects, only passing those on that have any values.
    for (const key of Object.keys(obj)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const merged = mergeObjects(...objects.map((obj) => obj[key]));
      if (merged !== undefined) result[key] = merged;
    }
  }

  return result;
}

// Sends a value to a binding. If the binding is an array or object, it'll
// traverse the binding and the valye in parallel accordingly. If the binding is
// a reference, it will send the value to the referenced cell. If the binding is
// a literal, we verify that it matches the value and throw an error otherwise.
export function sendValueToBinding(
  cell: CellImpl<any>,
  binding: any,
  value: any
) {
  if (isReference(binding)) {
    cell.setAtPath(binding.$ref.path, value);
  } else if (Array.isArray(binding)) {
    if (Array.isArray(value))
      for (let i = 0; i < Math.min(binding.length, value.length); i++)
        sendValueToBinding(cell, binding[i], value[i]);
  } else if (typeof binding === "object" && binding !== null) {
    for (const key of Object.keys(binding))
      if (key in value) sendValueToBinding(cell, binding[key], value[key]);
  } else {
    if (binding !== value)
      throw new Error(`Got ${value} instead of ${binding}`);
  }
}

export function mapBindingsToCell<T>(binding: T, cell: CellImpl<any>): T {
  function convert(binding: any): any {
    if (isReference(binding))
      return {
        $ref: { ...binding.$ref, cell },
      };
    if (Array.isArray(binding)) return binding.map(convert);
    if (typeof binding === "object" && binding !== null)
      return Object.fromEntries(
        Object.entries(binding).map(([key, value]) => [key, convert(value)])
      );
    return binding;
  }
  return convert(binding) as T;
}
