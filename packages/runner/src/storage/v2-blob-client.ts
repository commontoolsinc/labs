/**
 * V2 Blob Client
 *
 * Client-side blob upload/download with content-addressed dedup
 * and local caching. Communicates with the server's blob HTTP
 * endpoints.
 *
 * @see spec 04-protocol.md §4.9
 * @module v2-blob-client
 */

import type { SpaceId } from "@commontools/memory/v2-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BlobClientOptions {
  baseUrl: string;
  spaceId: SpaceId;
  /** Optional authorization token (UCAN) for authenticated requests. */
  authToken?: string;
}

export interface BlobUploadResult {
  hash: string;
  created: boolean; // true if newly created, false if already existed
}

// ---------------------------------------------------------------------------
// Blob Client
// ---------------------------------------------------------------------------

export class V2BlobClient {
  private readonly baseUrl: string;
  private readonly spaceId: SpaceId;
  private authToken?: string;

  /** Local cache: hash → { data, contentType } */
  private cache = new Map<string, { data: Uint8Array; contentType: string }>();

  constructor(options: BlobClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.spaceId = options.spaceId;
    this.authToken = options.authToken;
  }

  /**
   * Upload a blob to the server. Content-hash based dedup:
   * if the blob already exists, this is a no-op.
   */
  async upload(
    hash: string,
    data: Uint8Array,
    contentType: string,
  ): Promise<BlobUploadResult> {
    const url = `${this.baseUrl}/blob/${hash}`;
    const headers: Record<string, string> = {
      "Content-Type": contentType,
    };
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(url, {
      method: "PUT",
      headers,
      body: data as unknown as BodyInit,
    });

    if (response.status === 201) {
      this.cache.set(hash, { data, contentType });
      return { hash, created: true };
    }
    if (response.status === 200) {
      this.cache.set(hash, { data, contentType });
      return { hash, created: false };
    }
    if (response.status === 400) {
      throw new Error(`Blob hash mismatch for ${hash}`);
    }
    if (response.status === 413) {
      throw new Error(`Blob too large for ${hash}`);
    }
    throw new Error(
      `Blob upload failed: ${response.status} ${response.statusText}`,
    );
  }

  /**
   * Download a blob from the server. Returns from cache if available.
   */
  async download(
    hash: string,
  ): Promise<{ data: Uint8Array; contentType: string } | null> {
    // Check local cache first
    const cached = this.cache.get(hash);
    if (cached) return cached;

    const url = `${this.baseUrl}/blob/${hash}`;
    const headers: Record<string, string> = {};
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(url, { method: "GET", headers });

    if (response.status === 404) return null;
    if (response.status === 403) {
      throw new Error(`Access denied for blob ${hash}`);
    }
    if (!response.ok) {
      throw new Error(
        `Blob download failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("Content-Type") ??
      "application/octet-stream";

    // Cache locally
    this.cache.set(hash, { data, contentType });

    return { data, contentType };
  }

  /**
   * Check if a blob exists in the local cache.
   */
  has(hash: string): boolean {
    return this.cache.has(hash);
  }

  /**
   * Clear the local cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Update the auth token (e.g., after token refresh).
   */
  setAuthToken(token: string): void {
    this.authToken = token;
  }
}
