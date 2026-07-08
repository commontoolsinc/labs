import type { Context } from "@hono/hono";
import { PatternsServer } from "./patterns-server.ts";

// Create a single server instance to be reused across requests
const patternsServer = new PatternsServer();

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
    // runtime would store as patternIdentity.identity for this source at this
    // build) as plain text, instead of the source itself.
    if (new URL(c.req.url).searchParams.has("identity")) {
      const identity = await patternsServer.identity(filename);
      return new Response(identity, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Get the file content from server
    const content = await patternsServer.getText(filename);

    // Return with proper headers for TSX files
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": "text/typescript-jsx; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      return c.json(
        { error: "File not found" },
        404,
      );
    }

    // A structurally invalid entry (incomplete import closure, or a cf: fabric
    // import the light identity path does not model) — surface the reason.
    if (
      error instanceof Error &&
      (error.message.includes("incomplete closure") ||
        error.message.includes("fabric import"))
    ) {
      return c.json(
        { error: error.message },
        400,
      );
    }

    console.error("Error serving pattern file:", error);
    return c.json(
      { error: "Internal server error" },
      500,
    );
  }
};
