/// <cts-enable />
/**
 * Gmail Expect-Response Follow-up Pattern
 *
 * Monitors emails with an "expect-response" label, shows a dashboard of threads
 * awaiting responses, uses LLM to draft polite follow-up pings, and allows
 * easy sending via Gmail.
 *
 * Features:
 * - Dashboard showing email threads due for follow-up (filtered by age)
 * - Thread context display so user understands context
 * - LLM-generated polite follow-up emails asking for updates
 * - One-click send via Gmail API (with confirmation)
 * - Ping tracking with suggestion to remove label after multiple unanswered pings
 * - Label management to remove "expect-response" when user gives up
 *
 * Usage:
 * 1. Deploy a google-auth charm and complete OAuth (needs gmail, gmailSend, gmailModify scopes)
 * 2. Deploy this pattern
 * 3. Link: ct charm link google-auth/auth expect-response-followup/overrideAuth
 * 4. Add the "expect-response" label to emails you're waiting on
 * 5. View threads, configure context, generate follow-ups, send or give up
 */
import {
  computed,
  derive,
  generateText,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import GmailExtractor, {
  type Auth,
  type Email,
} from "../core/gmail-extractor.tsx";
import {
  createReadOnlyAuthCell,
  type GmailLabel,
  GmailSendClient,
} from "../core/util/gmail-send-client.ts";
import type { Stream } from "commontools";

// =============================================================================
// CONSTANTS
// =============================================================================

const DEBUG = false;

/** Thread context types - affects day calculation */
type ThreadContext = "personal" | "business" | "urgent";

/** Default settings per context */
const DEFAULT_SETTINGS: Record<
  ThreadContext,
  { days: number; maxPings: number }
> = {
  personal: { days: 3, maxPings: 2 }, // Calendar days
  business: { days: 3, maxPings: 2 }, // Business days (Mon-Fri)
  urgent: { days: 1, maxPings: 3 }, // Calendar days, more persistent
};

/** Personal email domains (suggest "personal" context) */
const PERSONAL_DOMAINS = [
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "protonmail.com",
  "live.com",
  "msn.com",
];

// =============================================================================
// TYPES
// =============================================================================

/** Per-thread settings (persisted) */
interface ThreadSettings {
  context: ThreadContext;
  daysThreshold: number;
  maxPings: number;
}

/** Per-thread metadata (persisted) */
interface ThreadMetadata {
  pingCount: number;
  settings: ThreadSettings;
}

/** Email type that accepts readonly arrays from reactive system */
type ReadonlyEmail = {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds: readonly string[];
  readonly snippet: string;
  readonly subject: string;
  readonly from: string;
  readonly date: string;
  readonly to: string;
  readonly plainText: string;
  readonly htmlContent: string;
  readonly markdownContent: string;
};

/** Tracked thread (computed from emails + metadata) */
interface TrackedThread {
  threadId: string;
  subject: string;
  lastMessageDate: string;
  lastResponder: string;
  daysSinceLastResponse: number;
  pingCount: number;
  emails: readonly ReadonlyEmail[];
  draftedFollowUp: string | null;
  settings: ThreadSettings;
  isDue: boolean;
  shouldGiveUp: boolean;
  /** Most recent message ID (for threading replies) */
  lastMessageId: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Calculate business days between two dates (excludes Saturdays and Sundays)
 */
function calculateBusinessDays(fromDate: Date, toDate: Date): number {
  let count = 0;
  const current = new Date(fromDate);
  current.setHours(0, 0, 0, 0);
  const end = new Date(toDate);
  end.setHours(0, 0, 0, 0);

  while (current < end) {
    current.setDate(current.getDate() + 1);
    const dayOfWeek = current.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      count++;
    }
  }
  return count;
}

/**
 * Calculate calendar days between two dates
 */
function calculateCalendarDays(fromDate: Date, toDate: Date): number {
  const diff = toDate.getTime() - fromDate.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/**
 * Calculate days since date based on context
 */
function calculateDays(
  fromDateStr: string,
  context: ThreadContext,
): number {
  const fromDate = new Date(fromDateStr);
  const toDate = new Date();

  if (context === "business") {
    return calculateBusinessDays(fromDate, toDate);
  }
  return calculateCalendarDays(fromDate, toDate);
}

/**
 * Extract domain from email address
 */
function getDomain(email: string): string {
  const match = email.match(/@([^@\s]+)$/);
  return match ? match[1].toLowerCase() : "";
}

/**
 * Suggest context based on email domain
 */
function suggestContext(email: string): ThreadContext {
  const domain = getDomain(email);
  if (PERSONAL_DOMAINS.includes(domain)) {
    return "personal";
  }
  return "business";
}

/**
 * Format date for display
 */
function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== new Date().getFullYear()
        ? "numeric"
        : undefined,
    });
  } catch {
    return dateStr;
  }
}

/**
 * Format days display based on context
 */
function formatDaysDisplay(days: number, context: ThreadContext): string {
  const unit = context === "business" ? "business day" : "day";
  return days === 1 ? `1 ${unit}` : `${days} ${unit}s`;
}

