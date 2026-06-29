/**
 * Email Task Engine Pattern
 *
 * Fetches emails with `label:task-current` that HAVE subjects (opposite of email-notes),
 * uses LLM with tool calling to suggest actionable items like editing existing notes.
 * Designed with self-hoisting feedback loops in mind for future auto-execution.
 *
 * Features:
 * - Fetches task-current labeled emails with subjects
 * - LLM analyzes each email and suggests actions via tools
 * - Can search existing notes and suggest edits
 * - Execute/Dismiss buttons for user control
 * - Removes label after execution
 *
 * Confidence Tiers (current: Tier 1):
 * - < 0.5: Show "No auto-suggestion" message
 * - 0.5-0.8: Normal suggestion card
 * - > 0.8: (Future) High confidence, batch-executable
 */
import {
  computed,
  Default,
  generateObject,
  handler,
  NAME,
  pattern,
  schema,
  safeDateNow,
  Stream,
  TILE_UI,
  UI,
  wish,
  Writable,
} from "commonfabric";
import GmailExtractor, { type Email } from "../google/core/gmail-extractor.tsx";
import type {
  Auth,
  GoogleAuthCell,
} from "../google/core/util/google-auth-manager.tsx";
import {
  type GmailLabel,
  GmailSendClient,
} from "../google/core/util/gmail-send-client.ts";
import {
  createGoogleAuth,
  type ScopeKey,
} from "../google/core/util/google-auth-manager.tsx";
import ProcessingStatus from "../google/core/processing-status.tsx";
import Note from "../notes/note.tsx";

// Debug flag for development
const DEBUG_TASKS = false;

// =============================================================================
// TYPES
// =============================================================================

interface TaskEmail {
  id: string;
  subject: string;
  snippet: string;
  markdownContent: string;
  date: string;
  from: string;
}

// Type for the flat schema result used by generateObject
interface SuggestionResult {
  actionType: "edit-note" | "create-note" | "no-action";
  noteTitle?: string;
  addition?: string;
  title?: string;
  content?: string;
  reason?: string;
  confidence: number;
  reasoning?: string;
}

interface TaskAnalysis {
  email: TaskEmail;
  result: SuggestionResult | undefined;
  pending: boolean;
  error?: unknown;
}

// Note type from wish
type NotePiece = {
  [NAME]?: string;
  content?: string;
  title?: string;
  editContent?: Stream<{ detail: { value: string } }>;
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Format date for display (relative dates for recent, otherwise short format)
 */
function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = new Date(safeDateNow());
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

/**
 * Truncate text to a maximum length with ellipsis
 */
function truncateText(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) return text || "";
  return text.slice(0, maxLength - 3) + "...";
}

// =============================================================================
// HANDLERS (Module Scope)
// =============================================================================

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
    const client = GmailSendClient(auth, { debugMode: DEBUG_TASKS });
    const labels = await client.listLabels();

    // Find task-current label (case-insensitive)
    const taskLabel = labels.find(
      (l: GmailLabel) => l.name.toLowerCase() === "task-current",
    );

    if (taskLabel) {
      taskCurrentLabelId.set(taskLabel.id);
      if (DEBUG_TASKS) {
        console.log(
          "[EmailTaskEngine] Found task-current label:",
          taskLabel.id,
        );
      }
    } else {
      console.warn("[EmailTaskEngine] task-current label not found");
    }
  } catch (error) {
    console.error("[EmailTaskEngine] Failed to fetch labels:", error);
  } finally {
    loadingLabels.set(false);
  }
});

/**
 * Execute an edit-note suggestion
 */
const executeEditNote = handler<
  unknown,
  {
    removeLabels: Stream<{ messageId: string; labels: string[] }>;
    emailId: string;
    noteTitle: string;
    addition: string;
    taskCurrentLabelId: Writable<string>;
    hiddenTasks: Writable<string[]>;
    processingTasks: Writable<string[]>;
    allPieces: Writable<NotePiece[]>;
  }
