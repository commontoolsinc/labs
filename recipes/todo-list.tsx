/// <cts-enable />
import {
  Cell,
  Default,
  derive,
  h,
  handler,
  NAME,
  recipe,
  UI,
} from "commontools";

type TodoItem = {
  title: Default<string, "">;
  done: Default<boolean, false>;
};

type TodoList = {
  title: Default<string, "untitled">;
  items: Default<TodoItem[], []>;
};

const addTask = handler<
  { detail: { message: string } },
  { items: Cell<TodoItem[]> }
>(
  (event, { items }) => {
    const task = event.detail?.message?.trim();
    if (task) items.push({ title: task, done: false });
  },
);

const addItem = handler<{ title: string }, { items: Cell<TodoItem[]> }>(
  ({ title }, { items }) => {
    items.push({ title, done: false });
  },
);

const updateTitle = handler<
  { detail: { value: string } },
  { title: Cell<string> }
>(
  ({ detail }, state) => {
    state.title.set(detail?.value ?? "untitled");
  },
);

const updateItem = handler<
  { detail: { checked: boolean; value: string } },
  { item: TodoItem }
>(({ detail }, { item }) => {
  (item as any).done = detail.checked;
  (item as any).title = detail.value;
});

const deleteItem = handler<never, { items: Cell<TodoItem[]>; item: TodoItem }>(
  (_, { item, items }) => {
    const data = [...items.get()];
    const idx = data.findIndex((i) => i.title === item.title);
    if (idx !== -1) {
      data.splice(idx, 1);
      console.log("deleted item", item, data);
      items.set(data);
    }
  },
);

export default recipe<TodoList>("todo list", ({ title, items }) => {
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
});
