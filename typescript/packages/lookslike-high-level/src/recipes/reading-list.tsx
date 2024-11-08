import { h } from "@commontools/common-html";
import {
  recipe,
  handler,
  UI,
  NAME,
  derive,
  lift,
  cell,
} from "@commontools/common-builder";
import { z } from "zod";

const BookItem = z.object({
  title: z.string(),
  author: z.string(),
  done: z.boolean().default(false),
});

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

const deleteItem = handler<{}, { list: BookItem[]; item: BookItem }>(
  ({}, { item, list }) => {
    let idx = list.findIndex((i) => i.title === item.title);
    if (idx !== -1) list.splice(idx, 1);
    console.log("deleted item", item, idx);
  },
);

const oneWayCopyFn = lift(({ external, seen, internal }) => {
  const previousCells = seen.map((item: any) => JSON.stringify(item));
  console.log("previousCells", previousCells);
  external.forEach((item: any) => {
    if (!previousCells.includes(JSON.stringify(item))) {
      console.log("new item", item, JSON.stringify(item));
      seen.push(item);
      internal.push(item);
    }
  });
});

function oneWayCopy(external: any[]) {
  const seen = cell([]);
  const internal = cell([]);
  oneWayCopyFn({ external, seen, internal });
  return internal;
}

export default recipe(
  z
    .object({
      title: z.string().default("Reading list"),
      books: z.array(BookItem).default([]).describe("#booklist"),
    })
    .describe("Reading list"),
  ({ title, books }) => {
    const list = oneWayCopy(books);
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
            {list.map((item: BookItem) => (
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
                    onclick={deleteItem({ item, list })}
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
      list,
    };
  },
);
