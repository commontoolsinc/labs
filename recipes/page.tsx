import { h } from "@commontools/html";
import {
  compileAndRun,
  derive,
  handler,
  str,
  JSONSchema,
  NAME,
  navigateTo,
  render,
  ifElse,
  recipe,
  Schema,
  cell,
  UI,
} from "@commontools/builder/interface";

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
    },
    referenceablePages: {
      type: "array",
      items: PageResultSchema,
      default: [],
    },
  },
} as const satisfies JSONSchema;

const AnySchema = {} as const satisfies JSONSchema;

export type PageInputs = Schema<typeof PageInputSchema>;

const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
  ({ detail }, state) => {
    state.title = detail?.value ?? "untitled";
  },
);

const updateBody = handler<{ detail: { value: string } }, { body: string }>(
  ({ detail }, state) => {
    state.body = detail?.value ?? "";
  },
);

const updateTags = handler<{ detail: { value: string } }, { tags: string[] }>(
  ({ detail }, state) => {
    state.tags = (detail?.value?.split(",") ?? []).map((tag) => tag.trim());
  },
);

const addPage = handler<
  { detail: { message: string } },
  { pages: { title: string; lists: any[]; pages: any[]; tags: string[] } }
>(
  (event, { pages }) => {
    const task = event.detail?.message?.trim();
    if (task) pages.push({ title: task, lists: [], pages: [], tags: [] });
  },
);

const addList = handler<
  { detail: { message: string } },
  { lists: { title: string; items: any[] }[] }
>(
  (event, { lists }) => {
    const task = event.detail?.message?.trim();
    if (task) lists.push({ title: task, items: [] });
  },
);

const addItem = handler<
  { detail: { message: string } },
  { list: { title: string; items: any[] } }
>(
  (event, { list }) => {
    const item = event.detail?.message?.trim();
    if (item) list.items.push({ title: item });
  },
);

const removeItem = handler<
  never,
  { list: { title: string; items: any[] }; item: { title: string } }
>(
  (_, { list, item }) => {
    const idx = list.items.findIndex((i) => i.title === item.title);
    if (idx !== -1) list.items.splice(idx, 1);
  },
);

const viewList = handler<{ list: { title: string; items: any[] } }, void>(
  ({ list }) => {
    debugger;
    return navigateTo(
      recipe(
        AnySchema,
        {},
        (list: { title: string; items: any[] }) => {
          return (
            <div style="border: 1px solid black; padding: 10px; border-radius: 5px;">
              <h2 style="font-weight: bold;">{list.title}</h2>
              <common-vstack gap="md">
                <ul style="list-style-type: disc;">
                  {list.items.map((
                    item: { title: string; done: boolean },
                  ) => (
                    <li style="margin-left: 16px;">
                      <common-hstack gap="sm">
                        {item.title}
                        <sl-button
                          variant="danger"
                          onClick={removeItem({ list, item })}
                        >
                          [x]
                        </sl-button>
                      </common-hstack>
                    </li>
                  ))}
                </ul>
                <common-send-message
                  name="Add item"
                  placeholder="New item"
                  onmessagesend={addItem({ list })}
                />
              </common-vstack>
              <common-button onClick={viewList({ list })}>
                View
              </common-button>
            </div>
          );
        },
      )(list),
    );
  },
);
const DropdownInputSchema = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      items: PageResultSchema,
    },
    selectedPage: PageResultSchema,
  },
  required: ["pages"],
} as const satisfies JSONSchema;

const DropdownOutputSchema = {
  type: "object",
  properties: {
    selectedPage: PageResultSchema,
  },
  required: ["selectedPage"],
} as const satisfies JSONSchema;

const Dropdown = recipe(DropdownInputSchema, DropdownOutputSchema, ({ pages, selectedPage }) => {
  const open = cell(false)
  const openDropdown = handler<{ open: boolean }>(({}, state) => {
    state.open = !state.open
  })
  const onSelect = handler<>(({}, state) => {
    state.selectedPage = state.page
    state.open = false
  })
  const selectionLabel = derive(selectedPage, (selectedPage) => {
    return selectedPage ? selectedPage.title : "Select a page"
  })

  const dropdownArrow = derive(open, (open) => {
    return open ? "▲" : "▼"
  })

  return {
    [UI]: <common-vstack style="max-width: 192px;">
      <label style="border: 1px solid black; display: inline-block; padding: 5px;" onClick={openDropdown({ open })}>{selectionLabel} {dropdownArrow}</label>
      <div style="position: relative;">
        {ifElse(open, <div style="position: absolute;">{pages.map((page) => (
          <div style="background-color: grey;" onClick={onSelect({ page, selectedPage, open })}>
            {page.title}
          </div>
        ))}</div>, <div style="display: none">&nbsp;</div>)}
      </div>
    </common-vstack>
  }
})

/**
 * -----------------------------------------------------------------------------
 * Recipe Implementation
 * -----------------------------------------------------------------------------
 */
