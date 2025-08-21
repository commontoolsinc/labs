import { UI } from "@commontools/runner";
import type { Runtime } from "@commontools/runner";
import { isRecord } from "@commontools/utils/types";

export interface Spell {
  id: string;
  title: string;
  description: string;
  author: string;
  tags: string[];
  ui: unknown;
  data: unknown;
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
    url += `?search=${encodeURIComponent(searchQuery)}`;
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
  spell: unknown,
  title: string,
  description: string,
  tags: string[],
  runtime: Runtime,
): Promise<boolean> {
  try {
    // Get all the required data from commontools first
    const recipeMetaResult = runtime.recipeManager.getRecipeMeta(spell);
    const { src, spec, parents } = recipeMetaResult || {};
    if (!isRecord(spell)) {
      throw new Error("Invalid spell.");
    }
    const ui = ("resultRef" in spell && isRecord(spell.resultRef))
      ? spell.resultRef[UI]
      : undefined;

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

export async function createComment(
  spellId: string,
  content: string,
): Promise<Comment> {
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

export async function deleteSpell(spellId: string): Promise<boolean> {
  const response = await fetch(`/api/spellbook/${spellId}`, {
    method: "DELETE",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Failed to delete spell");
  }

  const data = await response.json();
  return data.success;
}
