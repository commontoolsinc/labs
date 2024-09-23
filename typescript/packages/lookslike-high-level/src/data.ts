// This file is setting up example data

import { ID, TYPE, NAME, UI, Recipe } from "@commontools/common-builder";
import {
  run,
  cell,
  isCell,
  CellImpl,
  getCellReferenceOrValue,
} from "@commontools/common-runner";

import { todoList } from "./recipes/todo-list.js";
import { localSearch } from "./recipes/local-search.js";
import { luftBnBSearch } from "./recipes/luft-bnb-search.js";
import { ticket } from "./recipes/ticket.js";
import { routine } from "./recipes/routine.js";
import { fetchExample } from "./recipes/fetchExample.js";
import { counter } from "./recipes/counter.js";

// Necessary, so that suggestions are indexed.
import "./recipes/todo-list-as-task.js";
import "./recipes/playlist.js";
import {
  getCellReferenceOrThrow,
  isCellProxyForDereferencing,
} from "@commontools/common-runner";
import { fetchCollections } from "./recipes/fetchCollections.js";
import { iframeExample } from "./recipes/iframeExample.js";
import { arenaRecipes } from "./recipes/arena.js";

export type Charm = {
  [ID]: number;
  [NAME]?: string;
  [UI]?: any;
  [TYPE]?: string;
  [key: string]: any;
};

export { ID, TYPE, NAME, UI };

// TODO: TYPE is now obsolete. Do we still need this?
export function isCharm(value: any): value is Charm {
  return isCell(value) && ID in value.get() && TYPE in value.get();
}

export const charms = cell<CellImpl<Charm>[]>([]);

export function addCharms(newCharms: CellImpl<any>[]) {
  const currentCharms = charms.get();
  const currentIds = new Set(currentCharms.map((charm) => charm.get()[ID]));
  const charmsToAdd = newCharms.filter(
    (charm) => !currentIds.has(charm.get()[ID])
  );

  if (charmsToAdd.length > 0) {
    charms.send([...currentCharms, ...charmsToAdd]);
  }
}

addCharms([
  run(iframeExample, { title: "two way binding counter", prompt: "counter example using write and subscribe with key `counter`", data: { counter: 0 } }),
  run(iframeExample, { title: "breakout", prompt: "playable breakout/arkanoid, use `score` to write score, click to start, reset score at start", data: { score: 0, counter: 0 } }),
  run(arenaRecipes.fetchChannels, { title: "are.na", page: 1, per: 25 }),
  run(fetchExample, {
    url: "https://anotherjesse-restfuljsonblobapi.web.val.run/items",
  }),
  run(fetchCollections, {
    url: "/api/data/collections/"
  }),
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
  run(counter, { title: "Summer Reading" }),
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
  {
    name: "Create a counter",
    recipe: counter,
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

// Terrible hack to open a charm from a recipe
let openCharmOpener: (charmId: number) => void = () => {};
export const openCharm = (charmId: number) => openCharmOpener(charmId);
openCharm.set = (opener: (charmId: number) => void) => {
  openCharmOpener = opener;
};

export function launch(recipe: Recipe, bindings: any) {
  if (isCellProxyForDereferencing(bindings)) {
    const { cell, path } = getCellReferenceOrThrow(bindings);
    const keys = Object.keys(bindings);
    bindings = Object.fromEntries(
      keys.map((key) => [key, { cell, path: [...path, key] }])
    );
  } else {
    bindings = Object.fromEntries(
      Object.entries(bindings).map(([key, value]) => [
        key,
        getCellReferenceOrValue(value),
      ])
    );
  }
  const charm = run(recipe, bindings);
  openCharm(charm.get()[ID]);
}

(window as any).recipes = recipes;
(window as any).charms = charms;
