import type { AppRouteHandler } from "@/lib/types.ts";
import type { createSpell, getSpell, listSpells } from "./spellbook.routes.ts";
import { hc } from "hono/client";
import { type AppType } from "@/app.ts";
import env from "@/env.ts";

const client = hc<AppType>("http://localhost:8000");

export const createSpellHandler: AppRouteHandler<typeof createSpell> = async (
  c,
) => {
  const logger = c.get("logger");
  const body = await c.req.json();

  try {
    const { spellId, title, description, tags, src, spec, parents, ui } = body;

    // Save to blobby with spellbook- prefix
    const blobRes = await client.api.storage.blobby[":key"].$post({
      param: {
        key: `spellbook-${spellId}`,
      },
      json: {
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
      },
    });

    if (!blobRes.ok) {
      logger.error("Failed to save spell to blobby:", await blobRes.text());
      return c.json({ success: false }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    logger.error({ error }, "Error creating spell");
    return c.json({ success: false }, 500);
  }
};

export const listSpellsHandler: AppRouteHandler<typeof listSpells> = async (
  c,
) => {
  const logger = c.get("logger");
  const searchQuery = c.req.query("search")?.toLowerCase();

  try {
    // Get all spellbook blobs from blobby
    const blobsRes = await client.api.storage.blobby.$get({
      query: {
        all: true,
        prefix: "spellbook-",
      },
    });

    if (!blobsRes.ok) {
      throw new Error("Failed to fetch blobs from blobby");
    }

    const data = await blobsRes.json();
    const hashes = data.blobs as string[];

    // Fetch each spell's data
    const spellPromises = hashes.map(async (hash) => {
      const blobRes = await client.api.storage.blobby[":key"].$get({
        param: {
          key: hash,
        },
      });
      if (!blobRes.ok) return null;

      const blobData = await blobRes.json();
      const spell = {
        hash,
        title: blobData.spellbookTitle || blobData.recipeName ||
          "Unnamed Spell",
        description: blobData.spellbookDescription || "",
        tags: blobData.spellbookTags || [],
        ui: blobData.spellbookUI || null,
        publishedAt: blobData.spellbookPublishedAt || "",
        author: blobData.spellbookAuthor || "Anonymous",
        data: blobData,
      };

      // Apply search filter if query exists
      if (searchQuery) {
        const matchesSearch = spell.title.toLowerCase().includes(searchQuery) ||
          spell.description.toLowerCase().includes(searchQuery) ||
          spell.tags.some((tag: string) =>
            tag.toLowerCase().includes(searchQuery)
          );

        return matchesSearch ? spell : null;
      }

      return spell;
    });

    const spells = (await Promise.all(spellPromises))
      .filter((spell): spell is NonNullable<typeof spell> => spell !== null);

    return c.json({ spells });
  } catch (error) {
    logger.error({ error }, "Error listing spells");
    return c.json({ error: "Internal server error" }, 500);
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
    const spell = {
      hash,
      title: blobData.spellbookTitle || blobData.recipeName || "Unnamed Spell",
      description: blobData.spellbookDescription || "",
      tags: blobData.spellbookTags || [],
      ui: blobData.spellbookUI || null,
      publishedAt: blobData.spellbookPublishedAt || "",
      author: blobData.spellbookAuthor || "Anonymous",
      data: blobData,
    };

    return c.json(spell);
  } catch (error) {
    logger.error({ error }, "Error getting spell");
    return c.json({ error: "Internal server error" }, 500);
  }
};
