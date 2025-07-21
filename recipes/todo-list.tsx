/// <cts-enable />
import {
  Cell,
  Default,
  derive,
  h,
  handler,
  NAME,
  recipe,
  Stream,
  UI,
} from "commontools";

// Define types using TypeScript interfaces
export interface TodoItem {
  title: string;
  done: boolean;
}

interface RecipeInput {
  title: string;
  items: Default<TodoItem[], []>;
}

// interface TodoResult {
//   items: Default<TodoItem[], []>;
//   addItem: Stream<{ title: string }>;
// }

const addTask = handler<
  { detail: { message: string } },
  { items: Cell<TodoItem[]> }
>(
  (event, state) => {
    console.log("addTask", event, state);
    const items = state.items;
    const task = event.detail?.message?.trim();
    if (task) items.push({ title: task, done: false });
  },
);

const addItem = handler<{ title: string }, { items: Cell<TodoItem[]> }>(
  ({ title }, { items }) => {
    items.push({ title, done: false });
  },
);

interface UpdateTitleEvent {
  detail: {
    value: string;
  };
}

const updateTitle = handler<UpdateTitleEvent, { title: Cell<string> }>(
  ({ detail }, { title }) => {
    title.set(detail?.value ?? "untitled");
  },
);

interface UpdateItemEvent {
  detail: {
    checked: boolean;
    value: string;
  };
}

const updateItem = handler<UpdateItemEvent, { item: Cell<TodoItem> }>(
  ({ detail }, { item }) => {
    item.update({ done: detail.checked, title: detail.value });
  },
);

const deleteItem = handler<
  unknown,
  { items: Cell<TodoItem[]>; item: TodoItem }
>(
  (_, { item, items }) => {
    const idx = items.get().findIndex((i) => i.title === item.title);
    if (idx !== -1) {
      // THIS IS UGLY AND SLOW.
      items.set([...items.get().slice(0, idx), ...items.get().slice(idx + 1)]);
    }
  },
);

export default recipe<RecipeInput>(
  "todo list",
  ({ title, items }) => {
    derive(items, (items) => {
      console.log("todo list items changed", JSON.stringify(items));
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
            {items.map((item) => (
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
    };
  },
);
