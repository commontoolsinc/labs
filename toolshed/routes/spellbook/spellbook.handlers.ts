import type { AppRouteHandler } from "@/lib/types.ts";
import type {
  createComment,
  createSpell,
  deleteSpell,
  getSpell,
  listSpells,
  shareSpell,
  toggleLike,
  trackRun,
} from "./spellbook.routes.ts";
import { hc } from "@hono/hono/client";
import { type AppType } from "@/app.ts";
import env from "@/env.ts";

const client = hc<AppType>(env.TOOLSHED_API_URL);

interface SpellData {
  spellbookTitle?: string;
  recipeName?: string;
  spellbookDescription?: string;
  spellbookTags?: string[];
  spellbookUI?: any;
  spellbookPublishedAt?: string;
  spellbookAuthor?: string;
  parents?: string[];
  likes?: string[];
  spellbookAuthorAvatar?: string;
  runs?: number;
  comments?: {
    id: string;
    content: string;
    author: string;
    authorAvatar: string;
    createdAt: string;
  }[];
  shares?: number;
  [key: string]: any;
}

async function sha256(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return hashHex;
}

function toSpell(hash: string, blobData: SpellData) {
  return {
    id: hash.replace("spellbook-", ""),
    title: blobData.spellbookTitle || "Unnamed Spell",
    description: blobData.spellbookDescription || "",
    tags: blobData.spellbookTags || [],
    ui: blobData.spellbookUI || null,
    publishedAt: blobData.spellbookPublishedAt || "",
    author: blobData.spellbookAuthor || "anon",
    authorAvatar: blobData.spellbookAuthorAvatar || "",
    likes: blobData.likes || [],
    comments: blobData.comments || [],
    data: blobData,
    shares: blobData.shares || 0,
    runs: blobData.runs || 0,
    spell: blobData.spell,
  };
}

