import { derive, h, handler, JSONSchema, NAME, recipe, UI } from "commontools";

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
          '# Getting Started\n\nWelcome to your wiki! This is your first page.\n\nYou can:\n- Edit this page using the markdown editor\n- Create new pages with the "+ New Page" button\n- Navigate between pages using the sidebar\n- Rename pages by editing the title',
      },
    },
    currentPage: {
      type: "string",
      default: "getting-started",
    },
  },
  required: ["pages", "currentPage"],
} as const satisfies JSONSchema;

const OutputSchema = WikiSchema;

// Utility functions
const slugToTitle = (slug: string): string => {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

const titleToSlug = (title: string): string => {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "") // Remove special chars
    .replace(/\s+/g, "-") // Replace spaces with hyphens
    .replace(/-+/g, "-") // Replace multiple hyphens with single
    .replace(/^-|-$/g, ""); // Remove leading/trailing hyphens
};

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
    const newTitle = detail?.value ?? "";
    const newSlug = titleToSlug(newTitle);

    if (newSlug && newSlug !== state.currentPage && newTitle.trim()) {
      // Move content to new slug
      state.pages[newSlug] = state.pages[state.currentPage];
      delete state.pages[state.currentPage];
      state.currentPage = newSlug;
    }
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
  ({ pages, currentPage }) => {
    const pageKeys = derive(pages, (pages) => Object.keys(pages).sort());
    const currentContent = derive(
      [pages, currentPage],
      ([pages, currentPage]) => (pages as any)[currentPage as any] || "",
    );
    const currentTitle = derive(
      currentPage,
      (currentPage) =>
        (currentPage || "").split("-").map((word) =>
          word.charAt(0).toUpperCase() + word.slice(1)
        ).join(" "),
    );
    const canDelete = derive(pages, (pages) => Object.keys(pages).length > 1);

    return {
      [NAME]: "Wiki",
      [UI]: (
        <div style="height: 100vh; width: 100%;">
          <ct-resizable-panel-group direction="horizontal">
            {/* Sidebar Panel */}
            <ct-resizable-panel default-size="25" min-size="20" max-size="40">
              <div style="padding: 1rem; height: 100%; overflow-y: auto; background: #f8fafc; border-right: 1px solid #e2e8f0;">
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
                        {derive([slug], ([slug]) =>
                          (slug || "").split("-").map((word) =>
                            word.charAt(0).toUpperCase() + word.slice(1)
                          ).join(" "))}
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
                  <ct-input
                    value={currentTitle}
                    placeholder="Page title..."
                    style="flex: 1; font-size: 1.2rem; font-weight: bold;"
                    onct-input={updatePageTitle({ pages, currentPage })}
                  />
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

                <div style="flex: 1; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                  <common-code-editor
                    source={currentContent}
                    language="text/x-markdown"
                    onChange={updatePageContent({ pages, currentPage })}
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

      // Update handler for external use
      update: update({ pages, currentPage }),
    };
  },
);
