// Load .env file
import { parseArgs } from "@std/cli/parse-args";
import { CharmManager, compileRecipe } from "@commontools/charm";
import {
  getEntityId,
  idle,
  isStream,
  setBobbyServerUrl,
  storage,
} from "@commontools/runner";
import {
  createSession,
  type DID,
  Identity,
  type Session,
} from "@commontools/identity";
import { assert } from "@commontools/memory/fact";

const {
  spaceName,
  spaceDID,
  charmId,
  recipeFile,
  cause,
  input,
  keyPath,
  quit,
} = parseArgs(Deno.args, {
  string: [
    "spaceName",
    "spaceDID",
    "charmId",
    "recipeFile",
    "cause",
    "input",
    "keyPath",
  ],
  boolean: ["quit"],
  default: { quit: false },
});

const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";

const OPERATOR_PASS = Deno.env.get("OPERATOR_PASS") ?? "implicit trust";

storage.setRemoteStorage(new URL(toolshedUrl));
setBobbyServerUrl(toolshedUrl);

async function main() {
  if (!spaceName && !spaceDID) {
    console.error("No space name or space DID provided");
    Deno.exit(1);
  }

  if (spaceName?.startsWith("~") && !spaceDID) {
    console.error(
      "If space name starts with ~, then space DID must be provided",
    );
    Deno.exit(1);
  }

  if (spaceDID && !spaceDID.startsWith("did:key:")) {
    console.error("Space DID must start with did:key:");
    Deno.exit(1);
  }

  let identity: Identity;
  if (keyPath) {
    try {
      const pkcs8Key = await Deno.readFile(keyPath);
      identity = await Identity.fromPkcs8(pkcs8Key);
    } catch (e) {
      throw new Error(`Could not read key at ${keyPath}.`);
    }
  } else {
    identity = await Identity.fromPassphrase(OPERATOR_PASS);
  }

  const session = {
    private: spaceName?.startsWith("~") ?? false,
    // TODO(seefeld): See what happens if we don't provide a name.
    name: spaceName ?? undefined as unknown as string,
    space: spaceDID as DID ?? await identity.derive(spaceName!),
    as: identity,
  } satisfies Session;

  // TODO(seefeld): It only wants the space, so maybe we simplify the above and just space the space did?
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

  let inputValue: unknown;
  if (input !== undefined && input !== "") {
    // Find all `@#<hex hash>[/<url escaoped path[/<more paths>[/...]]]`
    // and replace them with the corresponding JSON object.
    //
    // Example: "@#bafed0de/path/to/value" and "{ foo: @#bafed0de/a/path }"
    const regex = /(?<!"[^"]*?)@#([a-f0-9]+)((?:\/[^\/\s"',}]+)*?)(?![^"]*?")/g;
    const inputTransformed = input.replace(
      regex,
      (_, hash, path) =>
        JSON.stringify({
          cell: { "/": hash, path: path.split("/").map(decodeURIComponent) },
        }),
    );
    try {
      inputValue = JSON.parse(inputTransformed);
    } catch (error) {
      console.error("Error parsing input:", error);
      Deno.exit(1);
    }
  }

  if (recipeFile) {
    try {
      const recipeSrc = await Deno.readTextFile(recipeFile);
      const recipe = await compileRecipe(recipeSrc, "recipe", []);
      const charm = await manager.runPersistent(recipe, inputValue, cause);
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
        await idle();
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
