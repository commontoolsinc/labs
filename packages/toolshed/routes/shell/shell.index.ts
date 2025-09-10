import { exists } from "@std/fs";
import * as path from "@std/path";
import { createRouter } from "@/lib/create-app.ts";
import { cors } from "@hono/hono/cors";
import { getMimeType } from "@/lib/mime-type.ts";
import env from "@/env.ts";
import {
  compareETags,
  createCacheHeaders,
  generateETag,
} from "@commontools/static/etag";

// Cache durations for different file types

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
  /**
   * Encapsulates static file response with ETag-based caching support.
   * Handles both 200 (full content) and 304 (not modified) responses.
   */
  class StaticResponse {
    mimeType: string;
    buffer: Uint8Array<ArrayBuffer>;
    etag: string;

    constructor(
      buffer: Uint8Array<ArrayBuffer>,
      mimeType: string,
      etag: string,
    ) {
      this.buffer = buffer;
      this.mimeType = mimeType;
      this.etag = etag;
    }

    static async fromFile(filePath: string) {
      const buffer = await Deno.readFile(filePath);
      const mimeType = getMimeType(filePath);
      const etag = await generateETag(buffer);
      return new StaticResponse(buffer, mimeType, etag);
    }

    response(ifNoneMatch?: string | null) {
      // Check if client has matching ETag
      if (ifNoneMatch && compareETags(this.etag, ifNoneMatch)) {
        return new Response(null, {
          status: 304,
          headers: {
            "ETag": this.etag,
          },
        });
      }

      // Simple caching strategy:
      // Use no-cache + ETag for all files
      // This means: always validate with server, but use cache if 304
      const cacheHeaders = createCacheHeaders(this.etag);

      const response = new Response(this.buffer, {
        status: 200,
        headers: {
          "Content-Type": this.mimeType,
          ...cacheHeaders,
        },
      });
      return response;
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

    // Get If-None-Match header for ETag validation
    const ifNoneMatch = c.req.header("If-None-Match");

    const cached = cache.get(reqPath);
    if (cached) {
      return cached.response(ifNoneMatch);
    }

    try {
      const filePath = path.join(shellStaticRoot, reqPath);
      if (!filePath.startsWith(shellStaticRoot)) {
        throw new Error("Outside of static root range");
      }
      const res = await StaticResponse.fromFile(filePath);
      cache.set(reqPath, res);
      return res.response(ifNoneMatch);
    } catch {
      // Serve index.html for client-side routing
      const cached = cache.get("index.html");
      if (cached) {
        return cached.response(ifNoneMatch);
      }
      const indexPath = path.join(shellStaticRoot, "index.html");
      const res = await StaticResponse.fromFile(indexPath);
      cache.set("index.html", res);
      return res.response(ifNoneMatch);
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
