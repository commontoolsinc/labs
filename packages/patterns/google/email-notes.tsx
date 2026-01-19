/// <cts-enable />
/**
 * Email Notes Pattern
 *
 * Fetches emails with `label:task-current` that have no subject (notes sent to self),
 * displays them with copy buttons, and allows marking them as "done" by removing
 * the `task-current` label.
 *
 * Features:
 * - Embeds gmail-importer directly (like usps-informed-delivery.tsx)
 * - Pre-configured with task-current label filter
 * - Filters client-side to only show emails with empty subjects
 * - Copy note content to clipboard
 * - Mark as Done removes the task-current label
 *
 * Usage:
 * 1. Deploy this pattern
 * 2. Authenticate with Google (will auto-prompt)
 * 3. View notes, copy content, mark as done
 */
import {
  computed,
  derive,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import GmailImporter, { type Email } from "./gmail-importer.tsx";
import type { Auth } from "./util/google-auth-manager.tsx";
import { type GmailLabel, GmailSendClient } from "./util/gmail-send-client.ts";
import {
  createGoogleAuth,
  type ScopeKey,
} from "./util/google-auth-manager.tsx";

// Debug flag for development
const DEBUG_NOTES = false;

// =============================================================================
// TYPES
// =============================================================================

interface Note {
  id: string;
  content: string;
  date: string;
  snippet: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Format date for display (relative dates for recent, otherwise short format)
 */
function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    } else if (diffDays === 1) {
      return "Yesterday";
    } else if (diffDays < 7) {
      return date.toLocaleDateString([], { weekday: "short" });
    } else {
      return date.toLocaleDateString([], { month: "short", day: "numeric" });
    }
  } catch {
    return dateStr;
  }
}

// =============================================================================
// HANDLERS
// =============================================================================

/**
 * Mark a note as done by removing the task-current label
 */
const markAsDone = handler<
  unknown,
  {
    // deno-lint-ignore no-explicit-any
    auth: any;
    noteId: string;
    taskCurrentLabelId: Writable<string>;
    hiddenNotes: Writable<string[]>;
    processingNotes: Writable<string[]>;
  }
>(async (
  _event,
  { auth, noteId, taskCurrentLabelId, hiddenNotes, processingNotes },
) => {
  const labelId = taskCurrentLabelId.get();
  if (!labelId) {
    console.error("[EmailNotes] task-current label ID not found");
    return;
  }

  // Add to processing list
  const currentProcessing = processingNotes.get();
  processingNotes.set([...currentProcessing, noteId]);

  try {
    const client = new GmailSendClient(auth, { debugMode: DEBUG_NOTES });
    await client.modifyLabels(noteId, {
      removeLabelIds: [labelId],
    });

    if (DEBUG_NOTES) {
      console.log("[EmailNotes] Marked as done:", noteId);
    }

    // Add to hidden list to remove from display
    const currentHidden = hiddenNotes.get();
    hiddenNotes.set([...currentHidden, noteId]);
  } catch (err) {
    console.error("[EmailNotes] Failed to mark as done:", err);
  } finally {
    // Remove from processing list
    const stillProcessing = processingNotes.get().filter((id) => id !== noteId);
    processingNotes.set(stillProcessing);
  }
});

/**
 * Fetch labels to find task-current label ID
 */
const fetchLabels = handler<
  unknown,
  {
    // deno-lint-ignore no-explicit-any
    auth: any;
    taskCurrentLabelId: Writable<string>;
    loadingLabels: Writable<boolean>;
  }
>(async (_event, { auth, taskCurrentLabelId, loadingLabels }) => {
  loadingLabels.set(true);
  try {
    const client = new GmailSendClient(auth, { debugMode: DEBUG_NOTES });
    const labels = await client.listLabels();

    // Find task-current label (case-insensitive)
    const taskLabel = labels.find(
      (l: GmailLabel) => l.name.toLowerCase() === "task-current",
    );

    if (taskLabel) {
      taskCurrentLabelId.set(taskLabel.id);
      if (DEBUG_NOTES) {
        console.log("[EmailNotes] Found task-current label:", taskLabel.id);
      }
    } else {
      console.warn("[EmailNotes] task-current label not found");
    }
  } catch (error) {
    console.error("[EmailNotes] Failed to fetch labels:", error);
  } finally {
    loadingLabels.set(false);
  }
});

// =============================================================================
// PATTERN
// =============================================================================

