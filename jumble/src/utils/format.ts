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
) {
  const payload = await parseComposerDocument(
    prompt,
    charmManager,
  );

  // Check if there are any sources before adding the sources section
  const hasSources = payload.sources && Object.keys(payload.sources).length > 0;

  let finalText = payload.text;

  // Only add sources section if there are actual sources
  if (hasSources) {
    finalText += `\n\n<sources>
    ${
      Object.entries(payload.sources).map(([id, source]) =>
        `<source id="${id}">
    ${`<title>${source.name || "Untitled"}</title>
    ${source.cell ? formatCell(source.cell) : ""}
    ${source.recipe ? formatRecipe(source.recipe) : ""}
    </source>`}`
      ).join("\n")
    }
    </sources>`;
  }

  return finalText;
}
