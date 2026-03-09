/// <cts-enable />
import {
  computed,
  Default,
  derive,
  fetchData,
  handler,
  ifElse,
  NAME,
  pattern,
  str,
  UI,
  Writable,
} from "commontools";
import {
  createGoogleAuth,
  type ScopeKey,
} from "./util/google-auth-manager.tsx";
import {
  type GoogleContact,
  parseConnection,
} from "./util/google-contacts-client.ts";

export type { Auth } from "./google-calendar-importer.tsx";
import type { Auth } from "./google-calendar-importer.tsx";

export type { GoogleContact };

type CFC<T, C extends string> = T;
type Confidential<T> = CFC<T, "confidential">;

type Settings = {
  // Maximum number of contacts to fetch
  maxContacts: Default<number, 100>;
  // Enable verbose console logging for debugging
  debugMode: Default<boolean, false>;
};

const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations";

// ============================================================================
// Tail-call pagination sub-pattern
//
// Each instance fetches one page via fetchData, then conditionally instantiates
// itself with the next pageToken inside a derive(). This avoids holding a
// storage transaction open across multiple async pages.
//
// TODO(#1305): switch to ifElse when the scheduler supports pull scheduling (both-branches bug)
//
// KNOWN RISKS (CT-1305 experiment):
// - O(n×p) storage: accumulated array is copied into a cell at each recursion
//   level. 500 contacts across 5 pages = ~1500 objects persisted across levels.
// - Silent partial results: if a page fetch fails (401/429), pagination stops
//   and returns whatever was accumulated so far — no error signal to the caller.
// - No retry/backoff: fetchData doesn't retry on 429. Pagination halts on rate limit.
// - Token refresh = full restart: if auth token changes mid-pagination, the entire
//   recursive chain tears down and restarts from page 1.
// ============================================================================

interface PageInput {
  token: string;
  pageToken: Default<string, "">;
  accumulated: Default<GoogleContact[], []>;
  maxContacts: Default<number, 100>;
  personFields: string;
}

interface PageOutput {
  contacts: GoogleContact[];
  pending: boolean;
}

// deno-lint-ignore no-explicit-any
const FetchContactsPage: any = pattern<PageInput, PageOutput>(
  ({ token, pageToken, accumulated, maxContacts, personFields }) => {
    const url = computed(() => {
      if (!token) return "";
      const u = new URL(
        "https://people.googleapis.com/v1/people/me/connections",
      );
      u.searchParams.set("personFields", personFields);
      u.searchParams.set("pageSize", String(Math.min(maxContacts, 100)));
      u.searchParams.set("sortOrder", "LAST_NAME_ASCENDING");
      u.searchParams.set("access_token", String(token));
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      return u.toString();
    });

    const page = fetchData({ url, mode: "json", options: {} });

    return derive(
      {
        pageResult: page.result,
        pageError: page.error,
        pagePending: page.pending,
        accumulated,
        token,
        maxContacts,
      },
      ({
        pageResult,
        pageError,
        pagePending,
        accumulated,
        token: tokenVal,
        maxContacts: maxVal,
      }: {
        pageResult: any;
        pageError: any;
        pagePending: boolean;
        accumulated: GoogleContact[];
        token: string;
        maxContacts: number;
      }): PageOutput => {
        // No token means no fetch was initiated — not pending
        if (!tokenVal) {
          return { contacts: accumulated || [], pending: false };
        }
        if (pagePending || !pageResult) {
          return { contacts: accumulated || [], pending: true };
        }
        if (pageError) {
          return { contacts: accumulated || [], pending: false };
        }

        const connections = (pageResult.connections || []).map(
          parseConnection,
        );
        const combined = [...(accumulated || []), ...connections];

        if (combined.length >= maxVal || !pageResult.nextPageToken) {
          return {
            contacts: combined.slice(0, maxVal),
            pending: false,
          };
        }

        // TAIL CALL — recursive sub-pattern instantiation
        return FetchContactsPage({
          token,
          pageToken: pageResult.nextPageToken,
          accumulated: combined,
          maxContacts,
          personFields,
        }) as any;
      },
    );
  },
);

const toggleShowContacts = handler<
  unknown,
  { showContacts: Writable<boolean> }
>(
  (_, { showContacts }) => {
    showContacts.set(!showContacts.get());
  },
);

const startFetch = handler<unknown, { shouldFetch: Writable<boolean> }>(
  (_, { shouldFetch }) => {
    shouldFetch.set(true);
  },
);

interface GoogleContactsImporterInput {
  settings?: Default<Settings, {
    maxContacts: 100;
    debugMode: false;
  }>;
  // Optional: Link auth directly from a Google Auth piece when wish() is unavailable
  // Use: ct piece link googleAuthPiece/auth contactsImporterPiece/overrideAuth
  overrideAuth?: Auth;
}

/** Google Contacts importer via People API. #googleContacts */
interface Output {
  contacts: GoogleContact[];
  contactCount: number;
  summary: string;
  mentionable: { name: string; email: string; org: string }[];
}

