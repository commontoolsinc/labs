/**
 * Parse a shared per-space host route. Storage and compute requests use the
 * same route, so only HTTP and HTTPS base URLs are valid.
 */
export const normalizeSpaceHost = (host: string | URL): URL => {
  const parsed = new URL(host);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(
      `Unsupported space host protocol: ${parsed.protocol}`,
    );
  }
  return parsed;
};
