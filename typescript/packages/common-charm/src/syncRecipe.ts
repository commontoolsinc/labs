import {
  addRecipe,
  getRecipe,
  getRecipeName,
  getRecipeParents,
  getRecipeSpec,
  getRecipeSrc,
} from "@commontools/runner";
import { buildRecipe } from "./localBuild.ts";

// FIXME(jake): This needs to be settable by environment variable...
// If this is hardcoded, then it is not possible to develop spellbook locally.
let BLOBBY_SERVER_URL = "/api/storage/blobby";

export function setBobbyServerUrl(url: string) {
  BLOBBY_SERVER_URL = new URL("/api/storage/blobby", url).toString();
}

const recipesKnownToStorage = new Set<string>();

// FIXME(Jake): this really really really needs to be revisited
export async function syncRecipeBlobby(id: string) {
  if (getRecipe(id)) {
    if (recipesKnownToStorage.has(id)) return;
    const src = getRecipeSrc(id);
    const spec = getRecipeSpec(id);
    const parents = getRecipeParents(id);
    if (src) saveRecipe(id, src, spec, parents);
    return;
  }

  console.log("Syncing recipe", id, BLOBBY_SERVER_URL);
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