const GoogleContactsImporter = pattern<GoogleContactsImporterInput, Output>(
  ({ settings, overrideAuth }) => {
    const shouldFetch = Writable.of(false);
    const showContacts = Writable.of(false); // Collapsed by default

    // Use createGoogleAuth utility for auth management
    const {
      auth: wishedAuth,
      fullUI,
      isReady: wishedIsReady,
      currentEmail: wishedCurrentEmail,
    } = createGoogleAuth({
      requiredScopes: ["contacts"] as ScopeKey[],
    });

    // Check if overrideAuth is provided (for manual linking when wish() is unavailable)
    const hasLinkedAuth = computed(() => !!(overrideAuth?.token));
    const overrideAuthEmail = computed(() => overrideAuth?.user?.email || "");

    // Use overrideAuth if provided, otherwise use wished auth
    const overrideAuthCell = Writable.of<Auth | null>(null);
    computed(() => {
      if (overrideAuth?.token) {
        overrideAuthCell.set(overrideAuth as any);
      }
    });

    // Choose auth source based on overrideAuth availability
    const auth = ifElse(hasLinkedAuth, overrideAuthCell, wishedAuth) as any;
    const isReady = ifElse(hasLinkedAuth, hasLinkedAuth, wishedIsReady);
    const currentEmail = ifElse(
      hasLinkedAuth,
      overrideAuthEmail,
      wishedCurrentEmail,
    );

    // Gate: only pass token when shouldFetch is true, otherwise empty string
    // causes fetchData to no-op (empty URL).
    const activeToken = computed(
      () => (shouldFetch.get() ? auth?.token || "" : ""),
    );

    const fetchResult = FetchContactsPage({
      token: activeToken,
      pageToken: "",
      accumulated: [],
      maxContacts: settings.maxContacts,
      personFields: PERSON_FIELDS,
    });

    const contacts = fetchResult.contacts;
    const fetching = fetchResult.pending;

    const contactCount = derive(
      contacts,
      (list: GoogleContact[]) => list?.length || 0,
    );

    const summary = derive(contacts, (list: GoogleContact[]) => {
      return list
        .slice(0, 30)
        .map((c) => {
          const parts = [c.displayName];
          const email = c.emails?.[0]?.value;
          if (email) parts.push(email);
          const org = c.organizations?.[0]?.name;
          if (org) parts.push(org);
          return parts.join(" ");
        })
        .filter((s) => s.length > 0)
        .join(" | ");
    });

    const mentionable = derive(contacts, (list: GoogleContact[]) => {
      return list.map((c) => ({
        name: c.displayName,
        email: c.emails?.[0]?.value || "",
        org: c.organizations?.[0]?.name || "",
      }));
    });

    return {
      [NAME]: str`Contacts Importer ${currentEmail}`,
      [UI]: (
        <ct-screen>
          <div slot="header">
            <ct-hstack align="center" gap="2">
              <ct-heading level={3}>Google Contacts Importer</ct-heading>
            </ct-hstack>
          </div>

          <ct-vscroll flex showScrollbar>
            <ct-vstack padding="6" gap="4">
              {/* Auth status - handled by createGoogleAuth utility */}
              {fullUI}

              <h3 style={{ fontSize: "18px", fontWeight: "bold" }}>
                Imported contact count: {contactCount}
              </h3>

              <ct-vstack gap="4">
                <div>
                  <label
                    style={{
                      display: "block",
                      marginBottom: "4px",
                      fontSize: "14px",
                    }}
                  >
                    Max Contacts
                  </label>
                  <ct-input
                    type="number"
                    $value={settings.maxContacts}
                    placeholder="100"
                  />
                </div>

                {ifElse(
                  isReady,
                  <ct-button
                    type="button"
                    onClick={startFetch({ shouldFetch })}
                    disabled={fetching}
                  >
                    {ifElse(
                      fetching,
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <ct-loader size="sm" show-elapsed></ct-loader>
                        Fetching...
                      </span>,
                      "Fetch Contacts",
                    )}
                  </ct-button>,
                  null,
                )}
              </ct-vstack>

              {/* Collapsible contacts list */}
              <div style={{ marginTop: "16px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    cursor: "pointer",
                  }}
                  onClick={toggleShowContacts({ showContacts })}
                >
                  <span style={{ fontSize: "14px" }}>
                    {ifElse(showContacts, "▼", "▶")}
                  </span>
                  <h4 style={{ fontSize: "16px", margin: 0 }}>
                    {derive(
                      contacts,
                      (list: GoogleContact[]) =>
                        `${list.length} contacts imported`,
                    )}
                  </h4>
                </div>
                {ifElse(
                  showContacts,
                  <div
                    style={{
                      marginTop: "12px",
                      maxHeight: "400px",
                      overflowY: "auto",
                      border: "1px solid #e5e7eb",
                      borderRadius: "8px",
                    }}
                  >
                    {contacts.map((contact: any) => (
                      <div
                        style={{
                          padding: "8px 12px",
                          borderBottom: "1px solid #f3f4f6",
                          fontSize: "13px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                          }}
                        >
                          <span style={{ fontWeight: "500" }}>
                            {contact.displayName}
                          </span>
                          {contact.organizations.map((org: any) => (
                            <span
                              style={{
                                padding: "2px 8px",
                                borderRadius: "12px",
                                backgroundColor: "#e0e7ff",
                                color: "#3730a3",
                                fontSize: "11px",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {org.name}
                              {ifElse(
                                computed(() => !!(org.title as any)),
                                <span>- {org.title}</span>,
                                null,
                              )}
                            </span>
                          ))}
                        </div>
                        <div
                          style={{
                            color: "#6b7280",
                            fontSize: "12px",
                            marginTop: "4px",
                          }}
                        >
                          {contact.emails.map((email: any) => (
                            <span style={{ marginRight: "12px" }}>
                              {email.value}
                            </span>
                          ))}
                          {contact.phoneNumbers.map((phone: any) => (
                            <span style={{ marginRight: "12px" }}>
                              {phone.value}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>,
                  <p
                    style={{
                      fontSize: "12px",
                      color: "#666",
                      marginTop: "8px",
                    }}
                  >
                    Click to expand contact list.
                  </p>,
                )}
              </div>
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
      contacts,
      contactCount,
      summary,
      mentionable,
    };
  },
);

export default GoogleContactsImporter;
