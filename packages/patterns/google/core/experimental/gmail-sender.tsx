/// <cts-enable />
/**
 * Gmail Sender Pattern
 *
 * Sends emails via Gmail API with mandatory user confirmation.
 *
 * Security: User must see the exact email content and explicitly confirm
 * before any email is sent. This pattern can serve as a declassification
 * gate when policies are implemented (patterns with verified SHA can be trusted).
 *
 * Usage:
 * 1. Create and favorite a Google Auth piece with "Gmail (send emails)" permission
 * 2. Create a Gmail Sender piece
 * 3. Compose your email and click "Review & Send"
 * 4. Review the confirmation dialog showing exactly what will be sent
 * 5. Click "Send Email" to send
 *
 * Multi-account support: Use createGoogleAuth() with accountType parameter
 * to wish for #googleAuthPersonal or #googleAuthWork accounts.
 * See: gmail-importer.tsx for an example with account switching dropdown.
 */

import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";
import { GmailSendClient } from "../util/gmail-send-client.ts";
import { type Auth, createGoogleAuth } from "../util/google-auth-manager.tsx";

// ============================================================================
// TYPES
// ============================================================================

type EmailDraft = {
  /** Recipient email address */
  to: Default<string, "">;
  /** Email subject line */
  subject: Default<string, "">;
  /** Plain text body */
  body: Default<string, "">;
  /** CC recipients (comma-separated) */
  cc: Default<string, "">;
  /** BCC recipients (comma-separated) */
  bcc: Default<string, "">;
  /** Message ID to reply to (for threading) */
  replyToMessageId: Default<string, "">;
  /** Thread ID to reply to (for threading) */
  replyToThreadId: Default<string, "">;
};

type SendResult = {
  success: boolean;
  messageId?: string;
  threadId?: string;
  error?: string;
  timestamp?: string;
};

interface Input {
  /** Email draft to compose/send */
  draft: Default<
    EmailDraft,
    {
      to: "";
      subject: "";
      body: "";
      cc: "";
      bcc: "";
      replyToMessageId: "";
      replyToThreadId: "";
    }
  >;
}

/** Gmail email sender with confirmation dialog. #gmailSender */
interface Output {
  [UI]: VNode;
  draft: EmailDraft;
  result: SendResult | null;
}

// ============================================================================
// HANDLERS
// ============================================================================

const prepareToSend = handler<
  unknown,
  { showConfirmation: Writable<boolean> }
>((_, { showConfirmation }) => {
  showConfirmation.set(true);
});

const cancelSend = handler<
  unknown,
  { showConfirmation: Writable<boolean> }
>((_, { showConfirmation }) => {
  showConfirmation.set(false);
});

const confirmAndSend = handler<
  unknown,
  {
    draft: Writable<EmailDraft>;
    auth: Writable<Auth>;
    sending: Writable<boolean>;
    result: Writable<SendResult | null>;
    showConfirmation: Writable<boolean>;
  }
>(async (_, { draft, auth, sending, result, showConfirmation }) => {
  sending.set(true);
  result.set(null);

  try {
    const client = new GmailSendClient(auth, { debugMode: true });
    const email = draft.get();

    const response = await client.sendEmail({
      to: email.to,
      subject: email.subject,
      body: email.body,
      cc: email.cc || undefined,
      bcc: email.bcc || undefined,
      replyToMessageId: email.replyToMessageId || undefined,
      replyToThreadId: email.replyToThreadId || undefined,
    });

    result.set({
      success: true,
      messageId: response.id,
      threadId: response.threadId,
      timestamp: Temporal.Now.instant().toString(),
    });

    showConfirmation.set(false);

    // Clear draft on success
    draft.set({
      to: "",
      subject: "",
      body: "",
      cc: "",
      bcc: "",
      replyToMessageId: "",
      replyToThreadId: "",
    });
  } catch (error) {
    result.set({
      success: false,
      error: error instanceof Error ? error.message : String(error),
      timestamp: Temporal.Now.instant().toString(),
    });
  } finally {
    sending.set(false);
  }
});

const dismissResult = handler<unknown, { result: Writable<SendResult | null> }>(
  (_, { result }) => {
    result.set(null);
  },
);

// ============================================================================
// PATTERN
// ============================================================================

