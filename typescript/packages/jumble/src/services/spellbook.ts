const TOOLSHED_API_URL = import.meta.env.TOOLSHED_API_URL || "http://localhost:8000";

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
  likes: string[];
  comments: {
    id: string;
    content: string;
    author: string;
    createdAt: string;
  }[];
  shares: number;
}

export interface LikeResponse {
  success: boolean;
  likes: string[];
  isLiked: boolean;
}

export async function listAllSpells(searchQuery?: string): Promise<Spell[]> {
  const url = new URL(`${TOOLSHED_API_URL}/api/spellbook`);
  if (searchQuery) {
    url.searchParams.set("search", searchQuery);
  }

  const response = await fetch(url.toString(), {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Failed to fetch spells");
  }

  const data = await response.json();
  return data.spells;
}

export async function getSpell(spellId: string): Promise<Spell> {
  const response = await fetch(`${TOOLSHED_API_URL}/api/spellbook/spellbook-${spellId}`, {
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

    const response = await fetch(`${TOOLSHED_API_URL}/api/spellbook`, {
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

export async function toggleLike(spellId: string): Promise<LikeResponse> {
  const response = await fetch(`${TOOLSHED_API_URL}/api/spellbook/${spellId}/like`, {
    method: "POST",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Failed to toggle like");
  }

  return response.json();
}
