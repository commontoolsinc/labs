export interface SpellSearchResult {
  key: string;
  name: string;
  description: string;
  matchType: string;
  compatibleBlobs: {
    key: string;
    snippet: string;
    data: {
      count: number;
      blobCreatedAt: string;
      blobAuthor: string;
    };
  }[];
}

export async function castSpell(replica: string, value: string) {
  const searchUrl = typeof window !== "undefined"
    ? new URL("/api/ai/spell/search", globalThis.location.origin).toString()
    : "//api/ai/spell/search";

  // Search for suggested spells based on input
  const response = await fetch(searchUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      accepts: "application/json",
    },
    body: JSON.stringify({
      replica,
      query: value,
      tags: [],
      options: {
        limit: 32,
        includeCompatibility: true,
      },
    }),
  });

  if (response.ok) {
    const searchResponse: {
      spells: {
        key: string;
        name: string;
        description: string;
        compatibleBlobs: { data: unknown; key: string; snippet: string }[];
      }[];
      blobs: string[];
    } = await response.json();
    console.log("Search response:", searchResponse);

    return searchResponse.spells as any;
  }
}
