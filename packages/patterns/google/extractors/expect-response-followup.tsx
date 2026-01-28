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
 * - Send via embedded gmail-sender sub-pattern (with Review & Send confirmation)
 * - Ping tracking with suggestion to remove label after multiple unanswered pings
 * - Label management to remove "expect-response" when user gives up
 *
 * Usage:
 * 1. Deploy this pattern
 * 2. The pattern will auto-request Google auth (gmail, gmailSend, gmailModify scopes)
 * 3. Add the "expect-response" label to emails you're waiting on
 * 4. View threads, configure context, generate follow-ups, send or give up
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
import GmailSender from "../core/experimental/gmail-sender.tsx";
import {
  createGoogleAuth,
  type ScopeKey,
} from "../core/util/google-auth-manager.tsx";
import {
  type GmailLabel,
  GmailSendClient,
} from "../core/util/gmail-send-client.ts";
import type { Stream } from "commontools";

/** Email draft shape matching gmail-sender's expected input */
type EmailDraft = {
  to: string;
  subject: string;
  body: string;
  cc: string;
  bcc: string;
  replyToMessageId: string;
  replyToThreadId: string;
};

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
 * Prepare to send follow-up via gmail-sender sub-pattern.
 * Populates the senderDraft with thread reply data and sets activeSendThread.
 */
const prepareSend = handler<
  unknown,
  {
    senderDraft: Writable<EmailDraft>;
    activeSendThread: Writable<string | null>;
    drafts: Writable<Record<string, string>>;
    thread: TrackedThread;
  }
>((_event, { senderDraft, activeSendThread, drafts, thread }) => {
  const threadId = thread.threadId;
  const draftBody = drafts.get()[threadId];

  if (!draftBody) {
    console.error("[ExpectResponse] No draft to send");
    return;
  }

  // Populate gmail-sender's draft input
  senderDraft.set({
    to: thread.lastResponder,
    subject: thread.subject.startsWith("Re:")
      ? thread.subject
      : `Re: ${thread.subject}`,
    body: draftBody,
    cc: "",
    bcc: "",
    replyToMessageId: thread.lastMessageId,
    replyToThreadId: threadId,
  });

  // Track which thread is being sent
  activeSendThread.set(threadId);
});

/**
 * Cancel the send flow - clear activeSendThread and reset senderDraft.
 */
const cancelSendFlow = handler<
  unknown,
  {
    senderDraft: Writable<EmailDraft>;
    activeSendThread: Writable<string | null>;
  }
>((_event, { senderDraft, activeSendThread }) => {
  activeSendThread.set(null);
  senderDraft.set({
    to: "",
    subject: "",
    body: "",
    cc: "",
    bcc: "",
    replyToMessageId: "",
    replyToThreadId: "",
  });
});

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
    auth: Writable<Auth>;
    expectResponseLabelId: Writable<string>;
    loadingLabels: Writable<boolean>;
  }
