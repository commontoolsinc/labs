import { html } from "@commontools/common-html";
import { recipe, lift, ID } from "../builder/index.js";
import { addSuggestion, description } from "../suggestions.js";
import { type TodoItem } from "./todo-list.js";

// TODO: detailUI as input is so we can overwrite it, but it should be an output
// that is then replacing another signal in the caller.
export const todoListAsTask = recipe<{
  list: { [ID]: number; items: TodoItem[] };
  task: TodoItem;
}>("todo list as task", ({ list, task }) => {
  const listSummary = lift((items: TodoItem[]) => {
    const notDoneTitles = items.flatMap((item) =>
      item.done ? [] : [item.title]
    );
    return (
      items.length +
      " items. " +
      (notDoneTitles.length
        ? "Open tasks: " +
          notDoneTitles.splice(0, 3).join(", ") +
          (notDoneTitles.length > 0 ? ", ..." : "")
        : "All done.")
    );
  })(list.items);

  task.done = lift((items: TodoItem[]) => items.every((item) => item.done))(
    list.items
  );

  const UI = html`
    <details>
      <summary>
        <common-vstack gap="sm">
          <common-saga-link saga=${list[ID]}>
          <span>${listSummary}</span>
        </common-vstack>
      </summary>
      ${list}
    </details>
  `;
  return {
    UI,
    list,
    task,
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
