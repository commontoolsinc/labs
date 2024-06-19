import { view, tags } from "@commontools/common-ui";
import { signal, Cancel } from "@commontools/common-frp";
import { recipe } from "../recipe.js";
const { binding } = view;
const { div } = tags;
const { state, effect } = signal;

// TODO: detailUI as input is so we can overwrite it, but it should be an output
// that is then replacing another signal in the caller.
export const todoListAsTask = recipe("todo list as task", ({ list, done }) => {
  const summary = state("no summary");

  let todoItemsListenerCancel: Cancel;
  const todoTasksListenerCancel: Cancel[] = [];

  // TODO: The signal machinery should take care of cleaning up listeners.
  // Maybe we should be able to express inputs as paths and have the system
  // walk the signals.
  effect(
    [list],
    (list: {
      items: signal.Signal<
        {
          title: signal.Signal<string>;
          done: signal.Signal<boolean>;
        }[]
      >;
    }) => {
      if (todoItemsListenerCancel) todoItemsListenerCancel();
      todoItemsListenerCancel = effect([list.items], (items) => {
        while (todoTasksListenerCancel.length) todoTasksListenerCancel.pop()!();

        const allTitles = items.map((item) => item.title);
        const allDones = items.map((item) => item.done);
        todoTasksListenerCancel.push(
          effect(allTitles, (...titles) => {
            const newSummary =
              titles.splice(0, 3).join(", ") +
              (titles.length > 0 ? ", ..." : "");
            // TODO: setTimeout shouldn't be necessary
            setTimeout(() => summary.send(newSummary));
          })
        );
        todoTasksListenerCancel.push(
          effect(allDones, (...dones) => {
            // TODO: setTimeout shouldn't be necessary
            setTimeout(() => done.send(dones.every((done: boolean) => done)));
          })
        );
      });
    }
  );

  const UI = [div({}, binding("summary")), { summary }];

  return {
    UI,
    list,
    done,
  };
});
