/** Encode the canonical identity of one GitHub connector destination. */
export function encodeGithubTargetIdentity(
  apiUrl: string,
  spaceDid: string,
  source: string,
): Uint8Array {
  const endpoint = new URL(apiUrl);
  endpoint.username = "";
  endpoint.password = "";
  endpoint.hash = "";
  endpoint.search = "";
  endpoint.pathname = "/";
  return new TextEncoder().encode(
    `${endpoint.href}\n${spaceDid}\n${source.toLowerCase()}`,
  );
}
