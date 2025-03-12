import {
  castNewRecipe,
  Charm,
  CharmManager,
  generateNewRecipeVersion,
  getIframeRecipe,
  iterate,
} from "@commontools/charm";
import { Cell } from "@commontools/runner";
import { fixRecipePrompt } from "@/utils/prompt-library/recipe-fix.ts";

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

  const fixedCode = await fixRecipePrompt(
    iframeRecipe.iframe.spec,
    iframeRecipe.iframe.src,
    JSON.stringify(iframeRecipe.iframe.argumentSchema),
    error.message,
    model,
  );

  return generateNewRecipeVersion(
    charmManager,
    charm,
    fixedCode,
    iframeRecipe.iframe.spec,
  );
}

export async function extendCharm(
  charmManager: CharmManager,
  focusedCharmId: string,
  spec: string,
): Promise<Cell<Charm>> {
  const charm = (await charmManager.get(focusedCharmId, false))!;
  return castNewRecipe(charmManager, charm, spec);
}

export async function iterateCharm(
  charmManager: CharmManager,
  focusedCharmId: string,
  input: string,
  preferredModel?: string,
): Promise<Cell<Charm>> {
  const charm = (await charmManager.get(focusedCharmId, false))!;
  return iterate(
    charmManager,
    charm,
    input,
    false,
    preferredModel,
  );
}
