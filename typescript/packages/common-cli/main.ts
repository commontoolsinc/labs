// Load .env file
import { parseArgs } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import {
  CharmManager,
  compileRecipe,
  setBobbyServerUrl,
  storage,
} from "@commontools/charm";
import { getEntityId, isStream } from "@commontools/runner";
import { Identity } from "@commontools/identity";

const { space, charmId, recipeFile, cause, quit } = parseArgs(Deno.args, {
  string: ["space", "charmId", "recipeFile", "cause"],
  boolean: ["quit"],
  default: { quit: false },
});

const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";

storage.setRemoteStorage(new URL(toolshedUrl));
setBobbyServerUrl(toolshedUrl);

async function main() {
  const identity = await Identity.fromPassphrase("common-cli");
  console.log("params:", {
    space,
    identity,
    charmId,
    recipeFile,
    cause,
    quit,
    toolshedUrl,
  });
  const manager = await CharmManager.open({
    space: (space as `did:key:${string}`) ?? identity.did(),
    signer: identity,
  });
  const charms = manager.getCharms();

  charms.sink((charms) => {
    console.log(
      "charms:",
      charms.map((c) => c.toJSON().cell?.["/"]),
    );
  });

  if (charmId) {
    const charm = await manager.get(charmId);
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
