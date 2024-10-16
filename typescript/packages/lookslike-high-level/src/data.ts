// This file is setting up example data

import { TYPE, NAME, UI, Recipe } from "@commontools/common-builder";
import {
  run,
  cell,
  getEntityId,
  CellImpl,
  raw,
  addModuleByRef,
  type ReactivityLog,
} from "@commontools/common-runner";

import { todoList } from "./recipes/todo-list.js";
import { localSearch } from "./recipes/local-search.js";
import { luftBnBSearch } from "./recipes/luft-bnb-search.js";
import { ticket } from "./recipes/ticket.js";
import { routine } from "./recipes/routine.js";
import { fetchExample } from "./recipes/fetchExample.js";
import { counter } from "./recipes/counter.js";
import { counters } from "./recipes/counters.js";

// Necessary, so that suggestions are indexed.
import "./recipes/todo-list-as-task.js";
import "./recipes/playlist.js";
import { iframe } from "./recipes/iframe.js";
import { search } from "./recipes/search.js";
import { importCalendar } from "./recipes/importCalendar.js";
import { dungeon } from "./recipes/dungeon.js";
import { dataDesigner } from "./recipes/dataDesigner.js";
import { jsonImporter } from "./recipes/jsonImport.js";
import { prompt } from "./recipes/prompts.js";
import { wiki } from "./recipes/wiki.js";
import { helloIsolated } from "./recipes/helloIsolated.js";
import { queryCollections } from "./recipes/queryCollections.js";

export type Charm = {
  [NAME]?: string;
  [UI]?: any;
  [TYPE]?: string;
  [key: string]: any;
};

export { TYPE, NAME, UI };

export const charms = cell<CellImpl<Charm>[]>([]);

export function addCharms(newCharms: CellImpl<any>[]) {
  const currentCharms = charms.get();
  const currentIds = new Set(
    currentCharms.map((charm) => JSON.stringify(charm.entityId)),
  );
  const charmsToAdd = newCharms.filter(
    (charm) => !currentIds.has(JSON.stringify(charm.entityId)),
  );

  if (charmsToAdd.length > 0) {
    charms.send([...currentCharms, ...charmsToAdd]);
  }
}

export function setCharms(newCharms: CellImpl<any>[]) {
  charms.send([...newCharms]);
}

function createCellWithCausalId(name: string) {
  const newCell = cell();
  newCell.generateEntityId(name);
  return newCell;
}

addCharms([
  run(
    iframe,
    {
      title: "two way binding counter",
      prompt: "counter",
      data: { counter: 0 },
    },
    createCellWithCausalId("iframe"),
  ),
  run(importCalendar, {}, createCellWithCausalId("importCalendar")),
  run(
    search,
    {
      query: "home",
    },
    createCellWithCausalId("search"),
  ),
  run(
    queryCollections,
    {
      collectionName: "home",
    },
    createCellWithCausalId("queryCollections"),
  ),
  run(
    todoList,
    {
      title: "My TODOs",
      items: ["Buy groceries", "Walk the dog", "Wash the car"].map((item) => ({
        title: item,
        done: false,
      })),
    },
    createCellWithCausalId("todoList"),
  ),
  run(
    todoList,
    {
      title: "My grocery shopping list",
      items: ["milk", "eggs", "bread"].map((item) => ({
        title: item,
        done: false,
      })),
    },
    createCellWithCausalId("todoList"),
  ),
  run(
    ticket,
    {
      title: "Reservation for 'Counterstrike the Musical'",
      show: "Counterstrike the Musical",
      date: getFridayAndMondayDateStrings().startDate,
      location: "New York",
    },
    createCellWithCausalId("ticket"),
  ),
  run(
    routine,
    {
      title: "Morning routine",
      // TODO: A lot more missing here, this is just to drive the suggestion.
      locations: ["coffee shop with great baristas"],
    },
    createCellWithCausalId("routine"),
  ),
  run(counters, {}, createCellWithCausalId("counters")),
]);

export type RecipeManifest = {
  name: string;
  recipeId: string;
};

// TODO: Make this a map of hashes that get persisted
export const recipeById = new Map<string, Recipe>();

let unknownCounter = 0;
function addRecipe(recipe: Recipe) {
  const id =
    (recipe.schema as { description: string })?.description ??
    `unknown-${unknownCounter++}`;

  recipeById.set(id, recipe);

  return id;
}

export const recipes: RecipeManifest[] = [
  {
    name: "Explore dungeon game",
    recipeId: addRecipe(dungeon),
  },
  {
    name: "Create a new TODO list",
    recipeId: addRecipe(todoList),
  },
  {
    name: "Find places",
    recipeId: addRecipe(localSearch),
  },
  {
    name: "Find a LuftBnB place to stay",
    recipeId: addRecipe(luftBnBSearch),
  },
  {
    name: "JSON Importer",
    recipeId: addRecipe(jsonImporter),
  },
  {
    name: "Data Designer",
    recipeId: addRecipe(dataDesigner),
  },
  {
    name: "Create a counter",
    recipeId: addRecipe(counter),
  },
  {
    name: "Fetch JSON from a URL",
    recipeId: addRecipe(fetchExample),
  },
  {
    name: "Explore imagery prompts",
    recipeId: addRecipe(prompt),
  },
  {
    name: "Explore Halucinated wiki",
    recipeId: addRecipe(wiki),
  },
  {
    name: "Hello Isolated",
    recipeId: addRecipe(helloIsolated),
  },
];

// Helper for mock data
function getFridayAndMondayDateStrings() {
  const today = new Date();
  const daysUntilFriday = (5 - today.getDay() + 7) % 7;

  const nextFriday = new Date(
    today.getTime() + daysUntilFriday * 24 * 60 * 60 * 1000,
  );
  const followingMonday = new Date(
    nextFriday.getTime() + 3 * 24 * 60 * 60 * 1000,
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
let openCharmOpener: (charmId: string) => void = () => {};
export const openCharm = (charmId: string) => openCharmOpener(charmId);
openCharm.set = (opener: (charmId: string) => void) => {
  openCharmOpener = opener;
};

addModuleByRef(
  "navigateTo",
  raw((inputsCell: CellImpl<any>) => (log: ReactivityLog) => {
    // HACK to follow the cell references to the entityId
    const entityId = getEntityId(inputsCell.getAsProxy([], log));
    if (entityId) openCharm(JSON.stringify(entityId));
  }),
);

(window as any).recipes = recipes;
(window as any).charms = charms;

export let annotationsEnabled = cell<boolean>(false);
export const toggleAnnotations = () => {
  annotationsEnabled.send(!annotationsEnabled.get());
};
