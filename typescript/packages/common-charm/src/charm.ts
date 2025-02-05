import { Module, NAME, Recipe, TYPE, UI } from "@commontools/builder";
import {
  getDoc,
  type DocLink,
  DocImpl,
  EntityId,
  idle,
  createRef,
  getRecipe,
  isDoc,
  isDocLink,
  run,
} from "@commontools/runner";
import { createStorage } from "./storage.js";

export type Charm = {
  [NAME]?: string;
  [UI]?: any;
  [TYPE]?: string;
  [key: string]: any;
};

// FIXME(ja): we shouldn't assume we are in a browser environment here.
const defaultReplica = "common-knowledge";
const urlParams = new URLSearchParams(window.location.search);
export const replica = urlParams.get("replica") ?? defaultReplica;
const storageType = urlParams.get("replica")
  ? "remote"
  : ((import.meta as any).env.VITE_STORAGE_TYPE ?? "memory");

export const storage = createStorage(storageType, replica);
export const charms = getDoc<DocLink[]>([], "charms");
(window as any).charms = charms;

export async function addCharms(newCharms: DocImpl<any>[]) {
  await storage.syncCell(charms);

  await idle();

  const currentCharmsIds = charms.get().map(({ cell }) => JSON.stringify(cell.entityId));
  const charmsToAdd = newCharms.filter(
    (cell) => !currentCharmsIds.includes(JSON.stringify(cell.entityId)),
  );

  if (charmsToAdd.length > 0) {
    charms.send([
      ...charms.get(),
      ...charmsToAdd.map((cell) => ({ cell, path: [] }) satisfies DocLink),
    ]);
  }
}

export function removeCharm(id: EntityId) {
  const newCharms = charms.get().filter(({ cell }) => cell.entityId !== id);
  if (newCharms.length !== charms.get().length) charms.send(newCharms);
}

export async function runPersistent(
  recipe: Recipe | Module,
  inputs?: any,
  cause?: any,
): Promise<DocImpl<any>> {
  await idle();

  // Fill in missing parameters from other charms. It's a simple match on
  // hashtags: For each top-level argument prop that has a hashtag in the
  // description, look for a charm that has a top-level output prop with the
  // same hashtag in the description, or has the hashtag in its own description.
  // If there is a match, assign the first one to the input property.

  // TODO: This should really be extracted into a full-fledged query builder.
  if (
    !isDoc(inputs) && // Adding to a cell input is not supported yet
    !isDocLink(inputs) && // Neither for cell reference
    recipe.argumentSchema &&
    (recipe.argumentSchema as any).type === "object"
  ) {
    const properties = (recipe.argumentSchema as any).properties;
    const inputProperties =
      typeof inputs === "object" && inputs !== null ? Object.keys(inputs) : [];
    for (const key in properties) {
      if (!(key in inputProperties) && properties[key].description?.includes("#")) {
        const hashtag = properties[key].description.match(/#(\w+)/)?.[1];
        if (hashtag) {
          charms.get().forEach(({ cell }) => {
            const type = cell.sourceCell?.get()?.[TYPE];
            const recipe = getRecipe(type);
            const charmProperties = (recipe?.resultSchema as any)?.properties as any;
            const matchingProperty = Object.keys(charmProperties ?? {}).find((property) =>
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

  return run(recipe, inputs, await storage.syncCell(createRef({ recipe, inputs }, cause)));
}

export async function syncCharm(
  entityId: string | EntityId | DocImpl<any>,
  waitForStorage: boolean = false,
): Promise<DocImpl<Charm>> {
  return storage.syncCell(entityId, waitForStorage);
}
