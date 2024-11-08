import { cors } from "@hono/hono/cors";
import { createClient } from "redis";
import { ensureDirSync } from "@std/fs";
import { Hono } from "@hono/hono";
import { join } from "@std/path";

import { sha256 } from "./utils/hash.ts";
import { DiskStorage } from "./lib/storage.ts";
import {
  addBlobToUser,
  getAllBlobs,
  getUserBlobs,
  type RedisClient,
} from "./lib/redis.ts";

// Ensure data directory exists
const dataDir = join(Deno.cwd(), "data");
const storage = new DiskStorage(dataDir);
await storage.init();

interface Variables {
  redis: RedisClient;
  user: string;
}

const app = new Hono<{ Variables: Variables }>();

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
    url: "redis://localhost:6379",
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
  const user = c.req.header("Tailscale-User-Login") ||
    c.req.header("X-Tailscale-User");
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

app.put("/blob/:hash", async (c) => {
  const redis = c.get("redis");
  const hash = c.req.param("hash");
  const content = await c.req.text();

  // Verify hash matches content
  const calculatedHash = await sha256(content);
  if (calculatedHash !== hash) {
    return c.json({ error: "Hash mismatch" }, 400);
  }

  // Save blob
  await storage.saveBlob(hash, content);

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

app.get("/blobs", async (c) => {
  const user = c.req.query("user");
  const redis = c.get("redis");

  const blobs = user
    ? await getUserBlobs(redis, user)
    : await getAllBlobs(redis);

  return c.json({ blobs });
});

const PORT = Deno.env.get("PORT") || 3000;

Deno.serve({ port: Number(PORT) }, app.fetch);
