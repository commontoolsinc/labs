// Load .env file
import { parse } from "https://deno.land/std/flags/mod.ts";
import { CharmManager, compileRecipe, storage } from "@commontools/charm";
import { getEntityId, isStream } from "@commontools/runner";

const { space, charmId, recipeFile, cause } = parse(Deno.args);

storage.setRemoteStorage(
  new URL(
    Deno.env.get("TOOLSHED_API_URL") ?? "https://toolshed.saga-castor.ts.net/"
  ),
);

async function main() {
  console.log("starting common-cli");
  const manager = new CharmManager(space ?? "common-cli");

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
      const charmWithSchema = await manager.get(charm);
      charmWithSchema.sink((value) => {
        console.log("running charm:", getEntityId(charm), value);
      });
      const updater = charmWithSchema.get()?.updater;
      if (isStream(updater)) {
        console.log("running updater");
        const randomId = Math.random().toString(36).substring(2, 15);
        updater.send({
            emails: [{
                id: randomId,
                threadId: randomId,
                labelIds: ["INBOX"],
                snippet: "test",
                subject: "test",
                from: "test",
                date: "test",
                to: "test",
                plainText: "test",
            }],
        });
      }
    } catch (error) {
      console.error("Error loading and compiling recipe:", error);
    }
  }

  return new Promise(() => {
    // This promise never resolves, keeping the program alive
    console.log("Program running. Press Ctrl+C to exit.");
  });
}

main();
