import { html } from "@commontools/common-html";
import { recipe, handler, UI, NAME, lift } from "@commontools/common-builder";

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
  ({ detail }, state) => (state.title = detail?.value ?? "untitled")
);

const toggleAll = handler<{}, { items: TodoItem[] }>(
  ({ }, { items }) => {
    items.forEach((item) => {
      item.done = !item.done;
      item.title += " T";
    });
  }
);

const getListSummary = lift(({ items }) => {
  const notDoneTitles = items.flatMap((item) =>
    item.done ? [] : [item.title]
  );

  return (
    notDoneTitles.length + ' of ' +
    items.length +
    " items completed." +
    (notDoneTitles.length
      ? " Open tasks: " + notDoneTitles.join(", ")
      : "")
  );
});

// const logger = lift(({obj}) => {
//   console.log("logger", obj);
// });

const updateItem = handler<
  { detail: { checked: boolean; value: string } },
  { item: TodoItem }
>(({ detail }, { item }) => {
  item.done = detail.checked;
  item.title = detail.value;
});

export const todoList = recipe<{
  title: string;
  items: TodoItem[];
}>("todo list", ({ title, items }) => {
  title.setDefault("untitled");
  items.setDefault([]);

  // logger({ obj: items });

  return {
    [UI]: html`
      <common-vstack gap="sm">
        <common-input
          value=${title}
          placeholder="List title"
          oncommon-input=${updateTitle({ title })}
        ></common-input>
        ${getListSummary({ items })}
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
        <button
          onclick=${toggleAll({ items })}
        >
          Toggle all done
        </button>
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
