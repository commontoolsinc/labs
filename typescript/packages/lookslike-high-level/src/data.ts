// This file is setting up example data
import { ID } from "./recipe.js";

import todoList from "./recipes/todo-list.js";

export const dataGems = {
  "grocery list": todoList({
    items: ["milk", "eggs", "bread"].map((item) => ({
      title: item,
      done: false,
    })),
  }),
};

export const keywords = {
  groceries: ["grocery list"],
};

/* TODO:

- finish todo list recipe
- make a task wrapper recipe around todo lists
  - renders a summary view
  - connects done state to all tasks being checked
- make a suggestion appear for that task wrapper and the grocery list
- add some pseudo type checking
- 
*/
