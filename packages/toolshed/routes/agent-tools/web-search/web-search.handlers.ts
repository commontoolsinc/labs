import type { AppRouteHandler } from "@/lib/types.ts";
import type { WebSearchRoute } from "./web-search.routes.ts";
import env from "@/env.ts";
import { sha256 } from "@/lib/sha2.ts";
import { ensureDir } from "@std/fs";

const CACHE_DIR = `${env.CACHE_DIR}/agent-tools-web-search`;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes in milliseconds

// Web search is backed by Google Search grounding via the gateway (Gemini),
// replacing the former Jina Search dependency. We send the query with the
// `google_search` tool and read the REAL search hits from the response's
// `grounding_metadata.groundingChunks` — these are actual results, not the
// model's prose (which hallucinates URLs). Each chunk's `web.uri` is a Google
// redirect that we follow to the real destination (which also validates it).
const GROUNDED_SEARCH_MODEL = "gemini-3.5-flash";
const RESOLVE_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146 Safari/537.36";

// Review/directory/aggregator/social brands to skip so we prefer a business's
// OWN site. Grounding sometimes ranks these above the official homepage; when a
// chunk resolves to one, we fall through to the next chunk. Matched by domain
// *label* (any TLD), so `yellowpages.do`, `yellowpages.ca`, etc. all count.
const AGGREGATOR_BRANDS: ReadonlySet<string> = new Set([
  "yelp",
  "tripadvisor",
  "opentable",
  "threebestrated",
  "checkle",
  "wanderboat",
  "placejoys",
  "restaurantji",
  "yellowpages",
  "mapquest",
  "grubhub",
  "doordash",
  "ubereats",
  "postmates",
  "seamless",
  "zomato",
  "allmenus",
  "menupix",
  "foursquare",
  "facebook",
  "instagram",
  "nextdoor",
  "reddit",
  "wikipedia",
  "google",
  "bing",
  "yahoo",
  "mapcarta",
  "chamberofcommerce",
  "loopnet",
  "bbb",
  "trustpilot",
  "interstatelogos",
  "menuism",
  "menupages",
  "zmenu",
  "sirved",
  "yellowbook",
  "manta",
  "citysearch",
  "ezlocal",
  "hotfrog",
  "n49",
  "twitter",
  "linkedin",
  "pinterest",
  "tiktok",
  "youtube",
]);

function isAggregatorHost(host: string): boolean {
  // Any label of the host matching a known aggregator brand disqualifies it
  // (e.g. "www.yellowpages.do" → label "yellowpages").
  return host.toLowerCase().split(".").some((label) =>
    AGGREGATOR_BRANDS.has(label)
  );
}

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

/** Pull groundingChunks out of a gateway chat-completion response. */
function extractGroundingChunks(completion: unknown): GroundingChunk[] {
  const gm = (completion as {
    choices?: Array<{ message?: { grounding_metadata?: unknown } }>;
  })?.choices?.[0]?.message?.grounding_metadata as
    | { groundingChunks?: unknown }
    | undefined;
  const chunks = gm?.groundingChunks;
  return Array.isArray(chunks) ? (chunks as GroundingChunk[]) : [];
}

/**
 * Follow a Google grounding redirect to its real destination, returning the
 * final URL only if it resolves to a reachable, non-Google http(s) page. This
 * both de-references the redirect AND validates the candidate in one request.
 */
async function resolveGroundingUrl(
  redirectUrl: string,
): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(redirectUrl, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": RESOLVE_UA },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    // Drain the body so the connection can be reused/closed promptly.
    await res.body?.cancel();
    if (res.status >= 400) return null;
    const finalUrl = res.url || redirectUrl;
    const host = new URL(finalUrl).host.toLowerCase();
    if (host.includes("vertexaisearch")) return null; // never left the redirect
    if (isAggregatorHost(host)) return null; // prefer the business's own site
    return finalUrl;
  } catch {
    return null;
  }
}

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
    // Grounded search: send the query to Gemini with the `google_search` tool
    // and read the REAL search hits from `grounding_metadata.groundingChunks`
    // (NOT the model's prose, which hallucinates URLs). Each chunk's `web.uri`
    // is a Google redirect we follow to the real destination — which also
    // validates reachability.
    const gatewayUrl = env.CFTS_AI_GATEWAY_URL.replace(/\/+$/, "");

    const runGroundedSearch = async (): Promise<{
      chunks: GroundingChunk[];
      finishReason: string | undefined;
    }> => {
      const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer gateway-internal",
        },
        body: JSON.stringify({
          model: GROUNDED_SEARCH_MODEL,
          messages: [{ role: "user", content: query }],
          tools: [{ type: "google_search", google_search: {} }],
          stream: false,
        }),
      });
      if (!res.ok) {
        throw new Error(`gateway ${res.status}: ${await res.text()}`);
      }
      const json = await res.json();
      return {
        chunks: extractGroundingChunks(json),
        finishReason: json?.choices?.[0]?.finish_reason as string | undefined,
      };
    };

    // A search occasionally trips Vertex's content filter (no grounding).
    // Retry once before giving up.
    let chunks: GroundingChunk[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      let finishReason: string | undefined;
      try {
        const r = await runGroundedSearch();
        chunks = r.chunks;
        finishReason = r.finishReason;
      } catch (e) {
        logger.error(
          { attempt, err: String(e) },
          "Grounded search call failed",
        );
        if (attempt === 2) return c.json({ error: "Search failed" }, 500);
        continue;
      }
      if (chunks.length > 0) break;
      logger.warn(
        { attempt, finishReason },
        "No grounding chunks returned; retrying",
      );
    }

    // Resolve each chunk's redirect to its real URL (dedup by host, validate),
    // stopping once we have max_results reachable sources.
    const seenHosts = new Set<string>();
    const results: Array<
      { title: string; url: string; description: string; content: string }
    > = [];
    for (const chunk of chunks) {
      if (results.length >= max_results) break;
      const redirect = chunk?.web?.uri;
      if (typeof redirect !== "string" || !redirect) continue;
      const url = await resolveGroundingUrl(redirect);
      if (!url) continue;
      const host = new URL(url).host.toLowerCase();
      if (seenHosts.has(host)) continue;
      seenHosts.add(host);
      const title =
        typeof chunk.web?.title === "string" && chunk.web.title.trim()
          ? chunk.web.title.trim()
          : host;
      results.push({ title, url, description: "", content: "" });
    }

    const transformedResult = {
      query,
      results,
      total_results: results.length,
    };

    logger.info(
      { query, chunks: chunks.length, count: results.length },
      "Grounded web search completed",
    );

    // Cache only non-empty result sets, so a transient empty/filtered
    // generation doesn't pin zero results for the whole TTL.
    if (results.length > 0) {
      await ensureDir(CACHE_DIR);
      await Deno.writeFile(
        cachePath,
        new TextEncoder().encode(JSON.stringify(transformedResult)),
      );
      logger.info({ promptSha }, "Search results cached");
    }

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
