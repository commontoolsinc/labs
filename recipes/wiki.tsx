import {
  derive,
  h,
  handler,
  ifElse,
  JSONSchema,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

const WikiSchema = {
  type: "object",
  properties: {
    pages: {
      type: "object",
      additionalProperties: {
        type: "string",
      },
      default: {
        "getting-started":
          '# Getting Started\n\nWelcome to your wiki! This is your first page.\n\nYou can:\n- Edit this page using the markdown editor\n- Create new pages with the "+ New Page" button\n- Navigate between pages using the sidebar\n- Rename pages using the rename button',
      },
    },
    currentPage: {
      type: "string",
      default: "getting-started",
    },
    showRenameForm: {
      type: "boolean",
      default: false,
    },
  },
  required: ["pages", "currentPage", "showRenameForm"],
} as const satisfies JSONSchema;

const OutputSchema = WikiSchema;

// Update page content from editor
const updatePageContent = handler<
  { detail: { value: string } },
  { pages: Record<string, string>; currentPage: string }
>(
  (event, state) => {
    const content = event.detail?.value ?? "";
    state.pages[state.currentPage] = content;
  },
);

// Select a different page
const selectPage = handler<
  Record<PropertyKey, never>,
  { slug: string; currentPage: string }
>(
  (_props, state) => {
    state.currentPage = state.slug;
  },
);

// Create new page
const createPage = handler<
  Record<PropertyKey, never>,
  { pages: Record<string, string>; currentPage: string }
>(
  (_, state) => {
    const timestamp = Date.now();
    const slug = `page-${timestamp}`;
    state.pages[slug] = `# New Page\n\nStart writing your content here...`;
    state.currentPage = slug;
  },
);

// Delete current page
const deletePage = handler<
  Record<PropertyKey, never>,
  { slug: string; pages: Record<string, string>; currentPage: string }
>(
  (_props, state) => {
    const pageKeys = Object.keys(state.pages);
    if (pageKeys.length <= 1) return; // Prevent deleting last page

    delete state.pages[state.slug];

    // Switch to first available page if current page was deleted
    if (state.currentPage === state.slug) {
      state.currentPage = Object.keys(state.pages)[0];
    }
  },
);

// Update page title (creates new slug if title changed)
const updatePageTitle = handler<
  { detail: { value: string } },
  { pages: Record<string, string>; currentPage: string }
>(
  ({ detail }, state) => {
    const newSlug = detail?.value ?? "";

    if (newSlug && newSlug !== state.currentPage && newSlug.trim()) {
      // Move content to new slug
      state.pages[newSlug] = state.pages[state.currentPage];
      delete state.pages[state.currentPage];
      state.currentPage = newSlug;
    }
  },
);

// Show rename form
const showRenameFormHandler = handler<
  Record<PropertyKey, never>,
  { showRenameForm: boolean }
>(
  (_, state) => {
    state.showRenameForm = true;
  },
);

// Hide rename form
const hideRenameFormHandler = handler<
  Record<PropertyKey, never>,
  { showRenameForm: boolean }
>(
  (_, state) => {
    state.showRenameForm = false;
  },
);

// Handle rename submission
const handleRename = handler<
  { detail: { value: string } },
  {
    pages: Record<string, string>;
    currentPage: string;
    showRenameForm: boolean;
  }
>(
  ({ detail }, state) => {
    const newSlug = detail?.value?.trim() ?? "";
    if (!newSlug) return;

    if (newSlug && newSlug !== state.currentPage) {
      // Move content to new slug
      state.pages[newSlug] = state.pages[state.currentPage];
      delete state.pages[state.currentPage];
      state.currentPage = newSlug;
    }
    state.showRenameForm = false;
  },
);

// External update handler
const update = handler<
  { key: string; value: string },
  { pages: Record<string, string>; currentPage: string }
>(
  ({ key, value }, state) => {
    console.log(`Updating page ${key} with value ${value}`);
    state.pages[key] = value;
  },
);

export default recipe(
  WikiSchema,
  OutputSchema,
  ({ pages, currentPage, showRenameForm }) => {
    const pageKeys = derive(pages, (pages) => Object.keys(pages).sort());
    const currentContent = derive(
      [pages, currentPage],
      ([pages, currentPage]) => (pages as any)[currentPage as any] || "",
    );
    const canDelete = derive(pages, (pages) => Object.keys(pages).length > 1);

    return {
      [NAME]: "Wiki",
      [UI]: (
        <div style="height: 100vh; width: 100%;">
          <ct-resizable-panel-group direction="horizontal">
            {/* Sidebar Panel */}
            <ct-resizable-panel default-size="25" min-size="20" max-size="40">
              <div style="padding: 1rem; height: 100%; overflw-y: auto; background: #f8fafc; border-right: 1px solid #e2e8f0;">
                <ct-vstack gap="sm">
                  <h3 style="margin: 0 0 1rem 0; font-size: 1.1rem; color: #374151;">
                    Wiki Pages
                  </h3>
                  <ct-button
                    onClick={createPage({ pages, currentPage })}
                    style="width: 100%;"
                  >
                    + New Page
                  </ct-button>
                  <ct-separator />
                  <div style="border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden; background: white;">
                    {pageKeys.map((slug) => (
                      <div
                        key={slug}
                        onClick={selectPage({ slug, currentPage })}
                        style={derive(
                          [currentPage, slug],
                          ([currentPage, slug]) =>
                            `padding: 0.75rem 1rem; cursor: pointer; border-bottom: 1px solid #f1f5f9; ${
                              currentPage === slug
                                ? "background: #f1f5f9; border-left: 3px solid #3b82f6; font-weight: 500;"
                                : "background: white;"
                            }`,
                        )}
                      >
                        {slug}
                      </div>
                    ))}
                  </div>
                </ct-vstack>
              </div>
            </ct-resizable-panel>

            {/* Resizable Handle */}
            <ct-resizable-handle />

            {/* Main Editor Panel */}
            <ct-resizable-panel default-size="75">
              <div style="padding: 1rem; height: 100%; display: flex; flex-direction: column;">
                <ct-hstack gap="sm" style="margin-bottom: 1rem;">
                  <h2 style="flex: 1; margin: 0; font-size: 1.5rem; color: #374151;">
                    {currentPage}
                  </h2>
                  <ct-button
                    onClick={showRenameFormHandler({ showRenameForm })}
                    style="margin-right: 0.5rem;"
                  >
                    Rename
                  </ct-button>
                  <ct-button
                    variant="destructive"
                    onClick={deletePage({
                      slug: currentPage,
                      pages,
                      currentPage: currentPage,
                    })}
                    disabled={!canDelete}
                  >
                    Delete Page
                  </ct-button>
                </ct-hstack>

                {ifElse(
                  showRenameForm,
                  (
                    <div style="margin-bottom: 1rem; padding: 1rem; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc;">
                      <ct-message-input
                        placeholder={str`Enter new name for "${currentPage}"`}
                        onSubmit={handleRename({
                          pages,
                          currentPage,
                          showRenameForm,
                        })}
                        onCancel={hideRenameFormHandler({ showRenameForm })}
                        submitLabel="Rename"
                        cancelLabel="Cancel"
                      />
                    </div>
                  ),
                  null,
                )}

                <div style="flex: 1; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                  <ct-code-editor
                    $value={currentContent}
                    onInput={updatePageContent({ pages, currentPage })}
                    language="text/x-markdown"
                    style="height: 100%;"
                  />
                </div>
              </div>
            </ct-resizable-panel>
          </ct-resizable-panel-group>
        </div>
      ),

      // Exposed properties
      wiki: pages, // Read access to all pages
      currentPage,
      showRenameForm,

      // Update handler for external use
      update: update({ pages, currentPage }),
    };
  },
);
