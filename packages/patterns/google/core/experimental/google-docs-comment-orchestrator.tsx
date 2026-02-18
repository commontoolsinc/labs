/// <cts-enable />
import {
  computed,
  Default,
  derive,
  generateObject,
  getPatternEnvironment,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";

// Import trusted handlers from confirmation file (TRUST BOUNDARY)
import {
  cancelAction,
  executeAction,
  type PendingCommentAction,
} from "./google-docs-comment-confirm.ts";

// Import Google Auth utility
import {
  createGoogleAuth,
  type ScopeKey,
} from "../util/google-auth-manager.tsx";

const _env = getPatternEnvironment();

// Debug flag for development - disable in production
const DEBUG_ORCHESTRATOR = false;

// =============================================================================
// SETUP REQUIREMENTS
// =============================================================================
//
// This pattern requires Google OAuth with specific scopes and APIs enabled:
//
// 1. GOOGLE AUTH CHARM
//    - Create and favorite a Google Auth piece with these scopes enabled:
//      - Drive (read/write files & comments) - for fetching and posting comments
//      - Docs (read document content) - for fetching document text for AI context
//
// 2. GOOGLE CLOUD CONSOLE
//    The OAuth project must have these APIs enabled:
//    - Google Drive API (usually enabled by default)
//    - Google Docs API (must be explicitly enabled)
//
//    To enable Google Docs API:
//    1. Go to https://console.developers.google.com/apis/library/docs.googleapis.com
//    2. Select your project
//    3. Click "Enable"
//
//    Without this, fetching document content will fail with a 403 error.
//    Comments will still work, but AI responses won't have document context.
//
// =============================================================================

// =============================================================================
// Types - Google API
// =============================================================================

interface GoogleCommentAuthor {
  displayName: string;
  photoLink?: string;
  emailAddress?: string;
}

interface GoogleCommentReply {
  id: string;
  author: GoogleCommentAuthor;
  content: string;
  htmlContent?: string;
  createdTime: string;
  modifiedTime?: string;
  action?: "resolve" | "reopen";
}

interface GoogleComment {
  id: string;
  author: GoogleCommentAuthor;
  content: string;
  htmlContent?: string;
  createdTime: string;
  modifiedTime?: string;
  resolved: boolean;
  quotedFileContent?: {
    value: string;
    mimeType?: string;
  };
  anchor?: string;
  replies?: GoogleCommentReply[];
}

// =============================================================================
// Types - Auth (from google-auth pattern)
// =============================================================================

type CFC<T, C extends string> = T;
type Secret<T> = CFC<T, "secret">;

type Auth = {
  token: Default<Secret<string>, "">;
  tokenType: Default<string, "">;
  scope: Default<string[], []>;
  expiresIn: Default<number, 0>;
  expiresAt: Default<number, 0>;
  refreshToken: Default<Secret<string>, "">;
  user: Default<{
    email: string;
    name: string;
    picture: string;
  }, { email: ""; name: ""; picture: "" }>;
};

// =============================================================================
// Types - Per-Comment State
// =============================================================================

interface CommentState {
  regenerateNonce: number;
  status: "pending" | "generating" | "ready" | "accepted" | "skipped";
}

// =============================================================================
// Types - AI Response
// =============================================================================

interface AIResponseSuggestion {
  suggestedResponse: string;
  tone: "professional" | "friendly" | "direct" | "empathetic";
  reasoning: string;
}

// =============================================================================
// Types - Input/Output
// =============================================================================

interface Input {
  // Config
  docUrl?: Writable<Default<string, "">>;
  globalPrompt?: Writable<Default<string, "">>;

  // Fetched data
  comments?: Writable<Default<GoogleComment[], []>>;
  docContent?: Writable<Default<string, "">>;

  // Per-comment state (keyed by comment ID)
  commentStates?: Writable<
    Default<Record<string, CommentState>, Record<string, never>>
  >;

  // UI state
  expandedCommentId?: Writable<Default<string | null, null>>;
  isFetching?: Writable<Default<boolean, false>>;
  showGlobalPrompt?: Writable<Default<boolean, false>>;
  lastError?: Writable<Default<string | null, null>>;

  // Pending action for trusted confirmation
  pendingAction?: Writable<Default<PendingCommentAction | null, null>>;
  isExecuting?: Writable<Default<boolean, false>>;
}

/** Google Docs Comment Orchestrator. AI-powered comment responses. #googleDocsComments */
interface Output {
  docUrl: string;
  comments: GoogleComment[];
  openCommentCount: number;
}

// =============================================================================
// API Client
// =============================================================================

class GoogleDocsClient {
  private token: string;
  private delay = 0;
  private delayIncrement = 1000;

  constructor(token: string) {
    this.token = token;
  }

  private async request(
    url: URL,
    options?: RequestInit,
    retries = 3,
  ): Promise<Response> {
    const token = this.token;
    if (!token) throw new Error("No authorization token");

    const opts = options ?? {};
    opts.headers = new Headers(opts.headers);
    opts.headers.set("Authorization", `Bearer ${token}`);

    // Add delay if we've been rate limited
    if (this.delay > 0) {
      await new Promise((r) => setTimeout(r, this.delay));
    }

    const res = await fetch(url, opts);
    const status = res.status;

    // Handle 401 (expired token) - tell user to refresh auth
    if (status === 401) {
      throw new Error(
        "Token expired. Please re-authenticate in your Google Auth piece.",
      );
    }

    // Handle 429 (rate limit) - exponential backoff
    if (status === 429 && retries > 0) {
      this.delay += this.delayIncrement;
      if (DEBUG_ORCHESTRATOR) {
        console.log(
          `[GoogleDocsClient] Rate limited, waiting ${this.delay}ms...`,
        );
      }
      await new Promise((r) => setTimeout(r, this.delay));
      return this.request(url, options, retries - 1);
    }

    // Reset delay on success
    if (res.ok) {
      this.delay = 0;
    }

    return res;
  }

  async listComments(fileId: string): Promise<GoogleComment[]> {
    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${fileId}/comments`,
    );
    url.searchParams.set(
      "fields",
      "comments(id,author,content,htmlContent,createdTime,modifiedTime,resolved,quotedFileContent,anchor,replies)",
    );
    url.searchParams.set("pageSize", "100");

    const res = await this.request(url);
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 403) {
        throw new Error(
          `Access denied (403). This could mean:\n` +
            `• The document is not shared with your Google account\n` +
            `• Your account doesn't have comment access (needs Commenter or Editor role)\n` +
            `• The document has restricted sharing settings\n\n` +
            `Make sure you're signed in with an account that has access to this document.`,
        );
      }
      throw new Error(`Failed to list comments: ${res.status} - ${text}`);
    }

    const json = await res.json();
    return json.comments || [];
  }

  async createReply(
    fileId: string,
    commentId: string,
    content: string,
    resolve = false,
  ): Promise<void> {
    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${fileId}/comments/${commentId}/replies`,
    );
    url.searchParams.set("fields", "id,content,action");

    const body: { content: string; action?: string } = { content };
    if (resolve) {
      body.action = "resolve";
    }

    const res = await this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to create reply: ${res.status} - ${text}`);
    }
  }

  async resolveComment(fileId: string, commentId: string): Promise<void> {
    // Resolve by creating a reply with action="resolve"
    await this.createReply(fileId, commentId, "Resolved", true);
  }

  async getDocContent(docId: string): Promise<string> {
    const url = new URL(
      `https://docs.googleapis.com/v1/documents/${docId}`,
    );

    const res = await this.request(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to get doc content: ${res.status} - ${text}`);
    }

    const json = await res.json();
    return extractDocText(json);
  }
}

// Helper to extract plain text from Google Docs document JSON
function extractDocText(doc: any): string {
  const parts: string[] = [];

  if (doc.body?.content) {
    for (const element of doc.body.content) {
      if (element.paragraph?.elements) {
        for (const elem of element.paragraph.elements) {
          if (elem.textRun?.content) {
            parts.push(elem.textRun.content);
          }
        }
      }
    }
  }

  return parts.join("");
}

// Format date helper (extracted to module scope for compiler compliance)
function formatCommentDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

// Helper to extract file ID from Google Docs URL
function extractFileId(url: string): string | null {
  // Handle various Google Docs URL formats:
  // https://docs.google.com/document/d/FILE_ID/edit
  // https://docs.google.com/document/d/FILE_ID/edit?...
  // https://drive.google.com/file/d/FILE_ID/view
  const patterns = [
    /\/document\/d\/([a-zA-Z0-9_-]+)/,
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

// =============================================================================
// System Prompt for AI Responses
// =============================================================================

const RESPONSE_SYSTEM_PROMPT =
  `You are an expert at drafting professional responses to document comments.

Your responses should:
1. Address the commenter's concern directly and specifically
2. Be concise but complete (typically 1-3 sentences)
3. Match the appropriate tone for the context
4. Be actionable when applicable
5. Acknowledge valid points before disagreeing

If the user has provided guidelines, prioritize following those.

Return a JSON object with:
- suggestedResponse: The response text to post as a reply
- tone: One of "professional", "friendly", "direct", or "empathetic"
- reasoning: Brief explanation of why this response approach was chosen (1 sentence)

JSON only.`;

// =============================================================================
// Handlers
// =============================================================================

// Toggle expanded comment
const toggleExpand = handler<
  unknown,
  { expandedCommentId: Writable<string | null>; commentId: string }
>((_, { expandedCommentId, commentId }) => {
  const current = expandedCommentId.get();
  expandedCommentId.set(current === commentId ? null : commentId);
});

// Toggle global prompt visibility
const toggleGlobalPrompt = handler<
  unknown,
  { showGlobalPrompt: Writable<boolean> }
>((_, { showGlobalPrompt }) => {
  showGlobalPrompt.set(!showGlobalPrompt.get());
});

// Fetch comments from Google Drive API
const fetchComments = handler<
  unknown,
  {
    docUrl: Writable<string>;
    auth: Writable<Auth>;
    comments: Writable<GoogleComment[]>;
    docContent: Writable<string>;
    isFetching: Writable<boolean>;
    lastError: Writable<string | null>;
  }
>(async (_, { docUrl, auth, comments, docContent, isFetching, lastError }) => {
  const url = docUrl.get();
  if (!url) {
    lastError.set("Please enter a Google Doc URL");
    return;
  }

  const fileId = extractFileId(url);
  if (!fileId) {
    lastError.set("Could not extract file ID from URL");
    return;
  }

  const token = auth.get()?.token;
  if (!token) {
    lastError.set("Please authenticate with Google first");
    return;
  }

  isFetching.set(true);
  lastError.set(null);

  try {
    const client = new GoogleDocsClient(token);

    // Fetch comments
    const allComments = await client.listComments(fileId);
    // Filter to only unresolved comments
    const openComments = allComments.filter((c) => !c.resolved);
    comments.set(openComments);

    // Also fetch doc content for context
    try {
      const content = await client.getDocContent(fileId);
      docContent.set(content);
    } catch (e) {
      console.warn("[fetchComments] Could not fetch doc content:", e);
      // Non-fatal - we can still work with comments
    }
  } catch (e: any) {
    console.error("[fetchComments] Error:", e);
    lastError.set(e.message || "Failed to fetch comments");
  } finally {
    isFetching.set(false);
  }
});

// Regenerate AI response for a comment (bump nonce)
const regenerateResponse = handler<
  unknown,
  { commentStates: Writable<Record<string, CommentState>>; commentId: string }
>((_, { commentStates, commentId }) => {
  const current = commentStates.get() ?? {};
  const state = current[commentId] ?? { regenerateNonce: 0, status: "pending" };
  commentStates.set({
    ...current,
    [commentId]: {
      ...state,
      regenerateNonce: state.regenerateNonce + 1,
      status: "pending",
    },
  });
});

// Prepare a reply action - sets pendingAction for trusted confirmation
const prepareReply = handler<
  unknown,
  {
    docUrl: Writable<string>;
    comments: Writable<GoogleComment[]>;
    commentId: string;
    responseText: string;
    resolve: boolean;
    pendingAction: Writable<PendingCommentAction | null>;
  }
>((_, {
  docUrl,
  comments,
  commentId,
  responseText,
  resolve,
  pendingAction,
}) => {
  const url = docUrl.get();
  const fileId = extractFileId(url);
  if (!fileId) {
    console.error("[prepareReply] Invalid document URL");
    return;
  }

  // Find the comment to get context for the confirmation UI
  const commentsList = comments.get() ?? [];
  const comment = commentsList.find((c: GoogleComment) => c.id === commentId);
  if (!comment) {
    console.error("[prepareReply] Comment not found");
    return;
  }

  // Set pending action - this will trigger the confirmation UI
  pendingAction.set({
    type: resolve ? "reply-resolve" : "reply",
    docUrl: url,
    fileId,
    commentId,
    commentAuthor: comment.author.displayName,
    commentContent: comment.content,
    quotedText: comment.quotedFileContent?.value,
    responseText,
  });
});

// Skip a comment (mark as skipped, collapse)
const skipComment = handler<
  unknown,
  {
    commentId: string;
    commentStates: Writable<Record<string, CommentState>>;
    expandedCommentId: Writable<string | null>;
  }
>((_, { commentId, commentStates, expandedCommentId }) => {
  const current = commentStates.get() ?? {};
  commentStates.set({
    ...current,
    [commentId]: {
      ...(current[commentId] ?? { regenerateNonce: 0 }),
      status: "skipped",
    },
  });
  expandedCommentId.set(null);
});

// =============================================================================
// Pattern
// =============================================================================

export default pattern<Input, Output>(
  ({
    docUrl,
    globalPrompt,
    comments,
    docContent,
    commentStates,
    expandedCommentId,
    isFetching,
    showGlobalPrompt,
    lastError,
    pendingAction,
    isExecuting,
  }) => {
    // Save cell references before entering reactive contexts
    const docUrlCell = docUrl;
    const globalPromptCell = globalPrompt;
    const commentsCell = comments;
    const docContentCell = docContent;
    const commentStatesCell = commentStates;
    const expandedCommentIdCell = expandedCommentId;
    const isFetchingCell = isFetching;
    const showGlobalPromptCell = showGlobalPrompt;
    const lastErrorCell = lastError;
    const pendingActionCell = pendingAction;
    const isExecutingCell = isExecuting;

    // Auth via createGoogleAuth utility (requires Drive and Docs scopes)
    const {
      auth,
      authInfo,
      fullUI: authFullUI,
      isReady: isAuthenticated,
      currentEmail: _currentEmail, // Prefixed with _ as not currently used in UI
    } = createGoogleAuth({
      requiredScopes: ["drive", "docs"] as ScopeKey[],
    });

    // Fetch button disabled when not authenticated or fetching
    // Prefixed with _ as not currently used - preserved for potential future UI binding
    const _fetchButtonDisabled = derive(
      [isAuthenticated, isFetchingCell],
      ([authenticated, fetching]: [boolean, boolean]) =>
        !authenticated || fetching,
    );

    // Open comment count
    const openCommentCount = computed(() => {
      const c = commentsCell.get() ?? [];
      return c.length;
    });

    // ==========================================================================
    // Per-Comment AI Generation
    // ==========================================================================

    // Generate AI responses for expanded comments
    // We use a single generateObject that only fires when a comment is expanded
    const currentExpandedPrompt = computed(() => {
      const expId = expandedCommentIdCell.get();
      if (!expId) return "";

      const commentsList = commentsCell.get() ?? [];
      const expandedComment = commentsList.find((c: GoogleComment) =>
        c.id === expId
      );
      if (!expandedComment) return "";

      const parts: string[] = [];

      // Global guidance
      const guidance = globalPromptCell.get();
      if (guidance && guidance.trim()) {
        parts.push(`## Response Guidelines\n${guidance}`);
      }

      // Document context (truncated)
      const content = docContentCell.get() ?? "";
      if (content && content.trim()) {
        parts.push(`## Document Context (excerpt)\n${content.slice(0, 1500)}`);
      }

      // Comment details
      parts.push(`## Comment to Respond To`);
      parts.push(`Author: ${expandedComment.author.displayName}`);

      if (expandedComment.quotedFileContent?.value) {
        parts.push(
          `Quoted text from document: "${expandedComment.quotedFileContent.value}"`,
        );
      }

      parts.push(`Comment: "${expandedComment.content}"`);

      // Existing replies for context
      if (expandedComment.replies && expandedComment.replies.length > 0) {
        parts.push(
          `\n## Existing Replies (${expandedComment.replies.length}):`,
        );
        for (const reply of expandedComment.replies) {
          parts.push(`- ${reply.author.displayName}: "${reply.content}"`);
        }
      }

      // Regeneration nonce for cache-busting
      const states = commentStatesCell.get() ?? {};
      const state = states[expId];
      if (state?.regenerateNonce > 0) {
        parts.push(`\n[Generation attempt: ${state.regenerateNonce}]`);
      }

      return parts.filter(Boolean).join("\n\n");
    });

    const aiResponse = generateObject<AIResponseSuggestion>({
      model: "anthropic:claude-sonnet-4-5",
      system: RESPONSE_SYSTEM_PROMPT,
      prompt: currentExpandedPrompt,
    });

    // ==========================================================================
    // UI
    // ==========================================================================

    // Auth status values come from authInfo computed (single source of truth)

    // Pre-compute all comment data with expansion and state info
    // This creates a single reactive computation that updates when inputs change
    // CRITICAL: Deep-copy all nested data to plain values to avoid $alias issues in render
    const commentsWithState = computed(() => {
      const commentsList = commentsCell.get() ?? [];
      const expandedId = expandedCommentIdCell.get();
      const states = commentStatesCell.get() ?? {};

      return commentsList.map((comment: GoogleComment) => ({
        id: comment.id,
        content: comment.content,
        createdTime: comment.createdTime,
        resolved: comment.resolved,
        author: {
          displayName: comment.author?.displayName ?? "",
          photoLink: comment.author?.photoLink ?? "",
          emailAddress: comment.author?.emailAddress ?? "",
        },
        quotedFileContent: comment.quotedFileContent
          ? {
            value: comment.quotedFileContent.value ?? "",
            mimeType: comment.quotedFileContent.mimeType ?? "",
          }
          : null,
        // Deep-copy replies array
        replies: (comment.replies ?? []).map((reply) => ({
          id: reply.id,
          content: reply.content,
          createdTime: reply.createdTime,
          action: reply.action,
          author: {
            displayName: reply.author?.displayName ?? "",
            photoLink: reply.author?.photoLink ?? "",
            emailAddress: reply.author?.emailAddress ?? "",
          },
        })),
        // Computed fields
        isExpanded: expandedId === comment.id,
        state: states[comment.id] ?? null,
        formattedDate: formatCommentDate(comment.createdTime),
        replyCount: (comment.replies ?? []).length,
      }));
    });

    // ==========================================================================
    // Pre-computed values for Confirmation UI
    // Single computed returning object - idiomatic pattern per CELLS_AND_REACTIVITY.md
    // ==========================================================================

    // Boolean computed for ifElse condition
    const hasAction = computed(() => pendingActionCell.get() !== null);
    const hasLastError = computed(() => !!lastErrorCell.get());

    // Single computed for all action display values
    const actionDetails = computed(() => {
      const a = pendingActionCell.get();
      if (!a) return null;

      const docUrlShort = a.docUrl
        ? a.docUrl.replace(/https?:\/\/docs\.google\.com\/document\/d\//, "")
          .slice(0, 30) + "..."
        : "Unknown document";

      return {
        typeLabel: a.type === "reply-resolve" ? "Reply and Resolve" : "Reply",
        docUrlShort,
        commentAuthor: a.commentAuthor ?? "",
        quotedText: a.quotedText ?? "",
        hasQuotedText: !!a.quotedText,
        commentContent: a.commentContent ?? "",
        responseText: a.responseText ?? "",
      };
    });

    return {
      [NAME]: "Google Docs Comment Orchestrator",
      [UI]: (
        <ct-screen>
          {/* Header */}
          <ct-vstack slot="header" gap={1}>
            <ct-hstack align="center" justify="between">
              <ct-heading level={4}>Google Docs Comments</ct-heading>
              <ct-hstack align="center" gap={1}>
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    backgroundColor: authInfo.statusDotColor,
                  }}
                />
                <span style={{ fontSize: "12px", color: "#666" }}>
                  {authInfo.statusText}
                </span>
              </ct-hstack>
            </ct-hstack>
          </ct-vstack>

          {/* Main content */}
          <ct-vstack gap="1" style="padding: 16px;">
            {/* Auth UI from utility - handles all states including scope warnings */}
            {authFullUI}

            {/* Doc URL input */}
            <ct-card>
              <ct-vstack gap={1}>
                <label style={{ fontSize: "13px", fontWeight: 500 }}>
                  Google Doc URL
                </label>
                <ct-hstack gap={1}>
                  <ct-input
                    $value={docUrl}
                    placeholder="https://docs.google.com/document/d/..."
                    style="flex: 1;"
                  />
                  {ifElse(
                    isAuthenticated,
                    <ct-button
                      variant="primary"
                      type="button"
                      disabled={isFetchingCell}
                      onClick={fetchComments({
                        docUrl: docUrlCell,
                        auth,
                        comments: commentsCell,
                        docContent: docContentCell,
                        isFetching: isFetchingCell,
                        lastError: lastErrorCell,
                      })}
                    >
                      {ifElse(
                        computed(() => isFetchingCell.get() === true),
                        <ct-hstack align="center" gap={1}>
                          <ct-loader />
                          <span>Fetching...</span>
                        </ct-hstack>,
                        "Fetch Comments",
                      )}
                    </ct-button>,
                    null,
                  )}
                </ct-hstack>

                {/* Error display */}
                {ifElse(
                  computed(() => !!lastError),
                  <div
                    style={{
                      marginTop: "8px",
                      padding: "8px 12px",
                      backgroundColor: "var(--ct-color-red-50, #fef2f2)",
                      border: "1px solid var(--ct-color-red-200, #fecaca)",
                      borderRadius: "6px",
                      fontSize: "12px",
                      color: "var(--ct-color-red-700, #b91c1c)",
                    }}
                  >
                    {lastError}
                  </div>,
                  null,
                )}
              </ct-vstack>
            </ct-card>

            {/* Global Prompt (collapsible) */}
            <ct-card>
              <ct-hstack
                align="center"
                justify="between"
                style="cursor: pointer;"
                onClick={toggleGlobalPrompt({
                  showGlobalPrompt: showGlobalPromptCell,
                })}
              >
                <span style={{ fontWeight: 500, fontSize: "13px" }}>
                  Response Guidelines
                  <span
                    style={{
                      fontWeight: 400,
                      color: "#888",
                      marginLeft: "8px",
                    }}
                  >
                    (optional)
                  </span>
                </span>
                <span style={{ color: "#888" }}>
                  {ifElse(showGlobalPrompt, "\u25BC", "\u25B6")}
                </span>
              </ct-hstack>

              {ifElse(
                showGlobalPrompt,
                <div style={{ marginTop: "12px" }}>
                  <ct-input
                    $value={globalPrompt}
                    placeholder="E.g., Be concise. Use formal language. Always acknowledge valid concerns before disagreeing."
                    style="width: 100%;"
                  />
                  <div
                    style={{
                      fontSize: "11px",
                      color: "#888",
                      marginTop: "4px",
                    }}
                  >
                    These guidelines will be included in all AI-generated
                    responses.
                  </div>
                </div>,
                null,
              )}
            </ct-card>

            {/* Comments List */}
            <ct-card style="flex: 1; overflow: hidden; display: flex; flex-direction: column;">
              <ct-hstack
                align="center"
                justify="between"
                style="margin-bottom: 12px;"
              >
                <span style={{ fontWeight: 600 }}>
                  Comments ({openCommentCount})
                </span>
              </ct-hstack>

              {/* Comments list - using pre-computed values, no reactive deps in map */}
              <ct-vscroll flex showScrollbar fadeEdges>
                {commentsWithState.map((item) => (
                  <div
                    style={{
                      borderRadius: "8px",
                      border: "1px solid var(--ct-color-border, #e0e0e0)",
                      marginBottom: "8px",
                      overflow: "hidden",
                      backgroundColor: item.state?.status === "skipped"
                        ? "var(--ct-color-surface-secondary, #f5f5f5)"
                        : "white",
                      opacity: item.state?.status === "skipped" ? 0.6 : 1,
                    }}
                  >
                    {/* Header (always visible, clickable) */}
                    <div
                      style={{
                        padding: "12px 16px",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "12px",
                      }}
                      onClick={toggleExpand({
                        expandedCommentId: expandedCommentIdCell,
                        commentId: item.id,
                      })}
                    >
                      {/* Expand indicator */}
                      <span
                        style={{
                          fontSize: "12px",
                          color: "#666",
                          marginTop: "2px",
                        }}
                      >
                        {item.isExpanded ? "\u25BC" : "\u25B6"}
                      </span>

                      {/* Content */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {/* Author and date */}
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: "4px",
                          }}
                        >
                          <span style={{ fontWeight: 600, fontSize: "14px" }}>
                            {item.author.displayName}
                          </span>
                          <span style={{ fontSize: "12px", color: "#888" }}>
                            {item.formattedDate}
                          </span>
                        </div>

                        {/* Quoted text preview */}
                        {item.quotedFileContent?.value && (
                          <div
                            style={{
                              fontSize: "12px",
                              color: "#666",
                              fontStyle: "italic",
                              marginBottom: "4px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            "{item.quotedFileContent.value.slice(0, 60)}
                            {item.quotedFileContent.value.length > 60
                              ? "..."
                              : ""}"
                          </div>
                        )}

                        {/* Comment preview */}
                        <div
                          style={{
                            fontSize: "13px",
                            color: "#333",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: item.isExpanded ? "normal" : "nowrap",
                          }}
                        >
                          {item.content}
                        </div>

                        {/* Reply count badge - use ifElse to avoid $alias leakage */}
                        {ifElse(
                          item.replyCount > 0,
                          <span
                            style={{
                              display: "inline-block",
                              marginTop: "4px",
                              fontSize: "11px",
                              padding: "2px 6px",
                              borderRadius: "10px",
                              backgroundColor:
                                "var(--ct-color-surface-secondary, #f0f0f0)",
                              color: "#666",
                            }}
                          >
                            {item.replyCount}{" "}
                            {ifElse(item.replyCount === 1, "reply", "replies")}
                          </span>,
                          null,
                        )}
                      </div>
                    </div>

                    {/* Expanded content - use ifElse to avoid conditional && which can leak reactive values */}
                    {ifElse(
                      item.isExpanded,
                      <div
                        style={{
                          borderTop:
                            "1px solid var(--ct-color-border, #e0e0e0)",
                          padding: "16px",
                          backgroundColor:
                            "var(--ct-color-surface-secondary, #fafafa)",
                        }}
                      >
                        {/* Full quoted text - use ifElse for conditional content */}
                        {ifElse(
                          item.quotedFileContent !== null,
                          <div
                            style={{
                              padding: "12px",
                              marginBottom: "12px",
                              borderLeft:
                                "3px solid var(--ct-color-blue-500, #3b82f6)",
                              backgroundColor: "white",
                              borderRadius: "4px",
                            }}
                          >
                            <div
                              style={{
                                fontSize: "11px",
                                color: "#888",
                                marginBottom: "4px",
                              }}
                            >
                              Highlighted text:
                            </div>
                            <div
                              style={{ fontSize: "13px", fontStyle: "italic" }}
                            >
                              "{item.quotedFileContent?.value ?? ""}"
                            </div>
                          </div>,
                          null,
                        )}

                        {/* Existing replies - use ifElse for conditional content */}
                        {ifElse(
                          item.replies.length > 0,
                          <div>
                            <div
                              style={{
                                fontSize: "12px",
                                fontWeight: 600,
                                marginBottom: "8px",
                                color: "#666",
                              }}
                            >
                              Previous replies:
                            </div>
                            {item.replies.map((reply) => (
                              <div
                                style={{
                                  padding: "8px 12px",
                                  marginBottom: "4px",
                                  borderLeft: "2px solid #ddd",
                                  backgroundColor: "white",
                                  borderRadius: "4px",
                                  fontSize: "13px",
                                }}
                              >
                                <span style={{ fontWeight: 500 }}>
                                  {reply.author.displayName}:
                                </span>{" "}
                                {reply.content}
                              </div>
                            ))}
                          </div>,
                          null,
                        )}
                      </div>,
                      null,
                    )}
                  </div>
                ))}
              </ct-vscroll>

              {/* AI Response Panel - OUTSIDE map, at pattern body level */}
              {ifElse(
                computed(() => !!expandedCommentIdCell.get()),
                <div
                  style={{
                    padding: "16px",
                    backgroundColor: "var(--ct-color-green-50, #f0fdf4)",
                    borderRadius: "8px",
                    border: "1px solid var(--ct-color-green-200, #bbf7d0)",
                    marginTop: "12px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "12px",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "14px",
                        fontWeight: 600,
                        color: "var(--ct-color-green-700, #15803d)",
                      }}
                    >
                      AI Suggested Response
                    </span>
                    <ct-button
                      variant="pill"
                      type="button"
                      title="Generate a new response"
                      onClick={regenerateResponse({
                        commentStates: commentStatesCell,
                        commentId: computed(() =>
                          expandedCommentIdCell.get() ?? ""
                        ),
                      })}
                    >
                      Regenerate
                    </ct-button>
                  </div>

                  {/* Response content - reads aiResponse directly at pattern body level */}
                  <div
                    style={{
                      fontSize: "14px",
                      lineHeight: 1.6,
                      marginBottom: "16px",
                    }}
                  >
                    {ifElse(
                      aiResponse.pending,
                      <span style={{ color: "#888" }}>
                        Generating response...
                      </span>,
                      ifElse(
                        aiResponse.result?.suggestedResponse,
                        <div>{aiResponse.result?.suggestedResponse}</div>,
                        <span style={{ color: "#888" }}>
                          Expand a comment to generate an AI response
                        </span>,
                      ),
                    )}
                  </div>

                  {/* Action Buttons */}
                  <div
                    style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}
                  >
                    <ct-button
                      variant="primary"
                      type="button"
                      disabled={computed(() => aiResponse.pending ||
                        !aiResponse.result?.suggestedResponse
                      )}
                      onClick={prepareReply({
                        docUrl: docUrlCell,
                        comments: commentsCell,
                        commentId: computed(() =>
                          expandedCommentIdCell.get() ?? ""
                        ),
                        responseText: computed(() =>
                          aiResponse.result?.suggestedResponse ?? ""
                        ),
                        resolve: false,
                        pendingAction: pendingActionCell,
                      })}
                    >
                      Reply
                    </ct-button>
                    <ct-button
                      variant="secondary"
                      type="button"
                      disabled={computed(() =>
                        aiResponse.pending ||
                        !aiResponse.result?.suggestedResponse
                      )}
                      onClick={prepareReply({
                        docUrl: docUrlCell,
                        comments: commentsCell,
                        commentId: computed(() =>
                          expandedCommentIdCell.get() ?? ""
                        ),
                        responseText: computed(() =>
                          aiResponse.result?.suggestedResponse ?? ""
                        ),
                        resolve: true,
                        pendingAction: pendingActionCell,
                      })}
                    >
                      Reply + Resolve
                    </ct-button>
                    <ct-button
                      variant="ghost"
                      type="button"
                      onClick={skipComment({
                        commentId: computed(() =>
                          expandedCommentIdCell.get() ?? ""
                        ),
                        commentStates: commentStatesCell,
                        expandedCommentId: expandedCommentIdCell,
                      })}
                    >
                      Skip
                    </ct-button>
                  </div>
                </div>,
                <div
                  style={{
                    padding: "16px",
                    textAlign: "center",
                    color: "#888",
                    fontSize: "14px",
                    marginTop: "12px",
                  }}
                >
                  Select a comment to generate an AI response
                </div>,
              )}
            </ct-card>

            {/* Trusted Confirmation Component - renders inline when pendingAction is set */}
            {/* TRUST BOUNDARY: executeAction lives in google-docs-comment-confirm.tsx */}
            {ifElse(
              hasAction,
              <ct-card
                style={{
                  padding: "20px",
                  marginTop: "16px",
                  border: "2px solid #f59e0b",
                  backgroundColor: "#fffbeb",
                  borderRadius: "8px",
                }}
              >
                {/* Header */}
                <ct-hstack
                  align="center"
                  gap={2}
                  style={{ marginBottom: "16px" }}
                >
                  <span style={{ fontSize: "24px" }}>⚠️</span>
                  <ct-heading level={4}>
                    Confirm Action on Google Docs
                  </ct-heading>
                </ct-hstack>

                {/* Action type badge */}
                <div
                  style={{
                    display: "inline-block",
                    padding: "4px 12px",
                    backgroundColor: "#fef3c7",
                    border: "1px solid #f59e0b",
                    borderRadius: "4px",
                    fontSize: "14px",
                    fontWeight: "600",
                    marginBottom: "12px",
                  }}
                >
                  {actionDetails?.typeLabel}
                </div>

                {/* Context info */}
                <ct-vstack gap={2} style={{ marginBottom: "16px" }}>
                  <div style={{ fontSize: "14px", color: "#666" }}>
                    <strong>Document:</strong> {actionDetails?.docUrlShort}
                  </div>
                  <div style={{ fontSize: "14px", color: "#666" }}>
                    <strong>Comment by:</strong> {actionDetails?.commentAuthor}
                  </div>
                  {ifElse(
                    computed(() => !!actionDetails?.hasQuotedText),
                    <div
                      style={{
                        fontSize: "14px",
                        color: "#666",
                        padding: "8px",
                        backgroundColor: "#fff",
                        borderLeft: "3px solid #ddd",
                        fontStyle: "italic",
                      }}
                    >
                      "{actionDetails?.quotedText}"
                    </div>,
                    null,
                  )}
                  <div style={{ fontSize: "14px", color: "#333" }}>
                    <strong>Original comment:</strong>{" "}
                    {actionDetails?.commentContent}
                  </div>
                </ct-vstack>

                {/* Your response */}
                <div
                  style={{
                    padding: "12px",
                    backgroundColor: "#fff",
                    border: "1px solid #ddd",
                    borderRadius: "4px",
                    marginBottom: "16px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#666",
                      marginBottom: "4px",
                      fontWeight: "600",
                    }}
                  >
                    Your response:
                  </div>
                  <div style={{ fontSize: "14px" }}>
                    {actionDetails?.responseText}
                  </div>
                </div>

                {/* Error display */}
                {ifElse(
                  hasLastError,
                  <div
                    style={{
                      padding: "12px",
                      backgroundColor: "#fef2f2",
                      border: "1px solid #ef4444",
                      borderRadius: "4px",
                      marginBottom: "16px",
                      color: "#dc2626",
                      fontSize: "14px",
                    }}
                  >
                    {lastErrorCell}
                  </div>,
                  null,
                )}

                {/* Action buttons */}
                <ct-hstack gap={2} justify="end">
                  <ct-button
                    variant="secondary"
                    type="button"
                    disabled={isExecutingCell}
                    onClick={cancelAction({ action: pendingActionCell })}
                  >
                    Cancel
                  </ct-button>
                  <ct-button
                    variant="primary"
                    type="button"
                    disabled={isExecutingCell}
                    onClick={executeAction({
                      action: pendingActionCell,
                      auth,
                      comments: commentsCell,
                      commentStates: commentStatesCell,
                      expandedCommentId: expandedCommentIdCell,
                      lastError: lastErrorCell,
                      isExecuting: isExecutingCell,
                    })}
                  >
                    {ifElse(
                      isExecutingCell,
                      "Posting...",
                      <span>✓ Post {actionDetails?.typeLabel}</span>,
                    )}
                  </ct-button>
                </ct-hstack>
              </ct-card>,
              null,
            )}
          </ct-vstack>
        </ct-screen>
      ),
      docUrl,
      comments,
      openCommentCount,
    };
  },
);
