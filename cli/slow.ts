// Load .env file
import { parseArgs } from "@std/cli/parse-args";
import { CharmManager, compileRecipe } from "@commontools/charm";
import {
  getEntityId,
  isStream,
  setBobbyServerUrl,
  storage,
} from "@commontools/runner";
import { createSession, Identity } from "@commontools/identity";

const { charmId, name } = parseArgs(Deno.args, {
  string: ["charmId", "name"],
});

const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";

storage.setRemoteStorage(new URL(toolshedUrl));
setBobbyServerUrl(toolshedUrl);

async function main() {
  const identity = await Identity.fromPassphrase("common user");
  const session = await createSession({
    identity,
    name: name!,
  });

  console.log("params:", {
    session,
    charmId,
    name,
    toolshedUrl,
  });
  const manager = new CharmManager(session);
  const charms = manager.getCharms();
  await storage.synced();
  charms.sink((charms) => {
    console.log(
      "all charms:",
      charms.map((c) => getEntityId(c)?.["/"]),
    );
  });

  const charm = await manager.get(charmId!);
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

main();
