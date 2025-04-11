import { parseArgs } from "@std/cli/parse-args";
import { CharmManager, compileRecipe } from "@commontools/charm";
import {
  getCell,
  getEntityId,
  setBobbyServerUrl,
  storage,
} from "@commontools/runner";
import { type DID } from "@commontools/identity";
import { createAdminSession } from "@commontools/identity";
import {
  BG_CELL_CAUSE,
  BG_SYSTEM_SPACE_ID,
  BGCharmEntriesSchema,
} from "./src/schema.ts";
import { getIdentity } from "./src/utils.ts";

const { recipePath, quit } = parseArgs(
  Deno.args,
  {
    string: ["recipePath"],
    boolean: ["quit"],
    default: {
      name: "recipe-caster",
      quit: false,
    },
  },
);

if (!recipePath) {
  console.error(
    "Usage: deno task castRecipe --recipePath <path to recipe>",
  );
  Deno.exit(1);
}

const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";

const identity = await getIdentity(
  Deno.env.get("IDENTITY"),
  Deno.env.get("OPERATOR_PASS"),
);

storage.setRemoteStorage(new URL(toolshedUrl));
setBobbyServerUrl(toolshedUrl);

async function castRecipe() {
  const spaceId = BG_SYSTEM_SPACE_ID;
  const cause = BG_CELL_CAUSE;
  console.log(`Casting recipe from ${recipePath} in space ${spaceId}`);

  storage.setSigner(identity);

  console.log("params:", {
    spaceId,
    recipePath,
    cause,
    toolshedUrl,
    quit,
  });

  try {
    // Load and compile the recipe first
    console.log("Loading recipe...");
    const recipeSrc = await Deno.readTextFile(recipePath!);
    const recipe = await compileRecipe(recipeSrc, "recipe", []);

    if (!recipe) {
      throw new Error(`Failed to compile recipe from ${recipePath}`);
    }

    if (!cause) {
      throw new Error("Cell ID is required");
    }

    console.log("Recipe compiled successfully");

    const targetCell = getCell(
      spaceId as DID,
      cause,
      BGCharmEntriesSchema,
    );

    // Ensure the cell is synced
    await storage.syncCell(targetCell, true);
    await storage.synced();

    console.log("Getting cell...");

    // Cast the recipe on the cell or with undefined if no cell
    console.log("Casting recipe...");

    // Create session and charm manager (matching main.ts pattern)
    const session = await createAdminSession({
      identity,
      name: "recipe-caster",
      space: spaceId as DID,
    });

    // Create charm manager for the specified space
    const charmManager = new CharmManager(session);

    const charm = await charmManager.runPersistent(
      recipe,
      { charms: targetCell },
    );

    console.log("Recipe cast successfully!");
    console.log("Result charm ID:", getEntityId(charm));

    await storage.synced();
    console.log("Storage synced, exiting");
    Deno.exit(0);
  } catch (error) {
    console.error("Error casting recipe:", error);
    if (quit) {
      await storage.synced();
      Deno.exit(1);
    }
  }
}

castRecipe();
