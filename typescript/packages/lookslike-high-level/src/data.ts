// This file is setting up example data
import { signal } from "@commontools/common-frp";
import { Gem } from "./recipe.js";
const { state } = signal;

import { todoList, makeTodoItem } from "./recipes/todo-list.js";
import { localSearch } from "./recipes/local-search.js";
import { luftBnBSearch } from "./recipes/luft-bnb-search.js";

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
  {
    name: "Find a LuftBnB place to stay",
    recipe: luftBnBSearch,
    inputs: { ...getFridayAndMondayDateStrings(), location: "" },
  },
];

// Helper for mock data
function getFridayAndMondayDateStrings() {
  const today = new Date();
  const daysUntilFriday = (5 - today.getDay() + 7) % 7;

  const nextFriday = new Date(
    today.getTime() + daysUntilFriday * 24 * 60 * 60 * 1000
  );
  const followingMonday = new Date(
    nextFriday.getTime() + 3 * 24 * 60 * 60 * 1000
  );

  const formatDate = (date: Date): string => {
    return date.toISOString().split("T")[0];
  };

  return {
    startDate: formatDate(nextFriday),
    endDate: formatDate(followingMonday),
  };
}
