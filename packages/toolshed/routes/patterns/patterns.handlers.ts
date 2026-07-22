import type { Context } from "@hono/hono";
import {
  compareETags,
  createCacheHeaders,
  generateETag,
} from "@commonfabric/static/etag";
import { PatternsServer } from "./patterns-server.ts";

// Create a single server instance to be reused across requests
const patternsServer = new PatternsServer();

/** Headers shared by source and `?identity` responses from this process. */
export function patternResponseHeaders(
  contentType: string,
  etag: string,
): Record<string, string> {
  return {
    "Content-Type": contentType,
    ...createCacheHeaders(etag),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "ETag",
  };
}

function patternResponse(
  c: Context,
  body: BodyInit,
  contentType: string,
  etag: string,
): Response {
  const headers = patternResponseHeaders(contentType, etag);
  if (compareETags(etag, c.req.header("If-None-Match"))) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: 200, headers });
}

/**
 * Handler for serving pattern files from the patterns directory.
 * Validates filenames and returns TSX/TS files with appropriate headers.
 */
export const getPattern = async (
  c: Context,
) => {
  const { filename } = c.req.param();

  try {
    // Security: validate filename doesn't contain path traversal
    // Decode first to catch encoded traversal sequences (e.g. %2e%2e)
    // Block .. sequences that could escape the patterns directory
    // Block leading / which would create absolute paths in URL resolution
    // Block : to prevent URL scheme injection (e.g., file:///etc/passwd)
    // Allow internal / for subdirectory access (e.g., record/registry.ts)
    const decoded = decodeURIComponent(filename);
    if (
      decoded.includes("..") || decoded.startsWith("/") ||
      decoded.includes(":")
    ) {
      return c.json(
        { error: "Invalid file path" },
        400,
      );
    }

    // `?identity`: return the file's content-addressed identity (the value the
    // runtime would store as patternIdentity.identity for this authored import
    // closure) as plain text, instead of the source itself.
    if (new URL(c.req.url).searchParams.has("identity")) {
      const identity = await patternsServer.identity(filename);
      return patternResponse(
        c,
        identity,
        "text/plain; charset=utf-8",
        `"${identity}"`,
      );
    }

    // Hash and serve the exact bytes so the ETag is a strong validator for the
    // representation the client caches.
    const content = await patternsServer.get(filename);
    const etag = await generateETag(content);

    // Return with proper headers for TSX files
    return patternResponse(
      c,
      content as BodyInit,
      "text/typescript-jsx; charset=utf-8",
      etag,
    );
  } catch (error) {
    const { status, body } = classifyPatternError(error);
    if (status === 500) console.error("Error serving pattern file:", error);
    return c.json(body, status);
  }
};

/**
 * Map a pattern-serving error to an HTTP status + body: a missing file → 404; a
 * structurally invalid entry (incomplete import closure, or a `cf:` fabric
 * import the light `?identity` path does not model) → 400 with the reason;
 * anything else → 500. Exported for testing.
 */
export function classifyPatternError(
  error: unknown,
): { status: 404 | 400 | 500; body: { error: string } } {
  if (error instanceof Error && error.message.includes("not found")) {
    return { status: 404, body: { error: "File not found" } };
  }
  if (
    error instanceof Error &&
    (error.message.includes("incomplete closure") ||
      error.message.includes("fabric import"))
  ) {
    return { status: 400, body: { error: error.message } };
  }
  return { status: 500, body: { error: "Internal server error" } };
}
