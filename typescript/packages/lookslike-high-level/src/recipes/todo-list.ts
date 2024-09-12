import { html } from "@commontools/common-html";
import { recipe, handler, UI, NAME } from "../builder/index.js";

export interface TodoItem {
  title: string;
  done: boolean;
}

const addTask = handler<{ detail: { message: string } }, { items: TodoItem[] }>(
  (event, { items }) => {
    const task = event.detail?.message?.trim();
    if (task) items.push({ title: task, done: false });
  }
);

const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
  ({ detail }, state) => (state.title = detail.value)
);

const updateItem = handler<
  { detail: { done: boolean; value: string } },
  { item: TodoItem }
>(({ detail }, { item }) => {
  item.done = detail.done;
  item.title = detail.value;
});

export const todoList = recipe<{
  title: string;
  items: TodoItem[];
}>("todo list", ({ title, items }) => {
  title.setDefault("untitled");
  items.setDefault([]);

  return {
    [UI]: html`
      <common-vstack gap="sm">
        <common-input
          value=${title}
          placeholder="List title"
          oncommon-input=${updateTitle({ title })}
          @common-input#value=${title}
        ></common-input>
        <common-vstack gap="sm">
          ${items.map(
            (item: TodoItem) => html`
              <common-vstack gap="sm">
                <common-todo
                  checked=${item.done}
                  value=${item.title}
                  ontodo-checked=${updateItem({ item })}
                  ontodo-input=${updateItem({ item })}
                >
                  <common-annotation
                    query=${item.title}
                    data=${{ task: item }}
                  />
                </common-todo>
              </common-vstack>
            `
          )}
        </common-vstack>
        <common-send-message
          name="Add"
          placeholder="New task"
          appearance="rounded"
          onmessagesend="${addTask({ items })}"
        ></send-input>
      </common-vstack>
    `,
    title,
    items,
    [NAME]: title,
  };
});
