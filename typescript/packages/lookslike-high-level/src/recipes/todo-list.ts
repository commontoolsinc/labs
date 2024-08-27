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
  //items.setDefault([]);

  const newTasks = handler<
    { detail: { message: string } },
    { items: TodoItem[] }
  >({ items }, (event, { items }) => {
    const task = event.detail?.message?.trim();
    if (task) items.push({ title: task, done: false });
  });

  return {
    [UI]: html`
      <vstack gap="sm">
        <common-input
          value=${title}
          placeholder="List title"
          @common-input#value=${title}
        ></common-input>
        <vstack gap="sm">
          ${items.map(
            (item: TodoItem) => html`
              <vstack gap="sm">
                <todo
                  checked=${item.done}
                  value=${item.title}
                  @todo-checked#checked=${item.done}
                  @todo-input#value=${item.title}
                >
                  ${
                    /*<annotation
                    query=${item.title}
                    target=${id}
                    data=${{ items, done: item.done, title: item.title }}
                  ></annotation>*/ ""
                  }
                </todo>
              </vstack>
            `
          )}
        </vstack>
        <send-input
          name="Add"
          placeholder="New task"
          appearance="rounded"
          @messageSend="${newTasks}"
        ></send-input>
      </vstack>
    `,
    title,
    items,
    [NAME]: apply({ title }, (title) => title || "untitled"),
  };
});
