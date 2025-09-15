import type { Context } from "@hono/hono";
import { PatternsCache } from "./patterns-cache.ts";

// Create a single cache instance to be reused across requests
const patternsCache = new PatternsCache();

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
    if (filename.includes("..") || filename.includes("/")) {
      return c.json(
        { error: "Invalid file path" },
        400,
      );
    }

    // Get the file content from cache
    const content = await patternsCache.getText(filename);

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

    console.error("Error serving pattern file:", error);
    return c.json(
      { error: "Internal server error" },
      500,
    );
  }
};
