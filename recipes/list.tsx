import { h } from "@commontools/html";
import {
  derive,
  handler,
  JSONSchema,
  NAME,
  recipe,
  Schema,
  UI,
} from "commontools";

const TodoItemSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    done: { type: "boolean" },
  },
  required: ["title", "done"],
} as const satisfies JSONSchema;

export type TodoItem = Schema<typeof TodoItemSchema>;

const TodoListSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      default: "untitled",
    },
    items: {
      type: "array",
      items: TodoItemSchema,
      default: [],
    },
  },
  required: ["title", "items"],
} as const satisfies JSONSchema;

const ResultSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: TodoItemSchema },
    addItem: {
      asStream: true,
      type: "object",
      properties: {
        title: { type: "string" },
      },
      example: { title: "New item" },
      required: ["title"],
    },
    "/action/drop/schema": { type: "object" },
    "/action/drop/handler": { asStream: true, type: "string" },
  },
  required: ["items", "/action/drop/schema", "/action/drop/handler"],
} as const satisfies JSONSchema;

const addTask = handler<{ detail: { message: string } }, { items: TodoItem[] }>(
  (event, { items }) => {
    const task = event.detail?.message?.trim();
    if (task) items.push({ title: task, done: false });
  },
);

const addItem = handler(
  {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
  {
    type: "object",
    properties: {
      items: { asCell: true, ...TodoListSchema.properties.items },
    },
    default: { items: [] },
  },
  ({ title }, { items }) => {
    items.push({ title, done: false });
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
  (item as any).done = detail.checked;
  (item as any).title = detail.value;
});

const deleteItem = handler<never, { items: TodoItem[]; item: TodoItem }>(
  (_, { item, items }) => {
    const idx = items.findIndex((i) => i.title === item.title);
    if (idx !== -1) items.splice(idx, 1);
  },
);

export default recipe(TodoListSchema, ResultSchema, ({ title, items }) => {
  derive(items, (items) => {
    console.log("todo list items changed", { items });
  });
  return {
    [NAME]: title,
    [UI]: (
      <os-container>
        <common-input
          value={title}
          placeholder="List title"
          oncommon-input={updateTitle({ title })}
          customStyle="font-size: 20px; font-family: monospace; text-decoration: underline;"
        />
        <common-vstack gap="sm">
          {items.map((item: TodoItem) => (
            <common-draggable
              $entity={item}
              spell={JSON.stringify(
                recipe(TodoItemSchema, {}, (item) => ({
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
    addItem: addItem({ items }),
    "action/drop/schema": { type: "string" },
    "action/drop/handler": handler<any[], { items: TodoItem[] }>(
      (event, { items }) => {
        console.log("todo drag handler", event);
        event.forEach((item) => {
          let newItem;
          if (typeof item === "object" && item !== null && "title" in item) {
            newItem = item;
          } else if (typeof item === "string") {
            newItem = { title: item, done: false };
          } else newItem = { title: item.toString(), done: false };
          console.log("todo drag handler newItem", newItem, item);
          items.push(newItem);
        });
      },
    )({ items }),
  };
});
