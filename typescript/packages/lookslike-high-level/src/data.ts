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

// Necessary, so that suggestions are indexed.
import "./recipes/todo-list-as-task.js";
import "./recipes/playlist.js";

// import FetchExample from "./recipes/fetcher.jsx";
import FetchService from "./effects/fetch.js";
import GmailService from "./effects/gmail.js";
import { refer, UI as ViewService } from "@commontools/common-system";

import * as helloWorld from "./spells/01_helloWorld.jsx";
import * as counter from "./spells/02_counter.jsx";
import * as desugared from "./spells/03_desugared.jsx";
import * as tamagotchi from "./spells/04_tamagotchi.jsx";
import * as readingList from "./spells/05_readingList.jsx";
import * as chat from "./spells/06_chat.jsx";
import * as sharedTags from "./spells/07_sharedTags.jsx";
import * as workbench from "./spells/08_workbench.jsx";
import * as importer from "./spells/09_importer.jsx";
import { composed } from "./spells/10_composed.jsx";
import github from "./spells/11_github.jsx";
import form from "./spells/13_form.jsx";
import * as helloWorldWithLikes from "./spells/12_helloWorldWithLikes.jsx";
import * as llmChat from "./spells/14_llm_chat.jsx";
import * as countdown from "./spells/countdown.jsx";
import * as themeable from "./spells/themeable.jsx";
import TimerService from "./effects/timer.js";
import { settings } from "./spells/settings.jsx";
import { emailComposer } from "./spells/15_email_composer.jsx";
import { addressBook } from "./spells/16_contacts.jsx";
import { formTest } from "./spells/17_complex_form.jsx";
import { musicLibrary } from "./spells/18_music.jsx";
import { spellManager } from "./spells/19_process_manager.jsx";
import { shaderManager } from "./spells/20_shader_editor.jsx";
import { schemaGenerator } from "./spells/21_model_builder.jsx";
import { search } from "./spells/22_search.jsx";
import { notebook } from "./spells/23_notes.jsx";
import { quotedb } from "./spells/24_quotes.jsx";
import { activity } from "./spells/25_activity.jsx";
import { activityRef } from "./sugar/activity.js";
import { stackLayout } from "./spells/26_stacks.jsx";
import { canvasLayout } from "./spells/27_canvas.jsx";

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
    cell => !currentCharmsIds.includes(JSON.stringify(cell.entityId)),
  );

  if (charmsToAdd.length > 0) {
    charms.send([
      ...charms.get(),
      ...charmsToAdd.map(cell => ({ cell, path: [] }) satisfies CellReference),
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
              property =>
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
  helloWorld.spawn({ helloWorld: 1 }),
  counter.spawn({ counter: 1 }),
  importer.spawn({ fetch: 1 }),
  sharedTags.spawn({ sharedDataInstance: 2 }),
  tamagotchi.spawn({ tamagochi: 1 }),
  tamagotchi.spawn({ tamagochi: 3 }),
  // readingList.spawn({ readingList: 1, }),
  // chat.spawn({ chat: 2, }),
  // workbench.spawn({ workbench: 1 }),
  form.spawn({ geneticsLab: 1 }),
  llmChat.spawn({ llmChat: 7 }),
  settings.spawn({ settings: 1 }),
  // composed.spawn({ composed: 1 }),
  // helloWorldWithLikes.spawn({ helloWorldWithLikes: 1 }),
  countdown.spawn({ countdown: 1 }),
  themeable.spawn({ themeable: 1 }),
  emailComposer.spawn({ email: 1 }),
  addressBook.spawn({ contacts: 1 }),
  formTest.spawn({ formTest: 1 }),
  musicLibrary.spawn({ musicLibrary: 1 }),
  spellManager.spawn({ spellManager: 1 }),
  shaderManager.spawn({ shaderManager: 1 }),
  schemaGenerator.spawn({ schemaGenerator: 1 }),
  search.spawn({ search: 1 }),
  notebook.spawn({ notes: 1 }),
  quotedb.spawn({ quotes: 1 }),
  activity.spawn(activityRef),
  stackLayout.spawn({ stack: 1 }),
  canvasLayout.spawn({ canvas: 1 }),
  FetchService.spawn() as any,
  GmailService.spawn() as any,
  ViewService.spawn() as any,
  TimerService.spawn() as any,
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
