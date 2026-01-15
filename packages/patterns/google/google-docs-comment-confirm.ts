/// <cts-enable />
/**
 * TRUSTED FILE - Google Docs Comment Confirmation Handlers
 *
 * NOTE: This is a utility module, not a standalone pattern.
 * It is imported by google-docs-comment-orchestrator.tsx.
 *
 * This file contains the trusted handlers and API client for Google Docs
 * comment actions. The actual side effects (API calls) happen here.
 *
 * TRUST BOUNDARY: User clicking a button that invokes executeAction
 * creates official approval for the side effect.
 *
 * Future trust policies can grant trust to this file independently
 * to assert "this action was user-approved".
 */
import { Default, handler, Writable } from "commontools";

// =============================================================================
// Types - Exported for orchestrator
// =============================================================================

type CFC<T, C extends string> = T;
type Secret<T> = CFC<T, "secret">;

export type Auth = {
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

export interface GoogleComment {
  id: string;
  author: { displayName: string; photoLink?: string; emailAddress?: string };
  content: string;
  htmlContent?: string;
  createdTime: string;
  modifiedTime?: string;
  resolved: boolean;
  quotedFileContent?: { value: string; mimeType?: string };
  anchor?: string;
  replies?: Array<{
    id: string;
    author: { displayName: string; photoLink?: string; emailAddress?: string };
    content: string;
    createdTime: string;
    action?: "resolve" | "reopen";
  }>;
}

export interface CommentState {
  regenerateNonce: number;
  status: "pending" | "generating" | "ready" | "accepted" | "skipped";
}

// =============================================================================
// Types - Pending Action
// =============================================================================

export interface PendingCommentAction {
  type: "reply" | "reply-resolve";
  docUrl: string;
  fileId: string;

  // Comment context
  commentId: string;
  commentAuthor: string;
  commentContent: string;
  quotedText?: string;

  // Action content
  responseText: string;
}

// =============================================================================
// API Client (TRUST BOUNDARY - API calls happen here)
// =============================================================================

class GoogleDocsClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
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

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401) {
        throw new Error(
          "Token expired. Please re-authenticate in your Google Auth charm.",
        );
      }
      if (res.status === 403) {
        throw new Error(
          "Access denied. You may not have permission to comment on this document.",
        );
      }
      throw new Error(`Failed to post reply: ${res.status} - ${text}`);
    }
  }
}

// =============================================================================
// Handlers (TRUST BOUNDARY - exported for use by orchestrator)
// =============================================================================

/**
 * Execute the confirmed action - THIS IS THE TRUST BOUNDARY
 *
 * User clicking the "Post Reply" button invokes this handler,
 * which executes the API call. This is the trusted side effect.
 */
export const executeAction = handler<
  unknown,
  {
    action: Writable<PendingCommentAction | null>;
    // deno-lint-ignore no-explicit-any
    auth: any; // Accepts OpaqueCell or Cell from wish()
    comments: Writable<GoogleComment[]>;
    commentStates: Writable<Record<string, CommentState>>;
    expandedCommentId: Writable<string | null>;
    lastError: Writable<string | null>;
    isExecuting: Writable<boolean>;
  }
>(async (_, {
  action,
  auth,
  comments,
  commentStates,
  expandedCommentId,
  lastError,
  isExecuting,
}) => {
  const pendingAction = action.get();
  if (!pendingAction) {
    lastError.set("No action to execute");
    return;
  }

  const token = auth?.token ?? auth?.get?.()?.token;
  if (!token) {
    lastError.set("Please authenticate with Google first");
    return;
  }

  isExecuting.set(true);
  lastError.set(null);

  try {
    const client = new GoogleDocsClient(token);
    const resolve = pendingAction.type === "reply-resolve";

    await client.createReply(
      pendingAction.fileId,
      pendingAction.commentId,
      pendingAction.responseText,
      resolve,
    );

    // Update local state - mark as accepted
    const currentStates = commentStates.get() ?? {};
    commentStates.set({
      ...currentStates,
      [pendingAction.commentId]: {
        ...(currentStates[pendingAction.commentId] ?? { regenerateNonce: 0 }),
        status: "accepted",
      },
    });

    // If resolved, remove from comments list
    if (resolve) {
      const currentComments = comments.get() ?? [];
      comments.set(
        currentComments.filter((c) => c.id !== pendingAction.commentId),
      );
    }

    // Collapse the comment and clear the action
    expandedCommentId.set(null);
    action.set(null);
  } catch (e: unknown) {
    console.error("[executeAction] Error:", e);
    const errorMessage = e instanceof Error
      ? e.message
      : "Failed to post reply";
    lastError.set(errorMessage);
  } finally {
    isExecuting.set(false);
  }
});

/**
 * Cancel the pending action
 */
export const cancelAction = handler<
  unknown,
  { action: Writable<PendingCommentAction | null> }
>((_, { action }) => {
  action.set(null);
});
