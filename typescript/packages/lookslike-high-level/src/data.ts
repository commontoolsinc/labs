// This file is setting up example data
import { signal } from "@commontools/common-frp";
import { Gem } from "./recipe.js";
const { state } = signal;

import { todoList, makeTodoItem } from "./recipes/todo-list.js";
import { localSearch } from "./recipes/local-search.js";

import "./recipes/todo-list-as-task.js"; // Necessary, so that suggestions are indexed.

export const dataGems = state<Gem[]>([]);

export function addGems(gems: Gem[]) {
  dataGems.send([...dataGems.get(), ...gems]);
}

addGems([
  todoList({
    title: "My TODOs",
    items: ["Buy groceries", "Walk the dog", "Wash the car"].map((item) =>
      makeTodoItem(item)
    ),
  }),
  todoList({
    title: "My grocery shopping list",
    items: ["milk", "eggs", "bread"].map((item) => makeTodoItem(item)),
  }),
]);

export type RecipeManifest = {
  name: string;
  recipe: (inputs: Record<string, any>) => Gem;
  inputs: Record<string, any>;
};

export const recipes: RecipeManifest[] = [
  {
    name: "Create a new TODO list",
    recipe: todoList,
    inputs: { title: "", items: [] },
  },
  {
    name: "Find places",
    recipe: localSearch,
    inputs: { query: "", location: "" },
  },
];
