import { view, tags } from "@commontools/common-ui";
import { signal, stream } from "@commontools/common-frp";
import { recipe, NAME } from "../recipe.js";
import { annotation } from "../components/annotation.js";
const { repeat } = view;
const { vstack, sendInput, todo, commonInput } = tags;
const { state, computed } = signal;
const { subject } = stream;

export interface TodoItem {
  title: signal.Signal<string>;
  done: signal.Signal<boolean>;
}

export function makeTodoItem(title: string, done: boolean = false): TodoItem {
  return {
    title: typeof title === "string" ? state(title) : title,
    done: typeof done === "boolean" ? state(done) : done,
  };
}

export const todoList = recipe("todo list", ({ title, items }) => {
  const newTasks = subject<{ detail: { message: string } }>();
  newTasks.sink({
    send: (event) => {
      const task = event.detail?.message?.trim();
      if (!task) return;
      items.send([...items.get(), makeTodoItem(task)]);
    },
  });

  return {
    UI: vstack({}, [
      commonInput({
        value: title,
        placeholder: "List title",
        "@common-input#value": title,
      }),
      vstack(
        {
          gap: "sm"
        },
        repeat(items, (item: TodoItem) =>
          vstack({}, [
            todo(
              {
                checked: item.done,
                value: item.title,
                "@todo-checked#checked": item.done,
                "@todo-input#value": item.title,
              },
              [
                annotation({
                  query: item.title,
                  data: { items, done: item.done, title: item.title },
                }),
              ]
            ),
          ])
        )
      ),
      sendInput({
        name: "Add",
        placeholder: "New task",
        appearance: "rounded",
        "@messageSend": newTasks,
      }),
    ]),
    title,
    items,
    [NAME]: computed([title], (title) => title || "untitled"),
  };
});
