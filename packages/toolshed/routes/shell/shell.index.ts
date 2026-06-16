import { exists } from "@std/fs";
import ports from "@commonfabric/ports" with { type: "json" };
import * as path from "@std/path";
import { createRouter } from "@/lib/create-app.ts";
import { cors } from "@hono/hono/cors";
import { getMimeType } from "@/lib/mime-type.ts";
import env from "@/env.ts";
import {
  compareETags,
  createCacheHeaders,
  generateETag,
} from "@commonfabric/static/etag";

// Cache durations for different file types

const router = createRouter();

router.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
  }),
);

// Keep the served shell document NON-cross-origin-isolated.
//
// The shell hosts untrusted user programs ("patterns") inside this same page,
// sandboxed with SES. A core Spectre-class defense is that pattern code cannot
// build a high-resolution timer: SharedArrayBuffer / Atomics and an un-clamped
// performance.now() are unavailable. In a browser those primitives are gated
// behind `crossOriginIsolated === true`, which a page only earns when it is
// served with both `Cross-Origin-Opener-Policy: same-origin` AND
// `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`).
//
// We deliberately serve neither isolating combination so `crossOriginIsolated`
// stays false. This is defense-in-depth on top of the SES taming: even if that
// taming ever regressed, a non-isolated page still hands patterns no parallel
// counter and no fine clock. We accept forgoing browser-process isolation
// against cross-origin Spectre because our threat is untrusted code inside our
// own origin, not other origins attacking us.
//
// COOP is set to the non-isolating `same-origin-allow-popups`, and COEP is
// pinned to `unsafe-none`. These run after the handler so they override any
// header an upstream change might set. See
// docs/specs/sandboxing/cross-origin-isolation.md.
router.use("/*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  c.header("Cross-Origin-Embedder-Policy", "unsafe-none");
});

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
  router.get("/DEV_SOCKET.js", async (_) => {
    return await fetch(`${SHELL_URL}/DEV_SOCKET.js`);
  });

  router.get("/scripts/*", async (c) => {
    return await fetch(`${SHELL_URL}${c.req.path}`);
  });

  router.get("/styles/*", async (c) => {
    return await fetch(`${SHELL_URL}${c.req.path}`);
  });

  router.get("/assets/*", async (c) => {
    return await fetch(`${SHELL_URL}${c.req.path}`);
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
    } catch (_) {
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
      `Shell app not available. Set SHELL_URL=http://localhost:${ports.shell} or run the compiled binary`,
      404,
    );
  });
}

export default router;
