import {
  h,
  cell,
  compileAndRun,
  derive,
  handler,
  ifElse,
  JSONSchema,
  NAME,
  navigateTo,
  recipe,
  render,
  Schema,
  str,
  UI,
} from "commontools";

const ListItemSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    done: { type: "boolean" },
  },
  required: ["title", "done"],
} as const satisfies JSONSchema;

export type ListItem = Schema<typeof ListItemSchema>;

const ListSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      default: "untitled",
    },
    items: {
      type: "array",
      items: ListItemSchema,
      default: [],
    },
  },
  required: ["title", "items"],
} as const satisfies JSONSchema;

/**
 * -----------------------------------------------------------------------------
 * Result Schema
 * -----------------------------------------------------------------------------
 *
 * For now we just echo the data.
 */
const PageResultSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    lists: { type: "array", items: {} },
    pages: { type: "array", items: {} },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["lists", "pages"],
} as const satisfies JSONSchema;

const AnySchema = {} as const satisfies JSONSchema;

/**
 * -----------------------------------------------------------------------------
 * Input Schema
 * -----------------------------------------------------------------------------
 *
 * Lists, Pages and Tags
 */
const PageInputSchema = {
  type: "object",
  properties: {
    page: {
      type: "object",
      properties: {
        title: {
          type: "string",
          default: "untitled page",
        },
        body: {
          type: "string",
          default: "",
        },
        lists: {
          type: "array",
          items: ListSchema,
          default: [],
        },
        pages: {
          type: "array",
          items: PageResultSchema,
          default: [],
        },
        tags: {
          type: "array",
          items: { type: "string" },
          default: [],
        },
      },
      required: ["lists", "pages"],
      default: {
        title: "untitled page",
        body: "",
        lists: [],
        pages: [],
        tags: [],
      },
    },
    selectedPage: PageResultSchema,
    referenceablePages: {
      type: "array",
      items: PageResultSchema,
      default: [],
    },
    referenceableLists: {
      type: "array",
      items: AnySchema,
      default: [],
    },
    mentionable: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          charm: {},
        },
        required: ["name", "charm"],
      },
      default: [],
    },
  },
} as const satisfies JSONSchema;

export type PageInputs = Schema<typeof PageInputSchema>;

/**
 * -----------------------------------------------------------------------------
 * Markdown List Parser
 * -----------------------------------------------------------------------------
 *
 * Parses nested markdown lists into structured outline items
 */
function parseMarkdownToOutline(markdown: string): { title: string; items: any[] }[] {
  const lines = markdown.split('\n').filter(line => line.trim());
  const lists: { title: string; items: any[] }[] = [];
  
  let currentList: { title: string; items: any[] } | null = null;
  let listCounter = 1;
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip empty lines
    if (!trimmed) continue;
    
    // Check if it's a list item (starts with -, *, +, or number.)
    const listItemMatch = trimmed.match(/^[-*+]\s+(.+)$/) || trimmed.match(/^\d+\.\s+(.+)$/);
    
    if (listItemMatch) {
      const itemText = listItemMatch[1];
      
      // If no current list, create one
      if (!currentList) {
        currentList = {
          title: `Imported List ${listCounter++}`,
          items: []
        };
        lists.push(currentList);
      }
      
      currentList.items.push({
        title: itemText,
        done: false
      });
    } else {
      // Non-list line - could be a header or section break
      // Create new list with this as title if it looks like a header
      if (trimmed.startsWith('#')) {
        const headerText = trimmed.replace(/^#+\s*/, '');
        currentList = {
          title: headerText,
          items: []
        };
        lists.push(currentList);
      } else {
        // Regular text - create new list section
        currentList = {
          title: trimmed,
          items: []
        };
        lists.push(currentList);
      }
    }
  }
  
  return lists;
}

const updateTitle = handler<
  { detail: { value: string } },
  { title: string | undefined }
>(({ detail }, state) => {
  state.title = detail?.value ?? "untitled";
});

const updateTags = handler<{ detail: { tags: string[] } }, { tags: string[] }>(
  ({ detail }, state) => {
    state.tags = detail?.tags ?? [];
  },
);

const updateOutliner = handler<{ detail: { value: string } }, { body: string }>(
  ({ detail }, state) => {
    state.body = detail?.value ?? "";
  },
);

// New handler for parsing markdown and adding lists
const parseAndAddMarkdown = handler<
  { detail: { message: string } },
  { lists: { title: string; items: any[] }[] }
>((event, { lists }) => {
  const markdown = event.detail?.message?.trim();
  if (markdown) {
    const parsedLists = parseMarkdownToOutline(markdown);
    lists.push(...parsedLists);
  }
});

const addLinkedPage = handler<
  void,
  {
    pages: any[];
    selectedPage: any;
  }
>((_, { pages, selectedPage }) => {
  if (selectedPage) {
    pages.push(selectedPage);
  }
});

const addNewPage = handler<
  { detail: { value: string } },
  {
    pages: any[];
  }
>((ev, { pages }) => {
  pages?.push({
    title: ev.detail.value ?? "untitled",
    lists: [],
    pages: [],
    tags: [],
  });
});

const addList = handler<
  { detail: { message: string } },
  { lists: { title: string; items: any[] }[] }
>((event, { lists }) => {
  const task = event.detail?.message?.trim();
  if (task) lists.push({ title: task, items: [] });
});

const addItem = handler<
  { detail: { message: string } },
  { list: { title: string; items: any[] } }
>((event, { list }) => {
  const item = event.detail?.message?.trim();
  if (item) list.items.push({ title: item });
});

const removeItem = handler<
  { detail: { item: { title: string } } },
  { list: { title: string; items: any[] } }
