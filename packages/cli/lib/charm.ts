import { ANYONE, createSession, Identity } from "@commontools/identity";
import { ensureDir } from "@std/fs";
import { loadIdentity } from "./identity.ts";
import {
  Cell,
  getEntityId,
  MemorySpace,
  Recipe,
  RecipeMeta,
  Runtime,
} from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache";
import {
  Charm,
  CharmManager,
  compileRecipe,
  getRecipeIdFromCharm,
} from "@commontools/charm";
import { join } from "@std/path";

export interface SpaceConfig {
  apiUrl: string;
  space: string;
  identity: string;
}

export interface CharmConfig extends SpaceConfig {
  charm: string;
}

function parseSpace(
  space: string,
): string {
  if (space.startsWith("did:key:")) {
    // Need to be able to resolve a did key to a name, based
    // on current Session requirements.
    throw new Error("`space` as a DID key is not yet supported.");
  }
  if (space.startsWith("~")) {
    // Need to be able to resolve a private space to a did key, based
    // on current Session requirements.
    throw new Error("`space` must not be a private space.");
  }
  return space;
}

/*
const account = isPrivateSpace(spaceName)
        ? root
        : await Identity.fromPassphrase(ANYONE);

      const user = await account.derive(spaceName);

      if (!ignore) {
        setSession({
          private: account.did() === root.did(),
          name: spaceName,
          space: user.did(),
          as: user,
        });
      }
      */
async function loadManager(config: SpaceConfig): Promise<CharmManager> {
  //const identity = await loadIdentity(config.identity);
  const identity = await Identity.fromPassphrase(ANYONE);

  const spaceName = parseSpace(config.space);
  const session = await createSession({
    identity,
    name: spaceName,
  });
  const runtime = new Runtime({
    storageManager: StorageManager.open({
      as: session.as,
      address: new URL("/api/storage/memory", config.apiUrl),
    }),
    blobbyServerUrl: config.apiUrl,
  });
  const charmManager = new CharmManager(session, runtime);
  await charmManager.synced();
  return charmManager;
}

async function getRecipeSource(
  manager: CharmManager,
  charmId: string,
): Promise<string> {
  const recipe = await getRecipeFromService(manager, charmId);
  const meta = manager.runtime.recipeManager.getRecipeMeta(
    recipe,
  ) as RecipeMeta;
  if (!meta.src) {
    throw new Error(`Charm "${charmId}" does not contain a recipe source.`);
  }
  return meta.src;
}

// Get a `Recipe` either from a local entry, or from the service.
async function getRecipeFromFile(
  manager: CharmManager,
  entryPath: string,
): Promise<Recipe> {
  // `compileRecipe` should accept a ProgramResolver for multifiles
  const recipeSrc = await Deno.readTextFile(entryPath);
  return await compileRecipe(
    recipeSrc,
    "recipe",
    manager.runtime,
    manager.getSpace(),
  );
}

async function getRecipeFromService(
  manager: CharmManager,
  charmId: string,
): Promise<Recipe> {
  // Could throw, TODO(js) handle
  const charm = await manager.get(charmId!, false);
  const recipeId = getRecipeIdFromCharm(charm!);
  return await manager.runtime.recipeManager.loadRecipe(
    recipeId,
    manager.getSpace(),
  );
}

async function exec({
  manager,
  recipe,
  charmId,
  input,
}: {
  manager: CharmManager;
  recipe: Recipe;
  charmId?: string;
  input?: object;
}): Promise<Cell<Charm>> {
  let charm;
  // If we have a charm ID, we're updating a specific charm.
  if (charmId) {
    charm = await manager.runPersistent2(recipe, charmId!, input);
  } // If we don't, we're creating a new recipe.
  else {
    charm = await manager.runPersistent(recipe, input);
  }
  await manager.runtime.idle();
  await manager.synced();
  return charm;
}

export async function listCharms(config: SpaceConfig) {
  const manager = await loadManager(config);
  const charms = manager.getCharms().get();
  // can also get recipe names from recipe meta here
  console.log(charms.map(getCharmId));
  //throw new Error("TODO");
}

export async function newCharm(
  config: SpaceConfig,
  entryPath: string,
  input: object | undefined,
): Promise<string> {
  const manager = await loadManager(config);
  const recipe = await getRecipeFromFile(manager, entryPath);
  const charm = await exec({ manager, recipe, input });
  return getCharmId(charm);
}

export async function setCharmRecipe(
  config: CharmConfig,
  entryPath: string,
): Promise<void> {
  const manager = await loadManager(config);
  const recipe = await getRecipeFromFile(
    manager,
    entryPath,
  );
  await exec({ manager, recipe, charmId: config.charm });
}

export async function saveCharmRecipe(
  config: CharmConfig,
  outPath: string,
): Promise<void> {
  await ensureDir(outPath);
  const manager = await loadManager(config);
  const src = await getRecipeSource(manager, config.charm);
  // update for multifile
  await Deno.writeTextFile(join(outPath, "main.tsx"), src);
}

export async function applyCharmInput(
  config: CharmConfig,
  input: object | undefined,
) {
  const manager = await loadManager(config);
  const recipe = await getRecipeFromService(manager, config.charm);
  await exec({ manager, recipe, charmId: config.charm, input });
}

function getCharmId(charm: Cell<Charm>): string {
  const id = getEntityId(charm)?.["/"];
  if (!id) {
    throw new Error("Could not get an ID from a Cell<Charm>");
  }
  return id;
}
