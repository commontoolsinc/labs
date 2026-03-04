/**
 * Airtable API client with automatic token refresh and retry logic.
 *
 * Usage:
 * ```typescript
 * import { AirtableClient } from "./util/airtable-client.ts";
 *
 * const client = new AirtableClient(authCell, { debugMode: true });
 * const bases = await client.listBases();
 * const tables = await client.listTables(baseId);
 * const records = await client.listRecords(baseId, tableId);
 * ```
 */
import { getPatternEnvironment, Writable } from "commontools";

const env = getPatternEnvironment();

import type { AirtableAuth as AirtableAuthType } from "../airtable-auth.tsx";

// ============================================================================
// TYPES
// ============================================================================

export interface AirtableClientConfig {
  retries?: number;
  delay?: number;
  debugMode?: boolean;
  /** External refresh callback for cross-piece token refresh */
  onRefresh?: () => Promise<void>;
}

export interface AirtableBase {
  id: string;
  name: string;
  permissionLevel: string;
}

export interface AirtableTable {
  id: string;
  name: string;
  description?: string;
  primaryFieldId: string;
  fields: AirtableField[];
}

export interface AirtableField {
  id: string;
  name: string;
  type: string;
  description?: string;
  options?: Record<string, unknown>;
}

export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

export interface ListRecordsOptions {
  pageSize?: number;
  maxRecords?: number;
  view?: string;
  filterByFormula?: string;
  sort?: Array<{ field: string; direction?: "asc" | "desc" }>;
  fields?: string[];
}

// ============================================================================
// HELPERS
// ============================================================================

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function debugLog(debugMode: boolean, ...args: unknown[]) {
  if (debugMode) console.log("[AirtableClient]", ...args);
}

// ============================================================================
// CLIENT
// ============================================================================

const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
const AIRTABLE_META_BASE = "https://api.airtable.com/v0/meta";

export class AirtableClient {
  private authCell: Writable<AirtableAuthType>;
  private retries: number;
  private delay: number;
  private debugMode: boolean;
  private onRefresh?: () => Promise<void>;

  constructor(
    authCell: Writable<AirtableAuthType>,
    config: AirtableClientConfig = {},
  ) {
    this.authCell = authCell;
    this.retries = config.retries ?? 2;
    this.delay = config.delay ?? 1000;
    this.debugMode = config.debugMode ?? false;
    this.onRefresh = config.onRefresh;
  }

  private getToken(): string {
    const auth = this.authCell.get();
    return auth?.accessToken || "";
  }

  /**
   * Make an authenticated API request with retry and token refresh.
   */
  private async request<T>(
    url: string,
    options: RequestInit = {},
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const token = this.getToken();
      if (!token) {
        throw new Error("No access token available");
      }

      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...options.headers,
          },
        });

        if (response.status === 401) {
          debugLog(this.debugMode, "Got 401, attempting token refresh...");
          await this.refreshToken();
          continue;
        }

        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const waitMs = retryAfter
            ? parseInt(retryAfter) * 1000
            : this.delay * (attempt + 1);
          debugLog(
            this.debugMode,
            `Rate limited, waiting ${waitMs}ms...`,
          );
          await sleep(waitMs);
          continue;
        }

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(
            `Airtable API error ${response.status}: ${errorBody}`,
          );
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.retries) {
          debugLog(
            this.debugMode,
            `Request failed (attempt ${attempt + 1}/${this.retries + 1}):`,
            lastError.message,
          );
          await sleep(this.delay);
        }
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  /**
   * Refresh the access token via the server endpoint.
   */
  private async refreshToken(): Promise<void> {
    if (this.onRefresh) {
      await this.onRefresh();
      return;
    }

    const auth = this.authCell.get();
    const refreshToken = auth?.refreshToken;
    if (!refreshToken) {
      throw new Error("No refresh token available");
    }

    const res = await fetch(
      new URL("/api/integrations/airtable-oauth/refresh", env.apiUrl),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      },
    );

    if (!res.ok) {
      throw new Error(`Token refresh failed: ${res.status}`);
    }

    const json = await res.json();
    if (!json.tokenInfo) {
      throw new Error("Invalid refresh response");
    }

    this.authCell.update({
      ...json.tokenInfo,
      user: auth.user,
    });

    debugLog(this.debugMode, "Token refreshed successfully");
  }

  // ==========================================================================
  // API METHODS
  // ==========================================================================

  /**
   * List all accessible bases.
   */
  async listBases(): Promise<AirtableBase[]> {
    debugLog(this.debugMode, "Listing bases...");

    const bases: AirtableBase[] = [];
    let offset: string | undefined;

    do {
      const url = new URL(`${AIRTABLE_META_BASE}/bases`);
      if (offset) url.searchParams.set("offset", offset);

      const response = await this.request<{
        bases: AirtableBase[];
        offset?: string;
      }>(url.toString());

      bases.push(...response.bases);
      offset = response.offset;
    } while (offset);

    debugLog(this.debugMode, `Found ${bases.length} bases`);
    return bases;
  }

  /**
   * List all tables in a base.
   */
  async listTables(baseId: string): Promise<AirtableTable[]> {
    debugLog(this.debugMode, `Listing tables for base ${baseId}...`);

    const response = await this.request<{ tables: AirtableTable[] }>(
      `${AIRTABLE_META_BASE}/bases/${baseId}/tables`,
    );

    debugLog(this.debugMode, `Found ${response.tables.length} tables`);
    return response.tables;
  }

  /**
   * List records from a table with pagination.
   */
  async listRecords(
    baseId: string,
    tableIdOrName: string,
    options: ListRecordsOptions = {},
  ): Promise<AirtableRecord[]> {
    debugLog(
      this.debugMode,
      `Listing records from ${baseId}/${tableIdOrName}...`,
    );

    const records: AirtableRecord[] = [];
    let offset: string | undefined;
    const maxRecords = options.maxRecords ?? 1000;

    do {
      const url = new URL(
        `${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(tableIdOrName)}`,
      );

      if (options.pageSize) {
        url.searchParams.set(
          "pageSize",
          String(Math.min(options.pageSize, 100)),
        );
      }
      if (offset) url.searchParams.set("offset", offset);
      if (options.view) url.searchParams.set("view", options.view);
      if (options.filterByFormula) {
        url.searchParams.set("filterByFormula", options.filterByFormula);
      }
      if (options.fields) {
        for (const field of options.fields) {
          url.searchParams.append("fields[]", field);
        }
      }
      if (options.sort) {
        for (let i = 0; i < options.sort.length; i++) {
          url.searchParams.set(`sort[${i}][field]`, options.sort[i].field);
          if (options.sort[i].direction) {
            url.searchParams.set(
              `sort[${i}][direction]`,
              options.sort[i].direction!,
            );
          }
        }
      }

      const response = await this.request<{
        records: AirtableRecord[];
        offset?: string;
      }>(url.toString());

      records.push(...response.records);
      offset = response.offset;

      if (records.length >= maxRecords) {
        break;
      }
    } while (offset);

    const result = records.slice(0, maxRecords);
    debugLog(this.debugMode, `Fetched ${result.length} records`);
    return result;
  }
}
