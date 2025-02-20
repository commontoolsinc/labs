import { getRecipeSpec, getRecipeSrc, getRecipeParents } from "@commontools/runner";
import { UI } from "@commontools/builder";

export interface Spell {
  id: string;
  title: string;
  description: string;
  tags: string[];
  ui: any;
  publishedAt: string;
  author: string;
  data: any;
}

export async function listAllSpells(searchQuery?: string): Promise<Spell[]> {
  if (searchQuery) {
    url.searchParams.set("search", searchQuery);
  }

  const response = await fetch("/api/spellbook", {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Failed to fetch spells");
  }

  const data = await response.json();
  return data.spells;
}

export async function getSpell(spellId: string): Promise<Spell> {
  const response = await fetch(`/api/spellbook/spellbook-${spellId}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Failed to fetch spell");
  }

  return response.json();
}

export async function saveSpell(
  spellId: string,
  spell: any,
  title: string,
  description: string,
  tags: string[],
): Promise<boolean> {
  try {
    // Get all the required data from commontools first
    const src = getRecipeSrc(spellId);
    const spec = getRecipeSpec(spellId);
    const parents = getRecipeParents(spellId);
    const ui = spell.resultRef?.cell.get()?.[UI];

    if (spellId === undefined) {
      throw new Error("Spell ID is undefined");
    }

    const response = await fetch(`/api/spellbook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        spellId,
        title,
        description,
        tags,
        src,
        spec,
        parents,
        ui,
      }),
    });

    if (!response.ok) {
      console.error("Failed to save spell:", await response.text());
      return false;
    }

    const data = await response.json();
    return data.success;
  } catch (error) {
    console.error("Failed to save spell:", error);
    return false;
  }
}
