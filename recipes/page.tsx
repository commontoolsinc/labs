import { h } from "@commontools/html";
import {
  derive,
  handler,
  JSONSchema,
  NAME,
  navigateTo,
  recipe,
  Schema,
  UI,
} from "@commontools/builder/interface";

/**
 * -----------------------------------------------------------------------------
 * Input Schema
 * -----------------------------------------------------------------------------
 *
 * A simple schema that accepts two arrays:
 *  - `lists` : references to Todo-lists produced by `list.tsx`
 *  - `pages` : references to other page recipes (including itself)
 *
 * We keep the item shape open (`{}`) for now—the framework will treat them
 * as opaque entities that can be passed around or rendered via spells later.
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
      items: {}, // Accept anything – concrete validation can be added later
      default: [],
    },
    pages: {
      type: "array",
      items: {}, // Same here
      default: [],
    },
  },
  required: ["lists", "pages"],
} as const satisfies JSONSchema;

const AnySchema = {} as const satisfies JSONSchema;

export type PageInputs = Schema<typeof PageInputSchema>;

/**
 * -----------------------------------------------------------------------------
 * Result Schema
 * -----------------------------------------------------------------------------
 *
 * For now we just echo back the same `lists` and `pages` arrays so that other
 * recipes can consume them. More sophisticated outputs will be added once we
 * introduce interactions (navigation, creation, etc.).
 */
const PageResultSchema = {
  type: "object",
  properties: {
    lists: { type: "array", items: {} },
    pages: { type: "array", items: {} },
  },
  required: ["lists", "pages"],
} as const satisfies JSONSchema;

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

/**
 * -----------------------------------------------------------------------------
 * Recipe Implementation
 * -----------------------------------------------------------------------------
 */
export default recipe(PageInputSchema, PageResultSchema, (
  { title, lists, pages, body },
) => {
  return {
    [NAME]: title,
    [UI]: (
      <os-container>
        <common-input
          value={title}
          placeholder="Page title"
          oncommon-input={updateTitle({ title })}
          customStyle="font-size: 20px; font-family: monospace; text-decoration: underline;"
        />
        <fieldset>
          <common-input
            value={body}
            placeholder="Content"
            oncommon-input={updateBody({ body })}
            customStyle="font-size: 16px; font-family: monospace; "
          />
        </fieldset>
        <common-vstack gap="lg">
          <section>
            <h1 style="font-weight: bold;">Lists</h1>
            <common-vstack gap="lg">
              {lists.map(recipe(AnySchema, {}, (items) => {
                return (
                  <div style="border: 1px solid black;">
                    <common-vstack gap="sm">
                      {items.map((item: { title: string; done: boolean }) => (
                        <common-hstack>
                          <common-todo
                            checked={item.done}
                            value={item.title}
                          />
                        </common-hstack>
                      ))}
                    </common-vstack>
                  </div>
                );
              }))}
            </common-vstack>
          </section>

          <section>
            <h1 style="font-weight: bold;">Pages</h1>
            <common-vstack gap="sm">
              {pages.map(recipe(AnySchema, {}, (page: { title: string }) => {
                return <a href="#">{page.title}</a>;
              }))}
            </common-vstack>
          </section>
        </common-vstack>
      </os-container>
    ),
    // Echo state so that downstream recipes can access it.
    title,
    lists,
    pages,
  };
});
