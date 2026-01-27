/// <cts-enable />
import {
  Cell,
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  UI,
} from "commontools";

// Import Google Auth utility
import {
  createGoogleAuth,
  type ScopeKey,
} from "../core/util/google-auth-manager.tsx";

// Import markdown conversion utilities
import {
  convertDocToMarkdown,
  extractDocTitle,
} from "../core/util/google-docs-markdown.ts";

// Import Google Docs client
import {
  extractFileId,
  type GoogleComment,
  GoogleDocsClient,
} from "../core/util/google-docs-client.ts";

// Import Note pattern for "Save as Note" feature
// NOTE: This requires deploying with --root packages/patterns to resolve the import
import Note from "../../notes/note.tsx";

// =============================================================================
// SETUP REQUIREMENTS
// =============================================================================
//
// This pattern requires Google OAuth with specific scopes and APIs enabled:
//
// 1. GOOGLE AUTH CHARM
//    - Create and favorite a Google Auth charm with these scopes enabled:
//      - Drive (read/write files & comments) - for fetching comments
//      - Docs (read document content) - for fetching document content
//
// 2. GOOGLE CLOUD CONSOLE
//    The OAuth project must have these APIs enabled:
//    - Google Drive API (usually enabled by default)
//    - Google Docs API (must be explicitly enabled)
//
// =============================================================================

// =============================================================================
// Types
// =============================================================================

interface Input {
  docUrl?: Cell<Default<string, "">>;
  markdown?: Cell<Default<string, "">>;
  docTitle?: Cell<Default<string, "">>;
  isFetching?: Cell<Default<boolean, false>>;
  lastError?: Cell<Default<string | null, null>>;
  includeComments?: Cell<Default<boolean, true>>;
  embedImages?: Cell<Default<boolean, false>>;
}

/** Google Docs Markdown Importer. Import Google Docs as Markdown with comments. #googleDocsImporter */
interface Output {
  docUrl: string;
  markdown: string;
  docTitle: string;
}

// =============================================================================
// Handlers
// =============================================================================

// Fetch document and convert to markdown
const importDocument = handler<
  unknown,
  {
    docUrl: Cell<string>;
    auth: Cell<unknown>;
    markdown: Cell<string>;
    docTitle: Cell<string>;
    isFetching: Cell<boolean>;
    lastError: Cell<string | null>;
    includeComments: Cell<boolean>;
    embedImages: Cell<boolean>;
  }
>(
  async (
    _,
    {
      docUrl,
      auth,
      markdown,
      docTitle,
      isFetching,
      lastError,
      includeComments,
      embedImages,
    },
  ) => {
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

    const authData = auth.get() as { token?: string } | null;
    const token = authData?.token;
    if (!token) {
      lastError.set("Please authenticate with Google first");
      return;
    }

    isFetching.set(true);
    lastError.set(null);

    try {
      // Create client with auth Cell for automatic token refresh
      const client = new GoogleDocsClient(auth as Cell<any>, {
        debugMode: true,
      });

      // Fetch document content
      const doc = await client.getDocument(fileId);
      const title = extractDocTitle(doc);
      docTitle.set(title);

      // Fetch comments if enabled (client handles pagination and filtering)
      let comments: GoogleComment[] = [];
      if (includeComments.get()) {
        try {
          comments = await client.listComments(
            fileId,
            false, /* includeResolved */
          );
        } catch (e) {
          console.warn("[importDocument] Could not fetch comments:", e);
          // Non-fatal - we can still convert without comments
        }
      }

      // Convert to markdown
      const md = await convertDocToMarkdown(doc, comments, {
        includeComments: includeComments.get(),
        embedImages: embedImages.get(),
        token,
      });

      markdown.set(md);
    } catch (e: unknown) {
      console.error("[importDocument] Error:", e);
      const errorMessage = e instanceof Error
        ? e.message
        : "Failed to import document";
      lastError.set(errorMessage);
    } finally {
      isFetching.set(false);
    }
  },
);

// Save as Note charm
const saveAsNote = handler<
  unknown,
  { markdown: Cell<string>; docTitle: Cell<string> }
>((_, { markdown, docTitle }) => {
  const md = markdown.get();
  const title = docTitle.get() || "Imported Document";

  if (!md) {
    return;
  }

  // Create and navigate to a new Note charm with the imported content
  return navigateTo(Note({ title, content: md }));
});

// Toggle include comments
const toggleComments = handler<unknown, { includeComments: Cell<boolean> }>(
  (_, { includeComments }) => {
    includeComments.set(!includeComments.get());
  },
);

// Toggle embed images
const toggleEmbedImages = handler<unknown, { embedImages: Cell<boolean> }>(
  (_, { embedImages }) => {
    embedImages.set(!embedImages.get());
  },
);

// =============================================================================
// Pattern
// =============================================================================

