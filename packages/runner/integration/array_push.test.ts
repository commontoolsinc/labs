#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

/**
 * as integration test, we make sure we can write 100 element array and get it back
 * as client performance test, we can use this script to create a charm and see how
 * fast the client can render 100 mapped elements, which often ends up creating a
 * lot of vdom nodes
 */
import { Identity, Session } from "@commontools/identity";
import { env } from "@commontools/integration";
import { StorageManager } from "../src/storage/cache.ts";
import { Runtime, Stream } from "../src/index.ts";
import { compileRecipe, PieceManager } from "@commontools/piece";

(Error as any).stackTraceLimit = 100;

const { API_URL } = env;
const MEMORY_WS_URL = `${
  API_URL.replace("http://", "ws://")
}/api/storage/memory`;
const SPACE_NAME = "runner_integration";

const TOTAL_COUNT = 20; // how many elements we push to the array
const TIMEOUT_MS = 180000; // timeout for the test in ms (3 minutes)

console.log("Array Push Test");
console.log(`Connecting to: ${MEMORY_WS_URL}`);
console.log(`API URL: ${API_URL}`);

// Main test function
async function runTest() {
  const account = await Identity.fromPassphrase("common user");
  const space_thingy = await account.derive(SPACE_NAME);
  const space_thingy_space = space_thingy.did();
  const session = {
    isPrivate: false,
    spaceName: SPACE_NAME,
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
    apiUrl: new URL(API_URL),
    storageManager,
  });

  // Create charm manager for the specified space
  const charmManager = new PieceManager(session, runtime);
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

  const charm = (await charmManager.runPersistent(recipe, {})).asSchema({
    type: "object",
    properties: {
      my_numbers_array: {
        type: "array",
        items: { type: "number" },
      },
      my_objects_array: {
        type: "array",
        items: {
          type: "object",
          properties: { count: { type: "number" } },
        },
      },
      pushNumbersHandler: {
        type: "object",
        properties: { value: { type: "number" } },
        asStream: true,
      },
      pushObjectsHandler: {
        type: "object",
        properties: {
          value: { type: "object", properties: { count: { type: "number" } } },
        },
        asStream: true,
      },
    },
    required: [
      "my_numbers_array",
      "my_objects_array",
      "pushNumbersHandler",
      "pushObjectsHandler",
    ],
  });
  console.log("Result charm ID:", charm.entityId);
  console.log("Result charm schema:", charm.schema);

  // Wait so we can load the page on the browser
  // await new Promise((resolve) => setTimeout(resolve, 10000));

  // Get the handler stream and send some numbers
  const pushNumbersHandlerStream = charm.key(
    "pushNumbersHandler",
  ) as unknown as Stream<{ value: number }>;
  const pushObjectsHandlerStream = charm.key(
    "pushObjectsHandler",
  ) as unknown as Stream<{ value: { count: number } }>;

  const expectedNumbers = [];
  const expectedObjects = [];

  let sendCount = 0;

  // Loop, sending numbers one by one
  for (let i = 0; i < TOTAL_COUNT; i++) {
    console.log(`Sending value: ${i}`);
    pushNumbersHandlerStream.send({ value: i });
    pushObjectsHandlerStream.send({ value: { count: i } });
    expectedNumbers.push(i);
    expectedObjects.push({ count: i });
    sendCount++;
  }

  console.log("Waiting for runtime to finish and storage to sync...");
  await runtime.idle();
  await runtime.storageManager.synced();
  console.log("Storage synced");

  // Now we should have all elements
  const actualNumbersElements = charm.get().my_numbers_array.length;
  const actualObjectsElements = charm.get().my_objects_array.length;
  if (
    actualNumbersElements === TOTAL_COUNT &&
    actualObjectsElements === TOTAL_COUNT
  ) {
    console.log(`Test passed - all ${TOTAL_COUNT} elements received`);
  } else {
    console.error(
      `Test failed - expected ${TOTAL_COUNT} but got ${actualNumbersElements} numbers and ${actualObjectsElements} objects`,
    );
    console.log("Array contents (numbers):", charm.get().my_numbers_array);
    console.log("Array contents (objects):", charm.get().my_objects_array);
    throw new Error(
      `Expected ${TOTAL_COUNT} numbers and ${TOTAL_COUNT} objects but got ${actualNumbersElements} numbers and ${actualObjectsElements} objects`,
    );
  }

  if (
    JSON.stringify(charm.get().my_numbers_array) ===
      JSON.stringify(expectedNumbers)
  ) {
    console.log("Numbers array is as expected");
  } else {
    console.log("Numbers array is not as expected");
    console.log("Expected:", expectedNumbers);
    console.log("Actual:", charm.get().my_numbers_array);
    throw new Error("Numbers array is not as expected");
  }
  if (
    JSON.stringify(charm.get().my_objects_array) ===
      JSON.stringify(expectedObjects)
  ) {
    console.log("Objects array is as expected");
  } else {
    console.log("Objects array is not as expected");
    console.log("Expected:", expectedObjects);
    console.log("Actual:", charm.get().my_objects_array);
    throw new Error("Objects array is not as expected");
  }

  // Clean up
  await runtime.dispose();
  await storageManager.close();
}

// Run the test with timeout
Deno.test({
  name: "array push test",
  fn: async () => {
    let timeoutHandle: number;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Test timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });

    try {
      await Promise.race([runTest(), timeoutPromise]);
      console.log("Test completed successfully within timeout");
    } finally {
      clearTimeout(timeoutHandle!);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
