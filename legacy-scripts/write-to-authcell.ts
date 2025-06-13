// Load .env file
import { AuthSchema, type MemorySpace, Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { parseArgs } from "@std/cli/parse-args";
import { Identity } from "@commontools/identity";

const TOOLSHED_API_URL = Deno.env.get("TOOLSHED_API_URL") ||
  "https://toolshed.saga-castor.ts.net";
const OPERATOR_PASS = Deno.env.get("OPERATOR_PASS") ?? "common user";

async function main(
  recipeSrc: string,
  replica?: MemorySpace,
  cause?: string,
  jsonData?: any,
) {
  const identity = await Identity.fromPassphrase(OPERATOR_PASS);
  // Create runtime with proper configuration
  const runtime = new Runtime({
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", TOOLSHED_API_URL),
    }),
    blobbyServerUrl: TOOLSHED_API_URL,
  });

  const cellId = {
    "/": "baedreiajxdvqjxmgpfzjix4h6vd4pl77unvet2k3acfvhb6ottafl7gpua",
  };

  const authCell = runtime.getCellFromEntityId(
    replica ?? identity.did(),
    cellId,
    [
      "argument",
      "auth",
    ],
    AuthSchema,
  );
  await runtime.storage.syncCell(authCell);
  await runtime.storage.synced();

  // authCell.set({ token: "wat" });

  console.log("AUTH CELL AFTER SET", authCell.get());

  console.log("AUTH CELL", authCell);

  // const recipe = await compileRecipe(recipeSrc, "recipe", []);

  // const charm = await manager.runPersistent(recipe, jsonData, cause);
  // await manager.syncRecipe(charm);
  // manager.add([charm]);
  // console.log({ charm });

  // const charmId = getEntityId(charm)["/"];
  // console.log(`http://localhost:5173/${replica}/${charmId}`);
  // console.log(`${TOOLSHED_API_URL}/${replica}/${charmId}`);

  // const gotCharm = await manager.get(charmId);

  // // This grabs the "input argument cell"
  // const argumentCell = manager.getArgument(gotCharm);

  // console.log("CHARM", gotCharm);
  // console.log("ARGUMENT", argumentCell);
  // // console.log("wat");

  // gotAuthCell.get();
  // await storage.sync(authCell);

  // gotAuthCell.set({ token: "ohai" });

  // manager.getArgument(gotCharm)
  // manager.getArgument(gotCharm).key("auth").get()

  // const charms = await manager.getCharms();
  // console.log(`found ${charms.length} charms`);

  // const charm = await manager.get(charmId);
  // console.log({ charm });

  // const emails = await fetchInboxEmails();
  // console.log({ emails });
}

const flags = parseArgs(Deno.args, {
  string: ["replica", "cause", "data"],
  default: {
    replica: "common-knowledge",
  },
});

const filename = flags._[0];
const replica = flags.replica as MemorySpace;
const cause = flags.cause;
const data = flags.data;
let recipeSrc: string;
let jsonData: unknown;

if (!filename) {
  console.error("No typescript recipe file provided");
  console.error(
    "Usage: deno run -A main.ts <recipe-file> [--replica=name] [--cause=id]",
  );
  Deno.exit(1);
}

// Check if filename is actually a string (not a number)
if (typeof filename !== "string") {
  console.error("Recipe file must be a string path");
  Deno.exit(1);
}

async function loadFile(path: string): Promise<string> {
  if (typeof path !== "string") {
    throw new Error("File path must be a string");
  }

  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    throw new Error(
      `Error accessing file ${path}: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }
}

async function loadJsonFile(path: string): Promise<unknown> {
  const content = await loadFile(path);
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Error parsing JSON from ${path}: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }
}

try {
  recipeSrc = await loadFile(filename);
  if (data) {
    jsonData = await loadJsonFile(data);
    console.log("Loaded data:", jsonData);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unknown error");
  Deno.exit(1);
}

main(recipeSrc, replica, cause, jsonData);
