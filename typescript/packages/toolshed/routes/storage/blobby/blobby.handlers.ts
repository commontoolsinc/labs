import type { AppRouteHandler } from "@/lib/types.ts";
import type {
  getBlob,
  getBlobPath,
  listBlobs,
  uploadBlob,
} from "./blobby.routes.ts";
import { addBlobToUser, getAllBlobs, getUserBlobs } from "@/lib/redis/redis.ts";
import { storage } from "@/storage.ts";

export const uploadBlobHandler: AppRouteHandler<
  typeof uploadBlob
> = async c => {
  const redis = c.get("blobbyRedis");
  if (!redis) throw new Error("Redis client not found in context");
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

export const getBlobHandler: AppRouteHandler<typeof getBlob> = async c => {
  const key = c.req.param("key");
  const content = await storage.getBlob(key);

  if (!content) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.json(JSON.parse(content), 200);
};

export const getBlobPathHandler: AppRouteHandler<
  typeof getBlobPath
> = async c => {
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

export const listBlobsHandler: AppRouteHandler<typeof listBlobs> = async c => {
  const redis = c.get("blobbyRedis");
  if (!redis) throw new Error("Redis client not found in context");
  const logger = c.get("logger");
  const showAll = c.req.query("all") === "true";
  const showAllWithData = c.req.query("allWithData") !== undefined;
  // TODO(jake): Replace with actual user when auth is added
  const user = "system";
  try {
    // Get the list of blobs based on user/all flag
    const blobs =
      showAll || showAllWithData
        ? await getAllBlobs(redis)
        : await getUserBlobs(redis, user);

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
