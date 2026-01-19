/// <cts-enable />
/**
 * Berkeley Public Library Email Pattern
 *
 * Processes Berkeley Public Library emails to show a dashboard of checked-out
 * books with due dates and urgency indicators.
 *
 * Features:
 * - Embeds gmail-importer directly for library emails
 * - Extracts book information using LLM from email markdown content
 * - Tracks due dates and calculates urgency levels
 * - Deduplicates books across multiple reminder emails
 * - Supports "Mark as Returned" for local tracking
 * - Omnibot actions: mark books as returned and dismiss holds
 *
 * Usage:
 * 1. Deploy a google-auth charm and complete OAuth
 * 2. Deploy this pattern
 * 3. Link: ct charm link google-auth/auth berkeley-library/linkedAuth
 *
 * Omnibot Actions:
 * - markAsReturned: Mark a book as returned by title
 * - dismissHold: Dismiss a hold (mark as picked up) by title
 */
import {
  computed,
  Default,
  generateObject,
  handler,
  JSONSchema,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commontools";
import type { Schema } from "commontools/schema";
import GmailImporter, { type Auth } from "./gmail-importer.tsx";

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

type EmailType =
  | "due_reminder"
  | "hold_ready"
  | "checkout_confirmation"
  | "renewal_confirmation"
  | "overdue_notice"
  | "fine_notice"
  | "other";

type ItemStatus =
  | "checked_out"
  | "hold_ready"
  | "overdue"
  | "renewed"
  | "returned";

type ItemType =
  | "book"
  | "audiobook"
  | "dvd"
  | "magazine"
  | "ebook"
  | "other";

type UrgencyLevel =
  | "overdue"
  | "urgent_1day"
  | "warning_3days"
  | "notice_7days"
  | "ok";

interface LibraryItem {
  title: string;
  author?: string;
  dueDate?: string; // ISO format YYYY-MM-DD
  status: ItemStatus;
  itemType?: ItemType;
  renewalsRemaining?: number;
  fineAmount?: number;
}

interface LibraryEmailAnalysis {
  emailType: EmailType;
  items: LibraryItem[];
  accountHolder?: string;
  summary: string;
}

/** A tracked library item with calculated urgency */
interface TrackedItem {
  key: string; // Deduplication key
  title: string;
  author?: string;
  dueDate?: string;
  status: ItemStatus;
  itemType?: ItemType;
  renewalsRemaining?: number;
  fineAmount?: number;
  urgency: UrgencyLevel;
  daysUntilDue: number;
  emailDate: string;
  isManuallyReturned: boolean;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const LIBRARY_SENDER = "notices@library.berkeleypubliclibrary.org";

// Schema for LLM email analysis
const EMAIL_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    emailType: {
      type: "string",
      enum: [
        "due_reminder",
        "hold_ready",
        "checkout_confirmation",
        "renewal_confirmation",
        "overdue_notice",
        "fine_notice",
        "other",
      ],
      description:
        "Type of library email: due_reminder for items coming due, hold_ready for available holds, checkout_confirmation for new checkouts, renewal_confirmation for renewals, overdue_notice for past-due items, fine_notice for fines",
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Title of the book or item",
          },
          author: {
            type: "string",
            description: "Author of the item (if available)",
          },
          dueDate: {
            type: "string",
            description: "Due date in ISO format YYYY-MM-DD (if available)",
          },
          status: {
            type: "string",
            enum: [
              "checked_out",
              "hold_ready",
              "overdue",
              "renewed",
              "returned",
            ],
            description: "Current status of the item",
          },
          itemType: {
            type: "string",
            enum: ["book", "audiobook", "dvd", "magazine", "ebook", "other"],
            description: "Type of library item",
          },
          renewalsRemaining: {
            type: "number",
            description: "Number of renewals remaining (if mentioned)",
          },
          fineAmount: {
            type: "number",
            description: "Fine amount in dollars (if applicable)",
          },
        },
        required: ["title", "status"],
      },
      description: "List of library items mentioned in the email",
    },
    accountHolder: {
      type: "string",
      description:
        "Name of the library account holder if mentioned (useful for forwarded emails)",
    },
    summary: {
      type: "string",
      description: "Brief one-sentence summary of the email content",
    },
  },
  required: ["emailType", "items", "summary"],
} as const satisfies JSONSchema;

type EmailAnalysisResult = Schema<typeof EMAIL_ANALYSIS_SCHEMA>;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Create a deduplication key for a library item.
 * Uses lowercase title + author only (not dueDate).
 * This allows the same book with different due dates (from renewals/different emails)
 * to be deduplicated, keeping the most recent information.
 */
function createItemKey(item: LibraryItem): string {
  const title = (item.title || "").toLowerCase().trim();
  const author = (item.author || "").toLowerCase().trim();
  return `${title}|${author}`;
}

/**
 * Calculate days until due date.
 * Returns negative number for overdue items.
 * Parses YYYY-MM-DD format explicitly to avoid timezone issues.
 */
function calculateDaysUntilDue(dueDate: string | undefined): number {
  if (!dueDate) return 999; // No due date = far in future

  // Parse YYYY-MM-DD explicitly as local date to avoid UTC timezone shifts
  const match = dueDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return 999; // Invalid format = treat as no due date

  const [, year, month, day] = match;
  const due = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));

  // Validate the parsed date is valid
  if (isNaN(due.getTime())) return 999;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Determine urgency level based on days until due.
 */
function calculateUrgency(
  daysUntilDue: number,
  status: ItemStatus,
): UrgencyLevel {
  if (status === "overdue" || daysUntilDue < 0) return "overdue";
  if (daysUntilDue <= 1) return "urgent_1day";
  if (daysUntilDue <= 3) return "warning_3days";
  if (daysUntilDue <= 7) return "notice_7days";
  return "ok";
}

/**
 * Get urgency color for styling.
 */
