import type { AppRouteHandler } from "@/lib/types.ts";
import type {
  ReadWebPageAdvancedRoute,
  ReadWebPageRoute,
} from "./webreader.routes.ts";
import env from "@/env.ts";
import { sha256 } from "@/lib/sha2.ts";
import { ensureDir } from "@std/fs";

const CACHE_DIR = `${env.CACHE_DIR}/ai-webreader`;
const JINA_API_ENDPOINT = `https://r.jina.ai/`;
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

export const readWebPage: AppRouteHandler<ReadWebPageRoute> = async (c) => {
  const logger = c.get("logger");
  logger.info({
    endpoint: JINA_API_ENDPOINT,
    keyLength: env.JINA_API_KEY?.length,
  }, "Jina API configuration");

  // NOTE(jake): When making a web request from the API docs reference UI, the
  // scalar client adds {.+} to the end of the URL. We need to strip it out here.
  let url = c.req.param("url").split("{")[0];
  url = decodeURIComponent(url);
  const promptSha = await sha256(url);
  const cachePath = `${CACHE_DIR}/${promptSha}.json`;

  logger.info({ url, promptSha }, "Starting web page extraction");

  // Check cache first
  try {
    const cachedContent = await Deno.readFile(cachePath);
    const isValid = await isValidCache(cachePath);

    if (!isValid) {
      logger.info(
        { promptSha, path: cachePath },
        "Cache expired - Extracting new content",
      );
      throw new Error("Cache expired");
    }

    logger.info(
      { promptSha, bytes: cachedContent.byteLength, path: cachePath },
      "🎯 Cache HIT - Serving cached content",
    );
    return c.json(JSON.parse(new TextDecoder().decode(cachedContent)), {
      headers: {
        "X-Disk-Cache": "HIT",
      },
    });
  } catch {
    logger.info(
      { promptSha, path: cachePath },
      "❌ Cache MISS - Extracting new content",
    );
  }

  try {
    const response = await fetch(JINA_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.JINA_API_KEY}`,
      },
      body: JSON.stringify({
        url,
      }),
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
        "Jina API request failed",
      );
      return c.json(
        { error: `Failed to extract content: ${errorText}` },
        500,
      );
    }

    const result = await response.json();
    logger.info({ result }, "Content extracted successfully");

    // Transform the response to match our API schema
    const transformedResult = {
      content: result.data.content,
      metadata: {
        title: result.data.title,
        date: result.data.publishedTime,
        word_count: Math.floor(result.data.usage.tokens * 0.75),
      },
    };

    // Save to cache
    await ensureDir(CACHE_DIR);
    await Deno.writeFile(
      cachePath,
      new TextEncoder().encode(JSON.stringify(transformedResult)),
    );
    logger.info({ promptSha }, "Content cached");

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
    }, "Content extraction failed");
    return c.json({ error: "Failed to extract content" }, 500);
  }
};

export const readWebPageAdvanced: AppRouteHandler<ReadWebPageAdvancedRoute> =
  async (c) => {
    const logger = c.get("logger");
    const payload = await c.req.json();
    const { url, ...options } = payload;

    const promptSha = await sha256(url);
    const cachePath = `${CACHE_DIR}/${promptSha}.json`;

    logger.info(
      { url, promptSha, options },
      "Starting advanced web extraction",
    );

    // Check cache first
    try {
      const cachedContent = await Deno.readFile(cachePath);
      const isValid = await isValidCache(cachePath);

      if (!isValid) {
        logger.info(
          { promptSha, path: cachePath },
          "Cache expired - Extracting new content",
        );
        throw new Error("Cache expired");
      }

      logger.info(
        { promptSha, bytes: cachedContent.byteLength, path: cachePath },
        "🎯 Cache HIT - Serving cached content",
      );
      return c.json(JSON.parse(new TextDecoder().decode(cachedContent)), {
        headers: { "X-Disk-Cache": "HIT" },
      });
    } catch {
      logger.info(
        { promptSha, path: cachePath },
        "❌ Cache MISS - Extracting new content",
      );
    }

    try {
      const response = await fetch(JINA_API_ENDPOINT, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.JINA_API_KEY}`,
        },
        body: JSON.stringify({
          url,
          ...options,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          {
            status: response.status,
            error: errorText,
            headers: Object.fromEntries(response.headers.entries()),
          },
          "Jina API request failed",
        );
        return c.json({ error: "Failed to extract content" }, 500);
      }

      const result = await response.json();
      logger.info({ result }, "Content extracted successfully");

      // Transform the response to match our API schema
      const transformedResult = {
        content: result.data.content,
        metadata: {
          title: result.data.title,
          date: result.data.publishedTime,
          word_count: Math.floor(result.data.usage.tokens * 0.75),
        },
      };

      // Save to cache
      await ensureDir(CACHE_DIR);
      await Deno.writeFile(
        cachePath,
        new TextEncoder().encode(JSON.stringify(transformedResult)),
      );
      logger.info({ promptSha }, "Content cached");

      return c.json(transformedResult, {
        headers: { "X-Disk-Cache": "MISS" },
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
      }, "Content extraction failed");
      return c.json({ error: "Failed to extract content" }, 500);
    }
  };