>(
  (
    _event,
    {
      removeLabels,
      emailId,
      noteTitle,
      addition,
      taskCurrentLabelId,
      hiddenTasks,
      processingTasks,
      allPieces,
    },
  ) => {
    const labelId = taskCurrentLabelId.get();
    if (!labelId) {
      console.error("[EmailTaskEngine] task-current label ID not found");
      return;
    }

    // Add to processing list
    const currentProcessing = processingTasks.get();
    processingTasks.set([...currentProcessing, emailId]);

    try {
      // Find the target note
      const pieces = allPieces.get() || [];
      const targetNoteIndex = pieces.findIndex((piece: NotePiece) => {
        const name = piece?.[NAME] || "";
        // Notes are named "📝 Title", extract title for matching
        const titleFromName = name.replace(/^📝\s*/, "").trim();
        return (
          titleFromName.toLowerCase() === noteTitle.toLowerCase() ||
          (piece as any)?.title?.toLowerCase() === noteTitle.toLowerCase()
        );
      });

      if (targetNoteIndex >= 0) {
        // Get the note cell and update content
        const noteCell = allPieces.key(targetNoteIndex);
        const contentCell = noteCell.key("content");
        const currentContent = contentCell.get() || "";

        // Append the addition with a newline separator
        const newContent = currentContent.trim()
          ? `${currentContent.trim()}\n\n${addition}`
          : addition;
        contentCell.set(newContent);

        if (DEBUG_TASKS) {
          console.log("[EmailTaskEngine] Updated note:", noteTitle);
        }

        // Remove the label after successful update
        removeLabels.send({ messageId: emailId, labels: [labelId] });

        // Add to hidden list to remove from display
        const currentHidden = hiddenTasks.get();
        hiddenTasks.set([...currentHidden, emailId]);
      } else {
        console.error("[EmailTaskEngine] Target note not found:", noteTitle);
      }
    } catch (err) {
      console.error("[EmailTaskEngine] Failed to execute edit-note:", err);
    } finally {
      // Remove from processing list
      const stillProcessing = processingTasks.get().filter((id) =>
        id !== emailId
      );
      processingTasks.set(stillProcessing);
    }
  },
);

/**
 * Execute a create-note suggestion
 */
const executeCreateNote = handler<
  unknown,
  {
    removeLabels: Stream<{ messageId: string; labels: string[] }>;
    emailId: string;
    title: string;
    content: string;
    taskCurrentLabelId: Writable<string>;
    hiddenTasks: Writable<string[]>;
    processingTasks: Writable<string[]>;
    allPieces: Writable<NotePiece[] | Default<[]>>;
  }
>(
  (
    _event,
    {
      removeLabels,
      emailId,
      title,
      content,
      taskCurrentLabelId,
      hiddenTasks,
      processingTasks,
      allPieces,
    },
  ) => {
    const labelId = taskCurrentLabelId.get();
    if (!labelId) {
      console.error("[EmailTaskEngine] task-current label ID not found");
      return;
    }

    // Add to processing list
    const currentProcessing = processingTasks.get();
    processingTasks.set([...currentProcessing, emailId]);

    try {
      // Create a new note
      const newNote = Note({
        title,
        content,
        isHidden: false,
      });

      // Add to allPieces
      allPieces.push(newNote);

      if (DEBUG_TASKS) {
        console.log("[EmailTaskEngine] Created new note:", title);
      }

      // Remove the label after successful creation
      removeLabels.send({ messageId: emailId, labels: [labelId] });

      // Add to hidden list to remove from display
      const currentHidden = hiddenTasks.get();
      hiddenTasks.set([...currentHidden, emailId]);
    } catch (err) {
      console.error("[EmailTaskEngine] Failed to execute create-note:", err);
    } finally {
      // Remove from processing list
      const stillProcessing = processingTasks.get().filter((id) =>
        id !== emailId
      );
      processingTasks.set(stillProcessing);
    }
  },
);

/**
 * Dismiss a task without action
 */
const dismissTask = handler<
  unknown,
  {
    removeLabels: Stream<{ messageId: string; labels: string[] }>;
    emailId: string;
    taskCurrentLabelId: Writable<string>;
    hiddenTasks: Writable<string[]>;
    processingTasks: Writable<string[]>;
  }