function getUrgencyColor(urgency: UrgencyLevel): {
  bg: string;
  border: string;
  text: string;
} {
  switch (urgency) {
    case "overdue":
      return { bg: "#fee2e2", border: "#ef4444", text: "#b91c1c" };
    case "urgent_1day":
      return { bg: "#ffedd5", border: "#f97316", text: "#c2410c" };
    case "warning_3days":
      return { bg: "#fef3c7", border: "#f59e0b", text: "#b45309" };
    case "notice_7days":
      return { bg: "#fef9c3", border: "#eab308", text: "#a16207" };
    case "ok":
      return { bg: "#d1fae5", border: "#10b981", text: "#047857" };
    default:
      return { bg: "#f3f4f6", border: "#d1d5db", text: "#4b5563" };
  }
}

/**
 * Get urgency label for display.
 */
function getUrgencyLabel(urgency: UrgencyLevel, daysUntilDue: number): string {
  switch (urgency) {
    case "overdue":
      return `${Math.abs(daysUntilDue)} day${
        Math.abs(daysUntilDue) !== 1 ? "s" : ""
      } overdue`;
    case "urgent_1day":
      return daysUntilDue === 0 ? "Due today" : "Due tomorrow";
    case "warning_3days":
      return `Due in ${daysUntilDue} days`;
    case "notice_7days":
      return `Due in ${daysUntilDue} days`;
    case "ok":
      return `Due in ${daysUntilDue} days`;
    default:
      return "";
  }
}

/**
 * Format date for display.
 */
function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return "N/A";
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// =============================================================================
// HANDLERS
// =============================================================================

// Handler to toggle checkbox selection for an item
// Pass the entire item Cell, then access .key inside the handler
// This ensures the reactive reference is resolved in the proper context
const toggleItemSelection = handler<
  unknown,
  {
    item: TrackedItem;
    selectedItems: Writable<Default<string[], []>>;
  }
>((_, { item, selectedItems }) => {
  const key = item.key; // Access key inside handler context
  const current = selectedItems.get() || [];
  const idx = current.indexOf(key);
  if (idx >= 0) {
    selectedItems.set(current.filter((k: string) => k !== key));
  } else {
    selectedItems.set([...current, key]);
  }
});

/**
 * Handler for omnibot to mark a book as returned by title.
 * Usage: Call with { title: "Book Title" }
 *
 * This searches for the book by title and marks all matching items as returned.
 * If you know the author, you can pass "Title by Author" for exact matching.
 */
const markAsReturnedHandler = handler<
  { title: string },
  {
    manuallyReturned: Writable<Default<string[], []>>;
    emailAnalyses: Array<{
      result?: LibraryEmailAnalysis;
    }>;
  }
>(({ title }, { manuallyReturned, emailAnalyses }) => {
  const normalizedInput = title.toLowerCase().trim();

  // Check if input is "Title by Author" format
  const byMatch = normalizedInput.match(/^(.+?)\s+by\s+(.+)$/);
  const searchTitle = byMatch ? byMatch[1].trim() : normalizedInput;
  const searchAuthor = byMatch ? byMatch[2].trim() : "";

  const current = manuallyReturned.get() || [];
  const keysToAdd: string[] = [];

  // Search through all analyzed emails for matching items
  for (const analysis of emailAnalyses) {
    if (!analysis.result?.items) continue;

    for (const item of analysis.result.items) {
      if (item.status === "hold_ready") continue; // Skip holds

      const itemTitle = (item.title || "").toLowerCase().trim();
      const itemAuthor = (item.author || "").toLowerCase().trim();

      // Match by title, optionally also by author if provided
      const titleMatches = itemTitle === searchTitle ||
        itemTitle.includes(searchTitle);
      const authorMatches = !searchAuthor || itemAuthor === searchAuthor ||
        itemAuthor.includes(searchAuthor);

      if (titleMatches && authorMatches) {
        const key = createItemKey(item);
        if (!current.includes(key) && !keysToAdd.includes(key)) {
          keysToAdd.push(key);
        }
      }
    }
  }

  if (keysToAdd.length > 0) {
    manuallyReturned.set([...current, ...keysToAdd]);
  }
});

/**
 * Handler for omnibot to dismiss a hold by title (mark as picked up).
 * Usage: Call with { title: "Book Title" }
 *
 * This searches for the hold by title and dismisses all matching holds.
 * If you know the author, you can pass "Title by Author" for exact matching.
 */
const dismissHoldHandler = handler<
  { title: string },
  {
    dismissedHolds: Writable<Default<string[], []>>;
    emailAnalyses: Array<{
      result?: LibraryEmailAnalysis;
    }>;
  }
>(({ title }, { dismissedHolds, emailAnalyses }) => {
  const normalizedInput = title.toLowerCase().trim();

  // Check if input is "Title by Author" format
  const byMatch = normalizedInput.match(/^(.+?)\s+by\s+(.+)$/);
  const searchTitle = byMatch ? byMatch[1].trim() : normalizedInput;
  const searchAuthor = byMatch ? byMatch[2].trim() : "";

  const current = dismissedHolds.get() || [];
  const keysToAdd: string[] = [];

  // Search through all analyzed emails for matching holds
  for (const analysis of emailAnalyses) {
    if (!analysis.result?.items) continue;

    for (const item of analysis.result.items) {
      if (item.status !== "hold_ready") continue; // Only holds

      const itemTitle = (item.title || "").toLowerCase().trim();
      const itemAuthor = (item.author || "").toLowerCase().trim();

      // Match by title, optionally also by author if provided
      const titleMatches = itemTitle === searchTitle ||
        itemTitle.includes(searchTitle);
      const authorMatches = !searchAuthor || itemAuthor === searchAuthor ||
        itemAuthor.includes(searchAuthor);

      if (titleMatches && authorMatches) {
        const key = createItemKey(item);
        if (!current.includes(key) && !keysToAdd.includes(key)) {
          keysToAdd.push(key);
        }
      }
    }
  }

  if (keysToAdd.length > 0) {
    dismissedHolds.set([...current, ...keysToAdd]);
  }
});

