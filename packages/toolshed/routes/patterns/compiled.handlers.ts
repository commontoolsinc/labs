import type { Context } from "@hono/hono";
import { patternCompiler } from "./pattern-compiler.ts";
import {
  compareETags,
  createCacheHeaders,
  generateETag,
} from "@commontools/static/etag";
import { encodeBase64 } from "@std/encoding/base64";

// Common CORS headers for all responses
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Handler for serving compiled pattern files.
 * Compiles TypeScript to JavaScript on the server, caching results.
 * Supports ETag-based caching with 304 Not Modified responses.
 */
export const getCompiledPattern = async (
  c: Context,
) => {
  const { filename } = c.req.param();

  try {
    // Security: validate filename doesn't contain path traversal
    // Block .. sequences that could escape the patterns directory
    // Block leading / which would create absolute paths in URL resolution
    // Block : to prevent URL scheme injection (e.g., file:///etc/passwd)
    // Allow internal / for subdirectory access (e.g., record/registry.ts)
    if (
      filename.includes("..") || filename.startsWith("/") ||
      filename.includes(":")
    ) {
      return c.json(
        { error: "Invalid file path" },
        400,
      );
    }

    // Compile the pattern (uses LRU cache internally)
    const compiled = await patternCompiler.compile(filename, {
      noCheck: true, // Skip type checking for speed
      includeSourceMap: true,
    });

    // Generate ETag from compiled JS content
    const etag = await generateETag(new TextEncoder().encode(compiled.js));

    // Check If-None-Match header for cache validation
    const ifNoneMatch = c.req.header("If-None-Match");
    if (ifNoneMatch && compareETags(etag, ifNoneMatch)) {
      // Client has matching cached version - return 304
      return new Response(null, {
        status: 304,
        headers: {
          "ETag": etag,
          ...CORS_HEADERS,
        },
      });
    }

    // Prepare JavaScript with inline source map
    let js = compiled.js;
    if (compiled.sourceMap) {
      const sourceMapJson = JSON.stringify(compiled.sourceMap);
      // Use encodeBase64 which handles UTF-8 properly (btoa only works with Latin1)
      const sourceMapBase64 = encodeBase64(new TextEncoder().encode(sourceMapJson));
      js += `\n//# sourceMappingURL=data:application/json;base64,${sourceMapBase64}`;
    }

    // Create cache headers with ETag
    const cacheHeaders = createCacheHeaders(etag);

    // Return compiled JavaScript
    return new Response(js, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "X-Content-Hash": compiled.contentHash,
        ...cacheHeaders,
        ...CORS_HEADERS,
      },
    });
  } catch (error) {
    // Handle not found errors
    if (error instanceof Deno.errors.NotFound) {
      return c.json(
        { error: "Pattern not found" },
        404,
      );
    }

    // Handle compilation errors with details
    if (error instanceof Error) {
      console.error("Error compiling pattern:", error);
      return c.json(
        {
          error: "Compilation failed",
          details: error.message,
        },
        500,
      );
    }

    console.error("Unknown error compiling pattern:", error);
    return c.json(
      { error: "Internal server error" },
      500,
    );
  }
};
