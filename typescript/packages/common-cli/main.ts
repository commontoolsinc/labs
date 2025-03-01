// Load .env file
import { parse } from "https://deno.land/std/flags/mod.ts";
import { CharmManager, compileRecipe, storage, setBobbyServerUrl } from "@commontools/charm";
import { getEntityId, isStream, Cell } from "@commontools/runner";
import { Charm } from "@commontools/charm";

let { space, charmId, recipeFile, cause } = parse(Deno.args);

const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ?? "https://toolshed.saga-castor.ts.net/";
storage.setRemoteStorage(new URL(toolshedUrl));
setBobbyServerUrl(toolshedUrl);

async function updateOnce(charm: Cell<Charm>) {
  console.log(Date.now(), "updating once", getEntityId(charm));
  // const authKey = charm.key("auth");
  const auth = charm.key("auth");
  const googleUpdater = charm.key("googleUpdater");

  if (googleUpdater && auth) {
    console.log("googleUpdater flow!");
    // const auth = manager.getArgument(charm).key("auth");
    // FIXME(ja): the space should be included in the authCellId
    const { token, expiresAt } = auth.get();

    if (token && expiresAt && expiresAt < Date.now()) {
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
      console.log("refreshed token");
    } else {
      if (token) {
        console.log("calling googleUpdater flow!");
        googleUpdater.send({});
      }
    }
  }
}

const watchedCharms = new Map<string, Cell<Charm>>();

const watchCharm = (charm: Cell<Charm>) => {
  const id = getEntityId(charm)!["/"];
  if (watchedCharms.has(id)) {
    return;
  }
  watchedCharms.set(id, charm);

  const auth = charm.key("auth");
  const googleUpdater = charm.key("googleUpdater");

  if (googleUpdater && auth) {
    updateOnce(charm);
    setInterval(() => {
      updateOnce(charm);
    }, 1000 * 30);
  }
};

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
    watchCharm(charm);
  } else if (charmId) {
    charm = await manager.get(charmId);
    if (!charm) {
      console.error("charm not found");
      return;
    }
    // FIXME(ja): is syncCell actually 'ensureIsLoaded'
    await storage.syncCell(charm, true);
    watchCharm(charm);
  } else if (space) {
    manager.getCharms().sink((charms) => {
      charms.forEach(async (charm) => {
        await manager.get(getEntityId(charm)!["/"]); // FIXME(ja): this runs the charm - we need to do this to get the schema!
        watchCharm(charm);
      });
    });

    console.log("implement watchSpace");
  }

  return new Promise(() => {
    // This promise never resolves, keeping the program alive
    console.log("Program running. Press Ctrl+C to exit.");
  });
}

main();
