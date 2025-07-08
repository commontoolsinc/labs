import { exists } from "@std/fs";
import * as path from "@std/path";
import { createRouter } from "@/lib/create-app.ts";
import { cors } from "@hono/hono/cors";
import { getMimeType } from "@/lib/mime-type.ts";

const router = createRouter();

router.use(
  "/shell/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
  }),
);

const dirname = import.meta?.dirname;
if (!dirname) {
  throw new Error("File does not have dirname in toolshed.");
}
const projectRoot = path.join(dirname, "..", "..");
const shellStaticRoot = path.join(projectRoot, "shell-frontend");
const COMPILED = await exists(path.join(projectRoot, "COMPILED"));
const SHELL_URL = Deno.env.get("SHELL_URL");

if (COMPILED) {
  // Production mode - serve static files
  router.get("/shell/*", async (c) => {
    const fullPath = c.req.path;
    let reqPath = fullPath.startsWith("/shell/")
      ? fullPath.slice(7) // Remove "/shell/" prefix
      : "";

    // Default to index.html for root path
    if (!reqPath) {
      reqPath = "index.html";
    }

    try {
      const filePath = path.join(shellStaticRoot, reqPath);
      const buffer = await Deno.readFile(filePath);
      const mimeType = getMimeType(reqPath);

      return new Response(buffer, {
        status: 200,
        headers: {
          "Content-Type": mimeType,
        },
      });
    } catch {
      // Serve index.html for client-side routing
      const indexPath = path.join(shellStaticRoot, "index.html");
      const buffer = await Deno.readFile(indexPath);
      return new Response(buffer, {
        status: 200,
        headers: {
          "Content-Type": "text/html",
        },
      });
    }
  });
} else if (SHELL_URL) {
  // Development mode with proxy

  // Handle root-level resources that shell app requests
  router.get("/DEV_SOCKET.js", async (c) => {
    const response = await fetch(`${SHELL_URL}/DEV_SOCKET.js`);
    return response;
  });

  router.get("/scripts/*", async (c) => {
    const response = await fetch(`${SHELL_URL}${c.req.path}`);
    return response;
  });

  router.get("/styles/*", async (c) => {
    const response = await fetch(`${SHELL_URL}${c.req.path}`);
    return response;
  });

  router.get("/assets/*", async (c) => {
    const response = await fetch(`${SHELL_URL}${c.req.path}`);
    return response;
  });

  router.get("/shell/*", async (c) => {
    const reqPath = c.req.path.replace("/shell", "") || "/";
    const targetUrl = `${SHELL_URL}${reqPath}`;

    try {
      const response = await fetch(targetUrl, {
        method: c.req.method,
        headers: c.req.header(),
      });

      return response;
    } catch (error) {
      return c.text(
        `Failed to proxy to ${targetUrl}. Is the shell dev server running?`,
        502,
      );
    }
  });
} else {
  // Development mode without proxy
  router.get("/shell/*", (c) => {
    return c.text(
      "Shell app not available. Set SHELL_URL=http://localhost:5173 or run the compiled binary",
      404,
    );
  });
}

export default router;
