import { html } from "@commontools/common-html";
import { recipe, lift, ID, UI } from "../builder/index.js";
import { addSuggestion, description } from "../suggestions.js";
import { type TodoItem } from "./todo-list.js";

const getListSummary = lift((items: TodoItem[]) => {
  const notDoneTitles = items.flatMap((item) =>
    item.done ? [] : [item.title]
  );

  return (
    items.length +
    " items. " +
    (notDoneTitles.length
      ? "Open tasks: " + notDoneTitles.join(", ")
      : "All done.")
  );
});

const allDone = lift((items: TodoItem[]) => items.every((item) => item.done));

export const todoListAsTask = recipe<{
  list: { [ID]: number; [UI]: any; items: TodoItem[] };
  task: TodoItem;
}>("todo list as task", ({ list, task }) => {
  task.done = allDone(list.items);

  return {
    [UI]: html` <details>
      <summary>
        <common-vstack gap="sm">
          <span>${getListSummary(list.items)}</span>
          <common-saga-link saga=${list[ID]} />
        </common-vstack>
      </summary>
      ${list[UI]}
    </details>`,
  };
});

addSuggestion({
  description: description`Add 💎${"list"} as sub tasks`,
  recipe: todoListAsTask,
  bindings: { task: "task" },
  dataGems: {
    list: "todo list",
  },
});