/**
 * Handler to set a new due date for selected items in a group.
 */
const setDueDateForGroup = handler<
  unknown,
  {
    groupItems: TrackedItem[];
    selectedItems: Writable<Default<string[], []>>;
    dueDateOverrides: Writable<Default<Record<string, string>, {}>>;
  }
>((event, { groupItems, selectedItems, dueDateOverrides }) => {
  const input = (event as { target: { value: string } }).target;
  const newDueDate = input.value;
  if (!newDueDate) return;

  // Get selected items in this group
  const currentSelected = selectedItems.get() || [];
  const selectedInThisGroup = groupItems.filter((item: TrackedItem) =>
    currentSelected.includes(item.key)
  );

  if (selectedInThisGroup.length === 0) return;

  // Update due date overrides for selected items
  const current = dueDateOverrides.get() || {};
  const updated = { ...current };
  for (const item of selectedInThisGroup) {
    updated[item.key] = newDueDate;
  }
  dueDateOverrides.set(updated);

  // Clear selections after updating
  selectedItems.set(
    currentSelected.filter(
      (k: string) =>
        !selectedInThisGroup.some((item: TrackedItem) => item.key === k),
    ),
  );

  // Reset the input
  input.value = "";
});

// =============================================================================
// PATTERN
// =============================================================================

interface PatternInput {
  // Optional: Link auth directly from a Google Auth charm
  // Use: ct charm link googleAuthCharm/auth berkeleyLibraryCharm/linkedAuth
  linkedAuth?: Auth;
  // Track items manually marked as returned (persisted)
  manuallyReturned: Writable<Default<string[], []>>;
  // Track holds manually dismissed (persisted)
  dismissedHolds: Writable<Default<string[], []>>;
  // Track selected items for bulk operations (per-group checkboxes)
  selectedItems: Writable<Default<string[], []>>;
  // Track manual due date overrides (persisted)
  dueDateOverrides: Writable<Default<Record<string, string>, {}>>;
}

/** Berkeley Public Library book tracker. #berkeleyLibrary */
interface PatternOutput {
  trackedItems: TrackedItem[];
  holdsReady: TrackedItem[];
  overdueCount: number;
  checkedOutCount: number;
  holdsReadyCount: number;
  previewUI: unknown;
  // Omnibot actions
  markAsReturned: Stream<{ title: string }>;
  dismissHold: Stream<{ title: string }>;
}

