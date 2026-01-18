/// <cts-enable />
/**
 * USPS Informed Delivery Mail Analyzer
 *
 * Processes USPS Informed Delivery emails to extract information about
 * incoming mail using LLM vision analysis.
 *
 * Features:
 * - Embeds gmail-importer directly (no separate charm needed)
 * - Pre-configured with USPS filter query and settings
 * - Auto-analyzes mail piece images with LLM vision
 * - Learns household members from recipient names over time
 * - Classifies mail type and spam likelihood
 *
 * Usage:
 * 1. Deploy a google-auth charm and complete OAuth
 * 2. Deploy this pattern
 * 3. Link: ct charm link google-auth/auth usps/linkedAuth
 */
import {
  computed,
  Default,
  generateObject,
  handler,
  JSONSchema,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import type { Schema } from "commontools/schema";
import GmailImporter, { type Auth } from "./gmail-importer.tsx";

// Debug flag for development - disable in production
const DEBUG_USPS = false;

// Email type - matches GmailImporter's Email type
interface Email {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  threadId: string;
  labelIds: string[];
  htmlContent: string;
  plainText: string;
  markdownContent: string;
}

// =============================================================================
// TYPES
// =============================================================================

type MailType =
  | "bill"
  | "advertisement"
  | "personal"
  | "package"
  | "government"
  | "subscription"
  | "charity"
  | "other";

/** A learned household member */
interface HouseholdMember {
  name: string;
  aliases: string[];
  mailCount: number;
  firstSeen: number;
  isConfirmed: boolean;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const USPS_SENDER = "informeddelivery.usps.com";

// Schema for LLM mail piece analysis
const MAIL_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    recipient: {
      type: "string",
      description: "Full name of the recipient shown on the mail piece",
    },
    sender: {
      type: "string",
      description: "Name of the sender or company (from return address)",
    },
    mailType: {
      type: "string",
      enum: [
        "bill",
        "advertisement",
        "personal",
        "package",
        "government",
        "subscription",
        "charity",
        "other",
      ],
      description: "Type/category of this mail piece",
    },
    isLikelySpam: {
      type: "boolean",
      description: "Whether this appears to be junk mail or spam",
    },
    spamConfidence: {
      type: "number",
      minimum: 0,
      maximum: 100,
      description: "Confidence score for spam classification (0-100)",
    },
    summary: {
      type: "string",
      description: "Brief one-sentence description of this mail piece",
    },
  },
  required: [
    "recipient",
    "sender",
    "mailType",
    "isLikelySpam",
    "spamConfidence",
    "summary",
  ],
} as const satisfies JSONSchema;

type MailAnalysis = Schema<typeof MAIL_ANALYSIS_SCHEMA>;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Extract image URLs/CIDs from USPS Informed Delivery email HTML content.
 *
 * USPS Informed Delivery emails embed mail piece images as inline MIME attachments
 * referenced by Content-ID (cid:). The images are NOT external URLs.
 *
 * Format in HTML: <img src="cid:1019388469-033.jpg" alt="Mailpiece Image">
 *
 * To use these images:
 * 1. gmail-importer needs to fetch attachments and resolve CID references
 * 2. Replace cid: URLs with base64 data URLs
 * 3. Then the LLM can analyze them
 *
 * For now, we extract cid: references to show what images exist, and also
 * accept base64 data URLs (if gmail-importer resolves them).
 */
function extractMailPieceImages(htmlContent: string): string[] {
  const images: string[] = [];

  // Look for img tags
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = imgRegex.exec(htmlContent)) !== null) {
    const src = match[1];

    // USPS mail piece images are inline attachments referenced by cid:
    // Example: cid:1019388469-033.jpg
    // Filter for mailpiece images (numeric ID pattern, not logos like "mailer-" or "content-")
    if (src.startsWith("cid:") && /^cid:\d+/.test(src)) {
      images.push(src);
    } // Accept base64 encoded images (resolved from cid: by gmail-importer)
    else if (src.startsWith("data:image")) {
      images.push(src);
    }
  }

  return images;
}

/**
 * Normalize a recipient name for comparison.
 */
