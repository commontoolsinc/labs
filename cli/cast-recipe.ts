import { parseArgs } from "@std/cli/parse-args";
import { CharmManager, compileRecipe } from "@commontools/charm";
import {
  getCell,
  getEntityId,
  isStream,
  setBobbyServerUrl,
  storage,
} from "@commontools/runner";
import { type DID, Identity } from "@commontools/identity";
import * as Session from "./session.ts";
import {
  bgUpdaterCharmsSchema,
  CELL_CAUSE,
  SYSTEM_SPACE_ID,
} from "@commontools/utils";

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
    "Usage: deno task castRecipe --recipePath <path to recipe> [--name <name>] [--quit]",
  );
  Deno.exit(1);
}

const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";

const OPERATOR_PASS = Deno.env.get("OPERATOR_PASS") ?? "implicit trust";

storage.setRemoteStorage(new URL(toolshedUrl));
setBobbyServerUrl(toolshedUrl);

async function castRecipe() {
  const spaceId = SYSTEM_SPACE_ID;
  const cause = CELL_CAUSE;
  console.log(`Casting recipe from ${recipePath} in space ${spaceId}`);

  console.log("OPERATOR_PASS", OPERATOR_PASS);
  const signer = await Identity.fromPassphrase(OPERATOR_PASS);
  storage.setSigner(signer);

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
      bgUpdaterCharmsSchema.properties.charms,
    );

    // Ensure the cell is synced
    storage.syncCell(targetCell, true);
    await storage.synced();

    console.log("Getting cell...");

    // Cast the recipe on the cell or with undefined if no cell
    console.log("Casting recipe...");

    // Create session and charm manager (matching main.ts pattern)
    const session = await Session.open({
      passphrase: OPERATOR_PASS,
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

    // Similar to main.ts, get the charm with schema and set up a sink
    const charmWithSchema = (await charmManager.get(charm))!;
    charmWithSchema.sink((value) => {
      console.log("running charm:", getEntityId(charm), value);
    });

    // Check for updater stream
    const updater = charmWithSchema.get()?.updater;
    if (isStream(updater)) {
      console.log("running updater");
      updater.send({ newValues: ["test"] });
    }

    // Wait for storage to sync and exit if quit is specified
    if (quit) {
      await storage.synced();
      console.log("Storage synced, exiting");
      Deno.exit(0);
    } else {
      console.log(
        "Recipe cast complete. Staying alive for updates. Press Ctrl+C to exit.",
      );
      // Keep the process alive to continue receiving updates
      return new Promise(() => {});
    }
  } catch (error) {
    console.error("Error casting recipe:", error);
    if (quit) {
      await storage.synced();
      Deno.exit(1);
    }
  }
}

castRecipe();
