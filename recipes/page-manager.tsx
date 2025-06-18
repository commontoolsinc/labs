import { h } from "@commontools/html";
import {
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
  },
} as const satisfies JSONSchema;

export type PageInputs = Schema<typeof PageInputSchema>;

const updateTitle = handler<
  { detail: { value: string } },
  { title: string | undefined }
>(
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

const addLinkedPage = handler<
  void,
  {
    pages: any[];
    selectedPage: any;
  }
>(
  (_, { pages, selectedPage }) => {
    if (selectedPage) {
      pages.push(selectedPage);
    }
  },
);

const addNewPage = handler<
  { detail: { value: string } },
  {
    pages: any[];
  }
>(
  (ev, { pages }) => {
    pages?.push({
      title: ev.detail.value ?? "untitled",
      lists: [],
      pages: [],
      tags: [],
    });
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

const viewList = handler<void, { list: { title: string; items: any[] } }>(
  (_, { list }) => {
    return navigateTo(
      recipe(
        AnySchema,
        {},
        (list: { title: string; items: any[] }) => {
          return (
            <div
              style={{
                border: "1px solid black",
                padding: "10px",
                borderRadius: "5px",
              }}
            >
              <h2 style={{ fontWeight: "bold" }}>{list.title}</h2>
              <common-vstack gap="md">
                <ul style={{ listStyleType: "disc" }}>
                  {list.items.map((
                    item: { title: string; done: boolean },
                  ) => (
                    <li style={{ marginLeft: "16px" }}>
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
              <ct-button onClick={viewList({ list })}>
                View
              </ct-button>
            </div>
          );
        },
      )(list),
    );
  },
);

/**
 * -----------------------------------------------------------------------------
 * Recipe Implementation
 * -----------------------------------------------------------------------------
 */
export const Page = recipe(PageInputSchema, PageResultSchema, (
  {
    page: { title, lists, pages, body, tags },
    selectedPage,
    referenceablePages,
    referenceableLists,
  },
) => {
  const tagString = derive(tags, (tags: string[]) => (tags || []).join(", "));
  const selectedSubPage = cell(null);
  const selectedList = cell(null);
  const selectItems = derive(
    referenceablePages,
    (pages) => pages.map((page) => ({ label: page.title, value: page })),
  );
  const listSelectItems = derive(
    referenceableLists,
    (lists) =>
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
  >(
    (_, { lists, selectedList }) => {
      debugger;
      if (selectedList) {
        lists.push(selectedList.items);
      }
    },
  );

  return {
    [NAME]: title,
    [UI]: (
      <div
        style={{
          border: "1px solid grey",
          padding: "10px",
          borderRadius: "5px",
          backgroundColor: "#f9f9f9",
        }}
      >
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
            <h1 style={{ fontWeight: "bold", fontSize: "1.5rem" }}>Lists</h1>
            <common-vstack gap="lg">
              {lists.map(
                recipe(
                  AnySchema,
                  {},
                  (list: { title: string; items: any[] }) => {
                    return (
                      <ct-card>
                        <h2 style={{ fontWeight: "bold" }}>{list.title}</h2>
                        <common-vstack gap="md">
                          <ul style={{ listStyleType: "disc" }}>
                            {list.items.map((
                              item: { title: string; done: boolean },
                            ) => (
                              <li style={{ marginLeft: "16px" }}>
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
                          <ct-message-input
                            buttonText="Add item"
                            placeholder="New item"
                            onct-send={addItem({ list })}
                          />
                        </common-vstack>
                      </ct-card>
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
            </common-vstack>
          </section>

          <section>
            <h1 style={{ fontWeight: "bold" }}>Pages</h1>
            <common-vstack gap="sm">
              <common-hstack gap="md">
                {pages.map(
                  recipe(
                    PageResultSchema,
                    {},
                    (page) => {
                      const summary = derive(
                        [page.pages, page.lists, page.tags],
                        ([pages, lists, tags]) => {
                          return `Pages: ${pages.length}, Lists: ${lists.length}, Tags: ${
                            tags.map((t: string) => "#" + t).join(", ")
                          }`;
                        },
                      );

                      const visitPage = handler<
                        void,
                        { selectedPage: any; page: any }
                      >((e, s) => {
                        s.selectedPage = s.page;
                      });

                      return (
                        <ct-card
                          onClick={visitPage({ page, selectedPage })}
                        >
                          <h3 style={{ fontWeight: "bold", margin: 0 }}>
                            {page.title}
                          </h3>
                          <details>
                            <summary>{summary}</summary>
                          </details>
                        </ct-card>
                      );
                    },
                  ),
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
      items: PageResultSchema,
      default: [],
    },
    lists: {
      type: "array",
      items: AnySchema,
      default: [],
    },
  },
  required: ["pages", "lists"],
} as const satisfies JSONSchema;

const AddPageEventSchema = {
  type: "object",
  properties: {
    detail: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    },
  },
  required: ["detail"],
} as const satisfies JSONSchema;

const AddPageStateSchema = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      items: PageResultSchema,
      default: [],
      asCell: true,
    },
  },
  required: ["pages"],
} as const satisfies JSONSchema;

const addTopLevelPage = handler(
  AddPageEventSchema,
  AddPageStateSchema,
  (event, { pages }) => {
    const title = event.detail?.message?.trim();
    if (title) {
      pages.push({
        title,
        lists: [],
        pages: [],
        tags: [],
      });
    }
  },
);

export default recipe(
  PageManagerInputSchema,
  AnySchema,
  ({ pages, lists }) => {
    const selectedPage = cell(null);

    const navigate = handler<{ page: any }, { selectedPage: any }>(
      ({ page }, state) => {
        state.selectedPage = page;
      },
    );

    const onFocusChanged = handler<
      { detail: { value: any } },
      { selectedPage: any }
    >(
      (ev, state) => {
        state.selectedPage = ev.detail.value;
      },
    );

    const items = derive(pages, (ps) => {
      return ps.map((p) => ({
        label: p.title,
        value: p,
      }));
    });

    const test = handler<any, any>((_, state) => {
      state.selectedPage = state.pages[0];
    });

    const listSelectItems = derive(
      lists,
      (listNodes: any[] | undefined) => {
        return (listNodes || []).map((listNode) => ({
          label: listNode[NAME] || "Unnamed List",
          value: listNode,
        }));
      },
    );

    return {
      [NAME]: "Page Manager",
      [UI]: (
        <common-vstack gap="lg">
          <common-hstack>
            <ct-select
              onchange={onFocusChanged({ selectedPage })}
              items={items}
              placeholder="Select a page"
            />
            <ct-message-input
              buttonText="Add page"
              placeholder="New page"
              onct-send={addTopLevelPage({ pages })}
            />
          </common-hstack>

          <ct-card>
            {ifElse(
              selectedPage,
              view(Page({
                page: selectedPage,
                referenceablePages: pages,
                referenceableLists: lists,
                selectedPage,
              })),
              <div>&nbsp;</div>,
            )}
          </ct-card>
        </common-vstack>
      ),
      pages,
      navigate,
      lists,
      selectedPage,
    };
  },
);

function view(x: any) {
  return x[UI];
}
