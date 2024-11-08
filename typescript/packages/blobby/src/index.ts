import { cors } from "@hono/hono/cors";
import {
  createClient,
  type RedisClientType,
  type RedisFunctions,
  type RedisModules,
  type RedisScripts,
} from "redis";
import { ensureDirSync } from "@std/fs";
import { Hono } from "@hono/hono";
import { join } from "@std/path";

import { sha256 } from "./utils/hash.ts";

// Ensure data directory exists
const dataDir = join(Deno.cwd(), "data");
await ensureDirSync(dataDir);

interface Variables {
  redis: RedisClientType<RedisModules, RedisFunctions, RedisScripts>;
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

app.get("/upload", (c) => {
  const template = Deno.readTextFileSync(
    join(import.meta.dirname!, "templates/upload.html"),
  );
  return c.html(template);
});

app.get("/:hash", async (c) => {
  const hash = c.req.param("hash");
  const object = await c.env.R2.get(hash);

  if (!object) {
    return c.text("Not Found", 404);
  }

  return c.body(object.body);
});

app.post("/:hash", async (c) => {
  const hash = c.req.param("hash");
  const content = await c.req.text();
  // FIXME(ja): verify the hash of the content is correct
  // const hash = createHash('sha256').update(content).digest('hex')

  await c.env.R2.put(hash, content);

  return c.json({ hash });
});

const PORT = Deno.env.get("PORT") || 3000;

Deno.serve(app.fetch);
