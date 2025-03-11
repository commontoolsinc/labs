import {
  Charm,
  CharmManager,
  extend,
  getIframeRecipe,
  iterate,
  saveNewRecipeVersion,
} from "@commontools/charm";
import { Cell, EntityId } from "@commontools/runner";

import { charmId } from "@/utils/charms.ts";
import { fixRecipePrompt } from "@/utils/prompt-library/recipe-fix.ts";
import { createPath } from "@/routes.ts";

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

export async function extendCharm(
  charmManager: CharmManager,
  focusedCharmId: string,
  focusedReplicaId: string,
  input: string,
  variants: boolean = false,
  preferredModel?: string,
): Promise<string | undefined> {
  try {
    console.group("Extending Charm");
    console.log("Performing extension");
    console.log("Focused Charm ID", focusedCharmId);
    console.log("Focused Replica ID", focusedReplicaId);
    console.log("Input", input);
    console.log("Variants", variants);
    console.log("Preferred Model", preferredModel);
    const charm = await charmManager.get(focusedCharmId);
    console.log("CHARM", charm);
    const newCharmId = await extend(
      charmManager,
      charm ?? null,
      input,
      preferredModel,
    );
    if (!newCharmId) {
      throw new Error("No new charm ID found after extend()");
    }
    console.log("NEW CHARM ID", newCharmId);
    console.groupEnd();
    const id = charmId(newCharmId);
    if (!id) {
      throw new Error("Invalid charm ID");
    }
    return createPath("charmShow", {
      charmId: id,
      replicaName: focusedReplicaId,
    });
  } catch (error) {
    console.groupEnd();
    console.error("Extend recipe error:", error);
  }
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
    console.group("Iterating Charm");
    console.log("Performing iteration");
    console.log("Focused Charm ID", focusedCharmId);
    console.log("Focused Replica ID", focusedReplicaId);
    console.log("Input", input);
    console.log("Variants", variants);
    console.log("Preferred Model", preferredModel);
    const charm = await charmManager.get(focusedCharmId);
    console.log("CHARM", charm);
    const newCharmId = await iterate(
      charmManager,
      charm ?? null,
      input,
      variants,
      preferredModel,
    );
    if (!newCharmId) {
      throw new Error("No new charm ID found after iterate()");
    }
    console.log("NEW CHARM ID", newCharmId);
    console.groupEnd();
    const id = charmId(newCharmId);
    if (!id) {
      throw new Error("Invalid charm ID");
    }
    return createPath("charmShow", {
      charmId: id,
      replicaName: focusedReplicaId,
    });
  } catch (error) {
    console.groupEnd();
    console.error("Edit recipe error:", error);
  }
}
