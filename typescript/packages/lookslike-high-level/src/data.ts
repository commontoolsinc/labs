// This file is setting up example data

import { TYPE, NAME, UI, Recipe } from "@commontools/common-builder";
import {
  run,
  cell,
  getEntityId,
  type CellImpl,
  type CellReference,
  raw,
  addModuleByRef,
  type ReactivityLog,
  createRef,
  addRecipe,
  idle,
  EntityId,
} from "@commontools/common-runner";
import { createStorage } from "./storage.js";

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

const storage = createStorage("local");

export const charms = cell<CellReference[]>([]);
charms.generateEntityId("charms");

export function addCharms(newCharms: CellImpl<any>[]) {
  const currentCharmsIds = charms
    .get()
    .map(({ cell }) => JSON.stringify(cell.entityId));
  const charmsToAdd = newCharms.filter(
    (cell) => !currentCharmsIds.includes(JSON.stringify(cell.entityId))
  );

  if (charmsToAdd.length > 0)
    charms.send([
      ...charms.get(),
      ...charmsToAdd.map(
        (cell) => ({ cell, path: [] } satisfies CellReference)
      ),
    ]);
}

export async function runPersistent(
  recipe: Recipe,
  inputs?: any,
  cause?: any
): Promise<CellImpl<any>> {
  await idle();
  return run(
    recipe,
    inputs,
    await storage.syncCell(createRef({ recipe, inputs }, cause))
  );
}

export async function syncCharm(
  entityId: string | EntityId | CellImpl<any>,
  waitForStorage: boolean = false
): Promise<CellImpl<Charm>> {
  return storage.syncCell(entityId, waitForStorage);
}

addCharms([
  /*
  await runPersistent(
    iframe,
    {
      title: "two way binding counter",
      prompt: "counter",
      data: { counter: 0 },
    },
    "iframe"
  ),
  await runPersistent(importCalendar, {}, "importCalendar"),
  await runPersistent(
    search,
    {
      query: "home",
    },
    "search"
  ),
  await runPersistent(
    queryCollections,
    {
      collectionName: "home",
    },
    "queryCollections"
  ),
  await runPersistent(
    todoList,
    {
      title: "My TODOs",
      items: ["Buy groceries", "Walk the dog", "Wash the car"].map((item) => ({
        title: item,
        done: false,
      })),
    },
    "todoList"
  ),
  await runPersistent(
    todoList,
    {
      title: "My grocery shopping list",
      items: ["milk", "eggs", "bread"].map((item) => ({
        title: item,
        done: false,
      })),
    },
    "todoList"
  ),
  await runPersistent(
    ticket,
    {
      title: "Reservation for 'Counterstrike the Musical'",
      show: "Counterstrike the Musical",
      date: getFridayAndMondayDateStrings().startDate,
      location: "New York",
    },
    "ticket"
  ),
  await runPersistent(
    routine,
    {
      title: "Morning routine",
      // TODO: A lot more missing here, this is just to drive the suggestion.
      locations: ["coffee shop with great baristas"],
    },
    "routine"
  ),*/
  await runPersistent(counters, {}, "counters"),
]);

export type RecipeManifest = {
  name: string;
  recipeId: string;
};

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
    name: "Create multiple counters",
    recipeId: addRecipe(counters),
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
  })
);

(window as any).recipes = recipes;
(window as any).charms = charms;

export let annotationsEnabled = cell<boolean>(false);
export const toggleAnnotations = () => {
  annotationsEnabled.send(!annotationsEnabled.get());
};
