/** Parses optional public configuration for the co-presence WebSocket. */
export function optionalPresenceUrl(
  value: string | undefined,
): URL | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("PRESENCE_URL requires a WebSocket URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "PRESENCE_URL must not contain credentials, query data, or a fragment",
    );
  }
  return url;
}
