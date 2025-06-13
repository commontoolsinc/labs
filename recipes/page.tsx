import { h } from "@commontools/html";
import {
  compileAndRun,
  derive,
  handler,
  JSONSchema,
  NAME,
  navigateTo,
  render,
  ifElse,
  recipe,
  Schema,
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

/**
 * -----------------------------------------------------------------------------
 * Recipe Implementation
 * -----------------------------------------------------------------------------
 */
export const Page = recipe(PageInputSchema, PageResultSchema, (
  { title, lists, pages, body, tags },
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
    focus: {
      type: "array",
      items: { type: "number" },
      default: [],
    },
  },
  required: ["pages"],
} as const satisfies JSONSchema;

const addTopLevelPage = handler<
  { detail: { message: string } },
  { pages: PageInputs[] }
>((event, { pages }) => {
  const title = event.detail?.message?.trim();
  if (title) pages.push({ title, body: "", lists: [], pages: [], tags: [] });
});

const focusPage = handler<{  }, { focus: number[], idx: number }>(
  ({ }, state) => {
    const pos = state.focus.indexOf(state.idx);
    if (pos === -1) state.focus.push(state.idx);           // add if not present
    else state.focus.splice(pos, 1);                 // toggle off if present
  },
);

export default recipe(PageManagerInputSchema, AnySchema, ({ pages, focus }) => {
  const focusedPages = derive([pages, focus], ([ps, f]) =>
    ps.filter((p, i) => f.indexOf(i) !== -1)
  );

  return {
    [NAME]: "Page Manager",
    [UI]: (
      <common-vstack gap="lg">
        {/* Sidebar */}
          <common-hstack gap="sm">
            {pages.map((p, idx) => (
              <common-button
                onClick={focusPage({ idx, focus })}
              >
                {p.title || `Untitled Page`}
              </common-button>
            ))}
            <common-send-message
              name="Add page"
              placeholder="New page"
              onmessagesend={addTopLevelPage({ pages })}
            />
          </common-hstack>
        <common-hstack gap="sm" style='background: grey;'>
          {focusedPages.map(p => <label>{p.title}</label>)}
        </common-hstack>
        <common-hstack gap="sm">
          {focusedPages.map(p => Page(p)[UI])}
        </common-hstack>
      </common-vstack>
    ),
    pages,
    focus,
  };
});