export const Page = recipe(PageInputSchema, PageResultSchema, (
  { page: { title, lists, pages, body, tags, referenceablePages } },
) => {
  const tagString = derive(tags, (tags: string[]) => tags.join(", "));

  return {
    [NAME]: title,
    [UI]: (
      <div style="border: 1px solid grey; padding: 10px; border-radius: 5px; background-color: #f9f9f9;">
        <common-input
          value={title}
          placeholder="Page title"
          oncommon-input={updateTitle({ title })}
          customStyle="font-size: 20px; font-family: monospace; text-decoration: underline;"
        />
        <fieldset>
          <common-input
            value={tagString}
            placeholder="Content"
            oncommon-input={updateTags({ tags })}
            customStyle="font-size: 12px; font-family: monospace; "
          />
          <common-input
            value={body}
            placeholder="Content"
            oncommon-input={updateBody({ body })}
            customStyle="font-size: 16px; font-family: serif; "
          />
        </fieldset>
        <common-vstack gap="lg">
          <section>
            <h1 style="font-weight: bold; font-size: 1.5rem;">Lists</h1>
            <common-vstack gap="lg">
              {lists.map(
                recipe(
                  AnySchema,
                  {},
                  (list: { title: string; items: any[] }) => {
                    return (
                      <div style="border: 1px solid black; padding: 10px; border-radius: 5px;">
                        <h2 style="font-weight: bold;">{list.title}</h2>
                        <common-vstack gap="md">
                          <ul style="list-style-type: disc;">
                            {list.items.map((
                              item: { title: string; done: boolean },
                            ) => (
                              <li style="margin-left: 16px;">
                                <common-hstack gap="sm">
                                  {item.title}
                                  <sl-button
                                    variant="danger"
                                    onClick={removeItem({ list, item })}
                                  >
                                    [x]
                                  </sl-button>
                                </common-hstack>
                              </li>
                            ))}
                          </ul>
                          <common-send-message
                            name="Add item"
                            placeholder="New item"
                            onmessagesend={addItem({ list })}
                          />
                        </common-vstack>
                        <common-button onClick={viewList({ list })}>
                          View
                        </common-button>
                      </div>
                    );
                  },
                ),
              )}
              <common-send-message
                name="Add"
                placeholder="New list"
                onmessagesend={addList({ lists })}
              />
            </common-vstack>
          </section>

          <section>
            <h1 style="font-weight: bold;">Pages</h1>
            <common-vstack gap="sm">
              <common-hstack gap="md">
                {pages.map(
                  recipe(
                    AnySchema,
                    {},
                    (
                      page: {
                        title: string;
                        pages: any[];
                        lists: any[];
                        tags: string[];
                      },
                    ) => {
                      const summary = derive(
                        [page.pages, page.lists, page.tags],
                        ([pages, lists, tags]) => {
                          return `Pages: ${pages.length}, Lists: ${lists.length}, Tags: ${
                            tags.map((t) => "#" + t).join(", ")
                          }`;
                        },
                      );

                      return (
                        <div style="border: 1px solid #ccc; padding: 16px; border-radius: 8px; background: #f9f9f9;">
                          <h3 style="font-weight: bold; margin: 0;">
                            {page.title}
                          </h3>
                          <details>
                            <summary>{summary}</summary>
                          </details>
                        </div>
                      );
                    },
                  ),
                )}
              </common-hstack>
              {Dropdown({ pages: referenceablePages })[UI]}
              <common-send-message
                name="Add"
                placeholder="New page"
                onmessagesend={addPage({ pages })}
              />
            </common-vstack>
          </section>
        </common-vstack>
      </div>
    ),
    title,
    lists,
    pages,
    tags,
  };
});

/**
 * -----------------------------------------------------------------------------
 * PageManager Recipe - acts as a lightweight router / window manager
 * -----------------------------------------------------------------------------
 */
const PageManagerInputSchema = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      items: PageInputSchema,
      default: [],
    },
  },
  required: ["pages"],
} as const satisfies JSONSchema;

const AddPageEventSchema = {
  type: "object",
  properties: {
    detail: {
      type: "object",
      properties: {
        message: { type: "string" }
      },
      required: ["message"]
    },
  },
  required: ["detail"]
} as const satisfies JSONSchema;

const AddPageStateSchema = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      items: PageInputSchema,
      default: [],
      asCell: true
    },
  },
  required: ["pages"],
} as const satisfies JSONSchema;

const addTopLevelPage = handler(AddPageEventSchema, AddPageStateSchema, (event, { pages }) => {
  const title = event.detail?.message?.trim();
  if (title) pages.push({ title, body: "", lists: [], pages: [], tags: [], referenceablePages: pages });
});

export default recipe(PageManagerInputSchema, AnySchema, ({ pages }) => {
  const selectedPage = cell(null);

  return {
    [NAME]: "Page Manager",
    [UI]: (
      <common-vstack gap="lg">
          <common-hstack>
          {Dropdown({ pages, selectedPage })[UI]}
          <common-send-message
            name="Add page"
            placeholder="New page"
            onmessagesend={addTopLevelPage({ pages })}
          />
          </common-hstack>
          <div style="border: 1px solid red;">
            {ifElse(selectedPage, Page({ page: selectedPage, referenceablePages: pages })[UI], <div>&nbsp;</div>)}
          </div>
      </common-vstack>
    ),
    pages,
  };
});
