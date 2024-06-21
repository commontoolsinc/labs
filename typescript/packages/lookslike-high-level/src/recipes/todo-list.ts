import { view, tags } from "@commontools/common-ui";
import { signal, stream } from "@commontools/common-frp";
import { recipe } from "../recipe.js";
import { annotation } from "../components/annotation.js";
const { binding, repeat } = view;
const { list, vstack, hstack, checkbox, div, include, sendInput, todo } = tags;
const { state } = signal;
const { subject } = stream;

export const todoList = recipe("todo list", ({ items }) => {
  const newTasks = subject<{
    type: "messageSend";
    detail: { message: string };
  }>();

  newTasks.sink({
    send: (event) => {
      const task = event.detail?.message?.trim();
      if (!task) return;
      items.send([...items.get(), todoTask({ title: task, done: false })]);
    },
  });

  return {
    UI: [
      list({}, [
        vstack({}, repeat("items", include({ content: binding("itemUI") }))),
        sendInput({
          name: "Add",
          placeholder: "New task",
          "@messageSend": binding("newTasks"),
        }),
      ]),
      { items, newTasks },
    ],
    items,
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
    itemUI: state([
      vstack({}, [
        todo({
          checked: binding("done"),
          value: binding("title"),
          "@todo-checked": binding("update"),
          "@todo-input": binding("update"),
        }),
        annotation({
          query: title,
          data: { done, title },
        }),
      ]),
      { done, title, update },
    ]),
    done,
    title,
  };
});
