const BLOBBY_BASE_URL =
  process.env.BLOBBY_BASE_URL || "https://toolshed.commontools.dev/api/storage/blobby";

export const getAllBlobs = async () => {
  const response = await fetch(`${BLOBBY_BASE_URL}?all=true&prefix=spell-`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Failed to fetch blobs");
  const data = await response.json();
  return data.blobs as string[];
};

export const getAllSellbookBlobs = async () => {
  const response = await fetch(`${BLOBBY_BASE_URL}?search=spellbookTitle&prefix=spell-`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Failed to fetch blobs");
  const data = await response.json();
  return data.blobs as string[];
};

// NOTE(jake): This uses tailscale auth to transparently filter on my user.
export const getMyBlobs = async () => {
  const response = await fetch(`${BLOBBY_BASE_URL}?prefix=spell-`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Failed to fetch blobs");
  const data = await response.json();
  return data.blobs as string[];
};

export const getBlobByHash = async (hash: string) => {
  const response = await fetch(`${BLOBBY_BASE_URL}/${hash}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    console.error("Response not ok for hash:", hash);
    throw new Error("Failed to fetch blob");
  }

  // First get the text content
  const text = await response.text();

  try {
    // Then try to parse it as JSON
    const parsed = JSON.parse(text);
    return parsed;
  } catch (error) {
    console.error("Failed to parse blob response for hash:", hash);
    console.error("Parse error:", error);
    throw new Error("Invalid blob data");
  }
};
