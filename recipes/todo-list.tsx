import { derive, h, handler, NAME, recipe, toSchema, UI } from "commontools";

// Define types using TypeScript interfaces
export interface TodoItem {
  title: string;
  done: boolean;
}

interface TodoListInput {
  title: string;
  items: TodoItem[];
}

interface TodoResult {
  items: TodoItem[];
  addItem: {
    title: string;
  }; // @asStream
  "/action/drop/schema": object;
  "/action/drop/handler": string; // @asStream
}

// Transform to schemas at compile time
const TodoItemSchema = toSchema<TodoItem>();

const TodoListSchema = toSchema<TodoListInput>({
  default: { title: "untitled", items: [] },
});

const ResultSchema = toSchema<TodoResult>({
  properties: {
    addItem: {
      asStream: true,
      example: { title: "New item" },
    },
  },
});

interface AddTaskEvent {
  detail: {
    message: string;
  };
}

interface ItemsState {
  items: TodoItem[];
}

const addTask = handler<AddTaskEvent, ItemsState>(
  (event, { items }) => {
    const task = event.detail?.message?.trim();
    if (task) items.push({ title: task, done: false });
  },
);

interface AddItemEvent {
  title: string;
}

interface AddItemState {
  items: TodoItem[]; // @asCell
}

const addItem = handler(
  toSchema<AddItemEvent>(),
  toSchema<AddItemState>({
    default: { items: [] },
  }),
  ({ title }, { items }) => {
    items.push({ title, done: false });
  },
);

interface UpdateTitleEvent {
  detail: {
    value: string;
  };
}

interface TitleState {
  title: string;
}

const updateTitle = handler<UpdateTitleEvent, TitleState>(
  ({ detail }, state) => {
    state.title = detail?.value ?? "untitled";
  },
);

interface UpdateItemEvent {
  detail: {
    checked: boolean;
    value: string;
  };
}

interface ItemState {
  item: TodoItem;
}

const updateItem = handler<UpdateItemEvent, ItemState>(
  ({ detail }, { item }) => {
    (item as any).done = detail.checked;
    (item as any).title = detail.value;
  },
);

interface DeleteItemState {
  items: TodoItem[];
  item: TodoItem;
}

const deleteItem = handler<never, DeleteItemState>(
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
    "action/drop/handler": handler<any[], ItemsState>(
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