export default pattern<PatternInput, PatternOutput>(
  ({
    linkedAuth,
    manuallyReturned,
    dismissedHolds,
    selectedItems,
    dueDateOverrides,
  }) => {
    // Directly instantiate GmailImporter with library-specific settings
    const gmailImporter = GmailImporter({
      settings: {
        // Search for library address anywhere (from OR body) to catch forwarded emails
        gmailFilterQuery: `from:${LIBRARY_SENDER} OR ${LIBRARY_SENDER}`,
        autoFetchOnAuth: true,
        resolveInlineImages: false,
        limit: 50,
        debugMode: false,
      },
      linkedAuth,
    });

    // Get emails directly from the embedded gmail-importer
    const allEmails = gmailImporter.emails;

    // Filter for library emails (from library OR forwarded with library content)
    const libraryEmails = computed(() => {
      return (allEmails || []).filter((e: Email) => {
        const fromLibrary = e.from?.toLowerCase().includes(
          "library.berkeleypubliclibrary.org",
        );
        const contentHasLibrary = e.markdownContent?.toLowerCase().includes(
          "library.berkeleypubliclibrary.org",
        ) ||
          e.markdownContent?.toLowerCase().includes(
            "notices@library.berkeleypubliclibrary.org",
          );
        return fromLibrary || contentHasLibrary;
      });
    });

    // Count of library emails found
    const libraryEmailCount = computed(() => libraryEmails?.length || 0);

    // Check if connected
    const isConnected = computed(() => {
      if (linkedAuth?.token) return true;
      return gmailImporter?.emailCount !== undefined;
    });

    // ==========================================================================
    // REACTIVE LLM ANALYSIS
    // Analyze each library email to extract book information
    // ==========================================================================

    const emailAnalyses = libraryEmails.map((email: Email) => {
      const analysis = generateObject<EmailAnalysisResult>({
        prompt: computed(() => {
          if (!email?.markdownContent) {
            return undefined;
          }

          return `Analyze this Berkeley Public Library email and extract information about library items (books, DVDs, etc.).

EMAIL SUBJECT: ${email.subject || ""}
EMAIL DATE: ${email.date || ""}

EMAIL CONTENT:
${email.markdownContent}

Extract:
1. The type of email (due_reminder, hold_ready, checkout_confirmation, renewal_confirmation, overdue_notice, fine_notice, or other)
2. All library items mentioned with their:
   - Title
   - Author (if available)
   - Due date in YYYY-MM-DD format (if mentioned)
   - Status (checked_out, hold_ready, overdue, renewed, or returned)
   - Item type (book, audiobook, dvd, magazine, ebook, or other)
   - Renewals remaining (if mentioned)
   - Fine amount in dollars (if applicable)
3. Account holder name (if this appears to be forwarded)
4. A brief summary of the email

Note: If this is a forwarded email, look for the original library content within the forwarded message.`;
        }),
        schema: EMAIL_ANALYSIS_SCHEMA,
        model: "anthropic:claude-sonnet-4-5",
      });

      return {
        email,
        emailId: email.id,
        emailDate: email.date,
        analysis,
        pending: analysis.pending,
        error: analysis.error,
        result: analysis.result,
      };
    });

    // Count pending analyses
    const pendingCount = computed(
      () => emailAnalyses?.filter((a) => a?.pending)?.length || 0,
    );

    // Count completed analyses
    const completedCount = computed(
      () =>
        emailAnalyses?.filter((a) =>
          a?.analysis?.pending === false && a?.analysis?.result !== undefined
        ).length || 0,
    );

    // ==========================================================================
    // DEDUPLICATION AND TRACKING
    // Combine items from all emails, keeping most recent data for duplicates
    // ==========================================================================

    // Process all analyses and build deduplicated item list
    const trackedItems = computed(() => {
      const itemMap = new Map<string, TrackedItem>();
      // manuallyReturned is a Writable Cell, get the actual array value
      const returnedKeys = manuallyReturned.get() || [];
      // Get due date overrides
      const overrides = dueDateOverrides.get() || {};

      // Sort emails by date (newest first) so we keep most recent data
      const sortedAnalyses = [...(emailAnalyses || [])]
        .filter((a) => a?.result?.items)
        .sort((a, b) => {
          const dateA = new Date(a.emailDate || 0).getTime();
          const dateB = new Date(b.emailDate || 0).getTime();
          return dateB - dateA;
        });

      for (const analysisItem of sortedAnalyses) {
        const result = analysisItem.result;
        if (!result?.items) continue;

        for (const item of result.items) {
          const key = createItemKey(item);

          // Skip if we already have this item (we process newest first)
          if (itemMap.has(key)) continue;

          // Skip items that are holds (not checked out)
          if (item.status === "hold_ready") continue;

          // Use overridden due date if available, otherwise use original
          const effectiveDueDate = overrides[key] || item.dueDate;

          const daysUntilDue = calculateDaysUntilDue(effectiveDueDate);
          const urgency = calculateUrgency(daysUntilDue, item.status);

          const trackedItem: TrackedItem = {
            key,
            title: item.title,
            author: item.author,
            dueDate: effectiveDueDate,
            status: item.status,
            itemType: item.itemType,
            renewalsRemaining: item.renewalsRemaining,
            fineAmount: item.fineAmount,
            urgency,
            daysUntilDue,
            emailDate: analysisItem.emailDate,
            isManuallyReturned: returnedKeys.includes(key),
          };

          itemMap.set(key, trackedItem);
        }
      }

      // Convert to array and sort by urgency (most urgent first)
      const items = Array.from(itemMap.values());
      const urgencyOrder: Record<UrgencyLevel, number> = {
        overdue: 0,
        urgent_1day: 1,
        warning_3days: 2,
        notice_7days: 3,
        ok: 4,
      };

      return items.sort(
        (a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency],
      );
    });

    // Filter for holds ready (separate section)
    const holdsReady = computed(() => {
      const holdsSet = new Set<string>();
      const items: TrackedItem[] = [];
      // dismissedHolds is a Writable Cell, get the actual array value
      const dismissedKeys = dismissedHolds.get() || [];

      for (const analysisItem of emailAnalyses || []) {
        const result = analysisItem.result;
        if (!result?.items) continue;

        for (const item of result.items) {
          if (item.status !== "hold_ready") continue;

          const key = createItemKey(item);
          // Skip dismissed holds
          if (dismissedKeys.includes(key)) continue;
          if (holdsSet.has(key)) continue;
          holdsSet.add(key);

          items.push({
            key,
            title: item.title,
            author: item.author,
            dueDate: undefined,
            status: "hold_ready",
            itemType: item.itemType,
            renewalsRemaining: undefined,
            fineAmount: undefined,
            urgency: "ok",
            daysUntilDue: 999,
            emailDate: analysisItem.emailDate,
            isManuallyReturned: false,
          });
        }
      }

      return items;
    });

    // Active items (not manually returned)
    const activeItems = computed(() =>
      (trackedItems || []).filter((item) => !item.isManuallyReturned)
    );

    // Historical items (manually marked as returned)
    const historicalItems = computed(() =>
      (trackedItems || []).filter((item) => item.isManuallyReturned)
    );

    // Dismissed holds (manually dismissed)
    const dismissedHoldsItems = computed(() => {
      const holdsSet = new Set<string>();
      const items: TrackedItem[] = [];
      const dismissedKeys = dismissedHolds.get() || [];

      for (const analysisItem of emailAnalyses || []) {
        const result = analysisItem.result;
        if (!result?.items) continue;

        for (const item of result.items) {
          if (item.status !== "hold_ready") continue;

          const key = createItemKey(item);
          // Only include dismissed holds
          if (!dismissedKeys.includes(key)) continue;
          if (holdsSet.has(key)) continue;
          holdsSet.add(key);

          items.push({
            key,
            title: item.title,
            author: item.author,
            dueDate: undefined,
            status: "hold_ready",
            itemType: item.itemType,
            renewalsRemaining: undefined,
            fineAmount: undefined,
            urgency: "ok",
            daysUntilDue: 999,
            emailDate: analysisItem.emailDate,
            isManuallyReturned: false,
          });
        }
      }

      return items;
    });

    // Count statistics
    const overdueCount = computed(
      () =>
        activeItems?.filter((item) => item.urgency === "overdue")?.length ||
        0,
    );

    const checkedOutCount = computed(() => activeItems?.length || 0);

    const holdsReadyCount = computed(() => holdsReady?.length || 0);

    // Most urgent status for badge coloring
    const mostUrgentLevel = computed((): UrgencyLevel => {
      const items = activeItems || [];
      if (items.some((i) => i.urgency === "overdue")) return "overdue";
      if (items.some((i) => i.urgency === "urgent_1day")) return "urgent_1day";
      if (items.some((i) => i.urgency === "warning_3days")) {
        return "warning_3days";
      }
      if (items.some((i) => i.urgency === "notice_7days")) {
        return "notice_7days";
      }
      return "ok";
    });

    // Group active items by due date for checkbox-based bulk returns
    const itemsByDueDate = computed(() => {
      const groups = new Map<string, TrackedItem[]>();
      const items = activeItems || [];

      for (const item of items) {
        const dueDate = item.dueDate || "No due date";
        if (!groups.has(dueDate)) {
          groups.set(dueDate, []);
        }
        groups.get(dueDate)!.push(item);
      }

      // Sort groups by due date (earliest first)
      return Array.from(groups.entries())
        .sort(([dateA], [dateB]) => {
          if (dateA === "No due date") return 1;
          if (dateB === "No due date") return -1;
          return dateA.localeCompare(dateB);
        })
        .map(([dueDate, items]) => ({ dueDate, items }));
    });

    // Preview UI for compact display in lists/pickers
    const previewUI = (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "8px 12px",
        }}
      >
        {/* Badge with checkout count - color based on urgency */}
        <div
          style={{
            width: "36px",
            height: "36px",
            borderRadius: "8px",
            backgroundColor: computed(
              () => getUrgencyColor(mostUrgentLevel).bg,
            ),
            border: computed(
              () => `2px solid ${getUrgencyColor(mostUrgentLevel).border}`,
            ),
            color: computed(() => getUrgencyColor(mostUrgentLevel).text),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: "bold",
            fontSize: "16px",
          }}
        >
          {checkedOutCount}
        </div>
        {/* Label and summary */}
        <div>
          <div style={{ fontWeight: "600", fontSize: "14px" }}>
            Library Books
          </div>
          <div style={{ fontSize: "12px", color: "#6b7280" }}>
            {overdueCount > 0 && (
              <span style={{ color: "#dc2626" }}>{overdueCount} overdue</span>
            )}
            {overdueCount > 0 &&
              (computed(() =>
                activeItems?.filter((i) => i.urgency === "urgent_1day")
                  ?.length || 0
              ) > 0) && <span>·</span>}
            {computed(() => {
              const dueTomorrow = activeItems?.filter((i) =>
                i.urgency === "urgent_1day"
              )?.length || 0;
              return dueTomorrow > 0 ? `${dueTomorrow} due tomorrow` : "";
            })}
            {holdsReadyCount > 0 && (
              <span style={{ color: "#2563eb" }}>
                {" "}
                · {holdsReadyCount} holds ready
              </span>
            )}
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: "Berkeley Library",

      trackedItems,
      holdsReady,
      overdueCount,
      checkedOutCount,
      holdsReadyCount,
      previewUI,

      // Omnibot actions - bind handlers with current state
      markAsReturned: markAsReturnedHandler({
        manuallyReturned,
        emailAnalyses,
      }),
      dismissHold: dismissHoldHandler({ dismissedHolds, emailAnalyses }),

      [UI]: (
        <ct-screen>
          <div slot="header">
            <ct-heading level={3}>Berkeley Public Library</ct-heading>
          </div>

          <ct-vscroll flex showScrollbar>
            <ct-vstack padding="6" gap="4">
              {/* Auth UI from embedded Gmail Importer */}
              {gmailImporter.authUI}

              {/* Connection Status */}
              <div
                style={{
                  padding: "12px 16px",
                  backgroundColor: computed(() =>
                    isConnected ? "#d1fae5" : "#fef3c7"
                  ),
                  borderRadius: "8px",
                  border: computed(() =>
                    isConnected ? "1px solid #10b981" : "1px solid #f59e0b"
                  ),
                  display: isConnected ? "block" : "none",
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
                    {libraryEmailCount} library emails found
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

              {/* Analysis Status */}
              <div
                style={{
                  padding: "12px 16px",
                  backgroundColor: "#eff6ff",
                  borderRadius: "8px",
                  border: "1px solid #3b82f6",
                  display: isConnected ? "block" : "none",
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
                  <span>{libraryEmailCount} emails</span>
                  <div
                    style={{
                      display: pendingCount > 0 ? "flex" : "none",
                      alignItems: "center",
                      gap: "4px",
                      color: "#2563eb",
                    }}
                  >
                    <ct-loader size="sm" />
                    <span>{pendingCount} analyzing...</span>
                  </div>
                  <span style={{ color: "#059669" }}>
                    {completedCount} completed
                  </span>
                </div>
              </div>

              {/* Stats Row */}
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
                    {checkedOutCount}
                  </div>
                  <div style={{ fontSize: "12px", color: "#666" }}>
                    Checked Out
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
                    {overdueCount}
                  </div>
                  <div style={{ fontSize: "12px", color: "#666" }}>Overdue</div>
                </div>
                <div>
                  <div
                    style={{
                      fontSize: "24px",
                      fontWeight: "bold",
                      color: "#2563eb",
                    }}
                  >
                    {holdsReadyCount}
                  </div>
                  <div style={{ fontSize: "12px", color: "#666" }}>
                    Holds Ready
                  </div>
                </div>
              </div>

              {/* Urgency Alert Banner - show if any overdue */}
              <div
                style={{
                  padding: "16px",
                  backgroundColor: "#fee2e2",
                  borderRadius: "12px",
                  border: "2px solid #ef4444",
                  display: computed(() => overdueCount > 0 ? "block" : "none"),
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    marginBottom: "8px",
                  }}
                >
                  <span style={{ fontSize: "20px" }}>⚠️</span>
                  <span
                    style={{
                      fontWeight: "700",
                      fontSize: "18px",
                      color: "#b91c1c",
                    }}
                  >
                    {overdueCount} Overdue Item{overdueCount !== 1 ? "s" : ""}
                  </span>
                </div>
                <div style={{ fontSize: "14px", color: "#b91c1c" }}>
                  Please return or renew these items to avoid additional fines.
                </div>
              </div>

              {/* Checked Out Items - Grouped by Due Date */}
              <div
                style={{
                  display: computed(() =>
                    (activeItems || []).length > 0 ? "block" : "none"
                  ),
                }}
              >
                <h3
                  style={{
                    fontSize: "16px",
                    fontWeight: "600",
                    marginBottom: "12px",
                    color: "#374151",
                  }}
                >
                  Checked Out Items
                </h3>
                <ct-vstack gap="4">
                  {itemsByDueDate.map((group) => {
                    const groupUrgency = computed(() => {
                      const items = group.items || [];
                      if (items.some((i) => i.urgency === "overdue")) {
                        return "overdue";
                      }
                      if (
                        items.some((i) => i.urgency === "urgent_1day")
                      ) return "urgent_1day";
                      if (
                        items.some((i) => i.urgency === "warning_3days")
                      ) return "warning_3days";
                      if (
                        items.some((i) => i.urgency === "notice_7days")
                      ) return "notice_7days";
                      return "ok";
                    });

                    // Get count of selected items in this group
                    const selectedCount = computed(() => {
                      const selected = selectedItems.get() || [];
                      return group.items.filter((item: TrackedItem) =>
                        selected.includes(item.key)
                      ).length;
                    });

                    return (
                      <div
                        style={{
                          padding: "16px",
                          backgroundColor: "#f9fafb",
                          borderRadius: "8px",
                          border: "1px solid #e5e7eb",
                        }}
                      >
                        {/* Group Header with Due Date */}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            marginBottom: "12px",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                            }}
                          >
                            <div
                              style={{
                                fontWeight: "600",
                                fontSize: "15px",
                                color: "#111827",
                              }}
                            >
                              Due: {computed(() => formatDate(group.dueDate))}
                            </div>
                            <div
                              style={{
                                fontSize: "13px",
                                padding: "4px 8px",
                                borderRadius: "4px",
                                backgroundColor: computed(() =>
                                  getUrgencyColor(groupUrgency).bg
                                ),
                                color: computed(() =>
                                  getUrgencyColor(groupUrgency).text
                                ),
                                fontWeight: "500",
                              }}
                            >
                              {computed(() => {
                                const items = group.items || [];
                                if (items.length === 0) return "";
                                const firstItem = items[0];
                                return getUrgencyLabel(
                                  firstItem.urgency,
                                  firstItem.daysUntilDue,
                                );
                              })}
                            </div>
                          </div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                            }}
                          >
                            {/* Date picker for setting new due date */}
                            <div
                              style={{
                                display: computed(() =>
                                  selectedCount > 0 ? "flex" : "none"
                                ),
                                alignItems: "center",
                                gap: "8px",
                              }}
                            >
                              <label
                                style={{
                                  fontSize: "13px",
                                  fontWeight: "500",
                                  color: "#374151",
                                }}
                              >
                                New due date:
                              </label>
                              <input
                                type="date"
                                onChange={setDueDateForGroup({
                                  groupItems: group.items,
                                  selectedItems,
                                  dueDateOverrides,
                                })}
                                style={{
                                  padding: "6px 12px",
                                  border: "1px solid #d1d5db",
                                  borderRadius: "6px",
                                  fontSize: "13px",
                                  cursor: "pointer",
                                }}
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                // Get selected items in this group
                                const currentSelected = selectedItems.get() ||
                                  [];
                                const selectedInThisGroup = group.items.filter(
                                  (item: TrackedItem) =>
                                    currentSelected.includes(item.key),
                                );
                                if (selectedInThisGroup.length === 0) return;

                                // Mark them as returned
                                const current = manuallyReturned.get();
                                const selectedKeys = selectedInThisGroup.map(
                                  (item: TrackedItem) => item.key,
                                );
                                manuallyReturned.set([
                                  ...current,
                                  ...selectedKeys,
                                ]);

                                // Clear selections for returned items
                                selectedItems.set(
                                  currentSelected.filter(
                                    (k: string) => !selectedKeys.includes(k),
                                  ),
                                );
                              }}
                              style={{
                                padding: "8px 16px",
                                backgroundColor: computed(() =>
                                  selectedCount > 0 ? "#10b981" : "#d1d5db"
                                ),
                                color: "white",
                                border: "none",
                                borderRadius: "6px",
                                cursor: computed(() =>
                                  selectedCount > 0 ? "pointer" : "not-allowed"
                                ),
                                fontSize: "13px",
                                fontWeight: "600",
                                display: computed(() =>
                                  selectedCount > 0 ? "block" : "none"
                                ),
                              }}
                            >
                              Mark {selectedCount} Returned
                            </button>
                          </div>
                        </div>

                        {/* Items in this group */}
                        <ct-vstack gap="2">
                          {group.items.map((item) => (
                            <div
                              style={{
                                display: "flex",
                                gap: "12px",
                                padding: "12px",
                                backgroundColor: "white",
                                borderRadius: "6px",
                                border: "1px solid #e5e7eb",
                                alignItems: "center",
                              }}
                            >
                              {/* Checkbox - pass item to handler for proper reactive resolution */}
                              <div
                                style={{
                                  cursor: "pointer",
                                  userSelect: "none",
                                  flexShrink: "0",
                                }}
                                onClick={toggleItemSelection({
                                  item,
                                  selectedItems,
                                })}
                              >
                                <ct-checkbox
                                  checked={computed(() => {
                                    const selected = selectedItems.get() || [];
                                    return selected.includes(item.key);
                                  })}
                                />
                              </div>

                              {/* Book Info */}
                              <div style={{ flex: 1 }}>
                                <div
                                  style={{
                                    fontWeight: "600",
                                    fontSize: "14px",
                                  }}
                                >
                                  {item.title}
                                </div>
                                <div
                                  style={{
                                    fontSize: "12px",
                                    color: "#6b7280",
                                    display: item.author ? "block" : "none",
                                  }}
                                >
                                  by {item.author}
                                </div>
                              </div>

                              {/* Individual Mark Returned Button */}
                              <button
                                type="button"
                                onClick={() => {
                                  const current = manuallyReturned.get();
                                  if (!current.includes(item.key)) {
                                    manuallyReturned.set([
                                      ...current,
                                      item.key,
                                    ]);
                                  }
                                  // Remove from selected if present
                                  const currentSelected = selectedItems.get();
                                  selectedItems.set(
                                    currentSelected.filter(
                                      (k: string) => k !== item.key,
                                    ),
                                  );
                                }}
                                style={{
                                  padding: "6px 12px",
                                  backgroundColor: "#10b981",
                                  color: "white",
                                  border: "none",
                                  borderRadius: "6px",
                                  cursor: "pointer",
                                  fontSize: "12px",
                                  fontWeight: "500",
                                  flexShrink: "0",
                                }}
                              >
                                Mark Returned
                              </button>
                            </div>
                          ))}
                        </ct-vstack>
                      </div>
                    );
                  })}
                </ct-vstack>
              </div>

              {/* Holds Ready Section */}
              <div
                style={{
                  display: holdsReadyCount > 0 ? "block" : "none",
                }}
              >
                <h3
                  style={{
                    fontSize: "16px",
                    fontWeight: "600",
                    marginBottom: "8px",
                    color: "#1d4ed8",
                  }}
                >
                  🔵 Holds Ready for Pickup ({holdsReadyCount})
                </h3>
                <ct-vstack gap="2">
                  {holdsReady.map((item) => (
                    <div
                      style={{
                        display: "flex",
                        gap: "12px",
                        padding: "12px",
                        backgroundColor: "#dbeafe",
                        borderRadius: "8px",
                        border: "1px solid #3b82f6",
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: "600", fontSize: "14px" }}>
                          {item.title}
                        </div>
                        <div
                          style={{
                            fontSize: "12px",
                            color: "#6b7280",
                            display: item.author ? "block" : "none",
                          }}
                        >
                          by {item.author}
                        </div>
                        <div
                          style={{
                            fontSize: "12px",
                            color: "#1d4ed8",
                            marginTop: "4px",
                          }}
                        >
                          Ready for pickup
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const current = dismissedHolds.get();
                          if (!current.includes(item.key)) {
                            dismissedHolds.set([...current, item.key]);
                          }
                        }}
                        style={{
                          padding: "6px 12px",
                          backgroundColor: "#10b981",
                          color: "white",
                          border: "none",
                          borderRadius: "6px",
                          cursor: "pointer",
                          fontSize: "12px",
                          fontWeight: "500",
                          alignSelf: "center",
                        }}
                      >
                        Picked Up
                      </button>
                    </div>
                  ))}
                </ct-vstack>
              </div>

              {/* Dismissed Holds Section */}
              <div
                style={{
                  display: computed(() =>
                    (dismissedHoldsItems || []).length > 0 ? "block" : "none"
                  ),
                }}
              >
                <details>
                  <summary
                    style={{
                      cursor: "pointer",
                      fontWeight: "600",
                      fontSize: "16px",
                      marginBottom: "8px",
                      color: "#6b7280",
                    }}
                  >
                    ✓ Dismissed Holds (
                    {computed(() => (dismissedHoldsItems || []).length)})
                  </summary>
                  <ct-vstack gap="2">
                    {dismissedHoldsItems.map((item) => (
                      <div
                        style={{
                          display: "flex",
                          gap: "12px",
                          padding: "12px",
                          backgroundColor: "#f3f4f6",
                          borderRadius: "8px",
                          border: "1px solid #d1d5db",
                          opacity: 0.7,
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: "600", fontSize: "14px" }}>
                            {item.title}
                          </div>
                          <div
                            style={{
                              fontSize: "12px",
                              color: "#6b7280",
                              display: item.author ? "block" : "none",
                            }}
                          >
                            by {item.author}
                          </div>
                          <div
                            style={{
                              fontSize: "12px",
                              color: "#9ca3af",
                              marginTop: "4px",
                            }}
                          >
                            Dismissed
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const current = dismissedHolds.get();
                            dismissedHolds.set(
                              current.filter((k: string) => k !== item.key),
                            );
                          }}
                          style={{
                            padding: "6px 12px",
                            backgroundColor: "#6b7280",
                            color: "white",
                            border: "none",
                            borderRadius: "6px",
                            cursor: "pointer",
                            fontSize: "12px",
                            fontWeight: "500",
                            alignSelf: "center",
                          }}
                        >
                          Undo
                        </button>
                      </div>
                    ))}
                  </ct-vstack>
                </details>
              </div>

              {/* Historical Items Section */}
              <div
                style={{
                  display: computed(() =>
                    (historicalItems || []).length > 0 ? "block" : "none"
                  ),
                }}
              >
                <details>
                  <summary
                    style={{
                      cursor: "pointer",
                      fontWeight: "600",
                      fontSize: "16px",
                      marginBottom: "8px",
                      color: "#6b7280",
                    }}
                  >
                    📚 Marked as Returned (
                    {computed(() => (historicalItems || []).length)})
                  </summary>
                  <ct-vstack gap="2">
                    {historicalItems.map((item) => (
                      <div
                        style={{
                          display: "flex",
                          gap: "12px",
                          padding: "12px",
                          backgroundColor: "#f3f4f6",
                          borderRadius: "8px",
                          border: "1px solid #d1d5db",
                          opacity: 0.7,
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: "600", fontSize: "14px" }}>
                            {item.title}
                          </div>
                          <div
                            style={{
                              fontSize: "12px",
                              color: "#6b7280",
                              display: item.author ? "block" : "none",
                            }}
                          >
                            by {item.author}
                          </div>
                          <div
                            style={{
                              fontSize: "12px",
                              color: "#9ca3af",
                              marginTop: "4px",
                            }}
                          >
                            Marked as returned
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const current = manuallyReturned.get();
                            manuallyReturned.set(
                              current.filter((k: string) => k !== item.key),
                            );
                          }}
                          style={{
                            padding: "6px 12px",
                            backgroundColor: "#6b7280",
                            color: "white",
                            border: "none",
                            borderRadius: "6px",
                            cursor: "pointer",
                            fontSize: "12px",
                            fontWeight: "500",
                            alignSelf: "center",
                          }}
                        >
                          Undo
                        </button>
                      </div>
                    ))}
                  </ct-vstack>
                </details>
              </div>

              {/* Debug View Section */}
              <div
                style={{
                  marginTop: "24px",
                  padding: "16px",
                  backgroundColor: "#f9fafb",
                  borderRadius: "8px",
                  border: "1px solid #d1d5db",
                  display: computed(() =>
                    libraryEmailCount > 0 ? "block" : "none"
                  ),
                }}
              >
                <details>
                  <summary
                    style={{
                      cursor: "pointer",
                      fontWeight: "600",
                      fontSize: "16px",
                      marginBottom: "12px",
                      color: "#374151",
                    }}
                  >
                    🔍 Debug View ({libraryEmailCount} emails)
                  </summary>

                  <div style={{ marginTop: "12px" }}>
                    <h4
                      style={{
                        fontSize: "14px",
                        fontWeight: "600",
                        marginBottom: "8px",
                        color: "#6b7280",
                      }}
                    >
                      Fetched Library Emails:
                    </h4>
                    <ct-vstack gap="2">
                      {libraryEmails.map((email: Email) => (
                        <div
                          style={{
                            padding: "8px 12px",
                            backgroundColor: "white",
                            borderRadius: "6px",
                            border: "1px solid #e5e7eb",
                            fontSize: "12px",
                          }}
                        >
                          <div
                            style={{ fontWeight: "600", marginBottom: "4px" }}
                          >
                            {email.subject}
                          </div>
                          <div style={{ color: "#6b7280" }}>
                            Date: {computed(() => formatDate(email.date))} (
                            {email.date})
                          </div>
                          <div style={{ color: "#9ca3af", fontSize: "11px" }}>
                            ID: {email.id}
                          </div>
                        </div>
                      ))}
                    </ct-vstack>

                    <h4
                      style={{
                        fontSize: "14px",
                        fontWeight: "600",
                        marginTop: "16px",
                        marginBottom: "8px",
                        color: "#6b7280",
                      }}
                    >
                      LLM Analysis Results:
                    </h4>
                    <ct-vstack gap="2">
                      {emailAnalyses.map((analysis) => (
                        <div
                          style={{
                            padding: "12px",
                            backgroundColor: "white",
                            borderRadius: "6px",
                            border: computed(() =>
                              analysis.pending
                                ? "1px solid #fbbf24"
                                : analysis.error
                                ? "1px solid #ef4444"
                                : "1px solid #10b981"
                            ),
                            fontSize: "12px",
                          }}
                        >
                          <div
                            style={{
                              fontWeight: "600",
                              marginBottom: "4px",
                              color: "#111827",
                            }}
                          >
                            {analysis.email.subject}
                          </div>

                          <div
                            style={{
                              display: analysis.pending ? "flex" : "none",
                              alignItems: "center",
                              gap: "4px",
                              color: "#f59e0b",
                              marginTop: "4px",
                            }}
                          >
                            <ct-loader size="sm" />
                            <span>Analyzing...</span>
                          </div>

                          <div
                            style={{
                              display: analysis.error ? "block" : "none",
                              color: "#dc2626",
                              marginTop: "4px",
                            }}
                          >
                            Error:{" "}
                            {computed(() =>
                              analysis.error ? String(analysis.error) : ""
                            )}
                          </div>

                          <div
                            style={{
                              display: computed(() =>
                                !analysis.pending && !analysis.error &&
                                  analysis.result
                                  ? "block"
                                  : "none"
                              ),
                            }}
                          >
                            <div
                              style={{
                                marginTop: "8px",
                                padding: "8px",
                                backgroundColor: "#f3f4f6",
                                borderRadius: "4px",
                              }}
                            >
                              <div style={{ color: "#374151" }}>
                                <strong>Email Type:</strong>{" "}
                                {computed(() =>
                                  analysis.result?.emailType || "N/A"
                                )}
                              </div>
                              <div
                                style={{ color: "#374151", marginTop: "4px" }}
                              >
                                <strong>Summary:</strong>{" "}
                                {computed(() =>
                                  analysis.result?.summary || "N/A"
                                )}
                              </div>
                              <div
                                style={{
                                  color: "#374151",
                                  marginTop: "4px",
                                  display: computed(() =>
                                    analysis.result?.accountHolder
                                      ? "block"
                                      : "none"
                                  ),
                                }}
                              >
                                <strong>Account Holder:</strong>{" "}
                                {computed(() =>
                                  analysis.result?.accountHolder || ""
                                )}
                              </div>
                              <div style={{ marginTop: "8px" }}>
                                <strong>Extracted Items:</strong> (
                                {computed(() =>
                                  analysis.result?.items?.length || 0
                                )}
                                )
                              </div>
                              <pre
                                style={{
                                  marginTop: "8px",
                                  padding: "8px",
                                  backgroundColor: "#ffffff",
                                  borderRadius: "4px",
                                  fontSize: "10px",
                                  overflow: "auto",
                                  maxHeight: "200px",
                                  border: "1px solid #e5e7eb",
                                }}
                              >
                                {computed(() =>
                                  JSON.stringify(
                                    analysis.result?.items || [],
                                    null,
                                    2,
                                  )
                                )}
                              </pre>
                            </div>
                          </div>
                        </div>
                      ))}
                    </ct-vstack>
                  </div>
                </details>
              </div>

              {/* Library Website Link */}
              <div style={{ marginTop: "16px", textAlign: "center" }}>
                <a
                  href="https://www.berkeleypubliclibrary.org/my-account"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-block",
                    padding: "10px 20px",
                    backgroundColor: "#2563eb",
                    color: "white",
                    borderRadius: "8px",
                    textDecoration: "none",
                    fontWeight: "500",
                    fontSize: "14px",
                  }}
                >
                  Open Library Website
                </a>
              </div>
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
    };
  },
);
