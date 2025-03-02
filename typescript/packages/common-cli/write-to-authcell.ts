// Load .env file
import { CharmManager, compileRecipe, createStorage } from "@commontools/charm";
import { getEntityId, idle } from "@commontools/runner";
import { fetchInboxEmails } from "./gmail.ts";
import { parse } from "https://deno.land/std/flags/mod.ts";

import { getCellFromDocLink } from "@commontools/runner";

const TOOLSHED_API_URL = Deno.env.get("TOOLSHED_API_URL") || "https://toolshed.saga-castor.ts.net";

async function main(
  recipeSrc: string,
  replica: string = "common-knowledge",
  cause?: string,
  jsonData?: any,
) {
  const storage = createStorage({
    type: "remote",
    replica,
    url: new URL(TOOLSHED_API_URL),
  });

  const cellId = { "/": "baedreiajxdvqjxmgpfzjix4h6vd4pl77unvet2k3acfvhb6ottafl7gpua" };

  await storage.syncCell(cellId, true);
  const authCellEntity = {
    cell: cellId,
    path: ["argument", "auth"],
  };

  const authCell = getCellFromDocLink(authCellEntity);
  // authCell.set({ token: "wat" });
  await storage.synced();

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

const flags = parse(Deno.args, {
  string: ["replica", "cause", "data"],
  default: {
    replica: "common-knowledge",
  },
});

const filename = flags._[0];
const replica = flags.replica;
const cause = flags.cause;
const data = flags.data;
let recipeSrc: string;
let jsonData: unknown;

if (!filename) {
  console.error("No typescript recipe file provided");
  console.error("Usage: deno run -A main.ts <recipe-file> [--replica=name] [--cause=id]");
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
    throw new Error(`Error accessing file ${path}: ${error.message}`);
  }
}

async function loadJsonFile(path: string): Promise<unknown> {
  const content = await loadFile(path);
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Error parsing JSON from ${path}: ${error.message}`);
  }
}

try {
  recipeSrc = await loadFile(filename);
  if (data) {
    jsonData = await loadJsonFile(data);
    console.log("Loaded data:", jsonData);
  }
} catch (error) {
  console.error(error.message);
  Deno.exit(1);
}

main(recipeSrc, replica, cause, jsonData);
