import type { Context } from "@hono/hono";
import { PatternsServer } from "./patterns-server.ts";
import {
  compareETags,
  createCacheHeaders,
} from "@commontools/static/etag";
import { decode } from "@commontools/utils/encoding";

// Create a single server instance to be reused across requests
const patternsServer = new PatternsServer();

// Common CORS headers for all responses
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Handler for serving pattern files from the patterns directory.
 * Validates filenames and returns TSX/TS files with appropriate headers.
 * Supports ETag-based caching with 304 Not Modified responses.
 */
export const getPattern = async (
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

    // Get the file content with ETag from server
    const { buffer, etag } = await patternsServer.getWithETag(filename);

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

    // Create cache headers with ETag
    const cacheHeaders = createCacheHeaders(etag);

    // Return with proper headers for TSX files
    return new Response(decode(buffer), {
      status: 200,
      headers: {
        "Content-Type": "text/typescript-jsx; charset=utf-8",
        ...cacheHeaders,
        ...CORS_HEADERS,
      },
    });
  } catch (error) {
    // Use proper error type checking instead of string matching
    if (error instanceof Deno.errors.NotFound) {
      return c.json(
        { error: "File not found" },
        404,
      );
    }

    console.error("Error serving pattern file:", error);
    return c.json(
      { error: "Internal server error" },
      500,
    );
  }
};
