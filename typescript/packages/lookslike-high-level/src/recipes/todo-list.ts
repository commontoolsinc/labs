import { html } from "@commontools/common-html";
import { recipe, apply, handler, UI, NAME } from "../builder/index.js";

export interface TodoItem {
  title: string;
  done: boolean;
}

export const todoList = recipe<{
  title: string;
  items: TodoItem[];
}>("todo list", ({ title, items }) => {
  title.setDefault("untitled");
  items.setDefault([]);

  const newTasks = handler<
    { detail: { message: string } },
    { items: TodoItem[] }
  >({ items }, (event, { items }) => {
    const task = event.detail?.message?.trim();
    if (task) items.push({ title: task, done: false });
  });

  return {
    [UI]: html`
      <common-vstack gap="sm">
        <common-input
          value=${title}
          placeholder="List title"
          oncommon-input=${handler({ title }, ({ detail }, state) => {
            state.title = detail.value;
          })}
          @common-input#value=${title}
        ></common-input>
        <common-vstack gap="sm">
          ${items.map(
            (item: TodoItem) => html`
              <common-vstack gap="sm">
                <common-todo
                  checked=${item.done}
                  value=${item.title}
                  ontodo-checked=${handler({ item }, ({ detail }, { item }) => {
                    item.done = detail.done;
                  })}
                  ontodo-input=${handler({ item }, ({ detail }, { item }) => {
                    item.title = detail.value;
                  })}
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
          onmessagesend="${newTasks}"
        ></send-input>
      </common-vstack>
    `,
    title,
    items,
    [NAME]: apply({ title }, ({ title }) => title || "untitled"),
  };
});
