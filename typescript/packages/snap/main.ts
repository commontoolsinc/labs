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

app.post("/test/:recipeId", async (c) => {
  const recipeId = c.req.param("recipeId");
  const body = await c.req.json();
  const testContent = body.test;

  if (!testContent) {
    return c.json({ error: "Missing test content" }, 400);
  }

  // Create temp directory if it doesn't exist
  const tempDir = join(Deno.cwd(), "temp-tests");
  await ensureDir(tempDir);

  // Create a unique filename
  const tempTestFilePath = join(tempDir, `test-${Date.now()}-${crypto.randomUUID()}.spec.ts`);

  try {
    // Replace the initial page.goto URL
    const updatedTestContent = testContent.replace(
      /await page\.goto\(['"][^'"]*['"]\)/,
      `await page.goto('http://localhost:5173/recipe/${recipeId}')`
    );

    // Write to temporary file
    await Deno.writeTextFile(tempTestFilePath, updatedTestContent);

    // Execute the test
    const args = ["playwright", "test", tempTestFilePath];
    const shellCommand = `npx ${args.join(" ")}`;
    console.log("Shell command:", shellCommand);

    const process = new Deno.Command("npx", {
      args,
      stdout: "piped",
      stderr: "piped",
    });

    console.log("deno command", process.toString());
    const { code, stdout, stderr } = await process.output();

    const output = new TextDecoder().decode(stdout);
    const error = new TextDecoder().decode(stderr);

    // Clean up
    await Deno.remove(tempTestFilePath);

    if (code === 0) {
      return c.json({ success: true, output });
    } else {
      return c.json({ 
        success: false, 
        error,
        output 
      }, 400);
    }
  } catch (error) {
    // Clean up on error
    try {
      await Deno.remove(tempTestFilePath);
    } catch {
      // Ignore cleanup errors
    }

    return c.json({ 
      success: false, 
      error: error.message 
    }, 500);
  }
});

const PORT = Deno.env.get("PORT") || 3000;

Deno.serve({ port: Number(PORT) }, app.fetch);
