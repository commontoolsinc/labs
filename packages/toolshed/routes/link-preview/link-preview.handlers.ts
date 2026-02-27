import type { AppRouteHandler } from "@/lib/types.ts";
import type { GetLinkPreviewRoute } from "./link-preview.routes.ts";
import env from "@/env.ts";
import { sha256 } from "@/lib/sha2.ts";
import { ensureDir } from "@std/fs";

const CACHE_DIR = `${env.CACHE_DIR}/link-preview`;
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

function extractMetaTag(
  html: string,
  property: string,
  isOgTag = true,
): string | undefined {
  // Try Open Graph property format first
  if (isOgTag) {
    const ogRegex = new RegExp(
      `<meta\\s+property=["']${property}["']\\s+content=["']([^"']+)["']`,
      "i",
    );
    const ogMatch = html.match(ogRegex);
    if (ogMatch?.[1]) return ogMatch[1];
  }

  // Try name attribute format
  const nameRegex = new RegExp(
    `<meta\\s+name=["']${property}["']\\s+content=["']([^"']+)["']`,
    "i",
  );
  const nameMatch = html.match(nameRegex);
  if (nameMatch?.[1]) return nameMatch[1];

  // Try reversed attribute order (content before property/name)
  if (isOgTag) {
    const ogRevRegex = new RegExp(
      `<meta\\s+content=["']([^"']+)["']\\s+property=["']${property}["']`,
      "i",
    );
    const ogRevMatch = html.match(ogRevRegex);
    if (ogRevMatch?.[1]) return ogRevMatch[1];
  }

  const nameRevRegex = new RegExp(
    `<meta\\s+content=["']([^"']+)["']\\s+name=["']${property}["']`,
    "i",
  );
  const nameRevMatch = html.match(nameRevRegex);
  return nameRevMatch?.[1];
}

function extractTitle(html: string): string | undefined {
  const titleRegex = /<title[^>]*>([^<]+)<\/title>/i;
  const match = html.match(titleRegex);
  return match?.[1]?.trim();
}

function extractFavicon(html: string): string | undefined {
  // Try icon link
  const iconRegex =
    /<link[^>]+rel=["'](?:icon|shortcut icon)["'][^>]+href=["']([^"']+)["']/i;
  const iconMatch = html.match(iconRegex);
  if (iconMatch?.[1]) return iconMatch[1];

  // Try reversed attribute order
  const iconRevRegex =
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:icon|shortcut icon)["']/i;
  const iconRevMatch = html.match(iconRevRegex);
  return iconRevMatch?.[1];
}

function resolveUrl(
  relative: string | undefined,
  base: string,
): string | undefined {
  if (!relative) return undefined;

  try {
    // If it's already absolute, return it
    if (relative.startsWith("http://") || relative.startsWith("https://")) {
      return relative;
    }

    // Resolve relative URL against base
    const resolved = new URL(relative, base);
    return resolved.href;
  } catch {
    return undefined;
  }
}

export const getLinkPreview: AppRouteHandler<GetLinkPreviewRoute> = async (
  c,
) => {
  const logger = c.get("logger");

  // Strip {.+} suffix that scalar client may add
  let url = c.req.param("url").split("{")[0];
  url = decodeURIComponent(url);

  // Validate URL format
  try {
    new URL(url);
  } catch {
    return c.json({ error: "Invalid URL format" }, 400);
  }

  const urlHash = await sha256(url);
  const cachePath = `${CACHE_DIR}/${urlHash}.json`;

  logger.info({ url, urlHash }, "Starting link preview extraction");

  // Check cache first
  try {
    const cachedContent = await Deno.readFile(cachePath);
    const isValid = await isValidCache(cachePath);

    if (!isValid) {
      logger.info(
        { urlHash, path: cachePath },
        "Cache expired - Fetching new preview",
      );
      throw new Error("Cache expired");
    }

    logger.info(
      { urlHash, bytes: cachedContent.byteLength, path: cachePath },
      "Cache HIT - Serving cached preview",
    );
    return c.json(JSON.parse(new TextDecoder().decode(cachedContent)), {
      headers: {
        "X-Disk-Cache": "HIT",
      },
    });
  } catch {
    logger.info(
      { urlHash, path: cachePath },
      "Cache MISS - Fetching new preview",
    );
  }

  // Fetch the URL
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; CommonToolsBot/1.0; +https://commontools.org)",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.error(
        { status: response.status, url },
        "Failed to fetch URL",
      );
      return c.json(
        { error: `Failed to fetch URL: HTTP ${response.status}` },
        500,
      );
    }

    const html = await response.text();

    // Extract metadata
    const title = extractMetaTag(html, "og:title") || extractTitle(html);
    const description = extractMetaTag(html, "og:description") ||
      extractMetaTag(html, "description", false);
    const imageRaw = extractMetaTag(html, "og:image");
    const faviconRaw = extractFavicon(html);
    const siteName = extractMetaTag(html, "og:site_name");

    // Resolve relative URLs
    const image = resolveUrl(imageRaw, url);
    let favicon = resolveUrl(faviconRaw, url);

    // If no favicon found, try /favicon.ico at domain root
    if (!favicon) {
      try {
        const urlObj = new URL(url);
        const rootFavicon = `${urlObj.protocol}//${urlObj.host}/favicon.ico`;

        // Check if favicon exists
        const faviconResponse = await fetch(rootFavicon, {
          method: "HEAD",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; CommonToolsBot/1.0; +https://commontools.org)",
          },
        });

        if (faviconResponse.ok) {
          favicon = rootFavicon;
        }
      } catch {
        // Ignore favicon fetch errors
      }
    }

    const result = {
      title,
      description,
      image,
      favicon,
      siteName,
      url,
    };

    logger.info({ result }, "Link preview extracted successfully");

    // Save to cache
    await ensureDir(CACHE_DIR);
    await Deno.writeFile(
      cachePath,
      new TextEncoder().encode(JSON.stringify(result)),
    );
    logger.info({ urlHash }, "Preview cached");

    return c.json(result, {
      headers: {
        "X-Disk-Cache": "MISS",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.error({ url }, "Request timeout");
      return c.json({ error: "Request timeout" }, 500);
    }

    logger.error(
      {
        error: error instanceof Error
          ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
          : String(error),
      },
      "Link preview extraction failed",
    );
    return c.json({ error: "Failed to extract link preview" }, 500);
  }
};
