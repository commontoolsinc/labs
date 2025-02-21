import { getRecipeSpec, getRecipeSrc, getRecipeParents } from "@commontools/runner";
import { UI } from "@commontools/builder";

export interface Spell {
  id: string;
  title: string;
  description: string;
  author: string;
  tags: string[];
  ui: any;
  data: any;
  likes: string[];
  shares: number;
  runs: number;
  comments: Comment[];
}

export interface LikeResponse {
  success: boolean;
  likes: string[];
  isLiked: boolean;
}

export interface Comment {
  id: string;
  content: string;
  author: string;
  authorAvatar: string;
  createdAt: string;
}

export interface CommentResponse {
  success: boolean;
  comment: Comment;
}

export interface UserProfile {
  name: string | null;
  email: string | null;
  shortName: string;
  avatar: string | null;
}

export interface ShareResponse {
  success: boolean;
  shares: number;
}

export interface RunResponse {
  runs: number;
}

export async function listAllSpells(searchQuery?: string): Promise<Spell[]> {
  let url = `/api/spellbook`;
  if (searchQuery) {
    url += `?search=${searchQuery}`;
  }

  const response = await fetch(url, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Failed to fetch spells");
  }

  const data = await response.json();
  return data.spells;
}

export async function getSpellbookBlob(spellId: string): Promise<Spell> {
  const response = await fetch(`/api/spellbook/spellbook-${spellId}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Failed to fetch spell");
  }

  return response.json();
}

export async function getSpellBlob(spellId: string): Promise<object> {
  const response = await fetch(`/api/storage/blobby/spell-${spellId}`, {
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
        spell,
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
  const response = await fetch(`/api/spellbook/${spellId}/like`, {
    method: "POST",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Failed to toggle like");
  }

  return response.json();
}

export async function createComment(spellId: string, content: string): Promise<Comment> {
  const response = await fetch(`/api/spellbook/${spellId}/comment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Failed to create comment");
  }

  const data = await response.json();
  return data.comment;
}

// FIXME(jake): this should be moved to a separate service
export async function whoami(): Promise<UserProfile> {
  const response = await fetch(`/api/whoami`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Failed to get user profile");
  }

  return response.json();
}

export async function shareSpell(spellId: string): Promise<ShareResponse> {
  const response = await fetch(`/api/spellbook/${spellId}/share`, {
    method: "POST",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Failed to share spell");
  }

  return response.json();
}

export async function trackRun(spellId: string): Promise<RunResponse> {
  const response = await fetch(`/api/spellbook/${spellId}/run`, {
    method: "POST",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error("Failed to track spell run");
  }

  return response.json();
}
