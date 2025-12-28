import type { Context } from "@hono/hono";
import * as HttpStatusCodes from "stoker/http-status-codes";
import {
  CompilationTimeoutError,
  createPatternCompiler,
  PathTraversalError,
  SemaphoreQueueFullError,
} from "./pattern-compiler.ts";
import { compareETags, createCacheHeaders } from "@commontools/static/etag";
import { encodeBase64 } from "@std/encoding/base64";

/**
 * Module-scoped pattern compiler instance.
 * Created on first use (lazy initialization).
 * Use `resetPatternCompiler()` in tests to get a fresh instance.
 */
let patternCompiler: ReturnType<typeof createPatternCompiler> | null = null;

function getPatternCompiler() {
  if (!patternCompiler) {
    patternCompiler = createPatternCompiler();
  }
  return patternCompiler;
}

/**
 * Reset the pattern compiler instance.
 * Useful in tests to ensure a clean state between test runs.
 * @internal Exported for testing only
 */
export function resetPatternCompiler(): void {
  patternCompiler = null;
}

/**
 * Sanitize error messages to remove sensitive information like absolute file paths.
 * Converts absolute paths to relative paths within the patterns directory.
 *
 * Example transformation:
 * - Input: `/Users/alex/Code/labs/packages/patterns/system/foo.tsx(15,7): error TS2322`
 * - Output: `system/foo.tsx(15,7): error TS2322`
 *
 * @param message - The error message to sanitize
 * @returns Sanitized error message with paths redacted
 */
export function sanitizeErrorMessage(message: string): string {
  // Pattern to match absolute file paths that contain "packages/patterns/"
  // Captures everything after "packages/patterns/" including line/column info
  // Handles both forward slashes (Unix) and backslashes (Windows)
  const patternsPathRegex =
    /(?:[A-Za-z]:)?[\\/](?:[^\s:'"<>|*?]+[\\/])*packages[\\/]patterns[\\/]([^\s:'"<>|*?]+)/g;

  // Replace absolute paths containing packages/patterns with relative paths
  let sanitized = message.replace(patternsPathRegex, "$1");

  // Also redact any remaining absolute paths that might leak server structure
  // Match paths like /Users/..., /home/..., C:\..., etc.
  // Be careful to preserve relative paths and common error patterns
  const absolutePathRegex =
    /(?:[A-Za-z]:)?[\\/](?:Users|home|var|tmp|opt|etc|root|usr)[\\/][^\s:'"<>|*?]+/g;
  sanitized = sanitized.replace(absolutePathRegex, "[redacted-path]");

  return sanitized;
}

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
    // Security: validate filename format before compilation
    // Block leading / which would create absolute paths in URL resolution
    // Block : to prevent URL scheme injection (e.g., file:///etc/passwd)
    // Note: Path traversal (..) is handled by validatePatternPath in the compiler
    if (filename.startsWith("/") || filename.includes(":")) {
      return c.json(
        { error: "Invalid file path" },
        HttpStatusCodes.BAD_REQUEST,
      );
    }

    // Compile the pattern (uses LRU cache internally)
    const compiled = await getPatternCompiler().compile(filename, {
      noCheck: true, // Skip type checking for speed
      includeSourceMap: true,
    });

    // Use contentHash as ETag (same source = same output, deterministic compilation)
    const etag = `"${compiled.contentHash}"`;

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
      const sourceMapBase64 = encodeBase64(
        new TextEncoder().encode(sourceMapJson),
      );
      js +=
        `\n//# sourceMappingURL=data:application/json;base64,${sourceMapBase64}`;
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
    // Handle path traversal attempts (security)
    if (error instanceof PathTraversalError) {
      return c.json(
        { error: "Invalid file path" },
        HttpStatusCodes.BAD_REQUEST,
      );
    }

    // Handle not found errors
    if (error instanceof Deno.errors.NotFound) {
      return c.json(
        { error: "Pattern not found" },
        HttpStatusCodes.NOT_FOUND,
      );
    }

    // Handle server overload - queue is full
    if (error instanceof SemaphoreQueueFullError) {
      console.warn("Pattern compilation queue full:", error.message);
      return c.json(
        { error: "Server busy, try again later" },
        HttpStatusCodes.SERVICE_UNAVAILABLE,
      );
    }

    // Handle compilation timeout
    if (error instanceof CompilationTimeoutError) {
      console.error("Pattern compilation timed out:", error.message);
      return c.json(
        { error: "Compilation timed out" },
        HttpStatusCodes.GATEWAY_TIMEOUT,
      );
    }

    // Handle other compilation errors with details
    if (error instanceof Error) {
      console.error("Error compiling pattern:", error);
      return c.json(
        {
          error: "Compilation failed",
          details: sanitizeErrorMessage(error.message),
        },
        HttpStatusCodes.INTERNAL_SERVER_ERROR,
      );
    }

    console.error("Unknown error compiling pattern:", error);
    return c.json(
      { error: "Internal server error" },
      HttpStatusCodes.INTERNAL_SERVER_ERROR,
    );
  }
};
