/**
 * Test Pattern: GoogleDocsCommentOrchestrator
 *
 * Verifies comment fetching exposes an inactive UI state until Google auth is
 * ready.
 *
 * Run: deno task cf test packages/patterns/google/core/experimental/google-docs-comment-orchestrator.test.tsx --root packages/patterns --verbose
 */
import { assert, pattern, UI, Writable } from "commonfabric";
import { hasText } from "../../../test/vnode-helpers.ts";
import GoogleDocsCommentOrchestrator from "./google-docs-comment-orchestrator.tsx";

type GoogleCommentForTest = {
  id: string;
  author: { displayName: string; photoLink?: string; emailAddress?: string };
  content: string;
  createdTime: string;
  resolved: boolean;
};

export default pattern(() => {
  const lastError = new Writable<string | null>(null);
  const orchestrator = GoogleDocsCommentOrchestrator({
    docUrl: new Writable("https://docs.google.com/document/d/example/edit"),
    globalPrompt: new Writable(""),
    comments: new Writable<GoogleCommentForTest[]>([]),
    docContent: new Writable(""),
    commentStates: new Writable({}),
    expandedCommentId: new Writable<string | null>(null),
    isFetching: new Writable(false),
    showGlobalPrompt: new Writable(false),
    lastError,
    pendingAction: new Writable(null),
    isExecuting: new Writable(false),
  });

  const assert_fetch_waits_for_auth = assert(() =>
    hasText(orchestrator[UI], "Connect Google")
  );

  const assert_auth_ui_explains_required_scopes = assert(() =>
    hasText(orchestrator[UI], "Connect Your Google Account") &&
    hasText(
      orchestrator[UI],
      "Drive (read/write files & comments), Docs (read document content)",
    )
  );

  const assert_no_comments_initially = assert(() =>
    orchestrator.openCommentCount === 0 &&
    orchestrator.comments.length === 0
  );

  return {
    tests: [
      { assertion: assert_fetch_waits_for_auth },
      { assertion: assert_auth_ui_explains_required_scopes },
      { assertion: assert_no_comments_initially },
    ],
    orchestrator,
  };
});
