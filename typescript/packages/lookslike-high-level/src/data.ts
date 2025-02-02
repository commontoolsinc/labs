// This file is setting up example data

import {
  addModuleByRef,
  addRecipe,
  allRecipesByName,
  getDoc,
  type DocImpl,
  EntityId,
  getEntityId,
  getRecipe,
  getRecipeParents,
  getRecipeSrc,
  raw,
  type ReactivityLog,
  getRecipeSpec,
  getRecipeName,
  Action,
  addAction,
  removeAction,
} from "@commontools/runner";
import * as allRecipes from "./recipes/index.js";
import { buildRecipe } from "./localBuild.js";
import { setIframeContextHandler } from "@commontools/iframe-sandbox";
import { addCharms } from "@commontools/charm";

// Necessary, so that suggestions are indexed.
// import "./recipes/todo-list-as-task.jsx";
// import "./recipes/playlist.jsx";


export const BLOBBY_SERVER_URL =
  typeof window !== "undefined"
    ? window.location.protocol + "//" + window.location.host + "/api/storage/blobby"
    : "//api/storage/blobby";

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

  const response = await fetch(`${BLOBBY_SERVER_URL}/spell-${id}`);
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
  spellbookTitle?: string,
  spellbookTags?: string[],
) {
  // If the recipe is already known to storage, we don't need to save it again,
  // unless the user is trying to attach a spellbook title or tags.
  if (recipesKnownToStorage.has(id) && !spellbookTitle) return;
  recipesKnownToStorage.add(id);

  console.log("Saving recipe", id);
  const response = await fetch(`${BLOBBY_SERVER_URL}/spell-${id}`, {
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
      spellbookTitle,
      spellbookTags,
    }),
  });
  return response.ok;
}

import smolIframe from "./recipes/smolIframe.js";
import complexIframe from "./recipes/complexIframe.js";

addCharms([
  // await runPersistent(smolIframe, { count: 1 }, "smol iframe"),
  // await runPersistent(complexIframe, { count: 42 }, "complex iframe"),
]);

export type RecipeManifest = {
  name: string;
  recipeId: string;
};

export const recipes: RecipeManifest[] = Object.entries(allRecipes).map(([name, recipe]) => ({
  name: (recipe.argumentSchema as { description: string })?.description ?? name,
  recipeId: addRecipe(recipe),
}));

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
export type CharmActionFn = (charmId: string | EntityId | DocImpl<any>) => void;
export type CharmAction = CharmActionFn & {
  set: (opener: CharmActionFn) => void;
};

let charmOpener: CharmActionFn | CharmAction = () => {};
let charmCloser: CharmActionFn | CharmAction = () => {};
export const openCharm = (charmId: string | EntityId | DocImpl<any>) => charmOpener(charmId);
export const closeCharm = (charmId: string | EntityId | DocImpl<any>) => charmCloser(charmId);
openCharm.set = (opener: CharmActionFn) => {
  charmOpener = opener;
};
closeCharm.set = (closer: CharmActionFn) => {
  charmCloser = closer;
};

addModuleByRef(
  "navigateTo",
  raw((inputsCell: DocImpl<any>) => (log: ReactivityLog) => {
    // HACK to follow the cell references to the entityId
    const entityId = getEntityId(inputsCell.getAsQueryResult([], log));
    if (entityId) openCharm(entityId);
  }),
);

export let annotationsEnabled = getDoc<boolean>(false);
export const toggleAnnotations = () => {
  annotationsEnabled.send(!annotationsEnabled.get());
};

setIframeContextHandler({
  read(context: any, key: string): any {
    return context?.getAsQueryResult ? context?.getAsQueryResult([key]) : context?.[key];
  },
  write(context: any, key: string, value: any) {
    context.getAsQueryResult()[key] = value;
  },
  subscribe(context: any, key: string, callback: (key: string, value: any) => void): any {
    const action: Action = (log: ReactivityLog) =>
      callback(key, context.getAsQueryResult([key], log));

    addAction(action);
    return action;
  },
  unsubscribe(_context: any, receipt: any) {
    removeAction(receipt);
  },
});