// Load .env file
import { parseArgs } from "@std/cli/parse-args";
import { CharmManager, compileRecipe } from "@commontools/charm";
import {
  getEntityId,
  isStream,
  type MemorySpace,
  Runtime,
} from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import {
  createAdminSession,
  type DID,
  Identity,
  type Session,
} from "@commontools/identity";
import { isRecord } from "@commontools/utils/types";

const {
  spaceName,
  spaceDID,
  charmId,
  recipeFile,
  cause,
  input,
  userKey,
  adminKey,
  quit,
} = parseArgs(Deno.args, {
  string: [
    "spaceName",
    "spaceDID",
    "charmId",
    "recipeFile",
    "cause",
    "input",
    "userKey",
    "adminKey",
  ],
  boolean: ["quit"],
  default: { quit: false },
});

const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";

const OPERATOR_PASS = Deno.env.get("OPERATOR_PASS") ?? "common user";

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
  if (adminKey || userKey) {
    try {
      const pkcs8Key = await Deno.readFile(adminKey ?? userKey!);
      identity = await Identity.fromPkcs8(pkcs8Key);
    } catch (e) {
      console.error(`Could not read key at ${adminKey ?? userKey}.`);
      Deno.exit(1);
    }
  } else {
    identity = await Identity.fromPassphrase(OPERATOR_PASS);
  }

  // Actual identity is derived from space name if no admin key is provided.
  if (!adminKey && spaceName !== undefined) {
    identity = await identity.derive(spaceName);
  }

  const space: DID = spaceDID as DID ?? identity.did();

  const session = await createAdminSession({
    identity,
    space,
    name: spaceName ?? "unknown",
  }) satisfies Session;

  // TODO(seefeld): It only wants the space, so maybe we simplify the above and just space the space did?
  const runtime = new Runtime({
    storageManager: StorageManager.open({
      as: identity,
      address: new URL(toolshedUrl),
    }),
    blobbyServerUrl: toolshedUrl,
  });
  const charmManager = new CharmManager(session, runtime);
  await charmManager.ready;
  const charms = charmManager.getCharms();
  charms.sink((charms) => {
    console.log(
      "all charms:",
      charms.map((c) => getEntityId(c)?.["/"]),
    );
  });

  if (charmId) {
    const charm = await charmManager.get(charmId);
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
    const regex = /(?:^|[:\s,{])(@#[a-zA-Z0-9]+(?:\/[^\/\s"',}]+)*)/g;
    const inputTransformed = input.replace(
      regex,
      (match, fullRef) => {
        // Extract hash and path from the full reference
        // fullRef format is @#hash/path
        const hashMatch = fullRef.match(
          /@#([a-zA-Z0-9]+)((?:\/[^\/\s"',}]+)*)/,
        );
        if (!hashMatch) return match;

        const [_, hash, path] = hashMatch;

        // Create the cell JSON object
        const linkJson = JSON.stringify({
          cell: { "/": hash },
          path: path.split("/").filter(Boolean).map(decodeURIComponent),
        });

        // If the match starts with @, it means the reference is at the beginning of the string
        // or the entire string is a reference - don't prepend any character
        return match.charAt(0) === "@" ? linkJson : match.charAt(0) + linkJson;
      },
    );
    try {
      console.log("inputTransformed:", inputTransformed);
      inputValue = JSON.parse(inputTransformed);
    } catch (error) {
      console.error("Error parsing input:", error);
      Deno.exit(1);
    }
  }

  function mapToCell(value: unknown): unknown {
    if (
      isRecord(value) && isRecord(value.cell) &&
      typeof value.cell["/"] === "string" &&
      Array.isArray(value.path)
    ) {
      const space = (value.space ?? spaceDID) as MemorySpace;
      return runtime.getCellFromLink({
        space,
        cell: runtime.documentMap.getDocByEntityId(
          space,
          value.cell as { "/": string },
          true,
        )!,
        path: value.path,
      });
    } else if (Array.isArray(value)) {
      return value.map(mapToCell);
    } else if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, value]) => [key, mapToCell(value)]),
      );
    }
    return value;
  }

  inputValue = mapToCell(inputValue);

  if (recipeFile) {
    try {
      const recipeSrc = await Deno.readTextFile(recipeFile);
      const recipe = await compileRecipe(recipeSrc, "recipe", runtime, space);
      const charm = await charmManager.runPersistent(recipe, inputValue, cause);
      const charmWithSchema = (await charmManager.get(charm))!;
      charmWithSchema.sink((value) => {
        console.log("running charm:", getEntityId(charm), value);
      });
      const updater = charmWithSchema.get()?.updater;
      if (isStream(updater)) {
        console.log("running updater");
        updater.send({ newValues: ["test"] });
      }
      if (quit) {
        await runtime.idle();
        await runtime.storage.synced();
        // This console.log is load bearing for the integration tests. This is
        // how the integration tests get the charm ID.
        console.log("created charm: ", getEntityId(charm)!["/"]);
        Deno.exit(0);
      }
    } catch (error) {
      console.error("Error loading and compiling recipe:", error);
      if (quit) {
        await runtime.storage.synced();
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
