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
  getRecipeSrc,
  idle,
  isCell,
  isCellReference,
  raw,
  type ReactivityLog,
  run,
  getRecipeSpec,
} from "@commontools/common-runner";
import { createStorage } from "./storage.js";
import * as allRecipes from "./recipes/index.js";
import { buildRecipe } from "./localBuild.js";

export type Charm = {
  [NAME]?: string;
  [UI]?: any;
  [TYPE]?: string;
  [key: string]: any;
};

export { NAME, TYPE, UI };

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

  if (charmsToAdd.length > 0) {
    charms.send([
      ...charms.get(),
      ...charmsToAdd.map(
        (cell) => ({ cell, path: [] }) satisfies CellReference,
      ),
    ]);
  }
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
    if (src) saveRecipe(id, src, spec);
    return;
  }

  const response = await fetch(`${BLOBBY_SERVER_URL}/blob/${id}`);
  let src: string;
  let spec: string;
  try {
    const resp = await response.json();
    src = resp.src;
    spec = resp.spec;
  } catch (e) {
    src = await response.text();
    spec = "";
  }

  const { recipe, errors } = await buildRecipe(src);
  if (errors) throw new Error(errors);

  const recipeId = addRecipe(recipe!, src, spec);
  if (id !== recipeId) {
    throw new Error(`Recipe ID mismatch: ${id} !== ${recipeId}`);
  }
  recipesKnownToStorage.add(recipeId);
}

export async function saveRecipe(id: string, src: string, spec?: string) {
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
    }),
  });
  return response.ok;
}

addCharms([
  await runPersistent(
    allRecipes.counters,
    { title: "jake demo" },
    "hello world",
  ),
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
let openCharmOpener: (
  charmId: string | EntityId | CellImpl<any>,
) => void = () => {};
export const openCharm = (charmId: string | EntityId | CellImpl<any>) =>
  openCharmOpener(charmId);
openCharm.set = (
  opener: (charmId: string | EntityId | CellImpl<any>) => void,
) => {
  openCharmOpener = opener;
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