export default pattern<Input, Output>(({ draft }) => {
  // Auth via createGoogleAuth - discovers favorited Google Auth piece with gmailSend scope
  const {
    auth,
    fullUI: authUI,
    isReady: hasAuth,
    currentEmail: senderEmail,
  } = createGoogleAuth({
    requiredScopes: ["gmailSend"],
  });

  // UI state
  const showConfirmation = Writable.of(false);
  const sending = Writable.of(false);
  const result = Writable.of<SendResult | null>(null);

  // Validation
  const canSend = computed(() =>
    hasAuth &&
    draft.to.trim() !== "" &&
    draft.subject.trim() !== "" &&
    draft.body.trim() !== "" &&
    !sending.get()
  );

  return {
    [NAME]: "Gmail Sender",
    [UI]: (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          padding: "20px",
          maxWidth: "700px",
        }}
      >
        <h2 style={{ fontSize: "24px", fontWeight: "bold", margin: "0" }}>
          Send Email
        </h2>

        {/* Auth status - using createGoogleAuth UI with avatar and switch button */}
        {authUI}

        {/* Result display */}
        {ifElse(
          computed(() => result.get()?.success === true),
          <div
            style={{
              padding: "16px",
              background: "#d1fae5",
              borderRadius: "8px",
              border: "1px solid #10b981",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
              }}
            >
              <div>
                <div
                  style={{
                    fontWeight: "bold",
                    marginBottom: "4px",
                    color: "#065f46",
                  }}
                >
                  Email Sent Successfully!
                </div>
                <div style={{ fontSize: "12px", color: "#047857" }}>
                  Message ID: {computed(() => result.get()?.messageId)}
                </div>
              </div>
              <button
                type="button"
                onClick={dismissResult({ result })}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "18px",
                  color: "#065f46",
                }}
              >
                ×
              </button>
            </div>
          </div>,
          null,
        )}

        {ifElse(
          computed(() => result.get()?.success === false),
          <div
            style={{
              padding: "16px",
              background: "#fee2e2",
              borderRadius: "8px",
              border: "1px solid #ef4444",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
              }}
            >
              <div>
                <div
                  style={{
                    fontWeight: "bold",
                    marginBottom: "4px",
                    color: "#991b1b",
                  }}
                >
                  Failed to Send Email
                </div>
                <div style={{ fontSize: "14px", color: "#b91c1c" }}>
                  {computed(() => result.get()?.error)}
                </div>
              </div>
              <button
                type="button"
                onClick={dismissResult({ result })}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: "18px",
                  color: "#991b1b",
                }}
              >
                ×
              </button>
            </div>
          </div>,
          null,
        )}

        {/* Compose form */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            padding: "16px",
            background: "#f9fafb",
            borderRadius: "8px",
            border: "1px solid #e5e7eb",
          }}
        >
          <div>
            <label
              style={{
                display: "block",
                marginBottom: "4px",
                fontWeight: "500",
                fontSize: "14px",
              }}
            >
              To <span style={{ color: "#ef4444" }}>*</span>
            </label>
            <ct-input
              type="email"
              $value={draft.to}
              placeholder="recipient@example.com"
              style="width: 100%; padding: 8px 12px;"
            />
          </div>

          <div style={{ display: "flex", gap: "12px" }}>
            <div style={{ flex: 1 }}>
              <label
                style={{
                  display: "block",
                  marginBottom: "4px",
                  fontWeight: "500",
                  fontSize: "14px",
                }}
              >
                CC
              </label>
              <ct-input
                type="text"
                $value={draft.cc}
                placeholder="cc@example.com"
                style="width: 100%; padding: 8px 12px;"
              />
            </div>
            <div style={{ flex: 1 }}>
              <label
                style={{
                  display: "block",
                  marginBottom: "4px",
                  fontWeight: "500",
                  fontSize: "14px",
                }}
              >
                BCC
              </label>
              <ct-input
                type="text"
                $value={draft.bcc}
                placeholder="bcc@example.com"
                style="width: 100%; padding: 8px 12px;"
              />
            </div>
          </div>

          <div>
            <label
              style={{
                display: "block",
                marginBottom: "4px",
                fontWeight: "500",
                fontSize: "14px",
              }}
            >
              Subject <span style={{ color: "#ef4444" }}>*</span>
            </label>
            <ct-input
              type="text"
              $value={draft.subject}
              placeholder="Email subject"
              style="width: 100%; padding: 8px 12px;"
            />
          </div>

          <div>
            <label
              style={{
                display: "block",
                marginBottom: "4px",
                fontWeight: "500",
                fontSize: "14px",
              }}
            >
              Message <span style={{ color: "#ef4444" }}>*</span>
            </label>
            <ct-input
              $value={draft.body}
              placeholder="Write your message..."
              style="width: 100%; padding: 8px 12px; min-height: 150px;"
            />
          </div>

          <button
            type="button"
            onClick={prepareToSend({ showConfirmation })}
            disabled={computed(() => !canSend)}
            style={{
              padding: "12px 24px",
              background: "#2563eb",
              color: "white",
              border: "none",
              borderRadius: "6px",
              fontSize: "16px",
              fontWeight: "500",
              cursor: "pointer",
              opacity: computed(() => canSend ? 1 : 0.5),
            }}
          >
            Review & Send
          </button>
        </div>

        {/* CONFIRMATION DIALOG */}
        {ifElse(
          showConfirmation,
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0, 0, 0, 0.5)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1000,
            }}
          >
            <div
              style={{
                background: "white",
                borderRadius: "12px",
                maxWidth: "600px",
                width: "90%",
                maxHeight: "90vh",
                overflow: "auto",
                boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
              }}
            >
              {/* Header */}
              <div
                style={{
                  padding: "20px",
                  borderBottom: "2px solid #dc2626",
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                }}
              >
                <span style={{ fontSize: "24px" }}>📧</span>
                <h3
                  style={{ margin: 0, color: "#dc2626", fontSize: "20px" }}
                >
                  Confirm Send Email
                </h3>
              </div>

              {/* Content */}
              <div style={{ padding: "20px" }}>
                <div
                  style={{
                    background: "#f9fafb",
                    borderRadius: "8px",
                    padding: "16px",
                    marginBottom: "16px",
                  }}
                >
                  <div style={{ marginBottom: "12px" }}>
                    <span
                      style={{
                        color: "#6b7280",
                        minWidth: "60px",
                        display: "inline-block",
                      }}
                    >
                      From:
                    </span>
                    <span style={{ fontWeight: "500" }}>{senderEmail}</span>
                  </div>
                  <div style={{ marginBottom: "12px" }}>
                    <span
                      style={{
                        color: "#6b7280",
                        minWidth: "60px",
                        display: "inline-block",
                      }}
                    >
                      To:
                    </span>
                    <span style={{ fontWeight: "600" }}>{draft.to}</span>
                  </div>
                  {ifElse(
                    computed(() => draft.cc && draft.cc.trim() !== ""),
                    <div style={{ marginBottom: "12px" }}>
                      <span
                        style={{
                          color: "#6b7280",
                          minWidth: "60px",
                          display: "inline-block",
                        }}
                      >
                        CC:
                      </span>
                      <span>{draft.cc}</span>
                    </div>,
                    null,
                  )}
                  {ifElse(
                    computed(() => draft.bcc && draft.bcc.trim() !== ""),
                    <div style={{ marginBottom: "12px" }}>
                      <span
                        style={{
                          color: "#6b7280",
                          minWidth: "60px",
                          display: "inline-block",
                        }}
                      >
                        BCC:
                      </span>
                      <span>{draft.bcc}</span>
                    </div>,
                    null,
                  )}
                  <div style={{ marginBottom: "16px" }}>
                    <span
                      style={{
                        color: "#6b7280",
                        minWidth: "60px",
                        display: "inline-block",
                      }}
                    >
                      Subject:
                    </span>
                    <span style={{ fontWeight: "600" }}>{draft.subject}</span>
                  </div>
                  <div
                    style={{
                      borderTop: "1px solid #e5e7eb",
                      paddingTop: "12px",
                    }}
                  >
                    <div
                      style={{
                        color: "#6b7280",
                        marginBottom: "8px",
                        fontWeight: "500",
                      }}
                    >
                      Message:
                    </div>
                    <div
                      style={{
                        background: "white",
                        border: "1px solid #e5e7eb",
                        borderRadius: "6px",
                        padding: "12px",
                        maxHeight: "200px",
                        overflowY: "auto",
                        whiteSpace: "pre-wrap",
                        fontSize: "14px",
                        lineHeight: "1.5",
                      }}
                    >
                      {draft.body}
                    </div>
                  </div>
                </div>

                {/* Warning */}
                <div
                  style={{
                    padding: "12px 16px",
                    background: "#fef3c7",
                    borderRadius: "8px",
                    border: "1px solid #f59e0b",
                  }}
                >
                  <div
                    style={{
                      fontWeight: "600",
                      marginBottom: "4px",
                      color: "#92400e",
                    }}
                  >
                    This will send a real email
                  </div>
                  <div style={{ fontSize: "14px", color: "#78350f" }}>
                    The recipient will receive this email from your Google
                    account. This action cannot be undone.
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div
                style={{
                  padding: "16px 20px",
                  borderTop: "1px solid #e5e7eb",
                  display: "flex",
                  gap: "12px",
                  justifyContent: "flex-end",
                }}
              >
                <button
                  type="button"
                  onClick={cancelSend({ showConfirmation })}
                  disabled={sending}
                  style={{
                    padding: "10px 20px",
                    background: "white",
                    color: "#374151",
                    border: "1px solid #d1d5db",
                    borderRadius: "6px",
                    fontSize: "14px",
                    fontWeight: "500",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmAndSend({
                    draft,
                    auth,
                    sending,
                    result,
                    showConfirmation,
                  })}
                  disabled={sending}
                  style={{
                    padding: "10px 20px",
                    background: "#dc2626",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "14px",
                    fontWeight: "500",
                    cursor: "pointer",
                    opacity: computed(() => sending.get() ? 0.7 : 1),
                  }}
                >
                  {ifElse(sending, "Sending...", "Send Email")}
                </button>
              </div>
            </div>
          </div>,
          null,
        )}
      </div>
    ),
    draft,
    result,
  };
});
