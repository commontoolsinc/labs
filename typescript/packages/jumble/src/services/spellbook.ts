const TOOLSHED_API_URL = import.meta.env.TOOLSHED_API_URL || "http://localhost:8000";
const BLOBBY_BASE_URL = `${TOOLSHED_API_URL}/api/storage/blobby`;

import { getRecipeSpec, getRecipeSrc, getRecipeParents } from "@commontools/runner";
import { UI } from "@commontools/builder";

export async function saveSpell(
  spellId: string,
  spell: any,
  title: string,
  description: string,
  tags: string[],
): Promise<boolean> {
  const src = getRecipeSrc(spellId);
  const spec = getRecipeSpec(spellId);
  const parents = getRecipeParents(spellId);
  const ui = spell.resultRef?.cell.get()?.[UI];
  try {
    const blob = {
      spellbookTitle: title,
      spellbookDescription: description,
      spellbookTags: tags,
      spellbookPublishedAt: new Date().toISOString(),
      spellbookAuthor: "jake", // FIXME(jake): once we have api, we can populate author from tailscale headers
      spellId,
      parents,
      src,
      spec,
      spellbookUI: ui,
    };

    console.log(blob);

    if (spellId === undefined) {
      throw new Error("Spell ID is undefined");
    }

    const response = await fetch(`${BLOBBY_BASE_URL}/spellbook-${spellId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(blob),
    });

    if (!response.ok) {
      console.error("Failed to save spell:", await response.text());
    }

    return response.ok;
  } catch (error) {
    console.error("Failed to save spell:", error);
    return false;
  }
}
