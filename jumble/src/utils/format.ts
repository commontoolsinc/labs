import { CharmManager } from "@commontools/charm";
import { Cell } from "@commontools/runner";
import { Module, Recipe } from "@commontools/builder";
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
      sourcesMap[id] = source;

      // Replace the markdown link mention with the ID
      // Format: [character](charm://id)
      processedText = processedText.replace(
        new RegExp(`\\[(.*?)\\]\\(charm://${id}\\)`, "g"),
        `\`${id}\``,
      );
    });
  }

  return {
    text: processedText,
    sources: sourcesMap,
  };
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
