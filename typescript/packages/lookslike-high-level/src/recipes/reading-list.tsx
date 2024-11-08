import { h } from "@commontools/common-html";
import { recipe, handler, UI, NAME, derive } from "@commontools/common-builder";
import { z } from "zod";

const BookItem = z.object({
  title: z.string(),
  author: z.string(),
  done: z.boolean().default(false),
});

const ReadingList = z
  .object({
    title: z.string().default("Reading list"),
    items: z.array(BookItem).default([]).describe("#booklist"),
  })
  .describe("Reading list");

export type BookItem = z.infer<typeof BookItem>;

const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
  ({ detail }, state) => {
    state.title = detail?.value ?? "untitled";
  },
);

const updateItem = handler<
  { detail: { checked: boolean; value: string } },
  { item: BookItem }
>(({ detail }, { item }) => {
  item.done = detail.checked;
});

const deleteItem = handler<{}, { items: BookItem[]; item: BookItem }>(
  ({}, { item, items }) => {
    let idx = items.findIndex((i) => i.title === item.title);
    if (idx !== -1) items.splice(idx, 1);
  },
);

export default recipe(ReadingList, ({ title, items }) => {
  return {
    [NAME]: title,
    [UI]: (
      <os-container>
        <common-input
          value={title}
          placeholder="List title"
          oncommon-input={updateTitle({ title })}
        />
        <common-vstack gap="sm">
          {items.map((item: BookItem) => (
            <common-draggable $entity={item}>
              <common-hstack>
                <common-todo
                  checked={item.done}
                  value={derive(
                    item,
                    ({ title, author }) => `${title} by ${author}`,
                  )}
                  ontodo-checked={updateItem({ item })}
                  ontodo-input={updateItem({ item })}
                />
                <sl-button
                  outline
                  variant="danger"
                  onclick={deleteItem({ item, items })}
                >
                  Delete
                </sl-button>
              </common-hstack>
            </common-draggable>
          ))}
        </common-vstack>
      </os-container>
    ),
    title,
    items,
  };
});
