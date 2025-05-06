import { Cell } from "@commontools/runner";
import { Module, NAME, Recipe } from "@commontools/builder";

export function formatCell(
  cell: Cell<any & { argument: any; resultRef?: any }>,
) {
  if (!cell || !cell.get().argument) return null;

  try {
    const cellData = cell.get();
    let content = "";

    // Format argument
    if (cellData.argument) {
      const argStr = typeof cellData.argument === "string"
        ? cellData.argument
        : JSON.stringify(cellData.argument);
      content += `<argument>${argStr}</argument>`;
    }

    // Format resultRef if present
    if (cellData.resultRef) {
      const resultStr = typeof cellData.resultRef === "string"
        ? cellData.resultRef
        : JSON.stringify(cellData.resultRef);
      content += `<resultRef>${resultStr}</resultRef>`;
    }

    // Wrap in cell tag
    return `<cell>${content}</cell>`;
  } catch (e) {
    console.error("Failed to format cell:", e);
    return null;
  }
}

export function formatRecipe(recipe: Recipe | Module) {
  if (!recipe) return null;

  try {
    const recipeStr = typeof recipe === "string"
      ? recipe
      : JSON.stringify(recipe);
    return `<recipe>${recipeStr}</recipe>`;
  } catch (e) {
    console.error("Failed to format recipe:", e);
    return null;
  }
}

/**
 * Converts a string of multiple words into camelCase format
 * @param input - The string to convert
 * @returns The camelCased string
 *
 * Examples:
 * - "hello world" -> "helloWorld"
 * - "The quick brown FOX" -> "theQuickBrownFox"
 * - "this-is-a-test" -> "thisIsATest"
 * - "already_camel_case" -> "alreadyCamelCase"
 */
export function toCamelCase(input: string): string {
  // Handle empty string case
  if (!input) return "";

  // Split the input string by non-alphanumeric characters
  return input
    .split(/[^a-zA-Z0-9]/)
    .filter((word) => word.length > 0) // Remove empty strings
    .map((word, index) => {
      // First word should be all lowercase
      if (index === 0) {
        return word.toLowerCase();
      }
      // Other words should have their first letter capitalized and the rest lowercase
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join("");
}

export type SourceSet = { [id: string]: { name: string; cell: Cell<any> } };

export function grabCells(sources?: SourceSet) {
  const cells: { [id: string]: Cell<any> } = sources
    ? Object.entries(sources).reduce((acc, [id, source]) => {
      acc[id] = source.cell;
      return acc;
    }, {} as { [id: string]: Cell<any> })
    : {};
  return cells;
}
