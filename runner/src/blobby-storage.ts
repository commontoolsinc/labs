/**
 * Common utilities for interacting with the Blobby storage server.
 */

let BLOBBY_SERVER_URL = "/api/storage/blobby";

/**
 * Sets the URL for the Blobby server
 * @param url Base URL for the Blobby server
 */
export function setBlobbyServerUrl(url: string) {
  BLOBBY_SERVER_URL = new URL("/api/storage/blobby", url).toString();
}

/**
 * Gets the current Blobby server URL
 * @returns The current Blobby server URL
 */
export function getBlobbyServerUrl(): string {
  return BLOBBY_SERVER_URL;
}

/**
 * Saves an item to the Blobby server
 * @param prefix The prefix to use for the item (e.g., "spell" for recipes, "schema" for schemas)
 * @param id The ID of the item
 * @param data The data to save
 * @returns A promise that resolves to true if the save was successful, false otherwise
 */
export async function saveToBlobby(
  prefix: string,
  id: string,
  data: Record<string, any>,
): Promise<boolean> {
  console.log(`Saving ${prefix}-${id}`);
  const response = await fetch(`${BLOBBY_SERVER_URL}/${prefix}-${id}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  return response.ok;
}

/**
 * Loads an item from the Blobby server
 * @param prefix The prefix to use for the item (e.g., "spell" for recipes, "schema" for schemas)
 * @param id The ID of the item
 * @returns A promise that resolves to the loaded data or null if not found
 */
export async function loadFromBlobby<T extends Record<string, any>>(
  prefix: string,
  id: string,
): Promise<T | null> {
  const response = await fetch(`${BLOBBY_SERVER_URL}/${prefix}-${id}`);
  if (!response.ok) return null;

  try {
    return await response.json() as T;
  } catch (e) {
    const text = await response.text();
    return { src: text } as unknown as T;
  }
}

/**
 * Creates a set to track items known to storage to avoid redundant saves
 * @returns A new Set to track items
 */
export function createItemsKnownToStorageSet(): Set<string> {
  return new Set<string>();
}
