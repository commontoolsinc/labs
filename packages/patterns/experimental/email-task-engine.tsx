/// <cts-enable />
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
  derive,
  generateObject,
  handler,
  ifElse,
  NAME,
  pattern,
  Stream,
  UI,
  wish,
  Writable,
} from "commontools";
import GmailExtractor, {
  type Email,
} from "../google/building-blocks/gmail-extractor.tsx";
import type { Auth } from "../google/building-blocks/util/google-auth-manager.tsx";
import {
  type GmailLabel,
  GmailSendClient,
} from "../google/building-blocks/util/gmail-send-client.ts";
import {
  createGoogleAuth,
  type ScopeKey,
} from "../google/building-blocks/util/google-auth-manager.tsx";
import ProcessingStatus from "../google/building-blocks/processing-status.tsx";
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
  result: SuggestionResult | null;
  pending: boolean;
  error?: unknown;
}

// Note type from wish
type NoteCharm = {
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
    const client = new GmailSendClient(auth, { debugMode: DEBUG_TASKS });
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
    allCharms: Writable<NoteCharm[]>;
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
      allCharms,
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
      const charms = allCharms.get() || [];
      const targetNoteIndex = charms.findIndex((charm: NoteCharm) => {
        const name = charm?.[NAME] || "";
        // Notes are named "📝 Title", extract title for matching
        const titleFromName = name.replace(/^📝\s*/, "").trim();
        return (
          titleFromName.toLowerCase() === noteTitle.toLowerCase() ||
          (charm as any)?.title?.toLowerCase() === noteTitle.toLowerCase()
        );
      });

      if (targetNoteIndex >= 0) {
        // Get the note cell and update content
        const noteCell = allCharms.key(targetNoteIndex);
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
    allCharms: Writable<NoteCharm[]>;
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
      allCharms,
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

      // Add to allCharms
      allCharms.push(newNote);

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
const SUGGESTION_SCHEMA = {
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
};

// =============================================================================
// PATTERN
// =============================================================================

interface PatternInput {
  overrideAuth?: Auth;
}

interface PatternOutput {
  taskEmails: TaskEmail[];
  taskCount: number;
  analyses: TaskAnalysis[];
  previewUI: unknown;
}

/** Email task engine for processing actionable emails. #emailTaskEngine */
export default pattern<PatternInput, PatternOutput>(({ overrideAuth }) => {
  // State for label operations
  const taskCurrentLabelId = Writable.of("").for("taskCurrentLabelId");
  const loadingLabels = Writable.of(false).for("loadingLabels");
  const hiddenTasks = Writable.of<string[]>([]).for("hiddenTasks");
  const processingTasks = Writable.of<string[]>([]).for("processingTasks");
  const sortNewestFirst = Writable.of(true).for("sortNewestFirst");

  // Get all charms for note discovery
  const { allCharms } = wish<{ allCharms: NoteCharm[] }>("#default");

  // Use createGoogleAuth for scopes that include gmailModify
  const {
    auth,
    fullUI: authUI,
    isReady,
  } = createGoogleAuth({
    requiredScopes: ["gmail", "gmailModify"] as ScopeKey[],
  });

  // Resolve auth: use overrideAuth if provided, otherwise use created auth
  const hasOverrideAuth = computed(() => !!(overrideAuth as any)?.token);
  const resolvedAuth = ifElse(hasOverrideAuth, overrideAuth, auth);

  // Create a Stream from the fetchLabels handler for auto-triggering
  const labelFetcherStream = fetchLabels({
    auth,
    taskCurrentLabelId,
    loadingLabels,
  });

  // Auto-fetch labels when auth becomes ready
  const hasAutoFetchedLabels = Writable.of(false).for("hasAutoFetchedLabels");

  computed(() => {
    const ready = isReady;
    const alreadyFetched = hasAutoFetchedLabels.get();
    const hasLabelId = !!taskCurrentLabelId.get();
    const currentlyLoading = loadingLabels.get();

    if (ready && !alreadyFetched && !hasLabelId && !currentlyLoading) {
      if (DEBUG_TASKS) {
        console.log("[EmailTaskEngine] Auto-fetching labels on auth ready");
      }
      hasAutoFetchedLabels.set(true);
      labelFetcherStream.send({});
    }
  });

  // Instantiate GmailExtractor in raw mode (no extraction)
  const extractor = GmailExtractor({
    gmailQuery: "label:task-current",
    limit: 50,
    overrideAuth: resolvedAuth as Auth,
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

  const taskCount = computed(() => taskEmails?.length || 0);

  // Get available notes for the LLM context
  const availableNotes = computed(() => {
    const charms = allCharms || [];
    return charms
      .filter((charm: NoteCharm) => {
        const name = charm?.[NAME];
        return typeof name === "string" && name.startsWith("📝");
      })
      .map((charm: NoteCharm) => {
        const name = charm?.[NAME] || "";
        const title = name.replace(/^📝\s*/, "").trim();
        const content = (charm as any)?.content || "";
        return {
          title,
          contentPreview: truncateText(content, 200),
        };
      });
  });

  // Analyze each task email with LLM
  const analyses = taskEmails.map((email: TaskEmail) => {
    // Build prompt with available notes context
    const notesContext = computed(() => {
      const notes = availableNotes || [];
      if (notes.length === 0) return "No existing notes found.";
      return notes
        .map((n) => `- "${n.title}": ${n.contentPreview}`)
        .join("\n");
    });

    const prompt = computed(() => {
      if (!email?.subject) return undefined;

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
    });

    const llmAnalysis = generateObject<SuggestionResult>({
      prompt,
      schema: SUGGESTION_SCHEMA,
      model: "anthropic:claude-sonnet-4-5",
    });

    // Return the cells directly without wrapping in computed
    // This allows derive() to properly unwrap them
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
      analyses?.filter((a) => !a?.pending && a?.result !== null)?.length ||
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
          {computed(() => {
            const count = taskCount;
            return count === 1 ? "1 task" : `${count} tasks`;
          })}
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
    previewUI,

    [UI]: (
      <ct-screen>
        <div slot="header">
          <ct-hstack align="center" gap="2">
            <ct-heading level={3}>Email Task Engine</ct-heading>
            <span style={{ color: "#6b7280", fontSize: "14px" }}>
              ({taskCount} tasks)
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
                  {computed(() => `${taskCount} tasks found`)}
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

            {/* Analysis progress */}
            {ifElse(
              derive(
                { isReady, pendingCount },
                ({ isReady, pendingCount }) => isReady && pendingCount > 0,
              ),
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
                <ct-loader size="sm" />
                <span style={{ color: "#2563eb" }}>
                  Analyzing {pendingCount} tasks...
                </span>
              </div>,
              null,
            )}

            {/* Label status warning */}
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
                  <span>task-current label not found - click Load Labels</span>,
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

            {/* Task cards */}
            {ifElse(
              derive(taskCount, (count) => count === 0),
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
              </div>,
              <ct-vstack gap="3">
                {analyses.map((analysis) => {
                  const isProcessing = computed(() =>
                    processingTasks.get().includes(analysis.email.id)
                  );

                  // Determine card border color based on suggestion type
                  const borderColor = derive(
                    { pending: analysis.pending, result: analysis.result },
                    ({ pending, result }) => {
                      if (pending) return "#e5e7eb";
                      if (!result || result.actionType === "no-action") {
                        return "#e5e7eb";
                      }
                      if (result.confidence >= 0.8) return "#10b981"; // High confidence - green
                      if (result.confidence >= 0.5) return "#f59e0b"; // Medium - amber
                      return "#e5e7eb"; // Low - neutral
                    },
                  );

                  return (
                    <div
                      style={{
                        padding: "16px",
                        backgroundColor: "#ffffff",
                        borderRadius: "8px",
                        border: derive(borderColor, (c) => `2px solid ${c}`),
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
                            {derive(analysis, (a) => a.email.subject)}
                          </div>
                          <div
                            style={{
                              fontSize: "12px",
                              color: "#6b7280",
                              marginBottom: "4px",
                            }}
                          >
                            {derive(analysis, (a) => a.email.from)} •{" "}
                            {derive(analysis, (a) => formatDate(a.email.date))}
                          </div>
                          <div
                            style={{
                              fontSize: "13px",
                              color: "#4b5563",
                            }}
                          >
                            {derive(
                              analysis,
                              (a) => truncateText(a.email.snippet, 150),
                            )}
                          </div>
                        </div>

                        {/* Confidence badge */}
                        {ifElse(
                          derive(
                            {
                              pending: analysis.pending,
                              result: analysis.result,
                            },
                            ({ pending, result }) => !pending && result,
                          ),
                          <div
                            style={{
                              padding: "2px 8px",
                              borderRadius: "12px",
                              fontSize: "11px",
                              fontWeight: "500",
                              backgroundColor: derive(
                                analysis.result,
                                (result) => {
                                  if (!result) return "#f3f4f6";
                                  if (result.confidence >= 0.8) {
                                    return "#d1fae5";
                                  }
                                  if (result.confidence >= 0.5) {
                                    return "#fef3c7";
                                  }
                                  return "#f3f4f6";
                                },
                              ),
                              color: derive(
                                analysis.result,
                                (result) => {
                                  if (!result) return "#6b7280";
                                  if (result.confidence >= 0.8) {
                                    return "#059669";
                                  }
                                  if (result.confidence >= 0.5) {
                                    return "#b45309";
                                  }
                                  return "#6b7280";
                                },
                              ),
                            }}
                          >
                            {derive(
                              analysis.result,
                              (result) =>
                                result
                                  ? `${Math.round(result.confidence * 100)}%`
                                  : "",
                            )}
                          </div>,
                          null,
                        )}
                      </div>

                      {/* Suggestion section */}
                      {ifElse(
                        analysis.pending,
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
                          <ct-loader size="sm" />
                          <span style={{ fontSize: "13px", color: "#6b7280" }}>
                            Analyzing...
                          </span>
                        </div>,
                        // Show suggestion when analysis is complete
                        ifElse(
                          derive(
                            analysis.result,
                            (result) => result?.actionType === "edit-note",
                          ),
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
                              {derive(analysis.result, (result) =>
                                result?.actionType === "edit-note"
                                  ? result.noteTitle || ""
                                  : "")}
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
                              {derive(
                                analysis.result,
                                (result) => result?.reasoning || "",
                              )}
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
                              {derive(
                                analysis.result,
                                (result) =>
                                  result?.actionType === "edit-note"
                                    ? truncateText(result.addition || "", 200)
                                    : "",
                              )}
                            </div>
                          </div>,
                          ifElse(
                            derive(
                              analysis.result,
                              (result) =>
                                result?.actionType === "create-note",
                            ),
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
                                {derive(
                                  analysis.result,
                                  (result) =>
                                    result?.actionType === "create-note"
                                      ? result.title || ""
                                      : "",
                                )}
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
                                {derive(
                                  analysis.result,
                                  (result) => result?.reasoning || "",
                                )}
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
                                {derive(
                                  analysis.result,
                                  (result) =>
                                    result?.actionType === "create-note"
                                      ? truncateText(result.content || "", 200)
                                      : "",
                                )}
                              </div>
                            </div>,
                            // No action or low confidence
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
                                {derive(
                                  analysis.result,
                                  (result) =>
                                    result?.actionType === "no-action"
                                      ? `No auto-suggestion: ${
                                        result.reason || ""
                                      }`
                                      : "No auto-suggestion available",
                                )}
                              </div>
                            </div>,
                          ),
                        ),
                      )}

                      {/* Action buttons */}
                      {ifElse(
                        derive(analysis.pending, (pending) => !pending),
                        <div
                          style={{
                            display: "flex",
                            gap: "8px",
                            justifyContent: "flex-end",
                          }}
                        >
                          {/* Execute button - only show for actionable suggestions */}
                          {ifElse(
                            derive(
                              analysis.result,
                              (result) => {
                                return (
                                  result &&
                                  (result.actionType === "edit-note" ||
                                    result.actionType === "create-note")
                                );
                              },
                            ),
                            <button
                              type="button"
                              onClick={ifElse(
                                derive(
                                  analysis.result,
                                  (result) =>
                                    result?.actionType === "edit-note",
                                ),
                                executeEditNote({
                                  removeLabels: extractor.removeLabels,
                                  emailId: analysis.email.id,
                                  noteTitle: derive(
                                    analysis.result,
                                    (result) =>
                                      result?.actionType === "edit-note"
                                        ? result.noteTitle || ""
                                        : "",
                                  ),
                                  addition: derive(
                                    analysis.result,
                                    (result) =>
                                      result?.actionType === "edit-note"
                                        ? result.addition || ""
                                        : "",
                                  ),
                                  taskCurrentLabelId,
                                  hiddenTasks,
                                  processingTasks,
                                  allCharms,
                                }),
                                executeCreateNote({
                                  removeLabels: extractor.removeLabels,
                                  emailId: analysis.email.id,
                                  title: derive(
                                    analysis.result,
                                    (result) =>
                                      result?.actionType === "create-note"
                                        ? result.title || ""
                                        : "",
                                  ),
                                  content: derive(
                                    analysis.result,
                                    (result) =>
                                      result?.actionType === "create-note"
                                        ? result.content || ""
                                        : "",
                                  ),
                                  taskCurrentLabelId,
                                  hiddenTasks,
                                  processingTasks,
                                  allCharms,
                                }),
                              )}
                              disabled={derive(
                                { isProcessing, taskCurrentLabelId },
                                ({ isProcessing, taskCurrentLabelId }) =>
                                  isProcessing || !taskCurrentLabelId,
                              )}
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
                              {ifElse(isProcessing, "Processing...", "Execute")}
                            </button>,
                            null,
                          )}

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
                            disabled={derive(
                              { isProcessing, taskCurrentLabelId },
                              ({ isProcessing, taskCurrentLabelId }) =>
                                isProcessing || !taskCurrentLabelId,
                            )}
                            style={{
                              padding: "6px 16px",
                              backgroundColor: isProcessing
                                ? "#e5e7eb"
                                : "#f3f4f6",
                              color: isProcessing ? "#9ca3af" : "#4b5563",
                              border: "1px solid #e5e7eb",
                              borderRadius: "6px",
                              fontSize: "13px",
                              cursor: isProcessing ? "not-allowed" : "pointer",
                              fontWeight: "500",
                            }}
                          >
                            Dismiss
                          </button>
                        </div>,
                        null,
                      )}
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
