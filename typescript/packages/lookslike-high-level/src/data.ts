// This file is setting up example data

import { todoList, todoTask } from "./recipes/todo-list.js";

export const dataGems = {
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
};

export const keywords = {
  groceries: ["grocery list"],
};

/* TODO:

- finish todo list recipe
- make a task wrapper recipe around todo lists
  - binds to an item in the task list
  - renders a summary view
  - connects done state to all tasks being checked
- make a suggestion appear for that task wrapper and the grocery list
- add some pseudo type checking
- 
*/