export default pattern<Input, Output>(
  (
    {
      docUrl,
      markdown,
      docTitle,
      isFetching,
      lastError,
      includeComments,
      embedImages,
    },
  ) => {
    // Save cell references
    const docUrlCell = docUrl;
    const markdownCell = markdown;
    const docTitleCell = docTitle;
    const isFetchingCell = isFetching;
    const lastErrorCell = lastError;
    const includeCommentsCell = includeComments;
    const embedImagesCell = embedImages;

    // Auth via createGoogleAuth utility (requires Drive and Docs scopes)
    const {
      auth,
      authInfo,
      fullUI: authFullUI,
      isReady: isAuthenticated,
    } = createGoogleAuth({
      requiredScopes: ["drive", "docs"] as ScopeKey[],
    });

    // Has markdown content
    const hasMarkdown = computed(() => {
      const md = markdownCell.get();
      return md && md.trim().length > 0;
    });

    // Has error
    const hasError = computed(() => !!lastErrorCell.get());

    // Computed name based on doc title
    const charmName = computed(() => {
      const title = docTitleCell.get();
      return title ? `Import: ${title}` : "Google Docs Importer";
    });

    return {
      [NAME]: charmName,
      [UI]: (
        <ct-screen>
          {/* Header */}
          <ct-vstack slot="header" gap={1}>
            <ct-hstack align="center" justify="between">
              <ct-heading level={4}>Google Docs Markdown Importer</ct-heading>
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
            {/* Auth UI */}
            {authFullUI}

            {/* Document URL input */}
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
                      onClick={importDocument({
                        docUrl: docUrlCell,
                        auth,
                        markdown: markdownCell,
                        docTitle: docTitleCell,
                        isFetching: isFetchingCell,
                        lastError: lastErrorCell,
                        includeComments: includeCommentsCell,
                        embedImages: embedImagesCell,
                      })}
                    >
                      {ifElse(
                        isFetchingCell,
                        <ct-hstack align="center" gap={1}>
                          <ct-loader />
                          <span>Importing...</span>
                        </ct-hstack>,
                        "Import",
                      )}
                    </ct-button>,
                    null,
                  )}
                </ct-hstack>

                {/* Options */}
                <ct-hstack gap={3} style={{ marginTop: "8px" }}>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      fontSize: "13px",
                      cursor: "pointer",
                    }}
                    onClick={toggleComments({
                      includeComments: includeCommentsCell,
                    })}
                  >
                    <input
                      type="checkbox"
                      checked={includeCommentsCell}
                      style={{ cursor: "pointer" }}
                    />
                    Include open comments
                  </label>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      fontSize: "13px",
                      cursor: "pointer",
                    }}
                    onClick={toggleEmbedImages({
                      embedImages: embedImagesCell,
                    })}
                  >
                    <input
                      type="checkbox"
                      checked={embedImagesCell}
                      style={{ cursor: "pointer" }}
                    />
                    Embed images as base64
                  </label>
                </ct-hstack>

                {/* Error display */}
                {ifElse(
                  hasError,
                  <div
                    style={{
                      marginTop: "8px",
                      padding: "8px 12px",
                      backgroundColor: "var(--ct-color-red-50, #fef2f2)",
                      border: "1px solid var(--ct-color-red-200, #fecaca)",
                      borderRadius: "6px",
                      fontSize: "12px",
                      color: "var(--ct-color-red-700, #b91c1c)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {lastErrorCell}
                  </div>,
                  null,
                )}
              </ct-vstack>
            </ct-card>

            {/* Markdown preview */}
            {ifElse(
              hasMarkdown,
              <ct-card style="flex: 1; display: flex; flex-direction: column;">
                <ct-hstack
                  align="center"
                  justify="between"
                  style={{ marginBottom: "12px" }}
                >
                  <span style={{ fontWeight: 600 }}>
                    Preview: {docTitleCell}
                  </span>
                  <ct-hstack gap={1}>
                    <ct-copy-button text={markdownCell} variant="secondary">
                      Copy to Clipboard
                    </ct-copy-button>
                    <ct-button
                      variant="primary"
                      type="button"
                      onClick={saveAsNote({
                        markdown: markdownCell,
                        docTitle: docTitleCell,
                      })}
                    >
                      Save as Note
                    </ct-button>
                  </ct-hstack>
                </ct-hstack>

                <ct-vscroll flex showScrollbar fadeEdges>
                  <div
                    style={{
                      padding: "16px",
                      backgroundColor:
                        "var(--ct-color-surface-secondary, #f9fafb)",
                      borderRadius: "8px",
                      fontFamily: "monospace",
                      fontSize: "13px",
                      whiteSpace: "pre-wrap",
                      lineHeight: "1.5",
                    }}
                  >
                    {markdownCell}
                  </div>
                </ct-vscroll>
              </ct-card>,
              <ct-card>
                <div
                  style={{
                    padding: "32px",
                    textAlign: "center",
                    color: "#888",
                    fontSize: "14px",
                  }}
                >
                  {ifElse(
                    isAuthenticated,
                    "Enter a Google Doc URL and click Import to convert it to Markdown",
                    "Please authenticate with Google to import documents",
                  )}
                </div>
              </ct-card>,
            )}
          </ct-vstack>
        </ct-screen>
      ),
      docUrl,
      markdown,
      docTitle,
    };
  },
);
