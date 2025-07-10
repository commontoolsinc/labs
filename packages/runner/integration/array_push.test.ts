#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

/**
 * integration test: pushes a bunch of numbers onto an array in a recipe
 */
import {
  ANYONE,
  createAdminSession,
  type DID,
  Identity,
  Session,
} from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.ts";
import { getEntityId, type JSONSchema, Runtime } from "../src/index.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { CharmManager, compileRecipe } from "@commontools/charm";
const TOOLSHED_URL = Deno.env.get("TOOLSHED_API_URL") ||
  "http://localhost:8000";
const MEMORY_WS_URL = `${
  TOOLSHED_URL.replace("http://", "ws://")
}/api/storage/memory`;
const SPACE_NAME = "myspace5";

console.log("Array Push Test");
console.log(`Connecting to: ${MEMORY_WS_URL}`);

const account = await Identity.fromPassphrase(ANYONE);
const space_thingy = await account.derive(SPACE_NAME);
const space_thingy_space = space_thingy.did();
const session = {
  private: false,
  name: SPACE_NAME,
  space: space_thingy_space,
  as: space_thingy,
} as Session;

// Create storage manager
const storageManager = StorageManager.open({
  as: session.as,
  address: new URL("/api/storage/memory", TOOLSHED_URL),
});

// Create runtime
const runtime = new Runtime({
  blobbyServerUrl: TOOLSHED_URL,
  storageManager,
});

// Create charm manager for the specified space
const charmManager = new CharmManager(session, runtime);
await charmManager.ready;

// Read the recipe file content
const recipeContent = await Deno.readTextFile(
  "./integration/array_push.test.tsx",
);

// FIXME(@ellyse) use this instead of compile
// const { result } = compileAndRun({
//   files: [{ name: "/main.tsx", contents: state.code }],
//   main: "/main.tsx",
// });
const recipe = await compileRecipe(
  recipeContent,
  "recipe",
  runtime,
  space_thingy_space,
);
console.log("Recipe compiled successfully");

const charm = await charmManager.runPersistent(
  recipe,
  {},
);
console.log("Result charm ID:", getEntityId(charm));

// Wait so we can load the page on the browser
// FIXME(@ellyse) we should remove this for final code,
// don't want to slow down integration testing any more than necessary
await new Promise((resolve) => setTimeout(resolve, 10000));

// Test the push handler
console.log("Initial array:", charm.get().my_array);

// Get the handler stream and send some numbers
const pushHandlerStream = charm.key("pushHandler");
let sendCount = 0;

// Loop, sending numbers one by one
const TOTAL_COUNT = 10;
console.log(`\nTesting sends - ${TOTAL_COUNT} numbers total...`);
for (let i = 0; i < TOTAL_COUNT; i++) {
  console.log(`Sending value: ${i}`);
  pushHandlerStream.send({ value: i });
  sendCount++;
}

console.log("Waiting for storage to sync...");
await runtime.idle();
await runtime.storage.synced();
console.log("Storage synced");

console.log("\nFinal results:");
console.log("Array length:", charm.get().my_array.length);
console.log("Total values sent:", sendCount);
console.log("Expected values:", TOTAL_COUNT);

// Now we should have all elements
const actualElements = charm.get().my_array.length;
if (actualElements === TOTAL_COUNT) {
  console.log(`Test passed --- All ${TOTAL_COUNT} elements received!`);
} else {
  console.error(
    `Test failed --- Expected ${TOTAL_COUNT} elements but got ${actualElements} (missing ${
      TOTAL_COUNT - actualElements
    })`,
  );
  console.log("Array contents:", charm.get().my_array);
}

// Clean up
await runtime.dispose();
await storageManager.close();
