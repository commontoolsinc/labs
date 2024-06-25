import { tags, render } from "@commontools/common-ui";
import { signal, Cancel } from "@commontools/common-frp";
import { Gem, recipe, description, addSuggestion, NAME } from "../recipe.js";
import { sagaLink } from "../components/saga-link.js";
const { include, vstack, span } = tags;
const { state, effect, computed } = signal;

const details = render.view("details", {});
const summary = render.view("summary", {});

// TODO: detailUI as input is so we can overwrite it, but it should be an output
// that is then replacing another signal in the caller.
export const todoListAsTask = recipe("todo list as task", ({ list, done }) => {
  const listSummary = state("no summary");

  let todoItemsListenerCancel: Cancel;
  let todoTasksListenerCancel: Cancel;

  // TODO: The signal machinery should take care of cleaning up listeners.
  // Maybe we should be able to express inputs as paths and have the system
  // walk the signals.
  effect(
    [list],
    (list: {
      [NAME]: string;
      items: signal.Signal<
        {
          title: signal.Signal<string>;
          done: signal.Signal<boolean>;
        }[]
      >;
    }) => {
      if (todoItemsListenerCancel) todoItemsListenerCancel();
      todoItemsListenerCancel = effect([list.items], (items) => {
        if (todoTasksListenerCancel) todoTasksListenerCancel;

        const allItems = items.flatMap((item) => [item.title, item.done]);
        todoTasksListenerCancel = effect(allItems, (...allItems) => {
          const items = [];
          while (allItems.length)
            items.push({ title: allItems.shift(), done: allItems.shift() });
          const notDoneTitles = items.flatMap((item) =>
            item.done ? [] : [item.title]
          );
          const newSummary =
            items.length +
            " items. " +
            (notDoneTitles.length
              ? "Open tasks: " +
                notDoneTitles.splice(0, 3).join(", ") +
                (notDoneTitles.length > 0 ? ", ..." : "")
              : "All done.");

          const allDone = items.every((item) => item.done);

          // TODO: setTimeout shouldn't be necessary
          setTimeout(() => listSummary.send(newSummary));
          setTimeout(() => done.send(allDone));
        });
      });
    }
  );

  const fullUI = computed([list], (list: Gem) => list["UI"]);

  const UI = details({}, [
    summary({}, [
      vstack({gap: 'sm'}, [sagaLink({ saga: list }), span({}, listSummary)]),
    ]),
    include({ content: fullUI }),
  ]);
  return {
    UI,
    list,
    done,
  };
});

addSuggestion({
  description: description`Add 💎${"list"} as sub tasks`,
  recipe: todoListAsTask,
  bindings: { done: "done" },
  dataGems: {
    list: "todo list",
  },
});
