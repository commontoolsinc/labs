// Load .env file
import { CharmManager, compileRecipe } from "@commontools/charm";
import { getEntityId, idle } from "@commontools/runner";
import {
  fetchInboxEmails,
  refreshAccessToken,
  ensureValidToken,
  AuthToken,
  fetchEmailsWithContent,
} from "./gmail.ts";
import { parse } from "https://deno.land/std/flags/mod.ts";
import { storage } from "../common-charm/src/storage.ts";

async function main(
  recipeSrc: string,
  replica: string = "common-knowledge",
  cause?: string,
  jsonData?: any,
  charmId?: string,
) {
  console.log({ recipeSrc, replica, cause, charmId });

  const emailsWithContent = JSON.parse(await Deno.readTextFile("./emails.json"));
  console.log({ emailsWithContent });

  // Set the remote storage URL
  storage.setRemoteStorage(new URL("https://toolshed.saga-castor.ts.net/"));

  const manager = new CharmManager( replica);
  
  const charms = manager.getCharms();
  await manager.sync(charms, true);
  console.log(`found ${charms.get().length} charms`);
  let charm
  if (charmId) {
    charm = await manager.get(charmId, true);
    console.log("got charm", charm.get());
    await idle();
    // charm.key("updater").send({ emails: emailsWithContent.slice(0, 1) });
    charm.key("emails").push(emailsWithContent[0]);
  } else {
    const recipe = await compileRecipe(recipeSrc, "recipe", []);

    charm = await manager.runPersistent(recipe, { emails: [emailsWithContent[0]] }, cause);
    await manager.syncRecipe(charm);
    manager.add([charm]);
    await manager.sync(charms, true);
    await idle();
    charmId = getEntityId(charm)["/"];
  }

  console.log(`https://toolshed.saga-castor.ts.net/${replica}/${charmId}`);
  // const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // await sleep(20 * 1000);

  // console.log(`found ${emailsWithContent.length} emails with content`);
  await idle();
  await manager.sync(charm, true);

  console.log(`http://localhost:5173/${replica}/${charmId}`);

  return;

  // const charms = await manager.getCharms();
  // console.log(`found ${charms.length} charms`);

  // const emails = await fetchInboxEmails();
  // console.log({ emails });
}

const flags = parse(Deno.args, {
  string: ["replica", "cause", "data", "charm"],
  default: {
    replica: "common-knowledge",
  },
});

const filename = flags._[0];
const replica = flags.replica;
const cause = flags.cause;
const data = flags.data;
const charmId = flags.charm;
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
  } catch (error: unknown) {
    throw new Error(
      `Error accessing file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadJsonFile(path: string): Promise<unknown> {
  const content = await loadFile(path);
  try {
    return JSON.parse(content);
  } catch (error: unknown) {
    throw new Error(
      `Error parsing JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

try {
  recipeSrc = await loadFile(filename);
  if (data) {
    jsonData = await loadJsonFile(data);
    console.log("Loaded data:", jsonData);
  }
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  Deno.exit(1);
}

main(recipeSrc, replica, cause, jsonData, charmId);
