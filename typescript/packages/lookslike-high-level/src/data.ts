// This file is setting up example data
import { signal } from "@commontools/common-frp";
const { state } = signal;

import { todoList, todoTask } from "./recipes/todo-list.js";
import { todoListAsTask } from "./recipes/todo-list-as-task.js";
import { Recipe, InstantiatedRecipe } from "./recipe.js";

export const keywords: { [key: string]: string[] } = {
  groceries: ["grocery list"],
};

export const dataGems = state<{ [key: string]: InstantiatedRecipe }>({});
dataGems.send({
  "todo list": todoList({
    items: ["Buy groceries", "Walk the dog", "Wash the car"].map((item) =>
      todoTask({
        title: item,
        done: false,
      })
    ),
  }),
  "grocery list": todoList({
    items: ["milk", "eggs", "bread"].map((item) =>
      todoTask({
        title: item,
        done: false,
      })
    ),
  }),
});

export type Suggestion = {
  // Description of the suggestion
  description: string[];

  // Recipe to run when the suggestion is clicked
  recipe: Recipe;

  // Map from locally available data to recipe input:
  bindings: { [key: string]: string };

  // Map from globally available data type to recipe input:
  dataGems: { [key: string]: string };
};

export const suggestions: Suggestion[] = [
  {
    description: ["Add ", "list", " as sub tasks"],
    recipe: todoListAsTask,
    bindings: { done: "done" },
    dataGems: {
      "todo list": "list",
    },
  },
];

/* TODO:

[x] finish todo list recipe
[x] make a task wrapper recipe around todo lists
  [x] binds to an item in the task list
  [x] renders a summary view
  [x] connects done state to all tasks being checked
[ ] make a suggestion appear for that task wrapper and the grocery list
[ ] add some pseudo type checking
[ ]
*/
