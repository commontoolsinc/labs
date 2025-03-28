import { fixRecipePrompt } from "@commontools/llm";
import { Cell, getRecipe } from "@commontools/runner";
import { Charm, CharmManager } from "./charm.ts";
import { getIframeRecipe } from "./iframe/recipe.ts";
import { extractUserCode, injectUserCode } from "./iframe/static.ts";
import { compileAndRunRecipe, generateNewRecipeVersion } from "./iterate.ts";
import { NAME } from "@commontools/builder";

export const castSpellAsCharm = async (
  charmManager: CharmManager,
  recipeKey: string,
  argument: Cell<any>,
) => {
  if (recipeKey && argument) {
    console.log("Syncing...");
    const recipeId = recipeKey.replace("spell-", "");
    await charmManager.syncRecipeBlobby(recipeId);

    const recipe = getRecipe(recipeId);
    if (!recipe) return;

    console.log("Casting...");
    const charm: Cell<Charm> = await charmManager.runPersistent(
      recipe,
      argument,
    );
    return charm;
  }
  console.log("Failed to cast");
  return null;
};

export async function fixItCharm(
  charmManager: CharmManager,
  charm: Cell<Charm>,
  error: Error,
  model = "anthropic:claude-3-7-sonnet-20250219-thinking",
): Promise<Cell<Charm>> {
  const iframeRecipe = getIframeRecipe(charm);
  if (!iframeRecipe.iframe) {
    throw new Error("Fixit only works for iframe charms");
  }

  // Extract just the user code portion instead of using the full source
  const userCode = extractUserCode(iframeRecipe.iframe.src);
  if (!userCode) {
    throw new Error("Could not extract user code from iframe source");
  }

  const fixedUserCode = await fixRecipePrompt(
    iframeRecipe.iframe.spec,
    userCode, // Send only the user code portion
    JSON.stringify(iframeRecipe.iframe.argumentSchema),
    error.message,
    model,
  );

  // Inject the fixed user code back into the template
  const fixedFullCode = injectUserCode(fixedUserCode);

  return generateNewRecipeVersion(
    charmManager,
    charm,
    fixedFullCode,
    iframeRecipe.iframe.spec,
  );
}

export async function renameCharm(
  charmManager: CharmManager,
  charmId: string,
  newName: string,
): Promise<void> {
  const charm = await charmManager.get(charmId);
  if (!charm) return;
  charm.key(NAME).set(newName);
}

export async function addGithubRecipe(
  charmManager: CharmManager,
  filename: string,
  spec: string,
  runOptions: any,
): Promise<Cell<Charm>> {
  const response = await fetch(
    `https://raw.githubusercontent.com/commontoolsinc/labs/refs/heads/main/recipes/${filename}?${Date.now()}`,
  );
  const src = await response.text();
  return await compileAndRunRecipe(
    charmManager,
    src,
    spec,
    runOptions,
  );
}
