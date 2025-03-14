import { parseArgs } from "@std/cli/parse-args";
import { CharmManager, compileRecipe } from "@commontools/charm";
import {
  type CellLink,
  getCell,
  getCellFromLink,
  getEntityId,
  isStream,
  setBobbyServerUrl,
  storage,
} from "@commontools/runner";
import { type DID, Identity } from "@commontools/identity";
import * as Session from "./session.ts";
import { gmailIntegrationCharmsSchema } from "@commontools/utils";

const { spaceId, targetCellCause, recipePath, cause, name, quit } = parseArgs(
  Deno.args,
  {
    string: ["spaceId", "targetCellCause", "recipePath", "cause", "name"],
    boolean: ["quit"],
    default: {
      name: "recipe-caster",
      quit: false,
    },
  },
);

if (!spaceId || !recipePath) {
  console.error(
    "Usage: deno task castRecipe --spaceId <spaceId> --recipePath <path to recipe> [--targetCellCause <targetCellCause>] [--cause <cause>] [--name <name>] [--quit]",
  );
  Deno.exit(1);
}

const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";

const OPERATOR_PASS = Deno.env.get("OPERATOR_PASS") ?? "implicit trust";

storage.setRemoteStorage(new URL(toolshedUrl));
setBobbyServerUrl(toolshedUrl);

async function castRecipe() {
  console.log(`Casting recipe from ${recipePath} in space ${spaceId}`);

  console.log("OPERATOR_PASS", OPERATOR_PASS);
  const signer = await Identity.fromPassphrase(OPERATOR_PASS);
  storage.setSigner(signer);

  console.log("params:", {
    spaceId,
    targetCellCause,
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

    if (!targetCellCause) {
      throw new Error("Cell ID is required");
    }

    console.log("Recipe compiled successfully");

    const targetCell = getCell(
      spaceId as DID,
      targetCellCause,
      gmailIntegrationCharmsSchema,
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
      name: name!,
      space: spaceId as DID,
    });

    // Create charm manager for the specified space
    const charmManager = new CharmManager(session);

    const charm = await charmManager.runPersistent(
      recipe,
      targetCell,
      cause,
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