/**
 * Get thread summary for LLM prompt
 */
function getThreadSummary(emails: readonly ReadonlyEmail[]): string {
  return emails
    .slice(-5) // Last 5 messages for context
    .map((email) => {
      const date = formatDate(email.date);
      const from = email.from;
      const snippet = email.snippet?.slice(0, 200) || "";
      return `[${date}] From: ${from}\n${snippet}`;
    })
    .join("\n\n");
}

// =============================================================================
// HANDLERS
// =============================================================================

/**
 * Toggle expanded state for a thread
 */
const toggleExpanded = handler<
  unknown,
  { expandedThreads: Writable<string[]>; threadId: string }
>((_event, { expandedThreads, threadId }) => {
  const current = expandedThreads.get();
  if (current.includes(threadId)) {
    expandedThreads.set(current.filter((id) => id !== threadId));
  } else {
    expandedThreads.set([...current, threadId]);
  }
});

/**
 * Update thread context
 */
const updateContext = handler<
  { target: { value: string } },
  {
    threadMetadata: Writable<Record<string, ThreadMetadata>>;
    threadId: string;
  }
>(({ target }, { threadMetadata, threadId }) => {
  const newContext = target.value as ThreadContext;
  const current = threadMetadata.get();
  const existing = current[threadId];
  const defaults = DEFAULT_SETTINGS[newContext];

  threadMetadata.set({
    ...current,
    [threadId]: {
      pingCount: existing?.pingCount || 0,
      settings: {
        context: newContext,
        daysThreshold: defaults.days,
        maxPings: defaults.maxPings,
      },
    },
  });
});

/**
 * Update days threshold
 */
const updateDaysThreshold = handler<
  { target: { value: string } },
  {
    threadMetadata: Writable<Record<string, ThreadMetadata>>;
    threadId: string;
    context: ThreadContext;
  }
>(({ target }, { threadMetadata, threadId, context }) => {
  const newDays = parseInt(target.value) || DEFAULT_SETTINGS[context].days;
  const current = threadMetadata.get();
  const existing = current[threadId];

  threadMetadata.set({
    ...current,
    [threadId]: {
      pingCount: existing?.pingCount || 0,
      settings: {
        context: existing?.settings?.context || context,
        daysThreshold: newDays,
        maxPings: existing?.settings?.maxPings ||
          DEFAULT_SETTINGS[context].maxPings,
      },
    },
  });
});

/**
 * Update max pings
 */
const updateMaxPings = handler<
  { target: { value: string } },
  {
    threadMetadata: Writable<Record<string, ThreadMetadata>>;
    threadId: string;
    context: ThreadContext;
  }
>(({ target }, { threadMetadata, threadId, context }) => {
  const newMaxPings = parseInt(target.value) ||
    DEFAULT_SETTINGS[context].maxPings;
  const current = threadMetadata.get();
  const existing = current[threadId];

  threadMetadata.set({
    ...current,
    [threadId]: {
      pingCount: existing?.pingCount || 0,
      settings: {
        context: existing?.settings?.context || context,
        daysThreshold: existing?.settings?.daysThreshold ||
          DEFAULT_SETTINGS[context].days,
        maxPings: newMaxPings,
      },
    },
  });
});

/**
 * Update draft text
 */
const updateDraft = handler<
  { target: { value: string } },
  { drafts: Writable<Record<string, string>>; threadId: string }
>(({ target }, { drafts, threadId }) => {
  const current = drafts.get();
  drafts.set({
    ...current,
    [threadId]: target.value,
  });
});

/**
 * Prepare to send follow-up (show confirmation)
 */
const prepareToSend = handler<
  unknown,
  { pendingSend: Writable<string | null>; threadId: string }
>((_event, { pendingSend, threadId }) => {
  pendingSend.set(threadId);
});

/**
 * Cancel send
 */
const cancelSend = handler<
  unknown,
  { pendingSend: Writable<string | null> }
>((_event, { pendingSend }) => {
  pendingSend.set(null);
});

/**
 * Confirm and send follow-up email
 */
const confirmAndSend = handler<
  unknown,
  {
    overrideAuth: Auth | undefined;
    pendingSend: Writable<string | null>;
    threadMetadata: Writable<Record<string, ThreadMetadata>>;
    drafts: Writable<Record<string, string>>;
    sendingThreads: Writable<string[]>;
    sendResults: Writable<Record<string, { success: boolean; error?: string }>>;
    thread: TrackedThread;
  }
