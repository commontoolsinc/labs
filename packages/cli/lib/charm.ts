import { ANYONE, Identity, Session } from "@commontools/identity";
import { ensureDir } from "@std/fs";
import { loadIdentity } from "./identity.ts";
import {
  Cell,
  getEntityId,
  NAME,
  Recipe,
  RecipeMeta,
  Runtime,
} from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache";
import {
  Charm,
  charmId,
  CharmManager,
  compileRecipe,
  getRecipeIdFromCharm,
  processSchema,
} from "@commontools/charm";
import { dirname, join } from "@std/path";
import { CliProgram } from "./dev.ts";

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

function getCharmIdSafe(charm: Cell<Charm>): string {
  const id = charmId(charm);
  if (!id) {
    throw new Error("Could not get an ID from a Cell<Charm>");
  }
  return id;
}

async function makeSession(config: SpaceConfig): Promise<Session> {
  if (config.space.startsWith("did:key")) {
    throw new Error("DID key spaces not yet supported.");
  }
  const root = await loadIdentity(config.identity);
  const account = config.space.startsWith("~")
    ? root
    : await Identity.fromPassphrase(ANYONE);
  const user = await account.derive(config.space);
  return {
    private: account.did() === root.did(),
    name: config.space,
    space: user.did(),
    as: user,
  };
}

async function loadManager(config: SpaceConfig): Promise<CharmManager> {
  const spaceName = parseSpace(config.space);
  const session = await makeSession(config);
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

async function getRecipeMeta(
  manager: CharmManager,
  charmId: string,
): Promise<RecipeMeta> {
  const recipe = await getRecipeFromService(manager, charmId);
  return manager.runtime.recipeManager.getRecipeMeta(
    recipe,
  ) as RecipeMeta;
}

async function getRecipeFromFile(
  manager: CharmManager,
  mainPath: string,
): Promise<Recipe> {
  // Walk entry file and collect all sources from fs.
  const program = await manager.runtime.harness.resolve(
    new CliProgram(mainPath),
  );
  return await compileRecipe(
    program,
    "recipe",
    manager.runtime,
    manager.getSpace(),
    undefined, // parents
  );
}

async function getRecipeFromService(
  manager: CharmManager,
  charmId: string,
): Promise<Recipe> {
  const charm = await manager.get(charmId, false);
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
    charm = await manager.runWithRecipe(recipe, charmId!, input);
  } // If we don't, we're creating a new recipe.
  else {
    charm = await manager.runPersistent(recipe, input);
  }
  await manager.runtime.idle();
  await manager.synced();
  return charm;
}

// Returns an array of metadata about charms to display.
export async function listCharms(
  config: SpaceConfig,
): Promise<{ id: string; name?: string; recipeName?: string }[]> {
  const manager = await loadManager(config);
  const charms = manager.getCharms().get();
  return Promise.all(charms.map(async (charm) => {
    const name = charm.get()[NAME];
    const id = getCharmIdSafe(charm);
    const recipeName = (await getRecipeMeta(manager, id)).recipeName;
    return { id, name, recipeName };
  }));
}

// Creates a new charm from source code and optional input.
export async function newCharm(
  config: SpaceConfig,
  mainPath: string,
): Promise<string> {
  const manager = await loadManager(config);
  const recipe = await getRecipeFromFile(manager, mainPath);
  const charm = await exec({ manager, recipe });
  return getCharmIdSafe(charm);
}

export async function setCharmRecipe(
  config: CharmConfig,
  mainPath: string,
): Promise<void> {
  const manager = await loadManager(config);
  const recipe = await getRecipeFromFile(
    manager,
    mainPath,
  );
  await exec({ manager, recipe, charmId: config.charm });
}

export async function saveCharmRecipe(
  config: CharmConfig,
  outPath: string,
): Promise<void> {
  await ensureDir(outPath);
  const manager = await loadManager(config);
  const meta = await getRecipeMeta(manager, config.charm);

  if (meta.src) {
    // Write the main source file
    await Deno.writeTextFile(join(outPath, "main.tsx"), meta.src);
  } else if (meta.program) {
    for (const { name, contents } of meta.program.files) {
      if (name[0] !== "/") {
        throw new Error("Ungrounded file in recipe.");
      }
      await Deno.writeTextFile(join(outPath, name.substring(1)), contents);
    }
  } else {
    throw new Error(
      `Charm "${config.charm}" does not contain a recipe source.`,
    );
  }
}

