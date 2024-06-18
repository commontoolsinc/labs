import { render } from "@commontools/common-ui";
import { todoList } from "./recipes/todo-list.js";

const todoItems = [
  { id: 1, title: "Buy groceries", done: false },
  { id: 2, title: "Walk the dog", done: true },
  { id: 3, title: "Wash the car", done: false },
];

const todos = todoList({ items: todoItems });

console.log("todos.UI", todos.UI);
console.log("todos.items", todos.items.get());

const element = render.render(todos.UI[0], todos.UI[1]);

document.body.appendChild(element);