>(
  async (
    _event,
    {
      overrideAuth,
      pendingSend,
      threadMetadata,
      drafts,
      sendingThreads,
      sendResults,
      thread,
    },
  ) => {
    const threadId = thread.threadId;
    const draft = drafts.get()[threadId];

    if (!draft) {
      console.error("[ExpectResponse] No draft to send");
      return;
    }

    if (!overrideAuth) {
      console.error("[ExpectResponse] No auth available");
      sendResults.set({
        ...sendResults.get(),
        [threadId]: {
          success: false,
          error: "No auth available - link google-auth first",
        },
      });
      return;
    }

    // Mark as sending
    const currentSending = sendingThreads.get();
    sendingThreads.set([...currentSending, threadId]);

    try {
      const authCell = createReadOnlyAuthCell(overrideAuth);
      const client = new GmailSendClient(authCell, { debugMode: DEBUG });

      // Send as reply to the thread
      await client.sendEmail({
        to: thread.lastResponder,
        subject: thread.subject.startsWith("Re:")
          ? thread.subject
          : `Re: ${thread.subject}`,
        body: draft,
        replyToMessageId: thread.lastMessageId,
        replyToThreadId: threadId,
      });

      // Increment ping count
      const currentMeta = threadMetadata.get();
      const existing = currentMeta[threadId];
      threadMetadata.set({
        ...currentMeta,
        [threadId]: {
          ...existing,
          pingCount: (existing?.pingCount || 0) + 1,
        },
      });

      // Clear draft
      const currentDrafts = drafts.get();
      const { [threadId]: _removed, ...remainingDrafts } = currentDrafts;
      drafts.set(remainingDrafts);

      // Record success
      sendResults.set({
        ...sendResults.get(),
        [threadId]: { success: true },
      });

      // Close confirmation
      pendingSend.set(null);
    } catch (error) {
      console.error("[ExpectResponse] Failed to send:", error);
      sendResults.set({
        ...sendResults.get(),
        [threadId]: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      // Remove from sending
      sendingThreads.set(
        sendingThreads.get().filter((id) => id !== threadId),
      );
    }
  },
);

/**
 * Give up on a thread (remove expect-response label)
 */
const giveUp = handler<
  unknown,
  {
    removeLabels: Stream<{ messageId: string; labels: string[] }>;
    thread: TrackedThread;
    expectResponseLabelId: Writable<string>;
    hiddenThreads: Writable<string[]>;
  }
>((_event, { removeLabels, thread, expectResponseLabelId, hiddenThreads }) => {
  const labelId = expectResponseLabelId.get();
  if (!labelId) {
    console.error("[ExpectResponse] expect-response label ID not found");
    return;
  }

  // Remove label from all messages in thread
  for (const email of thread.emails) {
    removeLabels.send({ messageId: email.id, labels: [labelId] });
  }

  // Hide thread from display
  const current = hiddenThreads.get();
  hiddenThreads.set([...current, thread.threadId]);

  if (DEBUG) {
    console.log("[ExpectResponse] Gave up on thread:", thread.threadId);
  }
});

/**
 * Fetch labels to find expect-response label ID
 */
const fetchLabels = handler<
  unknown,
  {
    overrideAuth: Auth | undefined;
    expectResponseLabelId: Writable<string>;
    loadingLabels: Writable<boolean>;
  }
>(async (_event, { overrideAuth, expectResponseLabelId, loadingLabels }) => {
  if (!overrideAuth) {
    console.error("[ExpectResponse] No auth available for fetching labels");
    return;
  }

  loadingLabels.set(true);
  try {
    const authCell = createReadOnlyAuthCell(overrideAuth);
    const client = new GmailSendClient(authCell, { debugMode: DEBUG });
    const labels = await client.listLabels();

    // Find expect-response label (case-insensitive)
    const targetLabel = labels.find(
      (l: GmailLabel) => l?.name?.toLowerCase() === "expect-response",
    );

    if (targetLabel) {
      expectResponseLabelId.set(targetLabel.id);
      if (DEBUG) {
        console.log(
          "[ExpectResponse] Found expect-response label:",
          targetLabel.id,
        );
      }
    } else {
      console.warn("[ExpectResponse] expect-response label not found");
    }
  } catch (error) {
    console.error("[ExpectResponse] Failed to fetch labels:", error);
  } finally {
    loadingLabels.set(false);
  }
});

/**
 * Dismiss send result
 */
const dismissResult = handler<
  unknown,
  {
    sendResults: Writable<Record<string, { success: boolean; error?: string }>>;
    threadId: string;
  }
>((_event, { sendResults, threadId }) => {
  const current = sendResults.get();
  const { [threadId]: _removed, ...remaining } = current;
  sendResults.set(remaining);
});

/**
 * Toggle settings panel for a thread
 */
const toggleSettings = handler<
  unknown,
  { settingsOpenFor: Writable<string | null>; threadId: string }
>((_event, { settingsOpenFor, threadId }) => {
  const current = settingsOpenFor.get();
  settingsOpenFor.set(current === threadId ? null : threadId);
});

/**
 * Generate draft for a thread - stores prompt for LLM generation
 */
const generateDraft = handler<
  unknown,
  {
    thread: TrackedThread;
    draftPrompts: Writable<Record<string, string>>;
  }
>((_event, { thread, draftPrompts }) => {
  const threadSummary = getThreadSummary(thread.emails);
  const prompt =
    `Based on this email thread, draft a brief, polite follow-up email asking for an update.
Keep it professional and friendly. Reference the original subject matter.
Don't be pushy. Make it 2-3 sentences max. Do not include a subject line - only the body text.

Thread summary:
- Subject: ${thread.subject}
- Last message from: ${thread.lastResponder}
- Days waiting: ${
      formatDaysDisplay(thread.daysSinceLastResponse, thread.settings.context)
    }
- Previous ping count: ${thread.pingCount}

Original context:
${threadSummary}

Write only the email body, no subject line or greeting line (the greeting will be auto-added):`;

  const current = draftPrompts.get();
  draftPrompts.set({
    ...current,
    [thread.threadId]: prompt,
  });
});

// =============================================================================
// PATTERN
// =============================================================================

interface PatternInput {
  overrideAuth?: Auth;
  /** User's email address - used to filter out threads where user sent last message */
  userEmail?: string;
}

/** Gmail expect-response follow-up manager. #expectResponseFollowup */
interface PatternOutput {
  threads: TrackedThread[];
  threadCount: number;
  dueCount: number;
}

export default pattern<PatternInput, PatternOutput>(
  ({ overrideAuth, userEmail }) => {
    // ==========================================================================
    // STATE
    // ==========================================================================

    // Persisted state
    const threadMetadata = Writable.of<Record<string, ThreadMetadata>>(
      {},
    ).for("threadMetadata");
    const hiddenThreads = Writable.of<string[]>([]).for(
      "hiddenThreads",
    );

    // UI state
    const expandedThreads = Writable.of<string[]>([]).for(
      "expandedThreads",
    );
    const drafts = Writable.of<Record<string, string>>({}).for("drafts");
    const draftPrompts = Writable.of<Record<string, string>>({}).for(
      "draftPrompts",
    );
    const pendingSend = Writable.of<string | null>(null).for("pendingSend");
    const sendingThreads = Writable.of<string[]>([]).for(
      "sendingThreads",
    );
    const sendResults = Writable.of<
      Record<string, { success: boolean; error?: string }>
    >({}).for("sendResults");
    const expectResponseLabelId = Writable.of("").for("expectResponseLabelId");
    const loadingLabels = Writable.of(false).for("loadingLabels");
    const settingsOpenFor = Writable.of<string | null>(null).for(
      "settingsOpenFor",
    );
    const sortOldestFirst = Writable.of(true).for("sortOldestFirst");

    // Label fetcher stream - fetches labels when auth is available
    const labelFetcherStream = fetchLabels({
      overrideAuth,
      expectResponseLabelId,
      loadingLabels,
    });

    // ==========================================================================
    // GMAIL EXTRACTOR
    // ==========================================================================

    const extractor = GmailExtractor({
      gmailQuery: "label:expect-response",
      limit: 100,
      overrideAuth,
    });

    const allEmails = extractor.emails;

    // Derive auth readiness
    const isReady = computed(() => !!overrideAuth);

    // ==========================================================================
    // THREAD PROCESSING
    // ==========================================================================

    /**
     * Group emails by threadId and compute thread state
     */
    const threads = computed((): TrackedThread[] => {
      const emails = allEmails || [];
      const hidden = hiddenThreads.get();
      const metadata = threadMetadata.get();
      const currentDrafts = drafts.get();
      // User email from input - if not provided, threads won't be filtered by sender
      const currentUserEmail = userEmail?.toLowerCase() || "";

      // Group by threadId
      const threadMap = new Map<string, Email[]>();
      for (const email of emails) {
        if (!email.threadId) continue;
        if (hidden.includes(email.threadId)) continue;

        const existing = threadMap.get(email.threadId) || [];
        existing.push(email);
        threadMap.set(email.threadId, existing);
      }

      // Process each thread
      const result: TrackedThread[] = [];

      for (const [threadId, threadEmails] of threadMap) {
        // Sort by date ascending
        threadEmails.sort(
          (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
        );

        const lastEmail = threadEmails[threadEmails.length - 1];
        const lastResponder = lastEmail.from.toLowerCase();

        // Skip threads where user sent the last message (not waiting for response)
        if (lastResponder === currentUserEmail) {
          continue;
        }

        // Get or create metadata
        const meta = metadata[threadId];
        const suggestedContext = suggestContext(lastResponder);
        const defaults = DEFAULT_SETTINGS[suggestedContext];

        const settings: ThreadSettings = meta?.settings || {
          context: suggestedContext,
          daysThreshold: defaults.days,
          maxPings: defaults.maxPings,
        };

        const pingCount = meta?.pingCount || 0;

        // Calculate days
        const daysSinceLastResponse = calculateDays(
          lastEmail.date,
          settings.context,
        );

        // Determine if due
        const isDue = daysSinceLastResponse >= settings.daysThreshold;

        // Determine if should give up
        const shouldGiveUp = pingCount >= settings.maxPings;

        // Get draft
        const draftedFollowUp = currentDrafts[threadId] || null;

        result.push({
          threadId,
          subject: lastEmail.subject || "(No Subject)",
          lastMessageDate: lastEmail.date,
          lastResponder: lastEmail.from,
          daysSinceLastResponse,
          pingCount,
          emails: threadEmails,
          draftedFollowUp,
          settings,
          isDue,
          shouldGiveUp,
          lastMessageId: lastEmail.id,
        });
      }

      // Sort by days waiting (oldest first by default)
      const oldest = sortOldestFirst.get();
      result.sort((a, b) => {
        if (oldest) {
          return b.daysSinceLastResponse - a.daysSinceLastResponse;
        }
        return a.daysSinceLastResponse - b.daysSinceLastResponse;
      });

      return result;
    });

    const threadCount = computed(() => threads?.length || 0);
    const dueCount = computed(
      () => threads?.filter((t) => t.isDue)?.length || 0,
    );

    // ==========================================================================
    // LLM DRAFT GENERATION
    // ==========================================================================

    // Reactive LLM generation - watches draftPrompts and generates drafts
    // When a prompt is added to draftPrompts, generateText will trigger
    // and update the drafts cell when complete
    computed(() => {
      const prompts = draftPrompts.get();
      const currentDrafts = drafts.get();

      for (const [threadId, prompt] of Object.entries(prompts)) {
        // Skip if already have a draft for this thread
        if (currentDrafts[threadId]) continue;

        // Generate the draft
        const result = generateText({
          prompt,
          model: "anthropic:claude-sonnet-4-5",
        });

        // When result is ready, update drafts
        if (!result.pending && result.result) {
          drafts.set({
            ...drafts.get(),
            [threadId]: result.result,
          });
          // Remove the prompt since we've processed it
          const updatedPrompts = { ...draftPrompts.get() };
          delete updatedPrompts[threadId];
          draftPrompts.set(updatedPrompts);
        }
      }
    });

    // ==========================================================================
    // UI
    // ==========================================================================

    const contextBadgeColors: Record<
      ThreadContext,
      { bg: string; text: string }
    > = {
      personal: { bg: "#dbeafe", text: "#1d4ed8" },
      business: { bg: "#fef3c7", text: "#b45309" },
      urgent: { bg: "#fee2e2", text: "#dc2626" },
    };

    return {
      [NAME]: "Expect Response Followup",
      threads,
      threadCount,
      dueCount,

      [UI]: (
        <ct-screen>
          <div slot="header">
            <ct-hstack align="center" gap="2">
              <ct-heading level={3}>Expect Response</ct-heading>
              <span style={{ color: "#6b7280", fontSize: "14px" }}>
                ({dueCount} due / {threadCount} total)
              </span>
              <ct-checkbox $checked={sortOldestFirst}>Oldest first</ct-checkbox>
            </ct-hstack>
          </div>

          <ct-vscroll flex showScrollbar>
            <ct-vstack padding="6" gap="4">
              {/* Connection status */}
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
                    {threadCount} threads awaiting response
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

              {/* Label status */}
              {ifElse(
                derive(
                  { isReady, expectResponseLabelId, loadingLabels },
                  ({ isReady, expectResponseLabelId, loadingLabels }) =>
                    isReady && (!expectResponseLabelId || loadingLabels),
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
                      expect-response label not found - click Load Labels
                    </span>,
                  )}
                  <button
                    type="button"
                    onClick={labelFetcherStream}
                    disabled={loadingLabels}
                    style={{
                      marginLeft: "8px",
                      padding: "4px 10px",
                      backgroundColor: derive(
                        loadingLabels,
                        (l) => l ? "#9ca3af" : "#6366f1",
                      ),
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                      fontSize: "12px",
                      cursor: derive(
                        loadingLabels,
                        (l) => l ? "not-allowed" : "pointer",
                      ),
                      fontWeight: "500",
                    }}
                  >
                    {ifElse(loadingLabels, "Loading...", "Load Labels")}
                  </button>
                </div>,
                null,
              )}

              {/* Threads list */}
              {ifElse(
                derive(threadCount, (count) => count === 0),
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
                    No threads awaiting response
                  </div>
                  <div style={{ fontSize: "13px" }}>
                    Add the "expect-response" label to emails you're waiting on.
                  </div>
                </div>,
                <ct-vstack gap="3">
                  {threads.map((thread) => {
                    const threadId = thread.threadId;
                    const isExpanded = computed(() =>
                      expandedThreads.get().includes(threadId)
                    );
                    const isSending = computed(() =>
                      sendingThreads.get().includes(threadId)
                    );
                    const result = computed(() => sendResults.get()[threadId]);
                    const settingsOpen = computed(() =>
                      settingsOpenFor.get() === threadId
                    );

                    return (
                      <div
                        style={{
                          backgroundColor: "#ffffff",
                          borderRadius: "8px",
                          border: derive(
                            thread,
                            (t) =>
                              t.shouldGiveUp
                                ? "2px solid #f97316"
                                : t.isDue
                                ? "2px solid #3b82f6"
                                : "1px solid #e5e7eb",
                          ),
                          overflow: "hidden",
                        }}
                      >
                        {/* Thread header */}
                        <div
                          style={{
                            padding: "12px 16px",
                            backgroundColor: derive(
                              thread,
                              (t) =>
                                t.shouldGiveUp
                                  ? "#fff7ed"
                                  : t.isDue
                                  ? "#eff6ff"
                                  : "#f9fafb",
                            ),
                            borderBottom: "1px solid #e5e7eb",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "12px",
                              marginBottom: "8px",
                            }}
                          >
                            {/* Subject */}
                            <div
                              style={{
                                flex: 1,
                                fontWeight: "600",
                                fontSize: "14px",
                                color: "#111827",
                              }}
                            >
                              {derive(thread, (t) => t.subject)}
                            </div>

                            {/* Ping count badge */}
                            {ifElse(
                              derive(thread, (t) => t.pingCount > 0),
                              <span
                                style={{
                                  padding: "2px 8px",
                                  backgroundColor: "#fef3c7",
                                  color: "#b45309",
                                  borderRadius: "12px",
                                  fontSize: "11px",
                                  fontWeight: "500",
                                }}
                              >
                                {derive(thread, (t) => t.pingCount)} pings
                              </span>,
                              null,
                            )}

                            {/* Context badge */}
                            <button
                              type="button"
                              onClick={toggleSettings({
                                settingsOpenFor,
                                threadId,
                              })}
                              style={{
                                padding: "2px 8px",
                                backgroundColor: derive(
                                  thread,
                                  (t) =>
                                    contextBadgeColors[t.settings.context].bg,
                                ),
                                color: derive(
                                  thread,
                                  (t) =>
                                    contextBadgeColors[t.settings.context].text,
                                ),
                                borderRadius: "12px",
                                fontSize: "11px",
                                fontWeight: "500",
                                border: "none",
                                cursor: "pointer",
                              }}
                            >
                              {derive(
                                thread,
                                (t) =>
                                  t.settings.context.charAt(0).toUpperCase() +
                                  t.settings.context.slice(1),
                              )}
                            </button>
                          </div>

                          {/* Metadata row */}
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "16px",
                              fontSize: "12px",
                              color: "#6b7280",
                            }}
                          >
                            <span>
                              From: {derive(thread, (t) => t.lastResponder)}
                            </span>
                            <span>
                              Last: {derive(thread, (t) =>
                                formatDate(t.lastMessageDate))}
                            </span>
                            <span
                              style={{
                                fontWeight: "600",
                                color: derive(
                                  thread,
                                  (t) => (t.isDue ? "#dc2626" : "#059669"),
                                ),
                              }}
                            >
                              {derive(
                                thread,
                                (t) =>
                                  formatDaysDisplay(
                                    t.daysSinceLastResponse,
                                    t.settings.context,
                                  ),
                              )} waiting
                            </span>
                            <button
                              type="button"
                              onClick={toggleExpanded({
                                expandedThreads,
                                threadId,
                              })}
                              style={{
                                marginLeft: "auto",
                                background: "none",
                                border: "none",
                                color: "#3b82f6",
                                cursor: "pointer",
                                fontSize: "12px",
                              }}
                            >
                              {ifElse(isExpanded, "Hide thread", "Show thread")}
                            </button>
                          </div>
                        </div>

                        {/* Settings panel (collapsible) */}
                        {ifElse(
                          settingsOpen,
                          <div
                            style={{
                              padding: "12px 16px",
                              backgroundColor: "#f3f4f6",
                              borderBottom: "1px solid #e5e7eb",
                              display: "flex",
                              alignItems: "center",
                              gap: "16px",
                              fontSize: "13px",
                            }}
                          >
                            <label
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                              }}
                            >
                              Context:
                              <select
                                value={derive(thread, (t) =>
                                  t.settings.context)}
                                onChange={updateContext({
                                  threadMetadata,
                                  threadId,
                                })}
                                style={{
                                  padding: "4px 8px",
                                  borderRadius: "4px",
                                  border: "1px solid #d1d5db",
                                  fontSize: "12px",
                                }}
                              >
                                <option value="personal">Personal</option>
                                <option value="business">Business</option>
                                <option value="urgent">Urgent</option>
                              </select>
                            </label>
                            <label
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                              }}
                            >
                              Due after:
                              <input
                                type="number"
                                value={derive(thread, (t) =>
                                  t.settings.daysThreshold)}
                                onChange={updateDaysThreshold({
                                  threadMetadata,
                                  threadId,
                                  context: derive(thread, (t) =>
                                    t.settings.context),
                                })}
                                min="1"
                                max="30"
                                style={{
                                  width: "50px",
                                  padding: "4px 8px",
                                  borderRadius: "4px",
                                  border: "1px solid #d1d5db",
                                  fontSize: "12px",
                                }}
                              />
                              days
                            </label>
                            <label
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                              }}
                            >
                              Max pings:
                              <input
                                type="number"
                                value={derive(thread, (t) =>
                                  t.settings.maxPings)}
                                onChange={updateMaxPings({
                                  threadMetadata,
                                  threadId,
                                  context: derive(thread, (t) =>
                                    t.settings.context),
                                })}
                                min="1"
                                max="10"
                                style={{
                                  width: "50px",
                                  padding: "4px 8px",
                                  borderRadius: "4px",
                                  border: "1px solid #d1d5db",
                                  fontSize: "12px",
                                }}
                              />
                            </label>
                          </div>,
                          null,
                        )}

                        {/* Thread history (expandable) */}
                        {ifElse(
                          isExpanded,
                          <div
                            style={{
                              padding: "12px 16px",
                              backgroundColor: "#f9fafb",
                              borderBottom: "1px solid #e5e7eb",
                              maxHeight: "200px",
                              overflowY: "auto",
                            }}
                          >
                            {derive(thread, (t) =>
                              t.emails.map((email, i) => (
                                <div
                                  key={i}
                                  style={{
                                    padding: "8px",
                                    marginBottom: "8px",
                                    backgroundColor: "#ffffff",
                                    borderRadius: "4px",
                                    border: "1px solid #e5e7eb",
                                  }}
                                >
                                  <div
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      fontSize: "11px",
                                      color: "#6b7280",
                                      marginBottom: "4px",
                                    }}
                                  >
                                    <span>{email.from}</span>
                                    <span>{formatDate(email.date)}</span>
                                  </div>
                                  <div
                                    style={{
                                      fontSize: "12px",
                                      color: "#374151",
                                      whiteSpace: "pre-wrap",
                                    }}
                                  >
                                    {email.snippet?.slice(0, 200)}
                                    {(email.snippet?.length || 0) > 200
                                      ? "..."
                                      : ""}
                                  </div>
                                </div>
                              )))}
                          </div>,
                          null,
                        )}

                        {/* Send result notification */}
                        {ifElse(
                          derive(result, (r) =>
                            r?.success === true),
                          <div
                            style={{
                              padding: "8px 16px",
                              backgroundColor: "#d1fae5",
                              borderBottom: "1px solid #10b981",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                            }}
                          >
                            <span
                              style={{ color: "#065f46", fontSize: "13px" }}
                            >
                              Follow-up sent successfully!
                            </span>
                            <button
                              type="button"
                              onClick={dismissResult({ sendResults, threadId })}
                              style={{
                                background: "none",
                                border: "none",
                                color: "#065f46",
                                cursor: "pointer",
                                fontSize: "16px",
                              }}
                            >
                              ×
                            </button>
                          </div>,
                          null,
                        )}

                        {ifElse(
                          derive(result, (r) =>
                            r?.success === false),
                          <div
                            style={{
                              padding: "8px 16px",
                              backgroundColor: "#fee2e2",
                              borderBottom: "1px solid #ef4444",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                            }}
                          >
                            <span
                              style={{ color: "#991b1b", fontSize: "13px" }}
                            >
                              Failed: {derive(result, (r) =>
                                r?.error)}
                            </span>
                            <button
                              type="button"
                              onClick={dismissResult({ sendResults, threadId })}
                              style={{
                                background: "none",
                                border: "none",
                                color: "#991b1b",
                                cursor: "pointer",
                                fontSize: "16px",
                              }}
                            >
                              ×
                            </button>
                          </div>,
                          null,
                        )}

                        {/* Draft area */}
                        <div style={{ padding: "12px 16px" }}>
                          {/* Generate draft button (only if no draft) */}
                          {ifElse(
                            derive(thread, (t) =>
                              !t.draftedFollowUp),
                            <button
                              type="button"
                              onClick={generateDraft({ thread, draftPrompts })}
                              style={{
                                padding: "8px 16px",
                                backgroundColor: "#6366f1",
                                color: "white",
                                border: "none",
                                borderRadius: "6px",
                                cursor: "pointer",
                                fontSize: "13px",
                                fontWeight: "500",
                              }}
                            >
                              Generate Follow-up Draft
                            </button>,
                            <div>
                              {/* Draft textarea */}
                              <textarea
                                value={derive(thread, (t) =>
                                  t.draftedFollowUp || "")}
                                onChange={updateDraft({ drafts, threadId })}
                                style={{
                                  width: "100%",
                                  minHeight: "100px",
                                  padding: "8px 12px",
                                  borderRadius: "6px",
                                  border: "1px solid #d1d5db",
                                  fontSize: "13px",
                                  fontFamily: "inherit",
                                  resize: "vertical",
                                }}
                              />

                              {/* Action buttons */}
                              <div
                                style={{
                                  display: "flex",
                                  gap: "8px",
                                  marginTop: "8px",
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={prepareToSend({
                                    pendingSend,
                                    threadId,
                                  })}
                                  disabled={isSending}
                                  style={{
                                    padding: "8px 16px",
                                    backgroundColor: derive(
                                      isSending,
                                      (s) =>
                                        s ? "#9ca3af" : "#10b981",
                                    ),
                                    color: "white",
                                    border: "none",
                                    borderRadius: "6px",
                                    cursor: derive(
                                      isSending,
                                      (s) =>
                                        s ? "not-allowed" : "pointer",
                                    ),
                                    fontSize: "13px",
                                    fontWeight: "500",
                                  }}
                                >
                                  {ifElse(
                                    isSending,
                                    "Sending...",
                                    "Send Follow-up",
                                  )}
                                </button>

                                <button
                                  type="button"
                                  onClick={generateDraft({
                                    thread,
                                    draftPrompts,
                                  })}
                                  style={{
                                    padding: "8px 16px",
                                    backgroundColor: "transparent",
                                    color: "#6366f1",
                                    border: "1px solid #6366f1",
                                    borderRadius: "6px",
                                    cursor: "pointer",
                                    fontSize: "13px",
                                  }}
                                >
                                  Regenerate
                                </button>

                                <button
                                  type="button"
                                  onClick={giveUp({
                                    removeLabels: extractor.removeLabels,
                                    thread,
                                    expectResponseLabelId,
                                    hiddenThreads,
                                  })}
                                  disabled={derive(
                                    expectResponseLabelId,
                                    (id) =>
                                      !id,
                                  )}
                                  style={{
                                    marginLeft: "auto",
                                    padding: "8px 16px",
                                    backgroundColor: derive(
                                      thread,
                                      (t) =>
                                        t.shouldGiveUp
                                          ? "#f97316"
                                          : "transparent",
                                    ),
                                    color: derive(
                                      thread,
                                      (t) =>
                                        t.shouldGiveUp ? "white" : "#f97316",
                                    ),
                                    border: derive(
                                      thread,
                                      (t) =>
                                        t.shouldGiveUp
                                          ? "none"
                                          : "1px solid #f97316",
                                    ),
                                    borderRadius: "6px",
                                    cursor: derive(
                                      expectResponseLabelId,
                                      (id) => id ? "pointer" : "not-allowed",
                                    ),
                                    fontSize: "13px",
                                    fontWeight: derive(
                                      thread,
                                      (t) => t.shouldGiveUp ? "600" : "normal",
                                    ),
                                  }}
                                >
                                  Give Up
                                </button>
                              </div>
                            </div>,
                          )}
                        </div>
                      </div>
                    );
                  })}
                </ct-vstack>,
              )}

              {/* Send confirmation dialog */}
              {ifElse(
                derive(pendingSend, (p) => p !== null),
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
                    <div
                      style={{
                        padding: "20px",
                        borderBottom: "2px solid #10b981",
                      }}
                    >
                      <h3
                        style={{
                          margin: 0,
                          color: "#065f46",
                          fontSize: "18px",
                        }}
                      >
                        Confirm Send Follow-up
                      </h3>
                    </div>

                    <div style={{ padding: "20px" }}>
                      <div
                        style={{
                          backgroundColor: "#f9fafb",
                          borderRadius: "8px",
                          padding: "12px",
                          marginBottom: "16px",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "12px",
                            color: "#6b7280",
                            marginBottom: "4px",
                          }}
                        >
                          To: {derive(threads, (ts) => {
                            const t = ts.find((t) =>
                              t.threadId === pendingSend.get()
                            );
                            return t?.lastResponder || "";
                          })}
                        </div>
                        <div
                          style={{
                            fontSize: "12px",
                            color: "#6b7280",
                            marginBottom: "8px",
                          }}
                        >
                          Subject: {derive(threads, (ts) => {
                            const t = ts.find((t) =>
                              t.threadId === pendingSend.get()
                            );
                            return t?.subject?.startsWith("Re:")
                              ? t.subject
                              : `Re: ${t?.subject}`;
                          })}
                        </div>
                        <div
                          style={{
                            backgroundColor: "white",
                            border: "1px solid #e5e7eb",
                            borderRadius: "6px",
                            padding: "12px",
                            fontSize: "13px",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {computed(() => {
                            const d = drafts.get();
                            const p = pendingSend.get();
                            const key = p || "";
                            return d[key] || "";
                          })}
                        </div>
                      </div>

                      <div
                        style={{
                          padding: "12px 16px",
                          background: "#fef3c7",
                          borderRadius: "8px",
                          border: "1px solid #f59e0b",
                          fontSize: "13px",
                          color: "#78350f",
                        }}
                      >
                        This will send a real email from your Google account.
                      </div>
                    </div>

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
                        onClick={cancelSend({ pendingSend })}
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
                        onClick={derive(threads, (ts) => {
                          const t = ts.find((t) =>
                            t.threadId === pendingSend.get()
                          );
                          return t
                            ? confirmAndSend({
                              overrideAuth,
                              pendingSend,
                              threadMetadata,
                              drafts,
                              sendingThreads,
                              sendResults,
                              thread: t,
                            })
                            : undefined;
                        })}
                        style={{
                          padding: "10px 20px",
                          background: "#10b981",
                          color: "white",
                          border: "none",
                          borderRadius: "6px",
                          fontSize: "14px",
                          fontWeight: "500",
                          cursor: "pointer",
                        }}
                      >
                        Send Email
                      </button>
                    </div>
                  </div>
                </div>,
                null,
              )}
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
    };
  },
);
