import type { AppRouteHandler } from "@/lib/types.ts";
import type {
  deleteBlob,
  getBlob,
  getBlobPath,
  listBlobs,
  uploadBlob,
} from "./blobby.routes.ts";
import {
  addBlobToUser,
  getAllBlobs,
  getUserBlobs,
  removeBlobFromUser,
} from "./lib/redis.ts";
import { getRedisClient, storage } from "./utils.ts";

export const uploadBlobHandler: AppRouteHandler<
  typeof uploadBlob
> = async (c) => {
  const redis = await getRedisClient();
  const logger = c.get("logger");
  const key = c.req.param("key");
  const content = await c.req.json();

  content.blobCreatedAt = new Date().toISOString();
  content.blobAuthor = "system";

  await storage.saveBlob(key, JSON.stringify(content));
  await addBlobToUser(redis, key, content.blobAuthor);

  logger.info({ key }, "Blob saved successfully");

  return c.json({ key }, 200);
};

export const getBlobHandler: AppRouteHandler<typeof getBlob> = async (c) => {
  const key = c.req.param("key");
  const content = await storage.getBlob(key);

  if (!content) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.json(JSON.parse(content), 200);
};

export const getBlobPathHandler: AppRouteHandler<
  typeof getBlobPath
> = async (c) => {
  const key = c.req.param("key");
  const path = c.req.param("path");

  const content = await storage.getBlob(key);
  if (!content) {
    return c.json({ error: "Path not found" }, 404);
  }

  try {
    const jsonContent = JSON.parse(content);
    const pathParts = path?.split("/") ?? [];

    let result = jsonContent;
    for (const part of pathParts) {
      if (part && result[part] !== undefined) {
        result = result[part];
      } else {
        return c.json({ error: "Path not found" }, 404);
      }
    }

    if (typeof result !== "object" || result === null) {
      c.header("Content-Type", "application/javascript");
      return c.body(String(result));
    }

    return c.json(result);
  } catch (error) {
    return c.json({ error: "Invalid JSON content" }, 400);
  }
};

export const listBlobsHandler: AppRouteHandler<typeof listBlobs> = async (
  c,
) => {
  const redis = await getRedisClient();
  const logger = c.get("logger");
  const showAll = c.req.query("all") === "true";
  const showAllWithData = c.req.query("allWithData") !== undefined;
  const prefix = c.req.query("prefix");
  const search = c.req.query("search");
  const keys = c.req.query("keys");
  const user = "system";

  try {
    // If keys are provided, fetch those specific blobs
    if (keys) {
      const requestedKeys = keys.split(",");
      const blobData: Record<string, unknown> = {};

      for (const key of requestedKeys) {
        const content = await storage.getBlob(key);
        if (content) {
          blobData[key] = JSON.parse(content);
        }
      }

      return c.json(blobData, 200);
    }

    // Get the list of blobs based on user/all flag
    let blobs = showAll || showAllWithData
      ? await getAllBlobs(redis)
      : await getUserBlobs(redis, user);

    // Apply prefix filter if specified
    if (prefix) {
      blobs = blobs.filter((key) => key.startsWith(prefix));
      logger.info(
        { prefix, matchingBlobs: blobs.length },
        "Applied prefix filter",
      );
    }

    // Apply fulltext search if specified
    if (search) {
      const searchTerm = search.toLowerCase();
      const matchingBlobs: string[] = [];

      for (const hash of blobs) {
        const content = await storage.getBlob(hash);
        if (
          content &&
          JSON.stringify(JSON.parse(content)).toLowerCase().includes(searchTerm)
        ) {
          matchingBlobs.push(hash);
        }
      }

      blobs = matchingBlobs;
      logger.info(
        { search, matchingBlobs: blobs.length },
        "Applied fulltext search",
      );
    }

    // If showAllWithData is true, fetch the full blob data for each hash
    if (showAllWithData) {
      const blobData: Record<string, unknown> = {};
      for (const hash of blobs) {
        const content = await storage.getBlob(hash);
        if (content) {
          blobData[hash] = JSON.parse(content);
        }
      }
      return c.json(blobData, 200);
    }

    return c.json({ blobs }, 200);
  } catch (error) {
    logger.error({ error }, "Error listing blobs");
    return c.json({ error: "Internal server error" }, 500);
  }
};

export const deleteBlobHandler: AppRouteHandler<typeof deleteBlob> = async (
  c,
) => {
  const redis = await getRedisClient();
  const logger = c.get("logger");
  const key = c.req.param("key");

  try {
    // Check if blob exists first
    const exists = await storage.getBlob(key);
    if (!exists) {
      return c.json({ error: "Not found" }, 404);
    }

    // Delete the blob from storage
    await storage.deleteBlob(key);

    // Remove from user's blob list in Redis
    await removeBlobFromUser(redis, key);

    logger.info({ key }, "Blob deleted successfully");
    return c.json({ success: true });
  } catch (error) {
    logger.error({ error, key }, "Failed to delete blob");
    return c.json({ success: false }, 500);
  }
};
