// This file is setting up example data

import { ID, TYPE, NAME, UI, Recipe } from "./builder/index.js";
import { run, cell, isCell, CellImpl } from "./runner/index.js";

import { todoList } from "./recipes/todo-list.js";
import { localSearch } from "./recipes/local-search.js";
import { luftBnBSearch } from "./recipes/luft-bnb-search.js";
import { ticket } from "./recipes/ticket.js";
import { routine } from "./recipes/routine.js";

// Necessary, so that suggestions are indexed.
import "./recipes/todo-list-as-task.js";
import "./recipes/playlist.js";

export type Gem = {
  [ID]: number;
  [NAME]?: string;
  [UI]?: any;
  [key: string]: any;
};

export { ID, TYPE, NAME, UI };

// TODO: TYPE is now obsolete. Do we still need this?
export function isGem(value: any): value is Gem {
  return isCell(value) && ID in value.get() && TYPE in value.get();
}

export const dataGems = cell<CellImpl<Gem>[]>([]);

export function addGems(gems: CellImpl<any>[]) {
  console.log("addGems", dataGems.get(), gems);
  dataGems.send([...dataGems.get(), ...gems]);
}

addGems([
  run(todoList, {
    title: "My TODOs",
    items: ["Buy groceries", "Walk the dog", "Wash the car"].map((item) => ({
      title: item,
      done: false,
    })),
  }),
  run(todoList, {
    title: "My grocery shopping list",
    items: ["milk", "eggs", "bread"].map((item) => ({
      title: item,
      done: false,
    })),
  }),
  run(ticket, {
    title: "Reservation for 'Counterstrike the Musical'",
    show: "Counterstrike the Musical",
    date: getFridayAndMondayDateStrings().startDate,
    location: "New York",
  }),
  run(routine, {
    title: "Morning routine",
    // TODO: A lot more missing here, this is just to drive the suggestion.
    locations: ["coffee shop with great baristas"],
  }),
]);

export type RecipeManifest = {
  name: string;
  recipe: Recipe;
};

export const recipes: RecipeManifest[] = [
  {
    name: "Create a new TODO list",
    recipe: todoList,
  },
  {
    name: "Find places",
    recipe: localSearch,
  },
  {
    name: "Find a LuftBnB place to stay",
    recipe: luftBnBSearch,
  },
];
(window as any).recipes = recipes;

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

// Terrible hack to open a saga from a recipe
let openSagaOpener: (sagaId: number) => void = () => {};
export const openSaga = (sagaId: number) => openSagaOpener(sagaId);
openSaga.set = (opener: (sagaId: number) => void) => {
  openSagaOpener = opener;
};