function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Check if two names are likely the same person (fuzzy match).
 * Prefixed with _ as not currently used - preserved for future use.
 */
function _namesMatch(name1: string, name2: string): boolean {
  const n1 = normalizeName(name1);
  const n2 = normalizeName(name2);

  if (n1 === n2) return true;

  // Check if one is a substring of the other (handles initials)
  const parts1 = n1.split(" ");
  const parts2 = n2.split(" ");

  // Same last name?
  if (parts1.length > 0 && parts2.length > 0) {
    const last1 = parts1[parts1.length - 1];
    const last2 = parts2[parts2.length - 1];
    if (last1 === last2) return true;
  }

  return false;
}

// =============================================================================
// HANDLERS
// =============================================================================

// Handler to confirm a household member
// Uses cell reference with .equals() - idiomatic approach
const confirmMember = handler<
  unknown,
  { member: Writable<HouseholdMember> }
>((_event, { member }) => {
  const current = member.get();
  member.set({ ...current, isConfirmed: true });
});

// Handler to delete a household member
// Uses cell reference - pass householdMembers array and the member cell
const deleteMember = handler<
  unknown,
  {
    householdMembers: Writable<HouseholdMember[]>;
    member: Writable<HouseholdMember>;
  }
>((_event, { householdMembers, member }) => {
  householdMembers.remove(member);
});

// NOTE: No triggerAnalysis handler needed!
// generateObject must be called at pattern level (reactive), not inside handlers.
// The pattern uses .map() to process emails reactively - see mailPieceAnalyses in pattern body.

// =============================================================================
// PATTERN
// =============================================================================

interface PatternInput {
  householdMembers: Default<HouseholdMember[], []>;
  // Optional: Link auth directly from a Google Auth charm
  // Use: ct charm link googleAuthCharm/auth uspsCharm/linkedAuth
  linkedAuth?: Auth;
}

/** USPS Informed Delivery mail analyzer. #uspsInformedDelivery */
interface PatternOutput {
  mailPieces: MailAnalysis[];
  householdMembers: HouseholdMember[];
  mailCount: number;
  spamCount: number;
}

