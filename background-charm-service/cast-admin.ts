import { parseArgs } from "@std/cli/parse-args";
import { CharmManager, compileRecipe } from "@commontools/charm";
import {
  getCell,
  getEntityId,
  setBobbyServerUrl,
  storage,
} from "@commontools/runner";
import { type DID, Identity } from "@commontools/identity";
import {
  bgUpdaterCharmsSchema,
  CELL_CAUSE,
  SYSTEM_SPACE_ID,
} from "@commontools/utils";
import { getIdentity } from "./src/utils.ts";
import { env } from "./src/env.ts";

const { recipePath, name, quit } = parseArgs(
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
  const spaceId = SYSTEM_SPACE_ID;
  const cause = CELL_CAUSE;
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
    // Cast the recipe on the cell or with undefined if no cell
    console.log("Casting recipe...");

    const identity = await Identity.fromPkcs8(Deno.readFileSync("key.pem"));
    // const identity = await Identity.fromPassphrase("common user");

    const session = {
      private: false,
      as: identity,
      name: "toolshed-system",
      space: spaceId as DID,
    };

    // Create charm manager for the specified space
    const charmManager = new CharmManager(session);

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
      bgUpdaterCharmsSchema.properties.charms,
    );

    // Ensure the cell is synced
    storage.syncCell(targetCell, true);
    await storage.synced();
    const charms = charmManager.getCharms();
    console.log({ charms: charms.get() });

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
