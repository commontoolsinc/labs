import { view, tags } from "@commontools/common-ui";
import { stream } from "@commontools/common-frp";
import { recipe } from "../recipe.js";
import { suggestion } from "../suggestion.js";
const { binding, repeat } = view;
const { vstack, hstack, checkbox, div, include, sendInput } = tags;
const { subject } = stream;

export const todoList = recipe(({ items }) => {
  const newTasks = subject<{
    type: "messageSend";
    detail: { message: string };
  }>();

  newTasks.sink({
    send: (event) => {
      console.log("event", event);
      items.send([
        ...items.get(),
        todoTask({ title: event.detail.message, done: false }),
      ]);
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

export const todoTask = recipe(({ title, done }) => {
  return {
    itemUI: [
      vstack({}, [
        hstack({}, [
          checkbox({ checked: binding("done") }),
          div({}, binding("title")),
        ]),
        suggestion({ for: binding("title") }),
      ]),
      { done, title },
    ],
    done,
    title,
  };
});
