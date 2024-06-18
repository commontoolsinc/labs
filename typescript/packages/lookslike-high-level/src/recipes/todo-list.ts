import { view as viewImport, tags, render } from "@commontools/common-ui";
import { signal, stream } from "@commontools/common-frp";
import { suggestion } from "../suggestion.js";
import { recipe, Bindings } from "../recipe.js";
const { vstack, hstack, checkbox, div, include, sendInput } = tags;
const { state, computed } = signal;
const { subject, sink } = stream;
const { view, binding } = viewImport;

export const todoTask = recipe(({ title, done }) => {
  return {
    itemUI: state([
      vstack(
        {},
        hstack(
          {},
          checkbox({ checked: binding("done") }),
          div({} /*binding("title")*/)
        ),
        suggestion({ for: binding("title") })
      ),
      { done, title },
    ]),
    done,
    title,
  };
});

export const todoList = recipe(({ items }: Binding) => {
  const newTasks = subject<{ type: "input"; data: string }>();

  newTasks.sink({
    send: (event: { data: string }) => {
      items.update((items: any[]) => [
        ...items,
        todoTask({ title: event.data, done: false }),
      ]);
    },
  });

  return {
    UI: [
      vstack(
        {},
        ...items
          .get()
          .map((item: { itemUI: object }) => include({ content: item.itemUI })),
        sendInput({
          name: "Add",
          placeholder: "New task",
          "@input": binding("newTasks"),
        })
      ),
      { items, newTasks },
    ],
    items,
  };
});