interface PatternInput {
  // Optional: Link auth directly from a Google Auth charm
  linkedAuth?: Auth;
}

/** Email notes manager for quick notes sent to self. #emailNotes */
interface PatternOutput {
  notes: Note[];
  noteCount: number;
}

export default pattern<PatternInput, PatternOutput>(({ linkedAuth }) => {
  // State for label operations
  const taskCurrentLabelId = Writable.of("").for("taskCurrentLabelId");
  const loadingLabels = Writable.of(false).for("loadingLabels");
  const hiddenNotes = Writable.of<string[]>([]).for("hiddenNotes");
  const processingNotes = Writable.of<string[]>([]).for("processingNotes");

  // Use createGoogleAuth for scopes that include gmailModify
  const {
    auth,
    fullUI: authUI,
    isReady,
  } = createGoogleAuth({
    requiredScopes: ["gmail", "gmailModify"] as ScopeKey[],
  });

  // Compute the effective auth - use linkedAuth if provided, otherwise auth from createGoogleAuth
  const hasLinkedAuth = computed(() => !!linkedAuth && !!linkedAuth.token);
  const effectiveAuth = ifElse(hasLinkedAuth, linkedAuth, auth);

  // Create a Stream from the fetchLabels handler for auto-triggering
  const labelFetcherStream = fetchLabels({
    auth: effectiveAuth,
    taskCurrentLabelId,
    loadingLabels,
  });

  // Auto-fetch labels when auth becomes ready
  // Track whether we've already triggered auto-fetch to prevent loops
  const hasAutoFetchedLabels = Writable.of(false).for("hasAutoFetchedLabels");

  computed(() => {
    const ready = isReady;
    const alreadyFetched = hasAutoFetchedLabels.get();
    const hasLabelId = !!taskCurrentLabelId.get();
    const currentlyLoading = loadingLabels.get();

    // Only auto-fetch once when:
    // - Auth is ready
    // - We haven't already auto-fetched this session
    // - No label ID loaded yet
    // - Not currently loading labels
    if (ready && !alreadyFetched && !hasLabelId && !currentlyLoading) {
      if (DEBUG_NOTES) {
        console.log("[EmailNotes] Auto-fetching labels on auth ready");
      }
      hasAutoFetchedLabels.set(true);
      // Trigger the label fetch via stream
      labelFetcherStream.send({});
    }
  });

  // Directly instantiate GmailImporter with task-current filter
  // Note: subject:"" in Gmail search means empty subject
  // GmailImporter will use linkedAuth if provided, otherwise its own wish
  const gmailImporter = GmailImporter({
    settings: {
      gmailFilterQuery: 'label:task-current subject:""',
      autoFetchOnAuth: true,
      resolveInlineImages: false,
      limit: 50,
      debugMode: DEBUG_NOTES,
    },
    linkedAuth: effectiveAuth,
  });

  // Get emails from importer
  const allEmails = gmailImporter.emails;

  // Filter for notes (empty subject) and exclude hidden ones
  const notes = computed(() => {
    const emails = allEmails || [];
    const hidden = new Set(hiddenNotes.get());

    return emails
      .filter((email: Email) => {
        // Filter for empty/missing subject
        const hasNoSubject = !email.subject || email.subject.trim() === "";
        // Exclude hidden notes
        const isNotHidden = !hidden.has(email.id);
        return hasNoSubject && isNotHidden;
      })
      .map((email: Email) => ({
        id: email.id,
        content: email.markdownContent || email.plainText || email.snippet,
        date: email.date,
        snippet: email.snippet,
      }));
  });

  const noteCount = computed(() => notes?.length || 0);

  return {
    [NAME]: "Email Notes",
    notes,
    noteCount,

    [UI]: (
      <ct-screen>
        <div slot="header">
          <ct-hstack align="center" gap="2">
            <ct-heading level={3}>Email Notes</ct-heading>
            <span style={{ color: "#6b7280", fontSize: "14px" }}>
              ({noteCount} notes)
            </span>
          </ct-hstack>
        </div>

        <ct-vscroll flex showScrollbar>
          <ct-vstack padding="6" gap="4">
            {/* Auth UI */}
            {authUI}

            {/* Connection status and refresh */}
            {ifElse(
              isReady,
              <div
                style={{
                  padding: "12px 16px",
                  backgroundColor: "#d1fae5",
                  borderRadius: "8px",
                  border: "1px solid #10b981",
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
                <span>Connected</span>
                <span style={{ marginLeft: "auto", color: "#059669" }}>
                  {noteCount} notes found
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
                  Refresh
                </button>
              </div>,
              null,
            )}

            {/* Label status with Load Labels button */}
            {ifElse(
              isReady,
              <div
                style={{
                  padding: "8px 12px",
                  backgroundColor: taskCurrentLabelId ? "#f0fdf4" : "#fef3c7",
                  borderRadius: "6px",
                  fontSize: "13px",
                  color: taskCurrentLabelId ? "#166534" : "#b45309",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                {ifElse(
                  loadingLabels,
                  <span>Loading labels...</span>,
                  ifElse(
                    taskCurrentLabelId,
                    <span>task-current label ready</span>,
                    <span>
                      task-current label not found - click Load Labels
                    </span>,
                  ),
                )}
                <button
                  type="button"
                  onClick={labelFetcherStream}
                  disabled={loadingLabels}
                  style={{
                    marginLeft: "8px",
                    padding: "4px 10px",
                    backgroundColor: loadingLabels ? "#9ca3af" : "#6366f1",
                    color: "white",
                    border: "none",
                    borderRadius: "4px",
                    fontSize: "12px",
                    cursor: loadingLabels ? "not-allowed" : "pointer",
                    fontWeight: "500",
                  }}
                >
                  {ifElse(loadingLabels, "Loading...", "Load Labels")}
                </button>
              </div>,
              null,
            )}

            {/* Notes list */}
            {ifElse(
              derive(noteCount, (count) => count === 0),
              <div
                style={{
                  padding: "24px",
                  textAlign: "center",
                  color: "#6b7280",
                  backgroundColor: "#f9fafb",
                  borderRadius: "8px",
                }}
              >
                <div style={{ fontSize: "16px", marginBottom: "8px" }}>
                  No notes found
                </div>
                <div style={{ fontSize: "13px" }}>
                  Send yourself an email with no subject and the label
                  "task-current" to see it here.
                </div>
              </div>,
              <ct-vstack gap="3">
                {notes.map((note) => {
                  // Check if this note is being processed
                  // Note: Inside .map(), 'note' is a reactive cell reference
                  const isProcessing = computed(() =>
                    processingNotes.get().includes(note.id)
                  );

                  return (
                    <div
                      style={{
                        padding: "16px",
                        backgroundColor: "#ffffff",
                        borderRadius: "8px",
                        border: "1px solid #e5e7eb",
                        boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05)",
                      }}
                    >
                      {/* Header with date and actions */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          marginBottom: "12px",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "12px",
                            color: "#9ca3af",
                          }}
                        >
                          {derive(note, (n) => formatDate(n.date))}
                        </span>
                        <div style={{ display: "flex", gap: "8px" }}>
                          {/* Copy button - uses ct-copy-button component */}
                          <ct-copy-button
                            text={note.content}
                            variant="outline"
                            size="sm"
                          >
                            Copy
                          </ct-copy-button>

                          {/* Mark as Done button */}
                          <button
                            type="button"
                            onClick={markAsDone({
                              auth: effectiveAuth,
                              noteId: note.id,
                              taskCurrentLabelId,
                              hiddenNotes,
                              processingNotes,
                            })}
                            disabled={derive(
                              { isProcessing, taskCurrentLabelId },
                              ({ isProcessing, taskCurrentLabelId }) =>
                                isProcessing || !taskCurrentLabelId,
                            )}
                            style={{
                              padding: "4px 10px",
                              backgroundColor: isProcessing
                                ? "#e5e7eb"
                                : "#3b82f6",
                              color: isProcessing ? "#9ca3af" : "white",
                              border: "none",
                              borderRadius: "4px",
                              fontSize: "12px",
                              cursor: isProcessing ? "not-allowed" : "pointer",
                              fontWeight: "500",
                              opacity: derive(taskCurrentLabelId, (id) =>
                                id ? 1 : 0.5),
                            }}
                          >
                            {ifElse(isProcessing, "Processing...", "Done")}
                          </button>
                        </div>
                      </div>

                      {/* Note content */}
                      <div
                        style={{
                          fontSize: "14px",
                          lineHeight: "1.5",
                          color: "#374151",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {note.content}
                      </div>
                    </div>
                  );
                })}
              </ct-vstack>,
            )}
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
  };
});
