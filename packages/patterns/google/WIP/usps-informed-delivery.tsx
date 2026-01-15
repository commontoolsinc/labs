/// <cts-enable />
/**
 * USPS Informed Delivery Mail Analyzer
 *
 * Processes USPS Informed Delivery emails to extract information about
 * incoming mail using LLM vision analysis.
 *
 * Features:
 * - Connects to gmail-importer via wish() for email fetching
 * - Auto-analyzes mail piece images with LLM vision
 * - Learns household members from recipient names over time
 * - Classifies mail type and spam likelihood
 *
 * Usage:
 * 1. Create a gmail-importer instance with:
 *    - gmailFilterQuery: "from:USPSInformeddelivery@email.informeddelivery.usps.com"
 *    - autoFetchOnAuth: true
 * 2. Deploy this pattern and it will connect via wish()
 */
import {
  Default,
  derive,
  generateObject,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  wish,
  Writable,
} from "commontools";

// Email type - inlined to avoid import chain issues when deploying from WIP/
interface Email {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  threadId: string;
  labels: string[];
  htmlContent: string;
  textContent: string;
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

/** A single mail piece extracted from an Informed Delivery email */
interface MailPiece {
  id: string;
  emailId: string;
  emailDate: string;
  imageUrl: string;
  // LLM-extracted fields
  recipient: string;
  sender: string;
  mailType: MailType;
  isLikelySpam: boolean;
  spamConfidence: number;
  summary: string;
  processedAt: number;
}

/** A learned household member */
interface HouseholdMember {
  name: string;
  aliases: string[];
  mailCount: number;
  firstSeen: number;
  isConfirmed: boolean;
}

/** Pattern settings */
interface Settings {
  lastProcessedEmailId: Default<string, "">;
}

/** Gmail importer output type (what we expect from wish) */
interface GmailImporterOutput {
  emails: Email[];
  emailCount: number;
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
} as const;

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
  settings: Default<
    Settings,
    {
      lastProcessedEmailId: "";
    }
  >;
  mailPieces: Default<MailPiece[], []>;
  householdMembers: Default<HouseholdMember[], []>;
  // Optional: Link emails directly from a Gmail Importer charm when wish() is unavailable
  // Use: ct charm link gmailImporterCharm/emails uspsCharm/linkedEmails
  linkedEmails?: Email[];
}

/** USPS Informed Delivery mail analyzer. #uspsInformedDelivery */
interface PatternOutput {
  mailPieces: MailPiece[];
  householdMembers: HouseholdMember[];
  mailCount: number;
  spamCount: number;
}