export async function applyCharmInput(
  config: CharmConfig,
  input: object | undefined,
) {
  const manager = await loadManager(config);
  const recipe = await getRecipeFromService(manager, config.charm);
  await exec({ manager, recipe, charmId: config.charm, input });
}

async function getCellByIdOrCharm(
  manager: CharmManager,
  cellId: string,
  label: string,
): Promise<{ cell: Cell<any>; isCharm: boolean }> {
  try {
    // Try to get as a charm first
    const charm = await manager.get(cellId, true);
    if (!charm) {
      throw new Error(`Charm ${cellId} not found`);
    }
    return { cell: charm, isCharm: true };
  } catch (error) {
    // If manager.get() fails (e.g., "recipeId is required"), try as arbitrary cell ID
    try {
      const cell = await manager.getCellById({ "/": cellId });

      // Check if this cell is actually a charm by looking at the charms list
      const charms = manager.getCharms().get();
      const isActuallyCharm = charms.some((charm) => {
        try {
          const id = getCharmIdSafe(charm);
          return id === cellId;
        } catch {
          // If we can't get the charm ID, it's not a valid charm
          return false;
        }
      });

      return { cell, isCharm: isActuallyCharm };
    } catch (cellError) {
      throw new Error(`${label} "${cellId}" not found as charm or cell`);
    }
  }
}

export async function linkCharms(
  config: SpaceConfig,
  sourceCharmId: string,
  sourcePath: (string | number)[],
  targetCharmId: string,
  targetPath: (string | number)[],
): Promise<void> {
  const manager = await loadManager(config);

  // Get source cell (charm or arbitrary cell)
  const { cell: sourceCell, isCharm: sourceIsCharm } = await getCellByIdOrCharm(
    manager,
    sourceCharmId,
    "Source",
  );

  // Get target cell (charm or arbitrary cell)
  const { cell: targetCell, isCharm: targetIsCharm } = await getCellByIdOrCharm(
    manager,
    targetCharmId,
    "Target",
  );

  // Navigate to the source path
  let sourceResultCell = sourceCell;
  // For charms, manager.get() already returns the result cell, so no need to add "result"

  for (const segment of sourcePath) {
    sourceResultCell = sourceResultCell.key(segment);
  }

  const sourceCellLink = sourceResultCell.getAsCellLink();

  // Navigate to the target path
  const targetKey = targetPath.pop();
  if (!targetKey) {
    throw new Error("Target path cannot be empty");
  }

  let targetInputCell = targetCell;
  if (targetIsCharm) {
    // For charms, target fields are in the source cell's argument
    const sourceCell = targetCell.getSourceCell(processSchema);
    if (!sourceCell) {
      throw new Error("Target charm has no source cell");
    }
    targetInputCell = sourceCell.key("argument");
  }

  for (const segment of targetPath) {
    targetInputCell = targetInputCell.key(segment);
  }

  targetInputCell.key(targetKey).set(sourceCellLink);

  await manager.runtime.idle();
  await manager.synced();
}

export async function inspectCharm(
  config: CharmConfig,
): Promise<{
  id: string;
  name?: string;
  recipeName?: string;
  source: any;
  result: any;
  readingFrom: Array<{ id: string; name?: string }>;
  readBy: Array<{ id: string; name?: string }>;
}> {
  const manager = await loadManager(config);

  const charm = await manager.get(config.charm, false);
  if (!charm) {
    throw new Error(`Charm "${config.charm}" not found`);
  }

  const id = getCharmIdSafe(charm);
  const name = charm.get()[NAME];

  // Get recipe metadata
  const recipeMeta = await getRecipeMeta(manager, config.charm);
  const recipeName = recipeMeta.recipeName;

  // Get source (arguments/inputs)
  const argumentCell = manager.getArgument(charm);
  const source = argumentCell.get();

  // Get result (charm data)
  const result = charm.get();

  // Get charms this one reads from
  const readingFrom = manager.getReadingFrom(charm).map((c) => ({
    id: getCharmIdSafe(c),
    name: c.get()[NAME],
  }));

  // Get charms that read from this one
  const readBy = manager.getReadByCharms(charm).map((c) => ({
    id: getCharmIdSafe(c),
    name: c.get()[NAME],
  }));

  return {
    id,
    name,
    recipeName,
    source,
    result,
    readingFrom,
    readBy,
  };
}
