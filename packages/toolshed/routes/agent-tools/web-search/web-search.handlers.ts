import type { AppRouteHandler } from "@/lib/types.ts";
import type { WebSearchRoute } from "./web-search.routes.ts";
import env from "@/env.ts";
import { sha256 } from "@/lib/sha2.ts";
import { ensureDir } from "@std/fs";

const CACHE_DIR = `${env.CACHE_DIR}/agent-tools-web-search`;
const JINA_SEARCH_ENDPOINT = "https://s.jina.ai/";
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes in milliseconds

async function isValidCache(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    const age = Date.now() - (stat.mtime?.getTime() ?? 0);
    return age < CACHE_TTL;
  } catch {
    return false;
  }
}

export const webSearch: AppRouteHandler<WebSearchRoute> = async (c) => {
  const logger = c.get("logger");
  const payload = await c.req.json();
  const { query, max_results = 5, include_content = false } = payload;

  const cacheKey = `${query}-${max_results}-${include_content}`;
  const promptSha = await sha256(cacheKey);
  const cachePath = `${CACHE_DIR}/${promptSha}.json`;

  logger.info(
    { query, max_results, include_content, promptSha },
    "Starting web search",
  );

  // Check cache first
  try {
    const cachedContent = await Deno.readFile(cachePath);
    const isValid = await isValidCache(cachePath);

    if (!isValid) {
      logger.info(
        { promptSha, path: cachePath },
        "Cache expired - Performing new search",
      );
      throw new Error("Cache expired");
    }

    logger.info(
      { promptSha, bytes: cachedContent.byteLength, path: cachePath },
      "🎯 Cache HIT - Serving cached search results",
    );
    return c.json(JSON.parse(new TextDecoder().decode(cachedContent)), {
      headers: {
        "X-Disk-Cache": "HIT",
      },
    });
  } catch {
    logger.info(
      { promptSha, path: cachePath },
      "❌ Cache MISS - Performing new search",
    );
  }

  try {
    // Build the search URL with query parameters
    const searchUrl = new URL(JINA_SEARCH_ENDPOINT);
    searchUrl.searchParams.set("q", query);

    // Build headers based on whether we want content or not
    const headers: Record<string, string> = {
      "Accept": "application/json",
      "Authorization": `Bearer ${env.JINA_API_KEY}`,
    };

    if (include_content) {
      headers["X-Engine"] = "direct"; // Fetch content from search results
    } else {
      headers["X-Respond-With"] = "no-content"; // Only search results, no content
    }

    const response = await fetch(searchUrl.toString(), {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const statusCode = response.status;
      logger.error(
        {
          status: statusCode,
          error: errorText,
          headers: Object.fromEntries(response.headers.entries()),
        },
        "Jina Search API request failed",
      );
      return c.json(
        { error: `Search failed: ${errorText}` },
        500,
      );
    }

    const result = await response.json();
    logger.info({ result }, "Search completed successfully");

    // Transform the Jina response to our API schema, preserving more fields
    const transformedResult = {
      code: result.code,
      status: result.status,
      query,
      results: (result.data || []).slice(0, max_results).map((item: any) => ({
        title: item.title || "Untitled",
        url: item.url,
        description: item.description || item.content?.substring(0, 200) || "",
        content: item.content || "",
        date: item.date,
        usage: item.usage,
      })),
      total_results: result.data?.length || 0,
      meta: result.meta,
    };

    // Save to cache
    await ensureDir(CACHE_DIR);
    await Deno.writeFile(
      cachePath,
      new TextEncoder().encode(JSON.stringify(transformedResult)),
    );
    logger.info({ promptSha }, "Search results cached");

    return c.json(transformedResult, {
      headers: {
        "X-Disk-Cache": "MISS",
      },
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error
        ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
        : String(error),
    }, "Web search failed");
    return c.json({ error: "Search failed" }, 500);
  }
};