>(
  (
    _event,
    { removeLabels, emailId, taskCurrentLabelId, hiddenTasks, processingTasks },
  ) => {
    const labelId = taskCurrentLabelId.get();
    if (!labelId) {
      console.error("[EmailTaskEngine] task-current label ID not found");
      return;
    }

    // Add to processing list
    const currentProcessing = processingTasks.get();
    processingTasks.set([...currentProcessing, emailId]);

    try {
      // Remove the label
      removeLabels.send({ messageId: emailId, labels: [labelId] });

      if (DEBUG_TASKS) {
        console.log("[EmailTaskEngine] Dismissed task:", emailId);
      }

      // Add to hidden list to remove from display
      const currentHidden = hiddenTasks.get();
      hiddenTasks.set([...currentHidden, emailId]);
    } catch (err) {
      console.error("[EmailTaskEngine] Failed to dismiss task:", err);
    } finally {
      // Remove from processing list
      const stillProcessing = processingTasks.get().filter((id) =>
        id !== emailId
      );
      processingTasks.set(stillProcessing);
    }
  },
);

// =============================================================================
// SCHEMA FOR LLM
// =============================================================================

// Simpler flat schema that works better with the framework's type system
const SUGGESTION_SCHEMA = schema({
  type: "object" as const,
  description:
    "Suggested action for this email. Use actionType to indicate what kind of action.",
  properties: {
    actionType: {
      type: "string" as const,
      enum: ["edit-note", "create-note", "no-action"],
      description:
        "Type of action: 'edit-note' to add to existing note, 'create-note' to make new note, 'no-action' if email needs no action",
    },
    // For edit-note
    noteTitle: {
      type: "string" as const,
      description: "For edit-note: The exact title of the note to edit",
    },
    addition: {
      type: "string" as const,
      description: "For edit-note: The text to append to the note",
    },
    // For create-note
    title: {
      type: "string" as const,
      description: "For create-note: Title for the new note",
    },
    content: {
      type: "string" as const,
      description: "For create-note: Content for the new note",
    },
    // For no-action
    reason: {
      type: "string" as const,
      description: "For no-action: Why no action is needed",
    },
    // Common fields
    confidence: {
      type: "number" as const,
      description: "Confidence score between 0 and 1",
    },
    reasoning: {
      type: "string" as const,
      description: "Brief explanation of why this action was chosen",
    },
  },
  required: ["actionType", "confidence"],
});

// =============================================================================
// PATTERN
// =============================================================================

interface PatternInput {
  overrideAuth?: GoogleAuthCell;
}

export interface PatternOutput {
  taskEmails: TaskEmail[];
  taskCount: number;
  analyses: TaskAnalysis[];
  [TILE_UI]: unknown;
}

