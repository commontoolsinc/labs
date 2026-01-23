/// <cts-enable />
/**
 * Gmail Label Manager Pattern
 *
 * Add or remove labels from emails with mandatory user confirmation.
 *
 * Security: User must see the exact label changes and explicitly confirm
 * before any modification. This pattern can serve as a declassification
 * gate when policies are implemented (patterns with verified SHA can be trusted).
 *
 * Usage:
 * 1. Create and favorite a Google Auth charm with "Gmail (add/remove labels)" permission
 * 2. Create a Gmail Label Manager charm
 * 3. Set the messageIds to modify (single ID or array of IDs)
 * 4. Select labels to add/remove
 * 5. Review the confirmation dialog
 * 6. Confirm to apply changes
 *
 * This pattern works well linked to a Gmail Importer - select emails there,
 * then manage their labels here.
 *
 * Multi-account support: Use createGoogleAuth() with accountType parameter
 * to wish for #googleAuthPersonal or #googleAuthWork accounts.
 * See: gmail-importer.tsx for an example with account switching dropdown.
 */

import {
  Default,
  derive,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import {
  type GmailLabel,
  GmailSendClient,
  type ModifyLabelsParams,
} from "../util/gmail-send-client.ts";
import {
  type Auth,
  createGoogleAuth,
  type ScopeKey,
} from "../util/google-auth-manager.tsx";

// ============================================================================
// TYPES
// ============================================================================

type LabelOperation = {
  /** Message IDs to modify */
  messageIds: string[];
  /** Label IDs to add */
  addLabelIds: string[];
  /** Label IDs to remove */
  removeLabelIds: string[];
  /** Human-readable label names (for display) */
  addLabelNames: string[];
  removeLabelNames: string[];
};

type OperationResult = {
  success: boolean;
  messageCount: number;
  error?: string;
  timestamp?: string;
};

interface Input {
  /** Message ID(s) to manage labels for - can be single string or array */
  messageIds: Default<string[], []>;
  /** Labels to add (by ID) */
  labelsToAdd: Default<string[], []>;
  /** Labels to remove (by ID) */
  labelsToRemove: Default<string[], []>;
}

/** Gmail label manager with confirmation. #gmailLabelManager */
interface Output {
  messageIds: string[];
  labelsToAdd: string[];
  labelsToRemove: string[];
  result: OperationResult | null;
  /** Available labels (fetched from Gmail) */
  availableLabels: GmailLabel[];
}

// ============================================================================
// HANDLERS
// ============================================================================

const fetchLabels = handler<
  unknown,
  {
    auth: Writable<Auth>;
    availableLabels: Writable<GmailLabel[]>;
    loadingLabels: Writable<boolean>;
  }
>(async (_, { auth, availableLabels, loadingLabels }) => {
  loadingLabels.set(true);
  try {
    const client = new GmailSendClient(auth, { debugMode: true });
    const labels = await client.listLabels();
    // Sort: user labels first (alphabetically), then system labels
    labels.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "user" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    availableLabels.set(labels);
  } catch (error) {
    console.error("[GmailLabelManager] Failed to fetch labels:", error);
  } finally {
    loadingLabels.set(false);
  }
});

const toggleAddLabel = handler<
  unknown,
  { labelsToAdd: Writable<string[]>; labelId: string }
>((_, { labelsToAdd, labelId }) => {
  const current = labelsToAdd.get();
  if (current.includes(labelId)) {
    labelsToAdd.set(current.filter((id) => id !== labelId));
  } else {
    labelsToAdd.set([...current, labelId]);
  }
});

const toggleRemoveLabel = handler<
  unknown,
  { labelsToRemove: Writable<string[]>; labelId: string }
>((_, { labelsToRemove, labelId }) => {
  const current = labelsToRemove.get();
  if (current.includes(labelId)) {
    labelsToRemove.set(current.filter((id) => id !== labelId));
  } else {
    labelsToRemove.set([...current, labelId]);
  }
});

const prepareOperation = handler<
  unknown,
  {
    messageIds: Writable<string[]>;
    labelsToAdd: Writable<string[]>;
    labelsToRemove: Writable<string[]>;
    availableLabels: Writable<GmailLabel[]>;
    pendingOp: Writable<LabelOperation | null>;
  }
>(
  (
    _,
    { messageIds, labelsToAdd, labelsToRemove, availableLabels, pendingOp },
  ) => {
    const ids = messageIds.get();
    const add = labelsToAdd.get();
    const remove = labelsToRemove.get();
    const labels = availableLabels.get();

    // Map IDs to names for display
    const labelMap = new Map(labels.map((l) => [l.id, l.name]));

    pendingOp.set({
      messageIds: [...ids],
      addLabelIds: [...add],
      removeLabelIds: [...remove],
      addLabelNames: add.map((id) => labelMap.get(id) || id),
      removeLabelNames: remove.map((id) => labelMap.get(id) || id),
    });
  },
);

const cancelOperation = handler<
  unknown,
  { pendingOp: Writable<LabelOperation | null> }
>((_, { pendingOp }) => {
  pendingOp.set(null);
});

const confirmOperation = handler<
  unknown,
  {
    pendingOp: Writable<LabelOperation | null>;
    auth: Writable<Auth>;
    processing: Writable<boolean>;
    result: Writable<OperationResult | null>;
    labelsToAdd: Writable<string[]>;
    labelsToRemove: Writable<string[]>;
  }
>(
  async (
    _,
    { pendingOp, auth, processing, result, labelsToAdd, labelsToRemove },
  ) => {
    const op = pendingOp.get();
    if (!op) return;

    processing.set(true);
    result.set(null);

    try {
      const client = new GmailSendClient(auth, { debugMode: true });

      const params: ModifyLabelsParams = {
        addLabelIds: op.addLabelIds.length > 0 ? op.addLabelIds : undefined,
        removeLabelIds: op.removeLabelIds.length > 0
          ? op.removeLabelIds
          : undefined,
      };

      if (op.messageIds.length === 1) {
        // Single message - use regular modify
        await client.modifyLabels(op.messageIds[0], params);
      } else {
        // Multiple messages - use batch modify
        await client.batchModifyLabels(op.messageIds, params);
      }

      result.set({
        success: true,
        messageCount: op.messageIds.length,
        timestamp: new Date().toISOString(),
      });

      pendingOp.set(null);

      // Clear selections after success
      labelsToAdd.set([]);
      labelsToRemove.set([]);
    } catch (error) {
      result.set({
        success: false,
        messageCount: op.messageIds.length,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
    } finally {
      processing.set(false);
    }
  },
);

const dismissResult = handler<
  unknown,
  { result: Writable<OperationResult | null> }
>((_, { result }) => {
  result.set(null);
});

// ============================================================================
// PATTERN
// ============================================================================

export default pattern<Input, Output>(
  ({ messageIds, labelsToAdd, labelsToRemove }) => {
    // Auth via createGoogleAuth utility - handles discovery, validation, and UI
    const { auth, fullUI, isReady } = createGoogleAuth({
      requiredScopes: ["gmail", "gmailModify"] as ScopeKey[],
    });
    const hasAuth = isReady;

    // UI state
    const availableLabels = Writable.of<GmailLabel[]>([]);
    const loadingLabels = Writable.of(false);
    const pendingOp = Writable.of<LabelOperation | null>(null);
    const processing = Writable.of(false);
    const result = Writable.of<OperationResult | null>(null);

    // Computed
    const messageCount = derive(messageIds, (ids) => ids.length);
    const hasMessages = derive(messageIds, (ids) => ids.length > 0);
    const hasChanges = derive(
      { labelsToAdd, labelsToRemove },
      ({ labelsToAdd, labelsToRemove }) =>
        labelsToAdd.length > 0 || labelsToRemove.length > 0,
    );
    const canApply = derive(
      { hasAuth, hasMessages, hasChanges, processing },
      ({ hasAuth, hasMessages, hasChanges, processing }) =>
        hasAuth && hasMessages && hasChanges && !processing,
    );

    // Common system labels that are useful (prefixed with _ as not currently used)
    const _systemLabelIds = [
      "INBOX",
      "STARRED",
      "IMPORTANT",
      "UNREAD",
      "SPAM",
      "TRASH",
    ];

    return {
      [NAME]: "Gmail Label Manager",
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
            Gmail Label Manager
          </h2>

          {/* Auth status - handled by createGoogleAuth utility */}
          {fullUI}

          {/* Refresh labels button - protected until authenticated */}
          {ifElse(
            isReady,
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                onClick={fetchLabels({ auth, availableLabels, loadingLabels })}
                disabled={loadingLabels}
                style={{
                  padding: "6px 12px",
                  background: "#10b981",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                {ifElse(loadingLabels, "Loading...", "Refresh Labels")}
              </button>
            </div>,
            null,
          )}

          {/* Result display */}
          {ifElse(
            derive(result, (r: OperationResult | null) => r?.success === true),
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
                    Labels Updated Successfully!
                  </div>
                  <div style={{ fontSize: "12px", color: "#047857" }}>
                    Modified {derive(result, (r: OperationResult | null) =>
                      r?.messageCount)} message(s)
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
            derive(result, (r: OperationResult | null) =>
              r?.success === false),
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
                    Failed to Update Labels
                  </div>
                  <div style={{ fontSize: "14px", color: "#b91c1c" }}>
                    {derive(result, (r: OperationResult | null) =>
                      r?.error)}
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

          {/* Message count indicator */}
          <div
            style={{
              padding: "12px 16px",
              background: hasMessages ? "#dbeafe" : "#f3f4f6",
              borderRadius: "8px",
              fontSize: "14px",
            }}
          >
            <strong>
              {ifElse(
                hasMessages,
                <span>
                  {messageCount} message(s) selected for label changes
                </span>,
                <span style={{ color: "#6b7280" }}>
                  No messages selected. Link messageIds from a Gmail Importer.
                </span>,
              )}
            </strong>
          </div>

          {/* Label selection */}
          {ifElse(
            derive(availableLabels, (l: GmailLabel[]) => l.length > 0),
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "16px",
              }}
            >
              {/* Add labels section */}
              <div
                style={{
                  padding: "16px",
                  background: "#f0fdf4",
                  borderRadius: "8px",
                  border: "1px solid #86efac",
                }}
              >
                <div
                  style={{
                    fontWeight: "600",
                    marginBottom: "12px",
                    color: "#166534",
                  }}
                >
                  + Add Labels
                </div>
                <div
                  style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}
                >
                  {derive(availableLabels, (labels) =>
                    labels.map((label) => {
                      const isSelected = derive(labelsToAdd, (add) =>
                        add.includes(label.id));
                      const isInRemove = derive(labelsToRemove, (rem) =>
                        rem.includes(label.id));
                      return (
                        <button
                          type="button"
                          onClick={toggleAddLabel({
                            labelsToAdd,
                            labelId: label.id,
                          })}
                          disabled={isInRemove}
                          style={{
                            padding: "6px 12px",
                            borderRadius: "16px",
                            fontSize: "13px",
                            cursor: "pointer",
                            border: "1px solid",
                            borderColor: derive(
                              isSelected,
                              (s) => s ? "#16a34a" : "#d1d5db",
                            ),
                            background: derive(
                              isSelected,
                              (s) =>
                                s ? "#dcfce7" : "white",
                            ),
                            color: derive(
                              isSelected,
                              (s) =>
                                s ? "#166534" : "#374151",
                            ),
                            opacity: derive(isInRemove, (r) => (r ? 0.5 : 1)),
                          }}
                        >
                          {label.type === "system"
                            ? `[${label.name}]`
                            : label.name}
                        </button>
                      );
                    }))}
                </div>
              </div>

              {/* Remove labels section */}
              <div
                style={{
                  padding: "16px",
                  background: "#fef2f2",
                  borderRadius: "8px",
                  border: "1px solid #fca5a5",
                }}
              >
                <div
                  style={{
                    fontWeight: "600",
                    marginBottom: "12px",
                    color: "#991b1b",
                  }}
                >
                  − Remove Labels
                </div>
                <div
                  style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}
                >
                  {derive(availableLabels, (labels) =>
                    labels.map((label) => {
                      const isSelected = derive(labelsToRemove, (rem) =>
                        rem.includes(label.id));
                      const isInAdd = derive(labelsToAdd, (add) =>
                        add.includes(label.id));
                      return (
                        <button
                          type="button"
                          onClick={toggleRemoveLabel({
                            labelsToRemove,
                            labelId: label.id,
                          })}
                          disabled={isInAdd}
                          style={{
                            padding: "6px 12px",
                            borderRadius: "16px",
                            fontSize: "13px",
                            cursor: "pointer",
                            border: "1px solid",
                            borderColor: derive(
                              isSelected,
                              (s) => s ? "#dc2626" : "#d1d5db",
                            ),
                            background: derive(
                              isSelected,
                              (s) =>
                                s ? "#fee2e2" : "white",
                            ),
                            color: derive(
                              isSelected,
                              (s) =>
                                s ? "#991b1b" : "#374151",
                            ),
                            opacity: derive(isInAdd, (a) => (a ? 0.5 : 1)),
                          }}
                        >
                          {label.type === "system"
                            ? `[${label.name}]`
                            : label.name}
                        </button>
                      );
                    }))}
                </div>
              </div>
            </div>,
            <div
              style={{
                padding: "16px",
                background: "#f3f4f6",
                borderRadius: "8px",
                textAlign: "center",
                color: "#6b7280",
              }}
            >
              {ifElse(
                hasAuth,
                <span>
                  Click "Refresh Labels" above to load your Gmail labels.
                </span>,
                <span>Authenticate to load labels.</span>,
              )}
            </div>,
          )}

          {/* Apply button */}
          <button
            type="button"
            onClick={prepareOperation({
              messageIds,
              labelsToAdd,
              labelsToRemove,
              availableLabels,
              pendingOp,
            })}
            disabled={derive(canApply, (can) => !can)}
            style={{
              padding: "12px 24px",
              background: "#2563eb",
              color: "white",
              border: "none",
              borderRadius: "6px",
              fontSize: "16px",
              fontWeight: "500",
              cursor: "pointer",
              opacity: derive(canApply, (can) => (can ? 1 : 0.5)),
            }}
          >
            Review & Apply Changes
          </button>

          {/* CONFIRMATION DIALOG */}
          {ifElse(
            pendingOp,
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
                  maxWidth: "500px",
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
                    borderBottom: "2px solid #2563eb",
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                  }}
                >
                  <span style={{ fontSize: "24px" }}>🏷️</span>
                  <h3 style={{ margin: 0, color: "#2563eb", fontSize: "20px" }}>
                    Confirm Label Changes
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
                    <div
                      style={{
                        fontSize: "16px",
                        fontWeight: "500",
                        marginBottom: "12px",
                      }}
                    >
                      Modifying{" "}
                      <strong>
                        {derive(pendingOp, (op: LabelOperation | null) =>
                          op?.messageIds.length || 0)}
                      </strong>{" "}
                      message(s)
                    </div>

                    {/* Labels to add */}
                    {ifElse(
                      derive(
                        pendingOp,
                        (op: LabelOperation | null) =>
                          (op?.addLabelNames.length || 0) > 0,
                      ),
                      <div style={{ marginBottom: "12px" }}>
                        <div
                          style={{
                            fontSize: "13px",
                            color: "#166534",
                            fontWeight: "500",
                            marginBottom: "6px",
                          }}
                        >
                          + Adding:
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "6px",
                          }}
                        >
                          {derive(pendingOp, (op: LabelOperation | null) =>
                            (op?.addLabelNames || []).map((name: string) => (
                              <span
                                style={{
                                  background: "#dcfce7",
                                  color: "#166534",
                                  padding: "4px 10px",
                                  borderRadius: "12px",
                                  fontSize: "13px",
                                }}
                              >
                                {name}
                              </span>
                            )))}
                        </div>
                      </div>,
                      null,
                    )}

                    {/* Labels to remove */}
                    {ifElse(
                      derive(
                        pendingOp,
                        (op: LabelOperation | null) =>
                          (op?.removeLabelNames.length || 0) > 0,
                      ),
                      <div>
                        <div
                          style={{
                            fontSize: "13px",
                            color: "#991b1b",
                            fontWeight: "500",
                            marginBottom: "6px",
                          }}
                        >
                          − Removing:
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "6px",
                          }}
                        >
                          {derive(pendingOp, (op: LabelOperation | null) =>
                            (op?.removeLabelNames || []).map((name: string) => (
                              <span
                                style={{
                                  background: "#fee2e2",
                                  color: "#991b1b",
                                  padding: "4px 10px",
                                  borderRadius: "12px",
                                  fontSize: "13px",
                                }}
                              >
                                {name}
                              </span>
                            )))}
                        </div>
                      </div>,
                      null,
                    )}
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
                      This will modify your Gmail labels
                    </div>
                    <div style={{ fontSize: "14px", color: "#78350f" }}>
                      The selected labels will be added or removed from the
                      specified messages in your Gmail account.
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
                    onClick={cancelOperation({ pendingOp })}
                    disabled={processing}
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
                    onClick={confirmOperation({
                      pendingOp,
                      auth,
                      processing,
                      result,
                      labelsToAdd,
                      labelsToRemove,
                    })}
                    disabled={processing}
                    style={{
                      padding: "10px 20px",
                      background: "#2563eb",
                      color: "white",
                      border: "none",
                      borderRadius: "6px",
                      fontSize: "14px",
                      fontWeight: "500",
                      cursor: "pointer",
                      opacity: derive(processing, (p) => (p ? 0.7 : 1)),
                    }}
                  >
                    {ifElse(processing, "Applying...", "Apply Changes")}
                  </button>
                </div>
              </div>
            </div>,
            null,
          )}
        </div>
      ),
      messageIds,
      labelsToAdd,
      labelsToRemove,
      result,
      availableLabels,
    };
  },
);
