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
import GmailExtractor, { type Email } from "../core/gmail-extractor.tsx";
import type { Auth } from "../core/util/google-auth-manager.tsx";
import {
  type GmailLabel,
  GmailSendClient,
} from "../core/util/gmail-send-client.ts";
import {
  createGoogleAuth,
  type ScopeKey,
} from "../core/util/google-auth-manager.tsx";
import ProcessingStatus from "../core/processing-status.tsx";
import type { Stream } from "commontools";

// Debug flag for development
const DEBUG_NOTES = false;

// =============================================================================
// TYPES
// =============================================================================

interface Note {
  id: string;
  content: string; // Markdown content for display
  htmlContent: string; // Original HTML for rich-text copying
  date: string;
  snippet: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Clean up content - minimal cleanup now that UTF-8 decoding is fixed
 */
function cleanContent(content: string): string {
  return content
    // Normalize multiple spaces
    .replace(/  +/g, " ")
    .trim();
}

/**
 * Format date for display (relative dates for recent, otherwise short format)
 */
function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = new Date(Temporal.Now.instant().epochMilliseconds);
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
    removeLabels: Stream<{ messageId: string; labels: string[] }>;
    noteId: string;
    taskCurrentLabelId: Writable<string>;
    hiddenNotes: Writable<string[]>;
    processingNotes: Writable<string[]>;
  }
>(
  (
    _event,
    { removeLabels, noteId, taskCurrentLabelId, hiddenNotes, processingNotes },
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
      // Dispatch to extractor's removeLabels stream
      removeLabels.send({ messageId: noteId, labels: [labelId] });

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
      const stillProcessing = processingNotes.get().filter((id) =>
        id !== noteId
      );
      processingNotes.set(stillProcessing);
    }
  },
);

/**
 * Fetch labels to find task-current label ID
 */
