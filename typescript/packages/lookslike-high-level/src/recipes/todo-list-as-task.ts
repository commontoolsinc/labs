import { html } from "@commontools/common-html";
import { recipe, lift, ID, UI } from "../builder/index.js";
import { addSuggestion, description } from "../suggestions.js";
import { type TodoItem } from "./todo-list.js";

// TODO: detailUI as input is so we can overwrite it, but it should be an output
// that is then replacing another signal in the caller.
export const todoListAsTask = recipe<{
  list: { [ID]: number; [UI]: any; items: TodoItem[] };
  task: TodoItem;
}>("todo list as task", ({ list, task }) => {
  const listSummary = lift((items: TodoItem[]) => {
    const notDoneTitles = items.flatMap((item) =>
      item.done ? [] : [item.title]
    );

    const summary =
      items.length +
      " items. " +
      (notDoneTitles.length
        ? "Open tasks: " +
          notDoneTitles.splice(0, 3).join(", ") +
          (notDoneTitles.length > 0 ? ", ..." : "")
        : "All done.");

    return summary;
  })(list.items);

  task.done = lift((items: TodoItem[]) => items.every((item) => item.done))(
    list.items
  );

  const listId = lift((list: { [ID]: number }) => list[ID])(list);
  const listUI = lift((list: { [UI]: any }) => list[UI])(list);

  return {
    [UI]: html` <details>
      <summary>
        <common-vstack gap="sm">
          <span>${listSummary}</span>
          <common-saga-link saga=${listId} />
          <span>${listId}</span>
        </common-vstack>
      </summary>
      ${listUI}
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