>(({ detail }, { list }) => {
  const idx = list.items.findIndex((i) => i.title === detail.item.title);
  if (idx !== -1) list.items.splice(idx, 1);
});

/**
 * -----------------------------------------------------------------------------
 * Recipe Implementation
 * -----------------------------------------------------------------------------
 */
export default recipe(
  PageInputSchema,
  PageResultSchema,
  ({
    page: { title, lists, pages, body, tags },
    selectedPage,
    referenceablePages,
    referenceableLists,
    mentionable,
  }) => {
    const selectedSubPage = cell(null);
    const selectedList = cell(null);
    const selectItems = derive(referenceablePages, (pages) =>
      pages.map((page) => ({ label: page.title, value: page })),
    );
    const listSelectItems = derive(referenceableLists, (lists) =>
      (lists || []).map((list) => ({
        label: list[NAME] || "Unnamed List",
        value: list,
      })),
    );

    const changeSubpage = handler<
      { detail: { value: any } },
      { selectedSubPage: any }
    >(({ detail: { value } }, state) => {
      state.selectedSubPage = value;
    });

    const changeList = handler<
      { detail: { value: any } },
      { selectedList: any }
    >(({ detail: { value } }, state) => {
      state.selectedList = value;
    });

    const addLinkedList = handler<
      void,
      {
        lists: any[];
        selectedList: any;
      }
    >((_, { lists, selectedList }) => {
      if (selectedList) {
        lists.push(selectedList);
      }
    });

    return {
      [NAME]: title,
      [UI]: (
        <common-vstack gap="lg" style={{ padding: "1rem" }}>
          <ct-card>
            <common-vstack gap="md">
              <common-input
                value={title}
                placeholder="Page title"
                oncommon-input={updateTitle({ title })}
                customStyle="font-size: 32px; font-family: serif; font-weight: bold;"
              />
              <div>
                <label>Tags</label>
                <ct-tags tags={tags} onct-change={updateTags({ tags })} />
              </div>
              <div>
                <label>Content</label>
                <ct-outliner
                  value={body}
                  mentionable={mentionable}
                  onct-change={updateOutliner({ body })}
                />
              </div>
            </common-vstack>
          </ct-card>

          <ct-card>
            <h2
              style={{
                fontWeight: "bold",
                fontSize: "1.25rem",
                marginBottom: "1rem",
              }}
            >
              Attachments
            </h2>
            <common-vstack gap="lg">
              <section>
                <h1 style={{ fontWeight: "bold", fontSize: "1.5rem" }}>
                  Lists
                </h1>
                <common-vstack gap="lg">
                  {lists.map(
                    recipe(
                      AnySchema,
                      {},
                      (list: { title: string; items: any[] }) => {
                        return (
                          <ct-list
                            list={list}
                            onct-add-item={addItem({ list })}
                            onct-remove-item={removeItem({ list })}
                          />
                        );
                      },
                    ),
                  )}
                  <common-hstack>
                    <ct-select
                      items={listSelectItems}
                      onchange={changeList({ selectedList })}
                      placeholder="Select a list"
                    />
                    <ct-button
                      onClick={addLinkedList({
                        lists,
                        selectedList,
                      })}
                    >
                      link
                    </ct-button>
                    <ct-message-input
                      buttonText="Add new list"
                      placeholder="New list"
                      onct-send={addList({ lists })}
                    />
                  </common-hstack>
                  
                  {/* New markdown import section */}
                  <div style={{ 
                    border: "2px dashed #ccc", 
                    padding: "1rem", 
                    borderRadius: "8px",
                    backgroundColor: "#f9f9f9"
                  }}>
                    <h3 style={{ fontWeight: "bold", marginBottom: "0.5rem" }}>
                      Import Markdown Lists
                    </h3>
                    <p style={{ fontSize: "0.9rem", color: "#666", marginBottom: "1rem" }}>
                      Paste markdown with nested lists (-, *, + or 1. 2. 3.) to convert to outline items
                    </p>
                    <ct-message-input
                      buttonText="Parse Markdown"
                      placeholder="Paste markdown lists here..."
                      onct-send={parseAndAddMarkdown({ lists })}
                      multiline={true}
                    />
                  </div>
                </common-vstack>
              </section>

              <section>
                <h1 style={{ fontWeight: "bold" }}>Pages</h1>
                <common-vstack gap="sm">
                  <common-hstack gap="md">
                    {pages.map(
                      recipe(PageResultSchema, {}, (page) => {
                        const summary = derive(
                          [page.pages, page.lists, page.tags],
                          ([pages, lists, tags]) => {
                            return `Pages: ${pages.length}, Lists: ${lists.length}, Tags: ${tags
                              .map((t: string) => "#" + t)
                              .join(", ")}`;
                          },
                        );

                        const visitPage = handler<
                          { detail: { item: any } },
                          { selectedPage: any }
                        >(({ detail }, state) => {
                          state.selectedPage = detail.item;
                        });

                        return (
                          <ct-tile
                            item={page}
                            summary={summary}
                            onct-click={visitPage({ selectedPage })}
                          />
                        );
                      }),
                    )}
                  </common-hstack>
                  <common-hstack>
                    <ct-select
                      items={selectItems}
                      onchange={changeSubpage({ selectedSubPage })}
                    />
                    <ct-button
                      onClick={addLinkedPage({
                        pages,
                        selectedPage: selectedSubPage,
                      })}
                    >
                      link
                    </ct-button>
                    <ct-message-input
                      buttonText="Add new page"
                      placeholder="New page"
                      onct-send={addNewPage({ pages })}
                    />
                  </common-hstack>
                </common-vstack>
              </section>
            </common-vstack>
          </ct-card>
        </common-vstack>
      ),
      title,
      lists,
      pages,
      tags,
    };
  },
);