import { view, tags } from "@commontools/common-ui";
import { signal, stream } from "@commontools/common-frp";
import { recipe } from "../recipe.js";
import { annotation } from "../components/annotation.js";
const { binding, repeat } = view;
const { vstack, hstack, checkbox, div, include, sendInput } = tags;
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
      vstack({}, [
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
  const toggle = subject<any>();

  toggle.sink({
    send: () => {
      done.send(!done.get());
    },
  });
  return {
    itemUI: state([
      vstack({}, [
        hstack({}, [
          checkbox({ "@change": binding("toggle"), checked: binding("done") }),
          div({}, binding("title")),
        ]),
        annotation({
          query: title,
          data: { done, title },
        }),
      ]),
      { done, title, toggle },
    ]),
    done,
    title,
  };
});