const fetchLabels = handler<
  unknown,
  {
    auth: Writable<Auth>;
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
      (l: GmailLabel) => l?.name?.toLowerCase() === "task-current",
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

// deno-lint-ignore no-empty-interface
interface PatternInput {
  // No inputs needed - pattern manages its own auth via createGoogleAuth()
}

/** Email notes manager for quick notes sent to self. #emailNotes */
interface PatternOutput {
  notes: Note[];
  noteCount: number;
  previewUI: unknown;
}

export default pattern<PatternInput, PatternOutput>(() => {
  // State for label operations
  const taskCurrentLabelId = Writable.of("").for("taskCurrentLabelId");
  const loadingLabels = Writable.of(false).for("loadingLabels");
  const hiddenNotes = Writable.of<string[]>([]).for("hiddenNotes");
  const processingNotes = Writable.of<string[]>([]).for("processingNotes");
  const sortNewestFirst = Writable.of(true).for("sortNewestFirst");

  // Use createGoogleAuth for scopes that include gmailModify
  // Note: We use auth directly (not wrapped in ifElse) because GmailSendClient
  // requires a Writable<Auth> with .get() method. Wrapping in ifElse() creates
  // a derived value that loses writability.
  const {
    auth,
    fullUI: authUI,
    isReady,
  } = createGoogleAuth({
    requiredScopes: ["gmail", "gmailModify"] as ScopeKey[],
  });

  // Create a Stream from the fetchLabels handler for auto-triggering
  const labelFetcherStream = fetchLabels({
    auth,
    taskCurrentLabelId,
    loadingLabels,
  });

  // NOTE: Auto-fetch labels was removed because having side effects (writes to
  // Writable cells, sending to streams) inside computed() caused infinite reactive
  // loops that kept CPU at 88%. Users can click "Load Labels" button when needed.
  // See docs/common/concepts/computed/side-effects.md for why computed() with
  // side effects is problematic.

  // Directly instantiate GmailExtractor with task-current filter (raw mode)
  // Note: Gmail API doesn't support subject:"" for empty subjects, so we only
  // filter by label here and do client-side filtering for empty subjects
  // Pass auth directly to maintain Writable<Auth> for token refresh
  const extractor = GmailExtractor({
    gmailQuery: "label:task-current",
    limit: 100,
    overrideAuth: auth,
  });

  // Get emails from extractor
  const allEmails = extractor.emails;

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
        content: cleanContent(
          email.markdownContent || email.plainText || email.snippet,
        ),
        htmlContent: cleanContent(
          email.htmlContent || email.plainText || email.snippet,
        ),
        date: email.date,
        snippet: email.snippet,
      }))
      .sort((a, b) => {
        const dateA = new Date(a.date).getTime();
        const dateB = new Date(b.date).getTime();
        return sortNewestFirst.get() ? dateB - dateA : dateA - dateB;
      });
  });

  const noteCount = computed(() => notes?.length || 0);

  // No processing/analysis in this pattern, so pending is always 0
  const pendingCount = computed(() => 0);
  const completedCount = computed(() => noteCount);

  // Preview UI for compact display
  const previewUI = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "8px 12px",
      }}
    >
      <div
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "8px",
          backgroundColor: "#eff6ff",
          border: "2px solid #3b82f6",
          color: "#1d4ed8",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: "bold",
          fontSize: "16px",
        }}
      >
        {noteCount}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: "600", fontSize: "14px" }}>Email Notes</div>
        <div style={{ fontSize: "12px", color: "#6b7280" }}>
          {derive(noteCount, (count) =>
            count === 1 ? "1 note" : `${count} notes`)}
        </div>
        {/* Loading/progress indicator */}
        <ProcessingStatus
          totalCount={noteCount}
          pendingCount={pendingCount}
          completedCount={completedCount}
        />
      </div>
    </div>
  );

  return {
    [NAME]: "Email Notes",
    notes,
    noteCount,
    previewUI,

    [UI]: (
      <ct-screen>
        <div slot="header">
          <ct-hstack align="center" gap="2">
            <ct-heading level={3}>Email Notes</ct-heading>
            <span style={{ color: "#6b7280", fontSize: "14px" }}>
              ({noteCount} notes)
            </span>
            <ct-checkbox $checked={sortNewestFirst}>Newest first</ct-checkbox>
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
                  onClick={extractor.refresh}
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

            {/* Label status - only show when there's a problem or loading */}
            {ifElse(
              derive(
                { isReady, taskCurrentLabelId, loadingLabels },
                ({ isReady, taskCurrentLabelId, loadingLabels }) =>
                  isReady && (!taskCurrentLabelId || loadingLabels),
              ),
              <div
                style={{
                  padding: "8px 12px",
                  backgroundColor: "#fef3c7",
                  borderRadius: "6px",
                  fontSize: "13px",
                  color: "#b45309",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                {ifElse(
                  loadingLabels,
                  <span>Loading labels...</span>,
                  <span>
                    task-current label not found - click Load Labels
                  </span>,
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
                  // Extract noteId before computed to avoid OpaqueRef issues
                  const noteId = note.id;
                  const isProcessing = computed(() =>
                    (processingNotes.get() || []).includes(noteId)
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
                          {/* Copy button - copies both plain text and HTML for rich pasting */}
                          <ct-copy-button
                            text={derive(note, (n) => ({
                              "text/plain": n.content,
                              "text/html": n.htmlContent,
                            }))}
                            variant="outline"
                            size="sm"
                          />

                          {/* Mark as Done button */}
                          <button
                            type="button"
                            onClick={markAsDone({
                              removeLabels: extractor.removeLabels,
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
                              backgroundColor: derive(
                                isProcessing,
                                (p) => p ? "#e5e7eb" : "#3b82f6",
                              ),
                              color: derive(
                                isProcessing,
                                (p) => p ? "#9ca3af" : "white",
                              ),
                              border: "none",
                              borderRadius: "4px",
                              fontSize: "12px",
                              cursor: derive(
                                isProcessing,
                                (p) => p ? "not-allowed" : "pointer",
                              ),
                              fontWeight: "500",
                              opacity: derive(
                                taskCurrentLabelId,
                                (id) => id ? 1 : 0.5,
                              ),
                            }}
                          >
                            {ifElse(isProcessing, "Processing...", "Done")}
                          </button>
                        </div>
                      </div>

                      {/* Note content - rendered as markdown */}
                      <ct-markdown
                        content={derive(note, (n) => n.content)}
                        compact
                        style="font-size: 14px; line-height: 1.5; color: #374151;"
                      />
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
