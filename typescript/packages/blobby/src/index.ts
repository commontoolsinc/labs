import { Hono } from "hono";
import { cors } from "hono/cors";
import { createHash } from "crypto";
import { join } from "@std/path";
import { ensureDirSync } from "@std/fs";
import { createClient } from "redis";

// Ensure data directory exists
const dataDir = join(Deno.cwd(), "data");
await ensureDirSync(dataDir);

// Initialize Redis Client
const redisClient = createClient();
redisClient.on("error", (err) => console.error("Redis Client Error", err));
await redisClient.connect();

const app = new Hono();

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

app.use("", async (c, next) => {
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

app.get("/upload", (c) => {
  const template = Deno.readTextFileSync("./templates/upload.html");
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

export default app;
