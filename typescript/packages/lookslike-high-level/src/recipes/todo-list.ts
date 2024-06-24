import { view, tags } from "@commontools/common-ui";
import { signal, stream } from "@commontools/common-frp";
import { recipe, NAME } from "../recipe.js";
import { annotation } from "../components/annotation.js";
const { binding, repeat } = view;
const { vstack, include, sendInput, todo, commonInput } = tags;
const { state, computed } = signal;
const { subject } = stream;

export const todoList = recipe("todo list", ({ title, items }) => {
  const newTasks = subject<{ detail: { message: string } }>();
  newTasks.sink({
    send: (event) => {
      const task = event.detail?.message?.trim();
      if (!task) return;
      items.send([...items.get(), todoTask({ title: task, done: false })]);
    },
  });

  return {
    UI: vstack({}, [
      commonInput({
        value: title,
        placeholder: "List title",
        "@common-input#value": title,
      }),
      vstack({}, repeat(items, include({ content: binding("UI") }))),
      sendInput({
        name: "Add",
        placeholder: "New task",
        "@messageSend": newTasks,
      }),
    ]),
    title,
    items,
    [NAME]: computed([title], (title) => title || "untitled"),
  };
});

export const todoTask = recipe("todo task", ({ title, done }) => {
  const update = subject<any>();

  update.sink({
    send: (event) => {
      done.send(!!event.detail?.checked);
      const newTitle = event.detail?.value?.trim();
      if (newTitle === undefined) return;
      title.send(newTitle);
    },
  });

  return {
    UI: state(
      vstack({}, [
        todo(
          {
            checked: done,
            value: title,
            "@todo-checked#checked": done,
            "@todo-input#value": title,
          },
          [
            annotation({
              query: title,
              data: { done, title },
            }),
          ]
        ),
      ])
    ),
    done,
    title,
  };
});
