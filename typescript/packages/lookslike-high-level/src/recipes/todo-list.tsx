import { h } from "@commontools/common-html";
import { recipe, handler, UI, NAME } from "@commontools/common-builder";
import { z } from "zod";

const TodoItem = z.object({
  title: z.string(),
  done: z.boolean(),
});

const TodoList = z
  .object({
    title: z.string().default("untitled"),
    items: z.array(TodoItem).default([]),
  })
  .describe("Todo list");

export type TodoItem = z.infer<typeof TodoItem>;

const addTask = handler<{ detail: { message: string } }, { items: TodoItem[] }>(
  (event, { items }) => {
    const task = event.detail?.message?.trim();
    if (task) items.push({ title: task, done: false });
  },
);

const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
  ({ detail }, state) => {
    state.title = detail?.value ?? "untitled";
  },
);

const updateItem = handler<
  { detail: { checked: boolean; value: string } },
  { item: TodoItem }
>(({ detail }, { item }) => {
  item.done = detail.checked;
  item.title = detail.value;
});

const deleteItem = handler<{}, { items: TodoItem[]; item: TodoItem }>(
  ({}, { item, items }) => {
    let idx = items.findIndex((i) => i.title === item.title);
    if (idx !== -1) items.splice(idx, 1);
  },
);

export default recipe(TodoList, ({ title, items }) => {
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
          {items.map((item: TodoItem) => (
            <common-draggable
              $entity={item}
              spell={JSON.stringify(
                recipe(TodoItem, (item) => ({
                  [UI]: (
                    <common-todo
                      checked={item.done}
                      value={item.title}
                      ontodo-checked={updateItem({ item })}
                      ontodo-input={updateItem({ item })}
                    />
                  ),
                })),
              )}
            >
              <common-hstack>
                <common-todo
                  checked={item.done}
                  value={item.title}
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
        <common-send-message
          name="Add"
          placeholder="New task"
          appearance="rounded"
          onmessagesend={addTask({ items })}
        />
      </os-container>
    ),
    title,
    items,
    "action/drop/schema": { type: "string" },
    "action/drop/handler": handler<any[], { items: TodoItem[] }>(
      (event, { items }) => {
        console.log("todo drag handler", event);
        event.forEach((item) => {
          let newItem;
          if (typeof item === "object" && item !== null && "title" in item)
            newItem = item;
          else if (typeof item === "string")
            newItem = { title: item, done: false };
          else newItem = { title: item.toString(), done: false };
          console.log("todo drag handler newItem", newItem, item);
          items.push(newItem);
        });
      },
    )({ items }),
  };
});
