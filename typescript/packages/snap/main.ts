import { cors } from "@hono/hono/cors";
import { Hono } from "@hono/hono";
import { logger } from "@hono/hono/logger";
import { join } from "@std/path";
import { ensureDir, exists } from "@std/fs";

import { sha256 } from "./lib/hash.ts";
import { takeScreenshot } from "./lib/playwright.ts";

// Ensure data directory exists
const dataDir = join(Deno.cwd(), "data");
ensureDir(dataDir);

interface Variables {
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
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: true,
  }),
);

// Middleware to extract Tailscale user
app.use(async (c, next) => {
  if (Deno.env.get("TAILSCALE_AUTH") === "false") {
    return next();
  }

  const user = c.req.header("Tailscale-User-Login");
  if (!user) {
    return c.text("Unauthorized", 401);
  }
  c.set("user", user);
  await next();
});

app.get("/screenshot/*", async (c) => {
  const uri = c.req.path.substring("/screenshot/".length);
  const fullPage = c.req.query("fullpage") === "true";

  let requestURL: URL;

  try {
    requestURL = new URL(uri);
  } catch {
    // If the uri is not a valid URL, we assume that it is a recipe ID
    requestURL = new URL(`http://localhost:5173/recipe/${uri}`);
  }

  const urlHash = await sha256(requestURL.toString());
  const outputPath = join(dataDir, `${urlHash}.png`);

  if (await exists(outputPath)) {
    console.log(
      "Fetching cached screenshot for",
      requestURL.toString(),
      "path: ",
      outputPath,
    );
    const screenshot = await Deno.readFile(outputPath);
    c.header("Content-Type", "image/png");
    c.header("CT-Cached-Image", "true");
    return c.body(screenshot);
  }

  console.log("Fetching screenshot for", requestURL.toString());

  const screenshot = await takeScreenshot(requestURL.toString(), {
    outputPath,
    fullPage,
  });

  // Set the content type to PNG and return the buffer directly
  c.header("Content-Type", "image/png");
  return c.body(screenshot);
});

const PORT = Deno.env.get("PORT") || 3000;

Deno.serve({ port: Number(PORT) }, app.fetch);