/** Email task engine for processing actionable emails. #emailTaskEngine */
export default pattern<PatternInput, PatternOutput>(({ overrideAuth }) => {
  // State for label operations
  const taskCurrentLabelId = new Writable("").for("taskCurrentLabelId");
  const loadingLabels = new Writable(false).for("loadingLabels");
  const hiddenTasks = new Writable<string[]>([]).for("hiddenTasks");
  const processingTasks = new Writable<string[]>([]).for("processingTasks");
  const sortNewestFirst = new Writable(true).for("sortNewestFirst");

  // Get all pieces for note discovery
  const { allPieces } = wish<{ allPieces: NotePiece[] }>({ query: "#default" })
    .result!;

  // Use createGoogleAuth for scopes that include gmailModify
  const {
    availability,
    fullUI: authUI,
  } = createGoogleAuth({
    requiredScopes: ["gmail", "gmailModify"] as ScopeKey[],
  });
  const auth = availability.state === "ready" ? availability.auth : null;

  // Resolve auth: use overrideAuth if provided, otherwise use created auth.
  const hasOverrideAuth = computed(() => !!overrideAuth?.get()?.token);
  const resolvedAuth = overrideAuth && hasOverrideAuth ? overrideAuth : auth;
  const extractorAuth = resolvedAuth ? resolvedAuth : undefined;

  // Auto-fetch labels is handled by the UI button - removed auto-trigger
  // to avoid reactivity loops from side effects in computed()

  // Instantiate GmailExtractor in raw mode (no extraction)
  const extractor = GmailExtractor({
    gmailQuery: "label:task-current",
    limit: 50,
    overrideAuth: extractorAuth,
  });

  // Get emails from extractor
  const allEmails = extractor.emails;

  // Filter for task emails (WITH subject) and exclude hidden ones
  const taskEmails = computed(() => {
    const emails = allEmails || [];
    const hidden = new Set(hiddenTasks.get());

    return emails
      .filter((email: Email) => {
        // Filter for non-empty subject (opposite of email-notes)
        const hasSubject = email.subject && email.subject.trim() !== "";
        // Exclude reminders marked with (R) in subject
        const isNotReminder = !email.subject?.includes("(R)");
        // Exclude hidden tasks
        const isNotHidden = !hidden.has(email.id);
        return hasSubject && isNotReminder && isNotHidden;
      })
      .map((email: Email) => ({
        id: email.id,
        subject: email.subject || "",
        snippet: email.snippet || "",
        markdownContent: email.markdownContent || email.plainText ||
          email.snippet || "",
        date: email.date || "",
        from: email.from || "",
      }))
      .sort((a, b) => {
        const dateA = new Date(a.date).getTime();
        const dateB = new Date(b.date).getTime();
        return sortNewestFirst.get() ? dateB - dateA : dateA - dateB;
      });
  });

  const taskCount = taskEmails?.length || 0;

  // Get available notes for the LLM context
  const availableNotes = computed(() => {
    const pieces = allPieces || [];
    return pieces
      .filter((piece: NotePiece) => {
        const name = piece?.[NAME];
        return typeof name === "string" && name.startsWith("📝");
      })
      .map((piece: NotePiece) => {
        const name = piece?.[NAME] || "";
        const title = name.replace(/^📝\s*/, "").trim();
        const content = (piece as any)?.content || "";
        return {
          title,
          contentPreview: truncateText(content, 200),
        };
      });
  });

  // Analyze each task email with LLM
  const analyses = taskEmails.map((email: TaskEmail) => {
    const llmAnalysis = generateObject<SuggestionResult>({
      prompt: computed(() => {
        // Build notes context directly from availableNotes
        const notes = availableNotes || [];
        const notesContext = notes.length === 0
          ? "No existing notes found."
          : notes.map((n: { title: string; contentPreview: string }) =>
            `- "${n.title}": ${n.contentPreview}`
          ).join("\n");

        return `You are analyzing an email to suggest an action. The email has been labeled "task-current" indicating the user wants to take action on it.

AVAILABLE NOTES:
${notesContext}

EMAIL:
Subject: ${email.subject}
From: ${email.from}
Date: ${email.date}
Content:
${truncateText(email.markdownContent, 2000)}

INSTRUCTIONS:
1. If this email relates to an existing note, suggest editing that note by appending relevant information.
2. If this is a new topic that should be tracked, suggest creating a new note.
3. If this email is informational only, spam, or doesn't require action, suggest no-action.

Consider:
- Is there a note with a related topic?
- What specific content should be added?
- Use high confidence (0.8+) when the match is clear
- Use medium confidence (0.5-0.8) when it's a reasonable guess
- Use low confidence (<0.5) when unsure

Respond with the most appropriate action.`;
      }),
      schema: SUGGESTION_SCHEMA,
      model: "anthropic:claude-sonnet-4-5",
    });

    // Return the cells directly without wrapping in computed;
    // reactive reads unwrap them at the consuming sites.
    return {
      email,
      pending: llmAnalysis.pending,
      result: llmAnalysis.result,
      error: llmAnalysis.error,
    };
  });

  // Count pending and completed analyses
  const pendingCount = computed(
    () => analyses?.filter((a) => a?.pending)?.length || 0,
  );
  const completedCount = computed(
    () =>
      analyses?.filter((a) => !a?.pending && a?.result !== undefined)?.length ||
      0,
  );

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
          backgroundColor: "#fef3c7",
          border: "2px solid #f59e0b",
          color: "#b45309",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: "bold",
          fontSize: "16px",
        }}
      >
        {taskCount}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: "600", fontSize: "14px" }}>Email Tasks</div>
        <div style={{ fontSize: "12px", color: "#6b7280" }}>
          {taskCount === 1 ? "1 task" : `${taskCount} tasks`}
        </div>
        <ProcessingStatus
          totalCount={taskCount}
          pendingCount={pendingCount}
          completedCount={completedCount}
        />
      </div>
    </div>
  );

  return {
    [NAME]: "Email Task Engine",
    taskEmails,
    taskCount,
    analyses,
    [TILE_UI]: previewUI,

    [UI]: (
      <cf-screen>
        <div slot="header">
          <cf-hstack align="center" gap="2">
            <cf-heading level={3}>Email Task Engine</cf-heading>
            <span style={{ color: "#6b7280", fontSize: "14px" }}>
              ({taskCount} tasks)
            </span>
            <cf-checkbox $checked={sortNewestFirst}>Newest first</cf-checkbox>
          </cf-hstack>
        </div>

        <cf-vscroll flex showScrollbar>
          <cf-vstack padding="6" gap="4">
            {/* Auth UI */}
            {authUI}

            {/* Connection status and refresh */}
            {resolvedAuth
              ? (
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
                    {`${taskCount} tasks found`}
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
                </div>
              )
              : null}

            {/* Analysis progress */}
            {resolvedAuth && pendingCount > 0
              ? (
                <div
                  style={{
                    padding: "12px 16px",
                    backgroundColor: "#eff6ff",
                    borderRadius: "8px",
                    border: "1px solid #3b82f6",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <cf-loader size="sm" />
                  <span style={{ color: "#2563eb" }}>
                    Analyzing {pendingCount} tasks...
                  </span>
                </div>
              )
              : null}

            {/* Label status warning */}
            {resolvedAuth && (!taskCurrentLabelId.get() || loadingLabels.get())
              ? (
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
                  {loadingLabels.get() ? <span>Loading labels...</span> : (
                    <span>
                      task-current label not found - click Load Labels
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={fetchLabels({
                      auth: resolvedAuth,
                      taskCurrentLabelId,
                      loadingLabels,
                    })}
                    disabled={loadingLabels.get()}
                    style={{
                      marginLeft: "8px",
                      padding: "4px 10px",
                      backgroundColor: loadingLabels.get()
                        ? "#9ca3af"
                        : "#6366f1",
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                      fontSize: "12px",
                      cursor: loadingLabels.get() ? "not-allowed" : "pointer",
                      fontWeight: "500",
                    }}
                  >
                    {loadingLabels.get() ? "Loading..." : "Load Labels"}
                  </button>
                </div>
              )
              : null}

            {/* Task cards */}
            {!resolvedAuth
              ? (
                <div
                  style={{
                    padding: "16px",
                    backgroundColor: "#f9fafb",
                    borderRadius: "8px",
                    border: "1px solid #e5e7eb",
                    color: "#4b5563",
                  }}
                >
                  <div style={{ fontWeight: "600", marginBottom: "4px" }}>
                    Waiting for Google connection
                  </div>
                  <div style={{ fontSize: "13px" }}>
                    Connect Google with Gmail label access before loading tasks
                    or labels.
                  </div>
                </div>
              )
              : taskCount === 0
              ? (
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
                    No tasks found
                  </div>
                  <div style={{ fontSize: "13px" }}>
                    Send yourself an email with a subject and add the
                    "task-current" label to see it here.
                  </div>
                </div>
              )
              : (
                <cf-vstack gap="3">
                  {analyses.map((analysis) => {
                    const isProcessing = processingTasks.get().includes(
                      analysis.email.id,
                    );

                    // Determine card border color based on suggestion type.
                    // Statement body (early returns) → keep as a computed.
                    const borderColor = computed(() => {
                      const pending = analysis.pending;
                      const result = analysis.result;
                      if (pending) return "#e5e7eb";
                      if (!result || result.actionType === "no-action") {
                        return "#e5e7eb";
                      }
                      if (result.confidence >= 0.8) return "#10b981"; // High confidence - green
                      if (result.confidence >= 0.5) return "#f59e0b"; // Medium - amber
                      return "#e5e7eb"; // Low - neutral
                    });

                    // Pre-compute the handler based on action type BEFORE the
                    // button. Statement body (branching) → keep as a computed.
                    const executeHandler = computed(() => {
                      const result = analysis.result;
                      if (result?.actionType === "edit-note") {
                        return executeEditNote({
                          removeLabels: extractor.removeLabels,
                          emailId: analysis.email.id,
                          noteTitle: result.noteTitle || "",
                          addition: result.addition || "",
                          taskCurrentLabelId,
                          hiddenTasks,
                          processingTasks,
                          allPieces,
                        });
                      } else if (result?.actionType === "create-note") {
                        return executeCreateNote({
                          removeLabels: extractor.removeLabels,
                          emailId: analysis.email.id,
                          title: result.title || "",
                          content: result.content || "",
                          taskCurrentLabelId,
                          hiddenTasks,
                          processingTasks,
                          allPieces,
                        });
                      }
                      return null;
                    });

                    return (
                      <div
                        style={{
                          padding: "16px",
                          backgroundColor: "#ffffff",
                          borderRadius: "8px",
                          border: `2px solid ${borderColor}`,
                          boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05)",
                        }}
                      >
                        {/* Email header */}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            justifyContent: "space-between",
                            marginBottom: "12px",
                          }}
                        >
                          <div style={{ flex: 1 }}>
                            <div
                              style={{
                                fontWeight: "600",
                                fontSize: "14px",
                                marginBottom: "4px",
                              }}
                            >
                              {analysis.email.subject}
                            </div>
                            <div
                              style={{
                                fontSize: "12px",
                                color: "#6b7280",
                                marginBottom: "4px",
                              }}
                            >
                              {analysis.email.from} •{" "}
                              {formatDate(analysis.email.date)}
                            </div>
                            <div
                              style={{
                                fontSize: "13px",
                                color: "#4b5563",
                              }}
                            >
                              {truncateText(analysis.email.snippet, 150)}
                            </div>
                          </div>

                          {/* Confidence badge */}
                          {!analysis.pending && analysis.result
                            ? (
                              <div
                                style={{
                                  padding: "2px 8px",
                                  borderRadius: "12px",
                                  fontSize: "11px",
                                  fontWeight: "500",
                                  backgroundColor: computed(() => {
                                    const result = analysis.result;
                                    if (!result) return "#f3f4f6";
                                    if (result.confidence >= 0.8) {
                                      return "#d1fae5";
                                    }
                                    if (result.confidence >= 0.5) {
                                      return "#fef3c7";
                                    }
                                    return "#f3f4f6";
                                  }),
                                  color: computed(() => {
                                    const result = analysis.result;
                                    if (!result) return "#6b7280";
                                    if (result.confidence >= 0.8) {
                                      return "#059669";
                                    }
                                    if (result.confidence >= 0.5) {
                                      return "#b45309";
                                    }
                                    return "#6b7280";
                                  }),
                                }}
                              >
                                {analysis.result
                                  ? `${
                                    Math.round(analysis.result.confidence * 100)
                                  }%`
                                  : ""}
                              </div>
                            )
                            : null}
                        </div>

                        {/* Suggestion section */}
                        {analysis.pending
                          ? (
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                padding: "12px",
                                backgroundColor: "#f9fafb",
                                borderRadius: "6px",
                              }}
                            >
                              <cf-loader size="sm" />
                              <span
                                style={{ fontSize: "13px", color: "#6b7280" }}
                              >
                                Analyzing...
                              </span>
                            </div>
                          )
                          // Show suggestion when analysis is complete
                          : analysis.result?.actionType === "edit-note"
                          ? (
                            // Edit note suggestion
                            <div
                              style={{
                                padding: "12px",
                                backgroundColor: "#eff6ff",
                                borderRadius: "6px",
                                marginBottom: "12px",
                              }}
                            >
                              <div
                                style={{
                                  fontWeight: "600",
                                  fontSize: "13px",
                                  color: "#1d4ed8",
                                  marginBottom: "4px",
                                }}
                              >
                                Suggest: Edit note "
                                {analysis.result?.actionType === "edit-note"
                                  ? analysis.result.noteTitle || ""
                                  : ""}
                                "
                              </div>
                              <div
                                style={{
                                  fontSize: "13px",
                                  color: "#4b5563",
                                  marginBottom: "8px",
                                  fontStyle: "italic",
                                }}
                              >
                                {analysis.result?.reasoning || ""}
                              </div>
                              <div
                                style={{
                                  fontSize: "13px",
                                  color: "#374151",
                                  padding: "8px",
                                  backgroundColor: "#ffffff",
                                  borderRadius: "4px",
                                  border: "1px solid #e5e7eb",
                                }}
                              >
                                {analysis.result?.actionType === "edit-note"
                                  ? truncateText(
                                    analysis.result.addition || "",
                                    200,
                                  )
                                  : ""}
                              </div>
                            </div>
                          )
                          : analysis.result?.actionType === "create-note"
                          ? (
                            // Create note suggestion
                            <div
                              style={{
                                padding: "12px",
                                backgroundColor: "#f0fdf4",
                                borderRadius: "6px",
                                marginBottom: "12px",
                              }}
                            >
                              <div
                                style={{
                                  fontWeight: "600",
                                  fontSize: "13px",
                                  color: "#15803d",
                                  marginBottom: "4px",
                                }}
                              >
                                Suggest: Create note "
                                {analysis.result?.actionType === "create-note"
                                  ? analysis.result.title || ""
                                  : ""}
                                "
                              </div>
                              <div
                                style={{
                                  fontSize: "13px",
                                  color: "#4b5563",
                                  marginBottom: "8px",
                                  fontStyle: "italic",
                                }}
                              >
                                {analysis.result?.reasoning || ""}
                              </div>
                              <div
                                style={{
                                  fontSize: "13px",
                                  color: "#374151",
                                  padding: "8px",
                                  backgroundColor: "#ffffff",
                                  borderRadius: "4px",
                                  border: "1px solid #e5e7eb",
                                }}
                              >
                                {analysis.result?.actionType === "create-note"
                                  ? truncateText(
                                    analysis.result.content || "",
                                    200,
                                  )
                                  : ""}
                              </div>
                            </div>
                          )
                          // No action or low confidence
                          : (
                            <div
                              style={{
                                padding: "12px",
                                backgroundColor: "#f9fafb",
                                borderRadius: "6px",
                                marginBottom: "12px",
                              }}
                            >
                              <div
                                style={{
                                  fontSize: "13px",
                                  color: "#6b7280",
                                }}
                              >
                                {analysis.result?.actionType === "no-action"
                                  ? `No auto-suggestion: ${
                                    analysis.result.reason || ""
                                  }`
                                  : "No auto-suggestion available"}
                              </div>
                            </div>
                          )}

                        {/* Action buttons */}
                        {!analysis.pending
                          ? (
                            <div
                              style={{
                                display: "flex",
                                gap: "8px",
                                justifyContent: "flex-end",
                              }}
                            >
                              {/* Execute button - only show for actionable suggestions */}
                              {analysis.result &&
                                  (analysis.result.actionType === "edit-note" ||
                                    analysis.result.actionType ===
                                      "create-note")
                                ? (
                                  <button
                                    type="button"
                                    onClick={executeHandler}
                                    disabled={isProcessing ||
                                      !taskCurrentLabelId.get()}
                                    style={{
                                      padding: "6px 16px",
                                      backgroundColor: isProcessing
                                        ? "#e5e7eb"
                                        : "#10b981",
                                      color: isProcessing ? "#9ca3af" : "white",
                                      border: "none",
                                      borderRadius: "6px",
                                      fontSize: "13px",
                                      cursor: isProcessing
                                        ? "not-allowed"
                                        : "pointer",
                                      fontWeight: "500",
                                    }}
                                  >
                                    {isProcessing ? "Processing..." : "Execute"}
                                  </button>
                                )
                                : null}

                              {/* Dismiss button */}
                              <button
                                type="button"
                                onClick={dismissTask({
                                  removeLabels: extractor.removeLabels,
                                  emailId: analysis.email.id,
                                  taskCurrentLabelId,
                                  hiddenTasks,
                                  processingTasks,
                                })}
                                disabled={isProcessing ||
                                  !taskCurrentLabelId.get()}
                                style={{
                                  padding: "6px 16px",
                                  backgroundColor: isProcessing
                                    ? "#e5e7eb"
                                    : "#f3f4f6",
                                  color: isProcessing ? "#9ca3af" : "#4b5563",
                                  border: "1px solid #e5e7eb",
                                  borderRadius: "6px",
                                  fontSize: "13px",
                                  cursor: isProcessing
                                    ? "not-allowed"
                                    : "pointer",
                                  fontWeight: "500",
                                }}
                              >
                                Dismiss
                              </button>
                            </div>
                          )
                          : null}
                      </div>
                    );
                  })}
                </cf-vstack>
              )}
          </cf-vstack>
        </cf-vscroll>
      </cf-screen>
    ),
  };
});
