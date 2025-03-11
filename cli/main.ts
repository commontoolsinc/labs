// Load .env file
import { parseArgs } from "@std/cli/parse-args";
import { CharmManager, compileRecipe } from "@commontools/charm";
import {
  getEntityId,
  isStream,
  setBobbyServerUrl,
  storage,
} from "@commontools/runner";
import * as Session from "./session.ts";
import type { DID } from "@commontools/identity";

const { space, charmId, recipeFile, cause, quit } = parseArgs(Deno.args, {
  string: ["space", "charmId", "recipeFile", "cause"],
  boolean: ["quit"],
  default: { quit: false },
});

const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";

const OPERATOR_PASS = Deno.env.get("OPERATOR_PASS") ?? "implicit trust";

storage.setRemoteStorage(new URL(toolshedUrl));
setBobbyServerUrl(toolshedUrl);

async function main() {
  const session = await Session.open({
    passphrase: OPERATOR_PASS,
    space: space as DID,
    name: `~${space}`,
  });

  console.log("params:", {
    space,
    session,
    charmId,
    recipeFile,
    cause,
    quit,
    toolshedUrl,
  });
  const manager = new CharmManager(session);
  const charms = manager.getCharms();
  charms.sink((charms) => {
    console.log(
      "all charms:",
      charms.map((c) => getEntityId(c)?.["/"]),
    );
  });

  if (charmId) {
    const charm = await manager.get(charmId);
    if (quit) {
      if (!charm) {
        console.error("charm not found:", charmId);
        Deno.exit(1);
      }
      console.log("charm:", charmId);
      console.log("charm:", JSON.stringify(charm.get(), null, 2));
      console.log(
        "sourceCell:",
        JSON.stringify(charm.getSourceCell().get(), null, 2),
      );
      Deno.exit(0);
    }
    charm?.sink((value) => {
      console.log("charm:", charmId, value);
    });
  }

  if (recipeFile) {
    try {
      const recipeSrc = await Deno.readTextFile(recipeFile);
      const recipe = await compileRecipe(recipeSrc, "recipe", []);
      const charm = await manager.runPersistent(recipe, undefined, cause);
      await manager.syncRecipe(charm);
      manager.add([charm]);
      const charmWithSchema = (await manager.get(charm))!;
      charmWithSchema.sink((value) => {
        console.log("running charm:", getEntityId(charm), value);
      });
      const updater = charmWithSchema.get()?.updater;
      if (isStream(updater)) {
        console.log("running updater");
        updater.send({ newValues: ["test"] });
      }
      if (quit) {
        await storage.synced();
        Deno.exit(0);
      }
    } catch (error) {
      console.error("Error loading and compiling recipe:", error);
      if (quit) {
        await storage.synced();
        Deno.exit(1);
      }
    }
  }

  return new Promise(() => {
    // This promise never resolves, keeping the program alive
    console.log("Program running. Press Ctrl+C to exit.");
  });
}

main();
