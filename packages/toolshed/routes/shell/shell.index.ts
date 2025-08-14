import { exists } from "@std/fs";
import * as path from "@std/path";
import { createRouter } from "@/lib/create-app.ts";
import { cors } from "@hono/hono/cors";
import { getMimeType } from "@/lib/mime-type.ts";
import env from "@/env.ts";

const STATIC_CACHE_DURATION = 60 * 60 * 1; // 1 hour

const router = createRouter();

router.use(
  "/*",
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
const shellStaticRoot = path.join(
  projectRoot,
  env.ENV === "production" ? "shell-frontend" : "shell-frontend-dev",
);
const COMPILED = await exists(path.join(projectRoot, "COMPILED"));
const SHELL_URL = Deno.env.get("SHELL_URL");

if (COMPILED) {
  class StaticResponse {
    mimeType: string;
    buffer: Uint8Array<ArrayBuffer>;
    constructor(buffer: Uint8Array<ArrayBuffer>, mimeType: string) {
      this.buffer = buffer;
      this.mimeType = mimeType;
    }

    static async fromFile(filePath: string) {
      const buffer = await Deno.readFile(filePath);
      const mimeType = getMimeType(filePath);
      return new StaticResponse(buffer, mimeType);
    }

    response() {
      return new Response(this.buffer, {
        status: 200,
        headers: {
          "Content-Type": this.mimeType,
          "Cache-Control": `max-age=${STATIC_CACHE_DURATION}`,
        },
      });
    }
  }

  const cache = new Map<string, StaticResponse>();

  // Production mode - serve static files
  router.get("/*", async (c) => {
    let reqPath = c.req.path.slice(1); // Remove leading slash

    // Default to index.html for root path
    if (!reqPath) {
      reqPath = "index.html";
    }

    const cached = cache.get(reqPath);
    if (cached) {
      return cached.response();
    }

    try {
      const filePath = path.join(shellStaticRoot, reqPath);
      if (!filePath.startsWith(shellStaticRoot)) {
        throw new Error("Outside of static root range");
      }
      const res = await StaticResponse.fromFile(filePath);
      cache.set(reqPath, res);
      return res.response();
    } catch {
      // Serve index.html for client-side routing
      const cached = cache.get("index.html");
      if (cached) {
        return cached.response();
      }
      const indexPath = path.join(shellStaticRoot, "index.html");
      const res = await StaticResponse.fromFile(indexPath);
      cache.set("index.html", res);
      return res.response();
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

  router.get("/*", async (c) => {
    const reqPath = c.req.path || "/";
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
  router.get("/*", (c) => {
    return c.text(
      "Shell app not available. Set SHELL_URL=http://localhost:5173 or run the compiled binary",
      404,
    );
  });
}

export default router;
