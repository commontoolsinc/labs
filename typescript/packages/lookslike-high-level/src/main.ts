import { view as viewImport, tags, render } from "@commontools/common-ui";
import { signal, stream } from "@commontools/common-frp";
import { suggestion } from "./suggestion.js";
import { recipe } from "./recipe.js";
const { dict, datatable, vstack, hstack, checkbox, div, include } = tags;
const { isSignal, state, computed } = signal;
const { view, binding } = viewImport;

const task = recipe(({ title, done }: viewImport.Bindings) => {
  return {
    itemVDom: [
      vstack(
        {},
        hstack(
          {},
          checkbox({ checked: binding("done") }),
          div({} /*binding("title")*/)
        ),
        suggestion({})
      ),
      { done, title },
    ],
    done,
    title,
  };
});

const todoItems = [
  { title: "Buy groceries", done: false },
  { title: "Walk the dog", done: true },
  { title: "Wash the car", done: false },
];

const todos = vstack(
  {},
  ...todoItems.map((item) => hstack({}, checkbox({}), div({}, item.title)))
);

const tree = vstack({}, todos, datatableNode, dictNode);

const element = render.render(tree, {});

document.body.appendChild(element);
