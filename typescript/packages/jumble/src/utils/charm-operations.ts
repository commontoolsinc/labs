import {
  Charm,
  CharmManager,
  getIframeRecipe,
  iterate,
  saveNewRecipeVersion,
} from "@commontools/charm";
import { Cell, EntityId } from "@commontools/runner";

import { charmId } from "@/utils/charms";
import { fixRecipePrompt } from "@/utils/prompt-library/recipe-fix";

export async function fixItCharm(
  charmManager: CharmManager,
  charm: Cell<Charm>,
  error: Error,
  model = "anthropic:claude-3-7-sonnet-20250219-thinking",
): Promise<string | undefined> {
  const iframeRecipe = getIframeRecipe(charm);
  if (!iframeRecipe?.iframe) {
    throw new Error("No iframe recipe found in charm");
  }

  const fixedCode = await fixRecipePrompt(
    iframeRecipe.iframe.spec,
    iframeRecipe.iframe.src,
    JSON.stringify(iframeRecipe.iframe.argumentSchema),
    error.message,
    model,
  );
  if (!fixedCode) {
    throw new Error("Could not extract fixed code from LLM response");
  }

  const newCharm = await saveNewRecipeVersion(
    charmManager,
    charm,
    fixedCode,
    iframeRecipe.iframe.spec,
  );
  const newCharmId = charmId(newCharm as EntityId);

  console.log("new charm id", newCharmId);
  return newCharmId;
}

export async function iterateCharm(
  charmManager: CharmManager,
  focusedCharmId: string,
  focusedReplicaId: string,
  input: string,
  variants: boolean,
  preferredModel?: string,
): Promise<string | undefined> {
  try {
    console.log("Performing iteration");
    console.log("Focused Charm ID", focusedCharmId);
    console.log("Focused Replica ID", focusedReplicaId);
    console.log("Input", input);
    console.log("Variants", variants);
    console.log("Preferred Model", preferredModel);
    const charm = await charmManager.get(focusedCharmId);
    console.log("CHARM", charm);
    const newCharmId = await iterate(charmManager, charm ?? null, input, false, preferredModel);
    console.log("NEW CHARM ID", newCharmId);
    if (!newCharmId) return;
    return `/${focusedReplicaId}/${charmId(newCharmId)}`;
  } catch (error) {
    console.error("Edit recipe error:", error);
  }
}
