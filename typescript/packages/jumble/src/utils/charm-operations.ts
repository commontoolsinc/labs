import {
  iterate,
  CharmManager,
  Charm,
  getIframeRecipe,
  saveNewRecipeVersion,
} from "@commontools/charm";
import { EntityId } from "@commontools/runner";

import { charmId } from "@/utils/charms";
import { fixSpell } from "@/utils/prompt-library/spell-fix";

export async function fixItCharm(
  charmManager: CharmManager,
  charm: Charm,
  error: Error,
  model = "anthropic:claude-3-5-sonnet-latest",
): Promise<string | null> {
  const iframeRecipe = getIframeRecipe(charm);
  if (!iframeRecipe?.iframe) {
    throw new Error("No iframe recipe found in charm");
  }

  const fixedCode = await fixSpell(
    iframeRecipe.iframe.spec,
    iframeRecipe.iframe.src,
    JSON.stringify(iframeRecipe.iframe.argumentSchema),
    error.message,
    model,
  );
  if (!fixedCode) {
    throw new Error("Could not extract fixed code from LLM response");
  }

  const newRecipe = await saveNewRecipeVersion(
    charmManager,
    charm,
    fixedCode,
    iframeRecipe.iframe.spec,
  );
  const newRecipeId = charmId(newRecipe as EntityId);

  console.log("new recipe", newRecipeId);
  return newRecipeId;
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
