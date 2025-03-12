import {
  castNewRecipe,
  Charm,
  CharmManager,
  generateNewRecipeVersion,
  getIframeRecipe,
  iterate,
} from "@commontools/charm";
import { Cell } from "@commontools/runner";

import { charmId } from "@/utils/charms.ts";
import { fixRecipePrompt } from "@/utils/prompt-library/recipe-fix.ts";
import { createPath } from "@/routes.ts";

export async function fixItCharm(
  charmManager: CharmManager,
  charm: Cell<Charm>,
  error: Error,
  model = "anthropic:claude-3-7-sonnet-20250219-thinking",
): Promise<string> {
  const iframeRecipe = getIframeRecipe(charm);
  if (!iframeRecipe.iframe) {
    throw new Error("No iframe recipe found in charm");
  }

  const fixedCode = (await fixRecipePrompt(
    iframeRecipe.iframe.spec,
    iframeRecipe.iframe.src,
    JSON.stringify(iframeRecipe.iframe.argumentSchema),
    error.message,
    model,
  ))!;

  const newCharm = await generateNewRecipeVersion(
    charmManager,
    charm,
    fixedCode,
    iframeRecipe.iframe.spec,
  );
  const newCharmId = charmId(newCharm)!;
  console.log("new charm id", newCharmId);
  return newCharmId;
}

export async function extendCharm(
  charmManager: CharmManager,
  focusedCharmId: string,
  focusedReplicaId: string,
  spec: string,
): Promise<string> {
  const charm = (await charmManager.get(focusedCharmId, false))!;
  const newCharm = await castNewRecipe(charmManager, charm, spec);
  const id = charmId(newCharm)!;
  console.log("NEW CHARM ID", id);
  return createPath("charmShow", {
    charmId: id,
    replicaName: focusedReplicaId,
  })!;
}

export async function iterateCharm(
  charmManager: CharmManager,
  focusedCharmId: string,
  focusedReplicaId: string,
  input: string,
  preferredModel?: string,
): Promise<string | undefined> {
  try {
    const charm = (await charmManager.get(focusedCharmId, false))!;
    const newCharm = await iterate(
      charmManager,
      charm,
      input,
      false,
      preferredModel,
    );
    const id = charmId(newCharm)!;
    return createPath("charmShow", {
      charmId: id,
      replicaName: focusedReplicaId,
    });
  } catch (error) {
    console.groupEnd();
    console.error("Edit recipe error:", error);
  }
}
