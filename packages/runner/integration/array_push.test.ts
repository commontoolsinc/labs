#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

/**
 * integration test: pushes a bunch of numbers onto an array in a recipe
 */
import { Session, ANYONE, Identity, createAdminSession, type DID } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.ts";
import { type JSONSchema, Runtime, getEntityId } from "../src/index.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { CharmManager, compileRecipe } from "@commontools/charm";
const TOOLSHED_URL = Deno.env.get("TOOLSHED_API_URL") ||
  "http://localhost:8000";
const MEMORY_WS_URL = `${
  TOOLSHED_URL.replace("http://", "ws://")
}/api/storage/memory`;
const SPACE_NAME = "myspace";

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

// Create builder and extract functions
// const builder = createBuilder(runtime);
// const { cell, handler } = builder.commontools;

// Read the recipe file content
const recipeContent = await Deno.readTextFile("./integration/array_push.test.tsx");

// TODO(@ellyse) use this instead off compile 
// const { result } = compileAndRun({
//   files: [{ name: "/main.tsx", contents: state.code }],
//   main: "/main.tsx",
// });
const recipe = await compileRecipe(recipeContent, "recipe", runtime, space_thingy_space);
console.log("Recipe compiled successfully");

const charm = await charmManager.runPersistent(
  recipe,
  {}
);
console.log("Result charm ID:", getEntityId(charm));

// Wait so we can load the page on the browser
// FIXME(@ellyse) we should remove this for final code,
// don't want to slow down integration testing any more than necessary
await new Promise(resolve => setTimeout(resolve, 10000));

// Test the push handler
console.log("Initial array:", charm.get().my_array);
console.log("\nTesting batch sends - 10 iterations, 5 numbers each...");

// Get the handler stream and send some numbers
const pushHandlerStream = charm.key("pushHandler");
let sendCount = 0;

// Loop 10 times, sending 5 numbers each time
for (let iteration = 0; iteration < 10; iteration++) {
  const startNum = iteration * 5;
  
  console.log(`Iteration ${iteration + 1}: sending ${startNum} to ${startNum + 4}`);
  
  for (let i = 0; i < 5; i++) {
    pushHandlerStream.send({ value: startNum + i });
    sendCount++;
  }
  
  // Wait for updates to process
  await runtime.idle();
  
  // Wait between batches
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  console.log(`  Current array length: ${charm.get().my_array.length}`);
}

console.log("\nFinal results:");
console.log("Array length:", charm.get().my_array.length);
console.log("Total values sent:", sendCount);
console.log("Expected values:", 50);

console.log("Waiting for storage to sync...");
await runtime.storage.synced();
console.log("Storage synced");
 
// Now we should have all 50 elements
const actualElements = charm.get().my_array.length;
if (actualElements === 50) {
  console.log(`Batch test passed --- All 50 elements received!`);
} else {
  console.error(`Batch test failed --- Expected 50 elements but got ${actualElements} (missing ${50 - actualElements})`);
  console.log("Array contents:", charm.get().my_array);
}

// Clean up
await runtime.dispose();
await storageManager.close();