export default pattern<PatternInput, PatternOutput>(
  ({ settings: _settings, mailPieces, householdMembers, linkedEmails }) => {
    // Local state - prefixed with _ as not currently used directly
    const _processing = Writable.of(false);

    // Check if linkedEmails is provided (manual linking via CT CLI)
    const hasLinkedEmails = derive(
      { linkedEmails },
      ({ linkedEmails: le }) => !!(le && Array.isArray(le) && le.length > 0),
    );

    // Wish for a gmail-importer instance (fallback when linkedEmails not provided)
    const gmailImporter = wish<GmailImporterOutput>({
      query: "#gmailEmails",
    });

    // Get emails from either linkedEmails or wish result
    const allEmails = derive(
      { linkedEmails, gmailImporter },
      ({ linkedEmails: le, gmailImporter: gi }) => {
        // Prefer linkedEmails if available
        if (le && Array.isArray(le) && le.length > 0) {
          return le;
        }
        // Fallback to wish result
        return gi?.result?.emails || [];
      },
    );

    // Filter for USPS emails
    const uspsEmails = derive(allEmails, (emails: Email[]) => {
      return (emails || []).filter((e: Email) =>
        e.from?.toLowerCase().includes(USPS_SENDER)
      );
    });

    // Count of USPS emails found
    const uspsEmailCount = derive(
      uspsEmails,
      (emails: Email[]) => emails?.length || 0,
    );

    // Check if we have emails (either from linkedEmails or wish)
    const isConnected = derive(
      { hasLinkedEmails, gmailImporter },
      ({ hasLinkedEmails: hle, gmailImporter: gi }) =>
        hle || !!gi?.result?.emails,
    );

    // ==========================================================================
    // REACTIVE LLM ANALYSIS
    // Extract images from emails and analyze them with generateObject at pattern level
    // This is the correct approach - generateObject must be called reactively, not in handlers
    // ==========================================================================

    // First, extract all mail piece images from all emails
    // Returns array of { emailId, emailDate, imageUrl } objects
    const mailPieceImages = derive(uspsEmails, (emails: Email[]) => {
      const images: {
        emailId: string;
        emailDate: string;
        imageUrl: string;
        imageIndex: number;
      }[] = [];
      for (const email of emails || []) {
        const urls = extractMailPieceImages(email.htmlContent);
        // DEBUG: Log extracted URLs
        console.log(
          `[USPS] Email ${
            email.id.slice(0, 8)
          }... extracted ${urls.length} images:`,
          urls.slice(0, 3),
        );
        urls.forEach((url, idx) => {
          images.push({
            emailId: email.id,
            emailDate: email.date,
            imageUrl: url,
            imageIndex: idx,
          });
        });
      }
      // DEBUG: Log total images
      console.log(`[USPS] Total images extracted: ${images.length}`);
      // Limit to first 10 images for now to avoid overwhelming LLM calls
      return images.slice(0, 10);
    });

    // Count of images to analyze
    const imageCount = derive(mailPieceImages, (imgs) => imgs?.length || 0);

    // Analyze each image with generateObject - this is called at pattern level (reactive)
    // Uses .map() over the derived array to create per-item LLM calls with automatic caching
    // NOTE: Per store-mapper pattern, generateObject prompt should use derive() with the cell
    const mailPieceAnalyses = mailPieceImages.map((imageInfo) => {
      // Get the image URL from the cell - need to derive to get actual value
      const imageUrl = derive(imageInfo, (info) => info?.imageUrl || "");

      const analysis = generateObject({
        // Prompt must be derived to access cell values properly
        prompt: derive(imageUrl, (url) => {
          // DEBUG: Log the URL being sent to LLM
          console.log(
            `[USPS LLM] Processing image URL (first 100 chars):`,
            url?.slice(0, 100),
          );

          if (!url) {
            console.log(`[USPS LLM] Empty URL, returning text-only prompt`);
            return "No image URL available - please return default values";
          }

          // Check if it's a base64 data URL vs external URL
          const isBase64 = url.startsWith("data:");
          console.log(
            `[USPS LLM] Image type: ${isBase64 ? "base64" : "external URL"}`,
          );

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
        imageUrl,
        analysis,
        pending: analysis.pending,
        error: analysis.error,
        result: analysis.result,
      };
    });

    // Count pending analyses
    const pendingCount = derive(
      mailPieceAnalyses,
      (analyses) => analyses?.filter((a: any) => a.pending)?.length || 0,
    );

    // Count completed analyses
    const completedCount = derive(
      mailPieceAnalyses,
      (analyses) =>
        analyses?.filter((a: any) => !a.pending && a.result)?.length || 0,
    );

    // Derived counts from stored mailPieces (persisted results)
    const mailCount = derive(
      mailPieces,
      (pieces: MailPiece[]) => pieces?.length || 0,
    );
    const spamCount = derive(
      mailPieces,
      (pieces: MailPiece[]) =>
        pieces?.filter((p) => p.isLikelySpam)?.length || 0,
    );

    // Group mail by date - prefixed with _ as not currently used in UI
    const _mailByDate = derive(mailPieces, (pieces: MailPiece[]) => {
      const groups: Record<string, MailPiece[]> = {};
      for (const piece of pieces || []) {
        const date = new Date(piece.emailDate).toLocaleDateString();
        if (!groups[date]) groups[date] = [];
        groups[date].push(piece);
      }
      return groups;
    });

    // Unconfirmed members count
    const unconfirmedCount = derive(
      householdMembers,
      (members: HouseholdMember[]) =>
        members?.filter((m) => !m.isConfirmed)?.length || 0,
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
              {/* Connection Status */}
              {ifElse(
                isConnected,
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
                    <span>Connected to Gmail Importer</span>
                    <span style={{ marginLeft: "auto", color: "#059669" }}>
                      {uspsEmailCount} USPS emails found
                    </span>
                  </div>
                </div>,
                <div
                  style={{
                    padding: "16px",
                    backgroundColor: "#fef3c7",
                    borderRadius: "8px",
                    border: "1px solid #f59e0b",
                  }}
                >
                  <h4 style={{ margin: "0 0 8px 0", color: "#b45309" }}>
                    Gmail Importer Not Connected
                  </h4>
                  <p
                    style={{ margin: "0", fontSize: "14px", color: "#92400e" }}
                  >
                    To use this pattern, please:
                  </p>
                  <ol
                    style={{
                      margin: "8px 0 0 0",
                      paddingLeft: "20px",
                      fontSize: "14px",
                      color: "#92400e",
                    }}
                  >
                    <li>Create a Gmail Importer charm</li>
                    <li>
                      Set the filter query to:
                      <code
                        style={{
                          display: "block",
                          margin: "4px 0",
                          padding: "4px 8px",
                          backgroundColor: "#fef9c3",
                          borderRadius: "4px",
                          fontSize: "12px",
                        }}
                      >
                        from:USPSInformeddelivery@email.informeddelivery.usps.com
                      </code>
                    </li>
                    <li>Enable "Auto-fetch on auth"</li>
                    <li>Connect Google Auth and favorite it</li>
                  </ol>
                </div>,
              )}

              {/* Analysis Status - reactive, no button needed */}
              {ifElse(
                isConnected,
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
                    {ifElse(
                      derive(pendingCount, (c: number) => c > 0),
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
                      </span>,
                      <span style={{ color: "#059669" }}>
                        {completedCount} completed
                      </span>,
                    )}
                  </div>
                </div>,
                null,
              )}

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
                <div>
                  <div style={{ fontSize: "24px", fontWeight: "bold" }}>
                    {derive(
                      householdMembers,
                      (m: HouseholdMember[]) => m?.length || 0,
                    )}
                  </div>
                  <div style={{ fontSize: "12px", color: "#666" }}>
                    Household Members
                  </div>
                </div>
              </div>

              {/* Household Members */}
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
                  {ifElse(
                    derive(unconfirmedCount, (c: number) => c > 0),
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
                    </span>,
                    null,
                  )}
                </summary>

                <ct-vstack gap="2">
                  {ifElse(
                    derive(
                      householdMembers,
                      (m: HouseholdMember[]) => !m || m.length === 0,
                    ),
                    <div style={{ color: "#666", fontSize: "14px" }}>
                      No household members learned yet. Analyze some mail to get
                      started.
                    </div>,
                    null,
                  )}
                  {/* Use .map() directly on cell array to get cell references */}
                  {householdMembers.map((member) => (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "8px 12px",
                        backgroundColor: derive(
                          member,
                          (m: HouseholdMember) =>
                            m.isConfirmed ? "#f0fdf4" : "#fefce8",
                        ),
                        borderRadius: "6px",
                        border: derive(
                          member,
                          (m: HouseholdMember) =>
                            `1px solid ${
                              m.isConfirmed ? "#86efac" : "#fde047"
                            }`,
                        ),
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: "500" }}>
                          {derive(member, (m: HouseholdMember) => m.name)}
                        </div>
                        <div style={{ fontSize: "12px", color: "#666" }}>
                          {derive(member, (m: HouseholdMember) => m.mailCount)}
                          {" "}
                          pieces
                          {derive(
                            member,
                            (m: HouseholdMember) => m.aliases?.length > 0
                              ? ` • Also: ${m.aliases.join(", ")}`
                              : "",
                          )}
                        </div>
                      </div>
                      {ifElse(
                        derive(member, (m: HouseholdMember) => !m.isConfirmed),
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
                        </button>,
                        null,
                      )}
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
                  {ifElse(
                    derive(imageCount, (c: number) => c === 0),
                    <div style={{ color: "#666", fontSize: "14px" }}>
                      No mail piece images found in emails. USPS emails may not
                      contain scanned images.
                    </div>,
                    null,
                  )}
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
                          src={derive(
                            analysisItem,
                            (a: any) => a.imageUrl || "",
                          )}
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
                        {ifElse(
                          derive(analysisItem, (a: any) => a.pending),
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
                          </div>,
                          ifElse(
                            derive(analysisItem, (a: any) => !!a.error),
                            <div style={{ color: "#dc2626", fontSize: "12px" }}>
                              LLM Error (image may be inaccessible)
                            </div>,
                            <div>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "8px",
                                }}
                              >
                                <span style={{ fontWeight: "600" }}>
                                  {derive(
                                    analysisItem,
                                    (a: any) =>
                                      a.result?.recipient || "Unknown",
                                  )}
                                </span>
                                {ifElse(
                                  derive(
                                    analysisItem,
                                    (a: any) => a.result?.isLikelySpam,
                                  ),
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
                                  </span>,
                                  null,
                                )}
                              </div>
                              <div
                                style={{ fontSize: "13px", color: "#4b5563" }}
                              >
                                From: {derive(
                                  analysisItem,
                                  (a: any) => a.result?.sender || "Unknown",
                                )}
                              </div>
                              <div
                                style={{
                                  fontSize: "12px",
                                  color: "#6b7280",
                                  marginTop: "4px",
                                }}
                              >
                                {derive(
                                  analysisItem,
                                  (a: any) => a.result?.summary || "",
                                )}
                              </div>
                              <div
                                style={{
                                  fontSize: "11px",
                                  color: "#9ca3af",
                                  marginTop: "4px",
                                }}
                              >
                                Type: {derive(
                                  analysisItem,
                                  (a: any) => a.result?.mailType || "unknown",
                                )} • Spam: {derive(
                                  analysisItem,
                                  (a: any) => a.result?.spamConfidence || 0,
                                )}%
                              </div>
                            </div>,
                          ),
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