export const createSpellHandler: AppRouteHandler<typeof createSpell> = async (
  c,
) => {
  const logger = c.get("logger");
  const requesterProfile = {
    name: c.req.header("tailscale-user-name"),
    email: c.req.header("tailscale-user-login"),
    shortName: c.req.header("tailscale-user-login")?.split("@")[0] || "system",
    avatar: c.req.header("tailscale-user-profile-pic"),
  };

  const body = await c.req.json();

  try {
    const { spellId, spell, title, description, tags, src, spec, parents, ui } =
      body;
    const spellKey = `spellbook-${spellId}`;

    // Check if spell already exists
    const existingSpell = await client.api.storage.blobby[":key"].$get({
      param: { key: spellKey },
    });

    if (existingSpell.ok) {
      // Spell exists, increment shares
      const existingData = await existingSpell.json() as SpellData;
      const updateRes = await client.api.storage.blobby[":key"].$post({
        param: { key: spellKey },
        json: {
          ...existingData,
          shares: (existingData.shares || 0) + 1,
        },
      });

      if (!updateRes.ok) {
        logger.error("Failed to update shares:", await updateRes.text());
        return c.json({ success: false }, 500);
      }

      return c.json({ success: true });
    }

    // Create new spell
    const blobRes = await client.api.storage.blobby[":key"].$post({
      param: { key: spellKey },
      json: {
        id: spellId,
        spellbookTitle: title,
        spellbookDescription: description,
        spellbookTags: tags,
        spellbookPublishedAt: new Date().toISOString(),
        spellbookAuthor: requesterProfile.shortName || "system",
        spellbookAuthorAvatar: requesterProfile.avatar || "",
        spellbookRuns: 0,
        parents,
        src,
        spec,
        spellbookUI: ui,
        likes: [],
        comments: [],
        shares: 1,
        spell,
      },
    });

    if (!blobRes.ok) {
      logger.error("Failed to save spell to blobby:", await blobRes.text());
      return c.json({ success: false }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    logger.error(error, "Error creating spell");
    return c.json({ success: false }, 500);
  }
};

export const listSpellsHandler: AppRouteHandler<typeof listSpells> = async (
  c,
) => {
  const logger = c.get("logger");
  const searchQuery = c.req.query("search")?.toLowerCase();

  try {
    // Get all spellbook blobs with their data from blobby
    const blobsRes = await client.api.storage.blobby.$get({
      query: {
        allWithData: "true",
        prefix: "spellbook-",
        search: searchQuery,
      },
    });

    if (!blobsRes.ok) {
      throw new Error("Failed to fetch blobs from blobby");
    }

    const data = await blobsRes.json();
    const spells = Object.entries(data).map((
      [hash, blobData]: [string, SpellData],
    ) => toSpell(hash, blobData));

    return c.json({ spells });
  } catch (error) {
    logger.error(error, "Error listing spells");
    return c.json({ spells: [] }, 500);
  }
};

export const getSpellHandler: AppRouteHandler<typeof getSpell> = async (c) => {
  const logger = c.get("logger");
  const hash = c.req.param("hash");

  try {
    const response = await client.api.storage.blobby[":key"].$get({
      param: {
        key: hash,
      },
    });
    if (!response.ok) {
      return c.json({ error: "Spell not found" }, 404);
    }

    const blobData = await response.json();
    const spell = toSpell(hash, blobData);

    return c.json(spell);
  } catch (error) {
    logger.error(error, "Error getting spell");
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const toggleLikeHandler: AppRouteHandler<typeof toggleLike> = async (
  c,
) => {
  const logger = c.get("logger");
  const spellId = c.req.param("spellId");
  const requesterProfile = {
    name: c.req.header("tailscale-user-name"),
    email: c.req.header("tailscale-user-login"),
    shortName: c.req.header("tailscale-user-login")?.split("@")[0] || "system",
    avatar: c.req.header("tailscale-user-profile-pic"),
  };

  try {
    // First get the current spell data
    const getRes = await client.api.storage.blobby[":key"].$get({
      param: {
        key: `spellbook-${spellId}`,
      },
    }) as SpellData;

    if (!getRes.ok) {
      return c.json({ error: "Spell not found" }, 404);
    }

    const blobData = await getRes.json();
    const likes = new Set(blobData.likes || []);
    const wasLiked = likes.has(requesterProfile.shortName);

    // Toggle the like
    if (wasLiked) {
      likes.delete(requesterProfile.shortName);
    } else {
      likes.add(requesterProfile.shortName);
    }

    // Update the spell with new likes
    const updateRes = await client.api.storage.blobby[":key"].$post({
      param: {
        key: `spellbook-${spellId}`,
      },
      json: {
        ...blobData,
        likes: Array.from(likes),
      },
    });

    if (!updateRes.ok) {
      logger.error("Failed to update spell likes:", await updateRes.text());
      return c.json({
        success: false,
        likes: Array.from(likes),
        isLiked: wasLiked,
      }, 500);
    }

    return c.json({
      success: true,
      likes: Array.from(likes),
      isLiked: !wasLiked,
    });
  } catch (error) {
    logger.error(error, "Error toggling spell like");
    return c.json({
      success: false,
      likes: [],
      isLiked: false,
    }, 500);
  }
};

export const createCommentHandler: AppRouteHandler<typeof createComment> =
  async (c) => {
    const logger = c.get("logger");
    const spellId = c.req.param("spellId");
    const requesterProfile = {
      name: c.req.header("tailscale-user-name"),
      email: c.req.header("tailscale-user-login"),
      shortName: c.req.header("tailscale-user-login")?.split("@")[0] ||
        "system",
      avatar: c.req.header("tailscale-user-profile-pic"),
    };

    console.log(requesterProfile);

    try {
      const body = await c.req.json();
      const { content } = body;
      const createdAt = new Date().toISOString();

      // First get the current spell data
      const getRes = await client.api.storage.blobby[":key"].$get({
        param: {
          key: `spellbook-${spellId}`,
        },
      });

      if (!getRes.ok) {
        return c.json({ error: "Spell not found" }, 404);
      }

      const blobData = await getRes.json() as SpellData;
      const comments = blobData.comments || [];

      // Create the new comment
      const commentId = await sha256(
        `${requesterProfile.shortName}:${content}:${createdAt}`,
      );
      const newComment = {
        id: commentId,
        content,
        author: requesterProfile.shortName,
        authorAvatar: requesterProfile.avatar || "",
        createdAt,
      };

      // Add the new comment to the list
      comments.push(newComment);

      // Update the spell with new comments
      const updateRes = await client.api.storage.blobby[":key"].$post({
        param: {
          key: `spellbook-${spellId}`,
        },
        json: {
          ...blobData,
          comments,
        },
      });

      if (!updateRes.ok) {
        logger.error(
          "Failed to update spell comments:",
          await updateRes.text(),
        );
        return c.json({
          success: false,
          error: "Failed to save comment",
        }, 500);
      }

      return c.json({
        success: true,
        comment: newComment,
      });
    } catch (error) {
      logger.error(error, "Error creating comment");
      return c.json({
        success: false,
        error: "Internal server error",
      }, 500);
    }
  };

export const shareSpellHandler: AppRouteHandler<typeof shareSpell> = async (
  c,
) => {
  const logger = c.get("logger");
  const spellId = c.req.param("spellId");

  try {
    // First get the current spell data
    const getRes = await client.api.storage.blobby[":key"].$get({
      param: {
        key: `spellbook-${spellId}`,
      },
    });

    if (!getRes.ok) {
      return c.json({ error: "Spell not found" }, 404);
    }

    const blobData = await getRes.json() as SpellData;
    const currentShares = blobData.shares || 0;

    // Update the spell with incremented share count
    const updateRes = await client.api.storage.blobby[":key"].$post({
      param: {
        key: `spellbook-${spellId}`,
      },
      json: {
        ...blobData,
        shares: currentShares + 1,
      },
    });

    if (!updateRes.ok) {
      logger.error("Failed to update spell shares:", await updateRes.text());
      return c.json({
        success: false,
        shares: currentShares,
      }, 500);
    }

    return c.json({
      success: true,
      shares: currentShares + 1,
    });
  } catch (error) {
    logger.error(error, "Error sharing spell");
    return c.json({
      success: false,
      shares: 0,
    }, 500);
  }
};

export const trackRunHandler: AppRouteHandler<typeof trackRun> = async (c) => {
  const logger = c.get("logger");
  const spellId = c.req.param("spellId");

  try {
    // First get the current spell data
    const getRes = await client.api.storage.blobby[":key"].$get({
      param: {
        key: `spellbook-${spellId}`,
      },
    });

    if (!getRes.ok) {
      return c.json({ error: "Spell not found" }, 404);
    }

    const blobData = await getRes.json() as SpellData;
    const currentRuns = blobData.runs || 0;

    // Update the spell with incremented run count
    const updateRes = await client.api.storage.blobby[":key"].$post({
      param: {
        key: `spellbook-${spellId}`,
      },
      json: {
        ...blobData,
        runs: currentRuns + 1,
      },
    });

    if (!updateRes.ok) {
      logger.error("Failed to update spell runs:", await updateRes.text());
      return c.json({
        success: false,
        runs: currentRuns,
      }, 500);
    }

    return c.json({
      success: true,
      runs: currentRuns + 1,
    });
  } catch (error) {
    logger.error(error, "Error tracking spell run");
    return c.json({
      success: false,
      runs: 0,
    }, 500);
  }
};

export const deleteSpellHandler: AppRouteHandler<typeof deleteSpell> = async (
  c,
) => {
  console.log("deleteSpellHandler");
  const logger = c.get("logger");
  const spellId = c.req.param("spellId");

  try {
    // Delete the spellbook blob
    const deleteRes = await client.api.storage.blobby[":key"].$delete({
      param: {
        key: `spellbook-${spellId}`,
      },
    });

    console.log("wat", deleteRes);

    if (!deleteRes.ok) {
      if (deleteRes.status === 404) {
        return c.json({ error: "Spell not found" }, 404);
      }
      logger.error("Failed to delete spell:", spellId);
      return c.json({ success: false }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    logger.error(error, "Error deleting spell");
    return c.json({ success: false }, 500);
  }
};
