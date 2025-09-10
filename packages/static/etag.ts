/**
 * ETag generation utilities for static asset caching.
 * Uses SHA-256 content hashing for strong ETags.
 */

/**
 * Generate a strong ETag from content using SHA-256 hash.
 * Returns a base64-encoded hash in quotes.
 */
export async function generateETag(content: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", content);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return `"${base64}"`;
}

/**
 * Compare ETags for equality.
 * Supports comma-separated lists of ETags from If-None-Match headers.
 * Handles weak ETags (W/ prefix) that nginx adds when compression is applied.
 */
export function compareETags(
  etag: string,
  ifNoneMatch: string | null | undefined,
): boolean {
  if (!ifNoneMatch) return false;

  // Handle comma-separated list of ETags
  const clientETags = ifNoneMatch.split(",").map((tag) => tag.trim());

  // Strip W/ prefix for weak ETag comparison
  // Nginx adds W/ when compression is applied
  const normalizeETag = (tag: string) => {
    return tag.replace(/^W\//, "");
  };

  const serverETag = normalizeETag(etag);

  return clientETags.some((clientETag) => {
    // Handle wildcard
    if (clientETag === "*") return true;
    return normalizeETag(clientETag) === serverETag;
  });
}

/**
 * Create cache headers with ETag support.
 * Uses no-cache strategy to always validate with ETag.
 */
export function createCacheHeaders(
  etag: string,
  options: {
    noCache?: boolean;
    public?: boolean;
  } = {},
): Record<string, string> {
  const {
    noCache = true,
    public: isPublic = true,
  } = options;

  const headers: Record<string, string> = {
    "ETag": etag,
  };

  if (noCache) {
    headers["Cache-Control"] = isPublic ? "public, no-cache" : "no-cache";
  }

  return headers;
}
