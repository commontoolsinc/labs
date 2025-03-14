const TOOLSHED_API_URL = import.meta.env.VITE_TOOLSHED_API_URL ||
  "http://localhost:8000";
const BLOBBY_BASE_URL = `${TOOLSHED_API_URL}/api/storage/blobby`;

export const getAllBlobs = async () => {
  const response = await fetch(`${BLOBBY_BASE_URL}?all=true&prefix=spell-`);
  if (!response.ok) throw new Error("Failed to fetch blobs");
  const data = await response.json();
  return data.blobs as string[];
};

export const getAllSpellbookBlobs = async () => {
  const response = await fetch(`${BLOBBY_BASE_URL}?all=true&prefix=spellbook-`);
  if (!response.ok) throw new Error("Failed to fetch blobs");
  const data = await response.json();
  return data.blobs as string[];
};

export const getMyBlobs = async () => {
  const response = await fetch(`${BLOBBY_BASE_URL}?prefix=spellbook-`);
  if (!response.ok) throw new Error("Failed to fetch blobs");
  const data = await response.json();
  return data.blobs as string[];
};

export const getBlobByHash = async (hash: string) => {
  const response = await fetch(`${BLOBBY_BASE_URL}/${hash}`);

  if (!response.ok) {
    console.error("Response not ok for hash:", hash);
    throw new Error("Failed to fetch blob");
  }

  const text = await response.text();

  try {
    const parsed = JSON.parse(text);
    return parsed;
  } catch (error) {
    console.error("Failed to parse blob response for hash:", hash);
    console.error("Parse error:", error);
    throw new Error("Invalid blob data");
  }
};
