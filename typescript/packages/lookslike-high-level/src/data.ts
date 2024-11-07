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
  allRecipesByName,
  idle,
  EntityId,
  getRecipe,
  getRecipeSrc,
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
import { tweets } from "./recipes/tweets.jsx";

// Necessary, so that suggestions are indexed.
import "./recipes/todo-list-as-task.js";
import "./recipes/playlist.js";

import { iframe } from "./recipes/iframe.js";
import { search } from "./recipes/search.js";
import { dataDesigner } from "./recipes/dataDesigner.js";
import { prompt } from "./recipes/prompts.js";
import { wiki } from "./recipes/wiki.js";
import { queryCollections } from "./recipes/queryCollections.js";
import { articleQuery } from "./recipes/articleQuery.jsx";
import { debounceExample } from "./recipes/examples/debounce.jsx";
import { calc } from "./recipes/examples/calculator.jsx";
import { rectangleQuery } from "./recipes/examples/rectangleQuery.jsx";
import { evalJs } from "./recipes/examples/eval.js";
import { importCalendar } from "./recipes/archive/importCalendar.js";
import { dungeon } from "./recipes/archive/dungeon.js";
import { jsonImporter } from "./recipes/archive/jsonImport.js";
import { helloIsolated } from "./recipes/examples/helloIsolated.js";
import { shoelaceDemo } from "./recipes/examples/shoelace.jsx";
import { z } from "zod";
import { datalogQueryExample } from "./recipes/datalogQuery.jsx";
import { todoQuery } from "./recipes/todoQuery.jsx";
import { mealExample } from "./recipes/meal.jsx";
import { charmExample } from "./recipes/charm.jsx";

export type Charm = {
  [NAME]?: string;
  [UI]?: any;
  [TYPE]?: string;
  [key: string]: any;
};

export { TYPE, NAME, UI };

const storage = createStorage(
  (import.meta as any).env.VITE_STORAGE_TYPE ?? "memory",
);

export const charms = cell<CellReference[]>([], "charms");
(window as any).charms = charms;

export async function addCharms(newCharms: CellImpl<any>[]) {
  await storage.syncCell(charms);

  await idle();

  const currentCharmsIds = charms
    .get()
    .map(({ cell }) => JSON.stringify(cell.entityId));
  const charmsToAdd = newCharms.filter(
    (cell) => !currentCharmsIds.includes(JSON.stringify(cell.entityId)),
  );

  if (charmsToAdd.length > 0)
    charms.send([
      ...charms.get(),
      ...charmsToAdd.map(
        (cell) => ({ cell, path: [] }) satisfies CellReference,
      ),
    ]);
}

export async function runPersistent(
  recipe: Recipe,
  inputs?: any,
  cause?: any,
): Promise<CellImpl<any>> {
  await idle();
  return run(
    recipe,
    inputs,
    await storage.syncCell(createRef({ recipe, inputs }, cause)),
  );
}

export async function syncCharm(
  entityId: string | EntityId | CellImpl<any>,
  waitForStorage: boolean = false,
): Promise<CellImpl<Charm>> {
  return storage.syncCell(entityId, waitForStorage);
}

const recipesKnownToStorage = new Set<string>();

export async function syncRecipe(id: string) {
  if (getRecipe(id)) {
    if (recipesKnownToStorage.has(id)) return;
    const src = getRecipeSrc(id);
    if (src) saveRecipe(id, src);
    return;
  }

  const response = await fetch(`https://up.commontools.dev/${id}`);
  const src = await response.text();

  const { recipe, errors } = buildRecipe(src);
  if (errors) throw new Error(errors);

  const recipeId = addRecipe(recipe!, src);
  if (id !== recipeId)
    throw new Error(`Recipe ID mismatch: ${id} !== ${recipeId}`);
  recipesKnownToStorage.add(recipeId);
}

export async function saveRecipe(id: string, src: string) {
  if (recipesKnownToStorage.has(id)) return;
  recipesKnownToStorage.add(id);

  console.log("Saving recipe", id);
  const response = await fetch(`https://up.commontools.dev/${id}`, {
    method: "POST",
    body: src,
  });
  return response.ok;
}

addCharms([
  await runPersistent(charmExample, {}, "Charm Example"),
  // await runPersistent(mealExample, {}, "Meal Example"),
  // await runPersistent(todoQuery, { titleInput: "" }, "Persisted Todos"),
  // await runPersistent(
  //   datalogQueryExample,
  //   {
  //     query: {
  //       select: {
  //         ".": "?item",
  //         title: "?title",
  //       },
  //       where: [
  //         {
  //           Case: ["?item", "title", "?title"],
  //         },
  //       ],
  //     },
  //   },
  //   "Datalog Query Playground",
  // ),
  // await runPersistent(shoelaceDemo, {}, "shoelace"),
  // await runPersistent(
  //   iframe,
  //   {
  //     title: "two way binding counter",
  //     prompt: "counter",
  //     data: { counter: 0 },
  //   },
  //   "iframe",
  // ),
  // await runPersistent(
  //   todoList,
  //   {
  //     title: "My TODOs",
  //     items: ["Buy groceries", "Walk the dog", "Wash the car"].map((item) => ({
  //       title: item,
  //       done: false,
  //     })),
  //   },
  //   "todoList",
  // ),
  // await runPersistent(
  //   todoList,
  //   {
  //     title: "My grocery shopping list",
  //     items: ["milk", "eggs", "bread"].map((item) => ({
  //       title: item,
  //       done: false,
  //     })),
  //   },
  //   "todoList",
  // ),
  // await runPersistent(
  //   ticket,
  //   {
  //     title: "Reservation for 'Counterstrike the Musical'",
  //     show: "Counterstrike the Musical",
  //     date: getFridayAndMondayDateStrings().startDate,
  //     location: "New York",
  //   },
  //   "ticket",
  // ),
  // await runPersistent(
  //   routine,
  //   {
  //     title: "Morning routine",
  //     // TODO: A lot more missing here, this is just to drive the suggestion.
  //     locations: ["coffee shop with great baristas"],
  //   },
  //   "routine",
  // ),
  // await runPersistent(counters, {}, "counters"),
  // await runPersistent(
  //   tweets,
  //   {
  //     username: "@gordonbrander",
  //   },
  //   "tweets",
  // ),
]);

export type RecipeManifest = {
  name: string;
  recipeId: string;
};

export const recipes: RecipeManifest[] = Object.entries(allRecipes).map(
  ([name, recipe]) => ({
    name: (recipe.schema as { description: string })?.description ?? name,
    recipeId: addRecipe(recipe),
  }),
);

(window as any).recipes = allRecipesByName();

/* TODO: Recreate test data for reservations that used to use this
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
*/

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
    const entityId = getEntityId(inputsCell.getAsQueryResult([], log));
    if (entityId) openCharm(JSON.stringify(entityId));
  }),
);

export let annotationsEnabled = cell<boolean>(false);
export const toggleAnnotations = () => {
  annotationsEnabled.send(!annotationsEnabled.get());
};
