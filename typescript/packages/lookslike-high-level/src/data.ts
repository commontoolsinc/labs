// This file is setting up example data

import { NAME, Recipe, TYPE, UI } from "@commontools/common-builder";
import {
  addModuleByRef,
  addRecipe,
  allRecipesByName,
  cell,
  type CellImpl,
  type CellReference,
  createRef,
  EntityId,
  getEntityId,
  getRecipe,
  getRecipeParents,
  getRecipeSrc,
  idle,
  isCell,
  isCellReference,
  raw,
  type ReactivityLog,
  run,
  getRecipeSpec,
  getRecipeName,
} from "@commontools/common-runner";
import { createStorage } from "./storage.js";
import * as allRecipes from "./recipes/index.js";
import { buildRecipe } from "./localBuild.js";

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
import * as charmExample from "./recipes/charm.jsx";
import Fetcher from "./recipes/fetcher.jsx";
import Fetch from "./recipes/fetch.js";

export type Charm = {
  [NAME]?: string;
  [UI]?: any;
  [TYPE]?: string;
  [key: string]: any;
};

export { NAME, TYPE, UI };

const storage = createStorage(
  (import.meta as any).env.VITE_STORAGE_TYPE ?? "local",
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

  if (charmsToAdd.length > 0) {
    charms.send([
      ...charms.get(),
      ...charmsToAdd.map(
        (cell) => ({ cell, path: [] }) satisfies CellReference,
      ),
    ]);
  }
}

export function removeCharm(id: EntityId) {
  const newCharms = charms.get().filter(({ cell }) => cell.entityId !== id);
  if (newCharms.length !== charms.get().length) charms.send(newCharms);
}

export async function runPersistent(
  recipe: Recipe,
  inputs?: any,
  cause?: any,
): Promise<CellImpl<any>> {
  await idle();

  // Fill in missing parameters from other charms. It's a simple match on
  // hashtags: For each top-level argument prop that has a hashtag in the
  // description, look for a charm that has a top-level output prop with the
  // same hashtag in the description, or has the hashtag in its own description.
  // If there is a match, assign the first one to the input property.

  // TODO: This should really be extracted into a full-fledged query builder.
  if (
    !isCell(inputs) && // Adding to a cell input is not supported yet
    !isCellReference(inputs) && // Neither for cell reference
    recipe.argumentSchema &&
    (recipe.argumentSchema as any).type === "object"
  ) {
    const properties = (recipe.argumentSchema as any).properties;
    const inputProperties =
      typeof inputs === "object" && inputs !== null ? Object.keys(inputs) : [];
    for (const key in properties) {
      if (
        !(key in inputProperties) &&
        properties[key].description?.includes("#")
      ) {
        const hashtag = properties[key].description.match(/#(\w+)/)?.[1];
        if (hashtag) {
          charms.get().forEach(({ cell }) => {
            const type = cell.sourceCell?.get()?.[TYPE];
            const recipe = getRecipe(type);
            const charmProperties = (recipe?.resultSchema as any)
              ?.properties as any;
            const matchingProperty = Object.keys(charmProperties ?? {}).find(
              (property) =>
                charmProperties[property].description?.includes(`#${hashtag}`),
            );
            if (matchingProperty) {
              inputs = {
                ...inputs,
                [key]: { $alias: { cell, path: [matchingProperty] } },
              };
            }
          });
        }
      }
    }
  }

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

export const BLOBBY_SERVER_URL =
  typeof window !== "undefined"
    ? window.location.protocol + "//" + window.location.host + "/api/blobby"
    : "//api/blobby";

const recipesKnownToStorage = new Set<string>();

export async function syncRecipe(id: string) {
  if (getRecipe(id)) {
    if (recipesKnownToStorage.has(id)) return;
    const src = getRecipeSrc(id);
    const spec = getRecipeSpec(id);
    const parents = getRecipeParents(id);
    if (src) saveRecipe(id, src, spec, parents);
    return;
  }

  const response = await fetch(`${BLOBBY_SERVER_URL}/blob/${id}`);
  let src: string;
  let spec: string;
  let parents: string[];
  try {
    const resp = await response.json();
    src = resp.src;
    spec = resp.spec;
    parents = resp.parents || [];
  } catch (e) {
    src = await response.text();
    spec = "";
    parents = [];
  }

  const { recipe, errors } = await buildRecipe(src);
  if (errors) throw new Error(errors);

  const recipeId = addRecipe(recipe!, src, spec, parents);
  if (id !== recipeId) {
    throw new Error(`Recipe ID mismatch: ${id} !== ${recipeId}`);
  }
  recipesKnownToStorage.add(recipeId);
}

export async function saveRecipe(
  id: string,
  src: string,
  spec?: string,
  parents?: string[],
) {
  if (recipesKnownToStorage.has(id)) return;
  recipesKnownToStorage.add(id);

  console.log("Saving recipe", id);
  const response = await fetch(`${BLOBBY_SERVER_URL}/blob/${id}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      src,
      recipe: JSON.parse(JSON.stringify(getRecipe(id))),
      spec,
      parents,
      recipeName: getRecipeName(id),
    }),
  });
  return response.ok;
}

addCharms([
  charmExample.spawn({
    v6: true,
  }),
  Fetcher.spawn(),
  Fetch.spawn(),
]);

export type RecipeManifest = {
  name: string;
  recipeId: string;
};

export const recipes: RecipeManifest[] = Object.entries(allRecipes).map(
  ([name, recipe]) => ({
    name:
      (recipe.argumentSchema as { description: string })?.description ?? name,
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
export type CharmActionFn = (
  charmId: string | EntityId | CellImpl<any>,
) => void;
export type CharmAction = CharmActionFn & {
  set: (opener: CharmActionFn) => void;
};

let charmOpener: CharmActionFn | CharmAction = () => {};
let charmCloser: CharmActionFn | CharmAction = () => {};
export const openCharm = (charmId: string | EntityId | CellImpl<any>) =>
  charmOpener(charmId);
export const closeCharm = (charmId: string | EntityId | CellImpl<any>) =>
  charmCloser(charmId);
openCharm.set = (opener: CharmActionFn) => {
  charmOpener = opener;
};
closeCharm.set = (closer: CharmActionFn) => {
  charmCloser = closer;
};

addModuleByRef(
  "navigateTo",
  raw((inputsCell: CellImpl<any>) => (log: ReactivityLog) => {
    // HACK to follow the cell references to the entityId
    const entityId = getEntityId(inputsCell.getAsQueryResult([], log));
    if (entityId) openCharm(entityId);
  }),
);

export let annotationsEnabled = cell<boolean>(false);
export const toggleAnnotations = () => {
  annotationsEnabled.send(!annotationsEnabled.get());
};