>(async (_event, { auth, expectResponseLabelId, loadingLabels }) => {
  if (!auth.get()) {
    console.error("[ExpectResponse] No auth available for fetching labels");
    return;
  }

  loadingLabels.set(true);
  try {
    const client = new GmailSendClient(auth, { debugMode: DEBUG });
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
 * Start generating a draft for a thread
 */
const startDraftGeneration = handler<
  unknown,
  {
    threadId: string;
    generatingDraftFor: Writable<string | null>;
    drafts: Writable<Record<string, string>>;
  }
>((_event, { threadId, generatingDraftFor, drafts }) => {
  // Clear any existing draft so we generate fresh
  const current = drafts.get();
  const { [threadId]: _removed, ...remaining } = current;
  drafts.set(remaining);
  // Trigger generation
  generatingDraftFor.set(threadId);
});

// =============================================================================
// PATTERN
// =============================================================================

// deno-lint-ignore no-empty-interface
interface PatternInput {
  // No inputs needed - pattern manages its own auth via createGoogleAuth()
}

/** Gmail expect-response follow-up manager. #expectResponseFollowup */
interface PatternOutput {
  threads: TrackedThread[];
  threadCount: number;
  dueCount: number;
}

export default pattern<PatternInput, PatternOutput>(() => {
  // ==========================================================================
  // STATE
  // ==========================================================================

  // Persisted state
  const threadMetadata = Writable.of<Record<string, ThreadMetadata>>(
    {},
  ).for("threadMetadata");
  const hiddenThreads = Writable.of<string[]>([]).for("hiddenThreads");

  // UI state
  const expandedThreads = Writable.of<string[]>([]).for("expandedThreads");
  const drafts = Writable.of<Record<string, string>>({}).for("drafts");
  const expectResponseLabelId = Writable.of("").for("expectResponseLabelId");

  // Gmail-sender integration state
  const emptyDraft: EmailDraft = {
    to: "",
    subject: "",
    body: "",
    cc: "",
    bcc: "",
    replyToMessageId: "",
    replyToThreadId: "",
  };
  const senderDraft = Writable.of<EmailDraft>(emptyDraft).for("senderDraft");
  const activeSendThread = Writable.of<string | null>(null).for(
    "activeSendThread",
  );
  const loadingLabels = Writable.of(false).for("loadingLabels");
  const settingsOpenFor = Writable.of<string | null>(null).for(
    "settingsOpenFor",
  );
  const sortOldestFirst = Writable.of(true).for("sortOldestFirst");

  // ==========================================================================
  // AUTH
  // ==========================================================================

  // Use createGoogleAuth to handle authentication with the wish system
  // This will auto-request a google-auth charm if one doesn't exist
  const {
    auth,
    fullUI: authUI,
    isReady,
    currentEmail,
  } = createGoogleAuth({
    requiredScopes: ["gmail", "gmailModify"] as ScopeKey[],
  });

  // ==========================================================================
  // GMAIL EXTRACTOR
  // ==========================================================================

  const extractor = GmailExtractor({
    gmailQuery: "label:expect-response",
    limit: 100,
    overrideAuth: auth,
  });

  const allEmails = extractor.emails;

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
    // User email from createGoogleAuth - used to filter out threads where user sent last message
    const currentUserEmail = (currentEmail || "").toLowerCase();

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

      result.push({
        threadId,
        subject: lastEmail.subject || "(No Subject)",
        lastMessageDate: lastEmail.date,
        lastResponder: lastEmail.from,
        daysSinceLastResponse,
        pingCount,
        emails: threadEmails,
        draftedFollowUp: null, // Drafts are computed separately in allDrafts
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

  // Track which thread is currently generating a draft
  const generatingDraftFor = Writable.of<string | null>(null).for(
    "generatingDraftFor",
  );

  // Single generateText call - only runs when a thread is selected for drafting
  // Uses computed prompt that builds from the selected thread's data
  // NOTE: When prompt is falsy/undefined, generateText should skip the API call
  const draftLlmResult = generateText({
    prompt: computed((): string | undefined => {
      const threadId = generatingDraftFor.get();
      if (!threadId) return undefined; // No thread selected, skip generation

      // Find the thread
      const currentThread = (threads || []).find((t) =>
        t.threadId === threadId
      );
      if (!currentThread) return undefined;

      const emailArray = Array.from(currentThread.emails || []);
      const threadSummary = emailArray
        .slice(-5)
        .map((email) => {
          const date = formatDate(String(email.date || ""));
          const from = String(email.from || "");
          const snippetStr = String(email.snippet || "");
          const snippet = snippetStr.slice(0, 200);
          return `[${date}] From: ${from}\n${snippet}`;
        })
        .join("\n\n");

      const subject = String(currentThread.subject || "(No Subject)");
      const lastResponder = String(currentThread.lastResponder || "");
      const context = currentThread.settings?.context || "personal";
      const daysWaiting = formatDaysDisplay(
        Number(currentThread.daysSinceLastResponse) || 0,
        context,
      );
      const pingCount = Number(currentThread.pingCount) || 0;

      return `Based on this email thread, draft a brief, polite follow-up email asking for an update.
Keep it professional and friendly. Reference the original subject matter.
Don't be pushy. Make it 2-3 sentences max. Do not include a subject line - only the body text.

Thread summary:
- Subject: ${subject}
- Last message from: ${lastResponder}
- Days waiting: ${daysWaiting}
- Previous ping count: ${pingCount}

Original context:
${threadSummary}

Write only the email body, no subject line or greeting line (the greeting will be auto-added):`;
    }),
    system:
      "You are a helpful assistant that drafts professional follow-up emails.",
    model: "anthropic:claude-sonnet-4-5",
  });

  // Auto-save LLM draft to drafts Writable when generation completes
  // This ensures the draft is available for the send handler
  const _autoSaveLlmDraft = computed(() => {
    const threadId = generatingDraftFor.get();
    const result = draftLlmResult.result;
    const isPending = draftLlmResult.pending;

    // Only save when generation completes with a result
    if (!isPending && result && threadId) {
      const current = drafts.get();
      // Idempotent check: only mutate if value changed
      if (current[threadId] !== result) {
        drafts.set({
          ...current,
          [threadId]: result,
        });
      }
    }

    return null;
  });

  // ==========================================================================
  // GMAIL SENDER SUB-PATTERN
  // ==========================================================================

  const sender = GmailSender({ draft: senderDraft });

  // Watch sender.result for successful sends → do bookkeeping
  const _autoHandleSendResult = computed(() => {
    const senderResult = sender.result;
    const threadId = activeSendThread.get();

    if (senderResult?.success && threadId) {
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

      // Clear send state
      activeSendThread.set(null);
      senderDraft.set({
        to: "",
        subject: "",
        body: "",
        cc: "",
        bcc: "",
        replyToMessageId: "",
        replyToThreadId: "",
      });
    }

    return null;
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
            {/* Auth UI - handles authentication via wish system */}
            {authUI}

            {/* Refresh button when authenticated */}
            {ifElse(
              isReady,
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "8px 12px",
                  backgroundColor: "#f9fafb",
                  borderRadius: "6px",
                }}
              >
                <span style={{ color: "#6b7280", fontSize: "13px" }}>
                  {threadCount} threads awaiting response
                </span>
                <button
                  type="button"
                  onClick={extractor.refresh}
                  style={{
                    marginLeft: "auto",
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
                  onClick={fetchLabels({
                    auth,
                    expectResponseLabelId,
                    loadingLabels,
                  })}
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
                  const uiThreadId = thread.threadId;
                  const isExpanded = computed(() =>
                    expandedThreads.get().includes(uiThreadId)
                  );
                  const isSendingThis = computed(() =>
                    activeSendThread.get() === uiThreadId
                  );
                  const settingsOpen = computed(() =>
                    settingsOpenFor.get() === uiThreadId
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
                              threadId: uiThreadId,
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
                            Last: {derive(
                              thread,
                              (t) => formatDate(t.lastMessageDate),
                            )}
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
                              threadId: uiThreadId,
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
                              value={derive(thread, (t) => t.settings.context)}
                              onChange={updateContext({
                                threadMetadata,
                                threadId: uiThreadId,
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
                              value={derive(
                                thread,
                                (t) => t.settings.daysThreshold,
                              )}
                              onChange={updateDaysThreshold({
                                threadMetadata,
                                threadId: uiThreadId,
                                context: derive(
                                  thread,
                                  (t) => t.settings.context,
                                ),
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
                              value={derive(thread, (t) => t.settings.maxPings)}
                              onChange={updateMaxPings({
                                threadMetadata,
                                threadId: uiThreadId,
                                context: derive(
                                  thread,
                                  (t) => t.settings.context,
                                ),
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

                      {/* Draft / Send area */}
                      <div style={{ padding: "12px 16px" }}>
                        {ifElse(
                          isSendingThis,
                          // Gmail-sender UI shown inline when this thread is active
                          <div>
                            {sender}
                            <div
                              style={{
                                display: "flex",
                                gap: "8px",
                                marginTop: "8px",
                              }}
                            >
                              <button
                                type="button"
                                onClick={cancelSendFlow({
                                  senderDraft,
                                  activeSendThread,
                                })}
                                style={{
                                  padding: "8px 16px",
                                  backgroundColor: "transparent",
                                  color: "#6b7280",
                                  border: "1px solid #d1d5db",
                                  borderRadius: "6px",
                                  cursor: "pointer",
                                  fontSize: "13px",
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>,
                          // Draft editing UI
                          (() => {
                            const isGenerating = computed(() =>
                              generatingDraftFor.get() === uiThreadId &&
                              draftLlmResult.pending
                            );
                            const hasDraft = computed(() => {
                              const d = drafts.get();
                              if (d[uiThreadId]) return true;
                              const genFor = generatingDraftFor.get();
                              if (
                                genFor === uiThreadId &&
                                !draftLlmResult.pending &&
                                draftLlmResult.result
                              ) {
                                return true;
                              }
                              return false;
                            });
                            const draftText = computed((): string => {
                              const d = drafts.get();
                              if (d[uiThreadId]) return String(d[uiThreadId]);
                              const genFor = generatingDraftFor.get();
                              if (genFor === uiThreadId) {
                                const result = draftLlmResult.result;
                                const error = draftLlmResult.error;
                                return String(result || error || "");
                              }
                              return "";
                            });

                            return ifElse(
                              isGenerating,
                              <div
                                style={{
                                  padding: "12px",
                                  backgroundColor: "#f3f4f6",
                                  borderRadius: "6px",
                                  color: "#6b7280",
                                  fontSize: "13px",
                                  textAlign: "center",
                                }}
                              >
                                Generating follow-up draft...
                              </div>,
                              ifElse(
                                hasDraft,
                                <div>
                                  <textarea
                                    value={derive(
                                      draftText,
                                      (t) => String(t || ""),
                                    )}
                                    onChange={updateDraft({
                                      drafts,
                                      threadId: uiThreadId,
                                    })}
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
                                  <div
                                    style={{
                                      display: "flex",
                                      gap: "8px",
                                      marginTop: "8px",
                                    }}
                                  >
                                    <button
                                      type="button"
                                      onClick={prepareSend({
                                        senderDraft,
                                        activeSendThread,
                                        drafts,
                                        thread,
                                      })}
                                      style={{
                                        padding: "8px 16px",
                                        backgroundColor: "#10b981",
                                        color: "white",
                                        border: "none",
                                        borderRadius: "6px",
                                        cursor: "pointer",
                                        fontSize: "13px",
                                        fontWeight: "500",
                                      }}
                                    >
                                      Send Follow-up
                                    </button>
                                    <button
                                      type="button"
                                      onClick={startDraftGeneration({
                                        threadId: uiThreadId,
                                        generatingDraftFor,
                                        drafts,
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
                                        (id) => !id,
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
                                            t.shouldGiveUp
                                              ? "white"
                                              : "#f97316",
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
                                          (id) =>
                                            id ? "pointer" : "not-allowed",
                                        ),
                                        fontSize: "13px",
                                        fontWeight: derive(
                                          thread,
                                          (t) =>
                                            t.shouldGiveUp ? "600" : "normal",
                                        ),
                                      }}
                                    >
                                      Give Up
                                    </button>
                                  </div>
                                </div>,
                                <div>
                                  <button
                                    type="button"
                                    onClick={startDraftGeneration({
                                      threadId: uiThreadId,
                                      generatingDraftFor,
                                      drafts,
                                    })}
                                    style={{
                                      padding: "12px 24px",
                                      backgroundColor: "#6366f1",
                                      color: "white",
                                      border: "none",
                                      borderRadius: "6px",
                                      cursor: "pointer",
                                      fontSize: "14px",
                                      fontWeight: "500",
                                      width: "100%",
                                    }}
                                  >
                                    Generate Follow-up Draft
                                  </button>
                                  <div
                                    style={{
                                      display: "flex",
                                      gap: "8px",
                                      marginTop: "8px",
                                      justifyContent: "flex-end",
                                    }}
                                  >
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
                                        (id) => !id,
                                      )}
                                      style={{
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
                                            t.shouldGiveUp
                                              ? "white"
                                              : "#f97316",
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
                                          (id) =>
                                            id ? "pointer" : "not-allowed",
                                        ),
                                        fontSize: "13px",
                                        fontWeight: derive(
                                          thread,
                                          (t) =>
                                            t.shouldGiveUp ? "600" : "normal",
                                        ),
                                      }}
                                    >
                                      Give Up
                                    </button>
                                  </div>
                                </div>,
                              ),
                            );
                          })(),
                        )}
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