export default pattern<PatternInput, PatternOutput>(
  ({ householdMembers, linkedAuth }) => {
    // Directly instantiate GmailImporter with USPS-specific settings
    // This eliminates the need for separate gmail-importer charm + wish()
    const gmailImporter = GmailImporter({
      settings: {
        gmailFilterQuery:
          "from:USPSInformeddelivery@email.informeddelivery.usps.com",
        autoFetchOnAuth: true,
        resolveInlineImages: true,
        limit: 20,
        debugMode: DEBUG_USPS,
      },
      linkedAuth, // Pass through from USPS input (user can link google-auth here)
    });

    // Get emails directly from the embedded gmail-importer
    const allEmails = gmailImporter.emails;

    // Filter for USPS emails
    const uspsEmails = computed(() => {
      return (allEmails || []).filter((e: Email) =>
        e.from?.toLowerCase().includes(USPS_SENDER)
      );
    });

    // Count of USPS emails found
    const uspsEmailCount = computed(() => uspsEmails?.length || 0);

    // Check if connected - either linkedAuth is provided or gmailImporter found auth via wish
    // We check emailCount > 0 OR if the importer is actively fetching
    const isConnected = computed(() => {
      // If linkedAuth has a token, we're connected
      if (linkedAuth?.token) return true;
      // Otherwise check if gmailImporter has found auth (emailCount will be defined, even if 0)
      // The importer uses wish() internally to find favorited google-auth
      return gmailImporter?.emailCount !== undefined;
    });

    // ==========================================================================
    // REACTIVE LLM ANALYSIS
    // Extract images from emails and analyze them with generateObject at pattern level
    // This is the correct approach - generateObject must be called reactively, not in handlers
    // ==========================================================================

    // First, extract all mail piece images from all emails
    // Returns array of { emailId, emailDate, imageUrl } objects
    const mailPieceImages = computed(() => {
      const images: {
        emailId: string;
        emailDate: string;
        imageUrl: string;
        imageIndex: number;
      }[] = [];
      for (const email of uspsEmails || []) {
        const urls = extractMailPieceImages(email.htmlContent);
        urls.forEach((url, idx) => {
          images.push({
            emailId: email.id,
            emailDate: email.date,
            imageUrl: url,
            imageIndex: idx,
          });
        });
      }
      // Limit to first 10 images for now to avoid overwhelming LLM calls
      return images.slice(0, 10);
    });

    // Count of images to analyze
    const imageCount = computed(() => mailPieceImages?.length || 0);

    // Analyze each image with generateObject - this is called at pattern level (reactive)
    // Uses .map() over the derived array to create per-item LLM calls with automatic caching
    const mailPieceAnalyses = mailPieceImages.map((imageInfo) => {
      // Get the image URL from the cell
      const analysis = generateObject<MailAnalysis>({
        // Prompt computed from imageUrl
        prompt: computed(() => {
          if (!imageInfo?.imageUrl) {
            if (DEBUG_USPS) {
              console.log(`[USPS LLM] Empty URL, returning text-only prompt`);
            }

            return undefined; // No-op while there is no URL
          }
          const url = imageInfo.imageUrl;

          // Debug logging (gated by DEBUG_USPS flag)
          if (DEBUG_USPS) {
            console.log(
              `[USPS LLM] Processing image URL (first 100 chars):`,
              url?.slice(0, 100),
            );
          }

          // Check if it's a base64 data URL vs external URL
          const isBase64 = url.startsWith("data:");
          if (DEBUG_USPS) {
            console.log(
              `[USPS LLM] Image type: ${isBase64 ? "base64" : "external URL"}`,
            );
          }

          // NOTE: External URLs from USPS require authentication and may fail.
          // The LLM server cannot fetch authenticated URLs.
          // For now, we still try and display an error if it fails.
          return [
            { type: "image" as const, image: url },
            {
              type: "text" as const,
              text:
                `Analyze this scanned mail piece image from USPS Informed Delivery. Extract:
1. The recipient name (who the mail is addressed to)
2. The sender or company name (from return address if visible)
3. The type of mail (bill, advertisement, personal, package notification, government, subscription, charity, or other)
4. Whether it appears to be spam/junk mail

If you cannot read the image clearly, make your best guess based on what you can see.`,
            },
          ];
        }),
        schema: MAIL_ANALYSIS_SCHEMA,
        // IMPORTANT: Must specify model explicitly for generateObject with images
        model: "anthropic:claude-sonnet-4-5",
      });

      return {
        imageInfo,
        imageUrl: imageInfo.imageUrl,
        analysis,
        pending: analysis.pending,
        error: analysis.error,
        result: analysis.result,
      };
    });

    // Count pending analyses
    const pendingCount = computed(
      () => mailPieceAnalyses?.filter((a) => a?.pending)?.length || 0,
    );

    // Count completed analyses
    const completedCount = computed(
      () =>
        mailPieceAnalyses?.filter((a) =>
          a?.analysis?.pending === false && a?.analysis?.result !== undefined
        ).length || 0,
    );

    const mailPieces = mailPieceAnalyses.map((a) => a.result);

    // Derived counts from stored mailPieces
    const mailCount = computed(() => mailPieces?.length || 0);
    const spamCount = computed(
      () => mailPieces?.filter((p) => p?.isLikelySpam)?.length || 0,
    );

    // Unconfirmed members count
    const unconfirmedCount = computed(
      () => householdMembers?.filter((m) => !m.isConfirmed)?.length || 0,
    );

    return {
      [NAME]: "USPS Informed Delivery",

      mailPieces,
      householdMembers,
      mailCount,
      spamCount,

      [UI]: (
        <ct-screen>
          <div slot="header">
            <ct-heading level={3}>USPS Informed Delivery</ct-heading>
          </div>

          <ct-vscroll flex showScrollbar>
            <ct-vstack padding="6" gap="4">
              {/* Auth UI from embedded Gmail Importer */}
              {gmailImporter.authUI}

              {/* Connection Status */}
              {isConnected
                ? (
                  <div
                    style={{
                      padding: "12px 16px",
                      backgroundColor: "#d1fae5",
                      borderRadius: "8px",
                      border: "1px solid #10b981",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      <span
                        style={{
                          width: "10px",
                          height: "10px",
                          borderRadius: "50%",
                          backgroundColor: "#10b981",
                        }}
                      />
                      <span>Connected to Gmail</span>
                      <span style={{ marginLeft: "auto", color: "#059669" }}>
                        {uspsEmailCount} USPS emails found
                      </span>
                      <button
                        type="button"
                        onClick={gmailImporter.bgUpdater}
                        style={{
                          marginLeft: "8px",
                          padding: "6px 12px",
                          backgroundColor: "#10b981",
                          color: "white",
                          border: "none",
                          borderRadius: "6px",
                          cursor: "pointer",
                          fontSize: "13px",
                          fontWeight: "500",
                        }}
                      >
                        Fetch Emails
                      </button>
                    </div>
                  </div>
                )
                : null}

              {/* Analysis Status - reactive, no button needed */}
              {isConnected
                ? (
                  <div
                    style={{
                      padding: "12px 16px",
                      backgroundColor: "#eff6ff",
                      borderRadius: "8px",
                      border: "1px solid #3b82f6",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                      }}
                    >
                      <span style={{ fontWeight: "600" }}>Analysis:</span>
                      <span>{imageCount} images found</span>
                      {pendingCount > 0 && (
                        <span
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                            color: "#2563eb",
                          }}
                        >
                          <ct-loader size="sm" />
                          {pendingCount} analyzing...
                        </span>
                      )}
                      <span style={{ color: "#059669" }}>
                        {completedCount} completed
                      </span>
                    </div>
                  </div>
                )
                : null}

              {/* Stats */}
              <div
                style={{
                  display: "flex",
                  gap: "16px",
                  padding: "12px",
                  backgroundColor: "#f3f4f6",
                  borderRadius: "8px",
                }}
              >
                <div>
                  <div style={{ fontSize: "24px", fontWeight: "bold" }}>
                    {mailCount}
                  </div>
                  <div style={{ fontSize: "12px", color: "#666" }}>
                    Mail Pieces
                  </div>
                </div>
                <div>
                  <div
                    style={{
                      fontSize: "24px",
                      fontWeight: "bold",
                      color: "#dc2626",
                    }}
                  >
                    {spamCount}
                  </div>
                  <div style={{ fontSize: "12px", color: "#666" }}>
                    Spam/Junk
                  </div>
                </div>
                {false && (
                  <div>
                    <div style={{ fontSize: "24px", fontWeight: "bold" }}>
                      {householdMembers?.length || 0}
                    </div>
                    <div style={{ fontSize: "12px", color: "#666" }}>
                      Household Members
                    </div>
                  </div>
                )}
              </div>

              {/* Household Members */}
              {false && (
                <details open style={{ marginTop: "8px" }}>
                  <summary
                    style={{
                      cursor: "pointer",
                      fontWeight: "600",
                      fontSize: "16px",
                      marginBottom: "8px",
                    }}
                  >
                    Household Members
                    {unconfirmedCount > 0
                      ? (
                        <span
                          style={{
                            marginLeft: "8px",
                            padding: "2px 8px",
                            backgroundColor: "#fef3c7",
                            borderRadius: "12px",
                            fontSize: "12px",
                            color: "#b45309",
                          }}
                        >
                          {unconfirmedCount} unconfirmed
                        </span>
                      )
                      : null}
                  </summary>

                  <ct-vstack gap="2">
                    {!householdMembers?.length
                      ? (
                        <div style={{ color: "#666", fontSize: "14px" }}>
                          No household members learned yet. Analyze some mail to
                          get started.
                        </div>
                      )
                      : null}
                    {/* Use .map() directly on cell array to get cell references */}
                    {householdMembers.map((member) => (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          padding: "8px 12px",
                          backgroundColor: member.isConfirmed
                            ? "#f0fdf4"
                            : "#fefce8",
                          borderRadius: "6px",
                          border: `1px solid ${
                            member.isConfirmed ? "#86efac" : "#fde047"
                          }`,
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: "500" }}>{member.name}</div>
                          <div style={{ fontSize: "12px", color: "#666" }}>
                            {member.mailCount} pieces
                            {member.aliases?.length > 0
                              ? ` • Also: ${member.aliases.join(", ")}`
                              : ""}
                          </div>
                        </div>
                        {!member.isConfirmed
                          ? (
                            <button
                              type="button"
                              onClick={confirmMember({ member })}
                              style={{
                                padding: "4px 8px",
                                fontSize: "12px",
                                backgroundColor: "#22c55e",
                                color: "white",
                                border: "none",
                                borderRadius: "4px",
                                cursor: "pointer",
                              }}
                            >
                              Confirm
                            </button>
                          )
                          : null}
                        <button
                          type="button"
                          onClick={deleteMember({ householdMembers, member })}
                          style={{
                            padding: "4px 8px",
                            fontSize: "12px",
                            backgroundColor: "#ef4444",
                            color: "white",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer",
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    ))}
                  </ct-vstack>
                </details>
              )}

              {/* Reactive Mail Piece Analysis Results */}
              <details open style={{ marginTop: "8px" }}>
                <summary
                  style={{
                    cursor: "pointer",
                    fontWeight: "600",
                    fontSize: "16px",
                    marginBottom: "8px",
                  }}
                >
                  Mail Pieces (Live Analysis)
                </summary>

                <ct-vstack gap="2">
                  {imageCount === 0
                    ? (
                      <div style={{ color: "#666", fontSize: "14px" }}>
                        No mail piece images found in emails. USPS emails may
                        not contain scanned images.
                      </div>
                    )
                    : null}
                  {/* Map over reactive analyses */}
                  {mailPieceAnalyses.map((analysisItem) => (
                    <div
                      style={{
                        display: "flex",
                        gap: "12px",
                        padding: "12px",
                        backgroundColor: "#f9fafb",
                        borderRadius: "8px",
                        border: "1px solid #e5e7eb",
                      }}
                    >
                      {/* Image thumbnail */}
                      <div
                        style={{
                          width: "80px",
                          height: "60px",
                          backgroundColor: "#e5e7eb",
                          borderRadius: "4px",
                          overflow: "hidden",
                          flexShrink: 0,
                        }}
                      >
                        <img
                          src={analysisItem.imageUrl || ""}
                          alt="Mail piece"
                          style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                          }}
                        />
                      </div>

                      {/* Details */}
                      <div style={{ flex: 1 }}>
                        {analysisItem.pending
                          ? (
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                              }}
                            >
                              <ct-loader size="sm" />
                              <span style={{ color: "#6b7280" }}>
                                Analyzing...
                              </span>
                            </div>
                          )
                          : analysisItem.error
                          ? (
                            <div style={{ color: "#dc2626", fontSize: "12px" }}>
                              LLM Error (image may be inaccessible)
                            </div>
                          )
                          : (
                            <div>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "8px",
                                }}
                              >
                                <span style={{ fontWeight: "600" }}>
                                  {analysisItem.result?.recipient || "Unknown"}
                                </span>
                                {analysisItem.result?.isLikelySpam
                                  ? (
                                    <span
                                      style={{
                                        padding: "2px 6px",
                                        backgroundColor: "#dc2626",
                                        color: "white",
                                        borderRadius: "4px",
                                        fontSize: "10px",
                                        fontWeight: "600",
                                      }}
                                    >
                                      SPAM
                                    </span>
                                  )
                                  : null}
                              </div>
                              <div
                                style={{ fontSize: "13px", color: "#4b5563" }}
                              >
                                From: {analysisItem.result?.sender || "Unknown"}
                              </div>
                              <div
                                style={{
                                  fontSize: "12px",
                                  color: "#6b7280",
                                  marginTop: "4px",
                                }}
                              >
                                {analysisItem.result?.summary || ""}
                              </div>
                              <div
                                style={{
                                  fontSize: "11px",
                                  color: "#9ca3af",
                                  marginTop: "4px",
                                }}
                              >
                                Type:{" "}
                                {analysisItem.result?.mailType || "unknown"}
                                {" "}
                                • Spam:{" "}
                                {analysisItem.result?.spamConfidence || 0}%
                              </div>
                            </div>
                          )}
                      </div>
                    </div>
                  ))}
                </ct-vstack>
              </details>
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
    };
  },
);
