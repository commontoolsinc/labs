/**
 * Google Contacts (People API) client with automatic token refresh and retry logic.
 *
 * Usage:
 * ```typescript
 * import { GoogleContactsClient } from "./util/google-contacts-client.ts";
 *
 * const client = new GoogleContactsClient(authCell, { debugMode: true });
 * const contacts = await client.fetchAllContacts(200);
 * ```
 */
import { getPatternEnvironment, Writable } from "commontools";

const env = getPatternEnvironment();

export type { Auth } from "../google-calendar-importer.tsx";
import type { Auth } from "../google-calendar-importer.tsx";

// ============================================================================
// TYPES
// ============================================================================

export interface GoogleContactsClientConfig {
  retries?: number;
  delay?: number;
  delayIncrement?: number;
  debugMode?: boolean;
}

export interface GoogleContact {
  resourceName: string;
  displayName: string;
  givenName: string;
  familyName: string;
  emails: Array<{ value: string; type: string }>;
  phoneNumbers: Array<{ value: string; type: string }>;
  addresses: Array<{
    formattedValue: string;
    type: string;
    city: string;
    region: string;
    country: string;
  }>;
  organizations: Array<{ name: string; title: string }>;
  birthdays: Array<{ date: { year: number; month: number; day: number } }>;
  photos: Array<{ url: string }>;
  biographies: Array<{ value: string }>;
  relations: Array<{ person: string; type: string }>;
}

// ============================================================================
// HELPERS
// ============================================================================

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function debugLog(debugMode: boolean, ...args: unknown[]) {
  if (debugMode) console.log("[ContactsClient]", ...args);
}

function debugWarn(debugMode: boolean, ...args: unknown[]) {
  if (debugMode) console.warn("[ContactsClient]", ...args);
}

// Fields to request from the People API
const DEFAULT_PERSON_FIELDS = [
  "names",
  "emailAddresses",
  "phoneNumbers",
  "addresses",
  "organizations",
  "birthdays",
  "photos",
  "biographies",
  "relations",
].join(",");

// ============================================================================
// PARSE HELPERS (module-scope for compiler compliance)
// ============================================================================

export function parseConnection(raw: any): GoogleContact {
  const names = raw.names || [];
  const primaryName = names[0] || {};

  return {
    resourceName: raw.resourceName || "",
    displayName: primaryName.displayName || "",
    givenName: primaryName.givenName || "",
    familyName: primaryName.familyName || "",
    emails: (raw.emailAddresses || []).map((e: any) => ({
      value: e.value || "",
      type: e.type || "",
    })),
    phoneNumbers: (raw.phoneNumbers || []).map((p: any) => ({
      value: p.value || "",
      type: p.type || "",
    })),
    addresses: (raw.addresses || []).map((a: any) => ({
      formattedValue: a.formattedValue || "",
      type: a.type || "",
      city: a.city || "",
      region: a.region || "",
      country: a.country || "",
    })),
    organizations: (raw.organizations || []).map((o: any) => ({
      name: o.name || "",
      title: o.title || "",
    })),
    birthdays: (raw.birthdays || []).map((b: any) => ({
      date: {
        year: b.date?.year || 0,
        month: b.date?.month || 0,
        day: b.date?.day || 0,
      },
    })),
    photos: (raw.photos || []).map((p: any) => ({
      url: p.url || "",
    })),
    biographies: (raw.biographies || []).map((b: any) => ({
      value: b.value || "",
    })),
    relations: (raw.relations || []).map((r: any) => ({
      person: r.person || "",
      type: r.type || "",
    })),
  };
}

// ============================================================================
// GOOGLE CONTACTS CLIENT
// ============================================================================

export class GoogleContactsClient {
  private auth: Writable<Auth>;
  private retries: number;
  private delay: number;
  private delayIncrement: number;
  private debugMode: boolean;

  constructor(
    auth: Writable<Auth>,
    {
      retries = 3,
      delay = 1000,
      delayIncrement = 100,
      debugMode = false,
    }: GoogleContactsClientConfig = {},
  ) {
    this.auth = auth;
    this.retries = retries;
    this.delay = delay;
    this.delayIncrement = delayIncrement;
    this.debugMode = debugMode;
  }

  private async refreshAuth(): Promise<void> {
    const refreshToken = this.auth.get().refreshToken;
    if (!refreshToken) {
      throw new Error("No refresh token available");
    }

    debugLog(this.debugMode, "Refreshing auth token...");

    const res = await fetch(
      new URL("/api/integrations/google-oauth/refresh", env.apiUrl),
      {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
      },
    );

    if (!res.ok) {
      throw new Error("Could not acquire a refresh token.");
    }

    const json = await res.json();
    const authData = json.tokenInfo as Auth;
    this.auth.update(authData);
    debugLog(this.debugMode, "Auth token refreshed successfully");
  }

  /**
   * Fetch all contacts up to `limit`, handling pagination automatically.
   */
  async fetchAllContacts(
    limit: number = 1000,
    personFields: string = DEFAULT_PERSON_FIELDS,
  ): Promise<GoogleContact[]> {
    const allContacts: GoogleContact[] = [];
    let pageToken: string | undefined;
    const pageSize = Math.min(limit, 100);

    do {
      const url = new URL(
        "https://people.googleapis.com/v1/people/me/connections",
      );
      url.searchParams.set("personFields", personFields);
      url.searchParams.set("pageSize", pageSize.toString());
      url.searchParams.set("sortOrder", "LAST_NAME_ASCENDING");
      if (pageToken) {
        url.searchParams.set("pageToken", pageToken);
      }

      debugLog(this.debugMode, `Fetching contacts page...`);

      const res = await this.googleRequest(url);
      const json = await res.json();

      const connections = json.connections || [];
      debugLog(
        this.debugMode,
        `Got ${connections.length} contacts in this page`,
      );

      for (const raw of connections) {
        allContacts.push(parseConnection(raw));
        if (allContacts.length >= limit) break;
      }

      pageToken = json.nextPageToken;

      // No delay between pages — keep handler within transaction window
    } while (pageToken && allContacts.length < limit);

    debugLog(this.debugMode, `Total contacts fetched: ${allContacts.length}`);
    return allContacts;
  }

  private async googleRequest(
    url: URL,
    _options?: RequestInit,
    _retries?: number,
  ): Promise<Response> {
    const token = this.auth.get().token;
    if (!token) {
      throw new Error("No authorization token.");
    }

    const retries = _retries ?? this.retries;
    const options = _options ?? {};
    options.headers = new Headers(options.headers);
    options.headers.set("Authorization", `Bearer ${token}`);

    const res = await fetch(url, options);
    const { ok, status, statusText } = res;

    if (ok) {
      debugLog(this.debugMode, `${url}: ${status} ${statusText}`);
      return res;
    }

    debugWarn(
      this.debugMode,
      `${url}: ${status} ${statusText}`,
      `Remaining retries: ${retries}`,
    );

    if (retries === 0) {
      throw new Error(`People API error: ${status} ${statusText}`);
    }

    await sleep(this.delay);

    if (status === 401) {
      await this.refreshAuth();
    } else if (status === 429) {
      this.delay += this.delayIncrement;
      debugLog(
        this.debugMode,
        `Rate limited, incrementing delay to ${this.delay}`,
      );
      await sleep(this.delay);
    }

    return this.googleRequest(url, _options, retries - 1);
  }
}
