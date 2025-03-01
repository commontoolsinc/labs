// Load .env file
import { parse } from "https://deno.land/std/flags/mod.ts";
import { CharmManager, compileRecipe, storage, setBobbyServerUrl } from "@commontools/charm";
import { getEntityId, isStream, Cell } from "@commontools/runner";
import { Charm } from "@commontools/charm";

let { space, charmId, recipeFile, cause } = parse(Deno.args);

const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ?? "https://toolshed.saga-castor.ts.net/";
storage.setRemoteStorage(new URL(toolshedUrl));
setBobbyServerUrl(toolshedUrl);

async function main() {
  console.log("starting common-cli");
  const manager = new CharmManager(space ?? "common-cli");

  let charm: Cell<Charm> | undefined;

  if (recipeFile) {
    const recipeSrc = await Deno.readTextFile(recipeFile);
    const recipe = await compileRecipe(recipeSrc, "recipe", []);
    charm = await manager.runPersistent(recipe, undefined, cause);
    await manager.syncRecipe(charm);
    manager.add([charm]);

    charmId = getEntityId(charm)!["/"];
    console.log("new charm:", `${toolshedUrl}${space}/${charmId}`);
    charm = await manager.get(charmId); // FIXME(ja): load with schema

    if (!charm) {
      console.error("newly created charm not found!!");
      return;
    }

    if (Deno.readTextFileSync("token.json")) {
      const token = JSON.parse(Deno.readTextFileSync("token.json"));
      charm.key("auth").send(token);
    }

    await storage.synced();
  } else if (charmId) {
    charm = await manager.get(charmId);
    if (!charm) {
      console.error("charm not found");
      return;
    }
    await storage.syncCell(charm, true);
  }

  // FIXME(ja): we need to keep checking this incase the token state changes
  if (charm) {
    // const authKey = charm.key("auth");
    const auth = charm.key("auth");
    const updater = charm.key("updater");

    // return;
    if (updater) {
      console.log("updater flow!");
      // const auth = manager.getArgument(charm).key("auth");
      // FIXME(ja): the space should be included in the authCellId
      const expiresAt = auth.get().expiresAt;
      console.log("checking expiresAt", expiresAt);
      if (expiresAt && expiresAt < Date.now()) {
        console.log("token expired, refreshing");

        const authCellId = JSON.parse(JSON.stringify(auth.getAsDocLink()));
        authCellId.space = space;
        console.log("authCellId", JSON.stringify(authCellId));
        const refresh_url = new URL("/api/integrations/google-oauth/refresh", toolshedUrl);
        const refresh_response = await fetch(refresh_url, {
          method: "POST",
          body: JSON.stringify({ authCellId }),
        });
        const refresh_data = await refresh_response.json();
        if (!refresh_data.success) {
          console.error("refresh_data", refresh_data);
          return;
        }
        await storage.synced();
      }

      updater.send({});
    }
  }

  // if (recipeFile) {
  //   try {
  //     const recipeSrc = await Deno.readTextFile(recipeFile);
  //     const recipe = await compileRecipe(recipeSrc, "recipe", []);
  //     const charm = await manager.runPersistent(recipe, undefined, cause);
  //     await manager.syncRecipe(charm);
  //     manager.add([charm]);
  //     console.log("charm:", `${toolshedUrl}/${space}/${getEntityId(charm)}`);

  //     const charmWithSchema = await manager.get(charm);
  //     if (!charmWithSchema) {
  //       console.error("charm not found");
  //       return;
  //     }
  //     charmWithSchema.sink((value) => {
  //       console.log("running charm:", getEntityId(charm), value);
  //     });
  //     const updater = charmWithSchema.get()?.updater;
  //     if (isStream(updater)) {
  //       console.log("running updater");
  //       const randomId = Math.random().toString(36).substring(2, 15);
  //       updater.send({
  //         emails: [
  //           {
  //             id: randomId,
  //             threadId: randomId,
  //             labelIds: ["INBOX"],
  //             snippet: "test",
  //             subject: "test",
  //             from: "test",
  //             date: "test",
  //             to: "test",
  //             plainText: "test",
  //           },
  //         ],
  //       });
  //     }
  //   } catch (error) {
  //     console.error("Error loading and compiling recipe:", error);
  //   }
  // }

  return new Promise(() => {
    // This promise never resolves, keeping the program alive
    console.log("Program running. Press Ctrl+C to exit.");
  });
}

main();
