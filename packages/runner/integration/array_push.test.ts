#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

/**
 * as integration test, we make sure we can write 100 element array and get it back
 * as client performance test, we can use this script to create a charm and see how
 * fast the client can render 100 mapped elements, which often ends up creating a
 * lot of vdom nodes
 */
import {
  ANYONE,
  createAdminSession,
  type DID,
  Identity,
  Session,
} from "@commontools/identity";
import { env } from "@commontools/integration";
import { StorageManager } from "../src/storage/cache.ts";
import { getEntityId, type JSONSchema, Runtime } from "../src/index.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { CharmManager, compileRecipe } from "@commontools/charm";

(Error as any).stackTraceLimit = 100;

const { API_URL } = env;
const MEMORY_WS_URL = `${
  API_URL.replace("http://", "ws://")
}/api/storage/memory`;
const SPACE_NAME = "runner_integration";

const TOTAL_COUNT = 100; // how many elements we push to the array
const TIMEOUT_MS = 30000; // timeout for the test in ms

console.log("Array Push Test");
console.log(`Connecting to: ${MEMORY_WS_URL}`);
console.log(`API URL: ${API_URL}`);

// Set up timeout
const timeoutPromise = new Promise((_, reject) => {
  setTimeout(() => {
    reject(new Error(`Test timed out after ${TIMEOUT_MS}ms`));
  }, TIMEOUT_MS);
});

// Main test function
async function runTest() {
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
    address: new URL("/api/storage/memory", API_URL),
  });

  // Create runtime
  const runtime = new Runtime({
    blobbyServerUrl: API_URL,
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
  // await new Promise((resolve) => setTimeout(resolve, 10000));

  // Get the handler stream and send some numbers
  const pushHandlerStream = charm.key("pushHandler");
  let sendCount = 0;

  // Loop, sending numbers one by one
  for (let i = 0; i < TOTAL_COUNT; i++) {
    console.log(`Sending value: ${i}`);
    pushHandlerStream.send({ value: i });
    sendCount++;
  }

  console.log("Waiting for runtime to finish and storage to sync...");
  await runtime.idle();
  await runtime.storage.synced();
  console.log("Storage synced");

  // Now we should have all elements
  const actualElements = charm.get().my_array.length;
  if (actualElements === TOTAL_COUNT) {
    console.log(`Test passed - all ${TOTAL_COUNT} elements received`);
  } else {
    console.error(
      `Test failed - expected ${TOTAL_COUNT} elements but got ${actualElements} (missing ${
        TOTAL_COUNT - actualElements
      })`,
    );
    console.log("Array contents:", charm.get().my_array);
    throw new Error(
      `Expected ${TOTAL_COUNT} elements but got ${actualElements}`,
    );
  }

  // Clean up
  await runtime.dispose();
  await storageManager.close();
}

// Run the test with timeout
try {
  await Promise.race([runTest(), timeoutPromise]);
  console.log("Test completed successfully within timeout");
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error("Test failed:", errorMessage, (error as Error).stack);
  Deno.exit(1);
}
