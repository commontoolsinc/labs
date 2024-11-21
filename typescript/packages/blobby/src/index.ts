import { cors } from "@hono/hono/cors";
import { Hono } from "@hono/hono";
import { logger } from "@hono/hono/logger";
import { createClient } from "redis";
import { join } from "@std/path";

import { DiskStorage } from "./lib/storage.ts";
import {
  addBlobToUser,
  getAllBlobs,
  getUserBlobs,
  type RedisClient,
} from "./lib/redis.ts";
import { sha256 } from "./utils/hash.ts";

// Ensure data directory exists
const dataDir = join(Deno.cwd(), "data");
const storage = new DiskStorage(dataDir);
await storage.init();

interface Variables {
  redis: RedisClient;
  user: string;
}

const app = new Hono<{ Variables: Variables }>();

app.use("*", logger());

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length", "X-Kuma-Revision"],
    maxAge: 600,
    credentials: true,
  }),
);

app.use("*", async (c, next) => {
  const redis = createClient({
    url: Deno.env.get("REDIS_URL") || "redis://localhost:6379",
  });
  redis.on("error", (err) => console.error("Redis Client Error", err));

  // Connect if not connected
  if (!redis.isOpen) {
    await redis.connect();
  }

  // Attach to context
  c.set("redis", redis);

  await next();
});

// Middleware to extract Tailscale user
app.use(async (c, next) => {
  const user = c.req.header("Tailscale-User-Login");

  if (Deno.env.get("TAILSCALE_AUTH") === "false") {
    c.set("user", user || "anonymous");
    return next();
  }

  if (!user) {
    return c.text("Unauthorized", 401);
  }
  c.set("user", user);
  await next();
});

app.get("/", (c) => {
  const template = Deno.readTextFileSync(
    join(import.meta.dirname!, "templates/upload.html"),
  );
  return c.html(template);
});

app.post("/blob/:hash", async (c) => {
  const redis = c.get("redis");
  const hash = c.req.param("hash");
  const content = await c.req.text();

  // TODO(jake): Verify hash matches content, requires clients to properly sha2 recipe code
  // const calculatedHash = await sha256(content);
  // if (calculatedHash !== hash) {
  //   return c.json({ error: "Hash mismatch" }, 400);
  // }

  // Parse content as JSON
  const jsonContent = JSON.parse(content);

  jsonContent.blobCreatedAt = new Date().toISOString();
  jsonContent.blobAuthor = c.get("user").split("@")[0];

  // Save blob
  await storage.saveBlob(hash, JSON.stringify(jsonContent));

  // Associate blob with user
  const user = c.get("user");
  await addBlobToUser(redis, hash, user);

  return c.json({ hash });
});

app.get("/blob/:hash", async (c) => {
  const hash = c.req.param("hash");
  const content = await storage.getBlob(hash);

  if (!content) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.body(content);
});

app.get("/blob/:hash/png", async (c) => {
  const hash = c.req.param("hash");
  const snapURL = `${Deno.env.get("SNAP_API_URL")}/screenshot/${hash}`;

  const snap = await fetch(snapURL);
  const snapBlob = await snap.blob();
  const arrayBuffer = await snapBlob.arrayBuffer();

  c.header("Content-Type", "image/png");
  return c.body(arrayBuffer);
});

app.get("/blob/:hash/*", async (c) => {
  const hash = c.req.param("hash");
  const path = c.req.path.split(`/blob/${hash}/`)[1];

  const content = await storage.getBlob(hash);
  if (!content) {
    return c.json({ error: "Not found" }, 404);
  }

  try {
    const jsonContent = JSON.parse(content);
    const pathParts = path.split("/");

    // Navigate through the JSON object
    let result = jsonContent;
    for (const part of pathParts) {
      if (part && result[part] !== undefined) {
        result = result[part];
      } else {
        return c.json({ error: "Path not found" }, 404);
      }
    }

    // If result is null or not an object (string, number, boolean, undefined), return as text
    if (typeof result !== "object" || result === null) {
      c.header("Content-Type", "application/javascript");
      return c.body(String(result));
    }

    // If it's an object or array, return as JSON
    return c.json(result);
  } catch (error) {
    return c.json({ error: "Invalid JSON content" }, 400);
  }
});

app.get("/blob", async (c) => {
  const showAll = c.req.query("all") === "true";
  const showAllWithData = c.req.query("allWithData") !== undefined;
  const redis = c.get("redis");
  const user = c.get("user");

  // Get the list of blobs
  const blobs =
    showAll || showAllWithData
      ? await getAllBlobs(redis)
      : await getUserBlobs(redis, user);

  // If showAllWithData is true, fetch the full blob data for each hash
  if (showAllWithData) {
    const blobData: Record<string, any> = {};
    for (const hash of blobs) {
      const content = await storage.getBlob(hash);
      if (content) {
        blobData[hash] = JSON.parse(content);
      }
    }
    return c.json(blobData);
  }

  return c.json({ blobs });
});

const PORT = Deno.env.get("PORT") || 3000;

Deno.serve({ port: Number(PORT) }, app.fetch);
