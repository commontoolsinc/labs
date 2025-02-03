// This file is setting up example data

import {
  addModuleByRef,
  addRecipe,
  allRecipesByName,
  getDoc,
  type DocImpl,
  EntityId,
  getEntityId,
  raw,
  type ReactivityLog,
  Action,
  addAction,
  removeAction,
} from "@commontools/runner";
import * as allRecipes from "./recipes/index.js";
import { setIframeContextHandler } from "@commontools/iframe-sandbox";
import { addCharms } from "@commontools/charm";

export const BLOBBY_SERVER_URL =
  typeof window !== "undefined"
    ? window.location.protocol + "//" + window.location.host + "/api/storage/blobby"
    : "//api/storage/blobby";

// Necessary, so that suggestions are indexed.
// import "./recipes/todo-list-as-task.jsx";
// import "./recipes/playlist.jsx";

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
