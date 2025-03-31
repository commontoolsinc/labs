import { CharmManager, charmSchema } from "@commontools/charm";
import { Cell } from "@commontools/runner";
import { Module, NAME, Recipe } from "@commontools/builder";
import { parseComposerDocument } from "@/components/Composer.tsx";

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

export async function formatPromptWithMentions(
  prompt: string,
  charmManager: CharmManager,
): Promise<{ text: string; sources: Record<string, any> }> {
  const payload = await parseComposerDocument(
    prompt,
    charmManager,
  );

  // Create a mapping of IDs to source objects
  const sourcesMap: Record<string, any> = {};

  // Process the text to inject IDs where mentions are
  let processedText = payload.text;

  // Check if there are any sources to process
  if (payload.sources && Object.keys(payload.sources).length > 0) {
    // Add each source to the map
    Object.entries(payload.sources).forEach(([id, source]) => {
      const shadowId = getCharmNameAsCamelCase(source.cell, sourcesMap);
      sourcesMap[shadowId] = source;

      // Replace the markdown link mention with the ID
      // Format: [character](charm://id)
      processedText = processedText.replace(
        new RegExp(`\\[(.*?)\\]\\(charm://${id}\\)`, "g"),
        `\`${shadowId}\``,
      );
    });
  }

  return {
    text: processedText,
    sources: sourcesMap,
  };
}

export function getCharmNameAsCamelCase(
  cell: Cell<any>,
  usedKeys: Record<string, any>,
): string {
  const charmName = toCamelCase(cell.asSchema(charmSchema).key(NAME).get());

  let name = charmName;
  let num = 0;

  while (name in usedKeys) name = charmName + `${++num}`;

  return name;
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
function toCamelCase(input: string): string {
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

// Use Record for the dynamic properties and intersection for the fixed properties
export type SourceSet = Record<string, { name: string; cell: Cell<any> } | string | undefined> & {
  __previewSpec?: string;
  __previewPlan?: string;
};

export function grabCells(sources?: SourceSet) {
  const cells: { [id: string]: Cell<any> } = sources
    ? Object.entries(sources).reduce((acc, [id, source]) => {
      // Skip special fields like __previewSpec and __previewPlan
      // Also skip string values which are not source cells
      if (id.startsWith("__") || typeof source === "string") {
        return acc;
      }
      acc[id] = (source as { name: string; cell: Cell<any> }).cell;
      return acc;
    }, {} as { [id: string]: Cell<any> })
    : {};
  return cells;
}
