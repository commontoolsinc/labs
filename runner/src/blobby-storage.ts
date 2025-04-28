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
