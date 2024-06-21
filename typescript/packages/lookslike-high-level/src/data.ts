// This file is setting up example data
import { signal } from "@commontools/common-frp";
import { Gem, NAME } from "./recipe.js";
const { state } = signal;

import { todoList, todoTask } from "./recipes/todo-list.js";
import "./recipes/todo-list-as-task.js"; // Necessary, so that suggestions are indexed.
import { todo } from "@commontools/common-ui/tags.js";

export const keywords: { [key: string]: string[] } = {
  groceries: ["grocery list"],
};

export const dataGems = state<Gem[]>([]);

export function addGems(gems: Gem[]) {
  dataGems.send([...dataGems.get(), ...gems]);
}

addGems([
  todoList({
    title: "My TODOs",
    items: ["Buy groceries", "Walk the dog", "Wash the car"].map((item) =>
      todoTask({
        title: item,
        done: false,
      })
    ),
  }),
  todoList({
    title: "My grocery shopping list",
    items: ["milk", "eggs", "bread"].map((item) =>
      todoTask({
        title: item,
        done: false,
      })
    ),
  }),
]);

export const recipes = {
  "Create a new TODO list": {
    recipe: todoList,
    inputs: { title: "", items: [] },
  },
};
