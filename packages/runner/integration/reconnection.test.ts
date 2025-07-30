#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

/**
 * Integration test for schema query reconnection
 * This test verifies that subscriptions are re-established after WebSocket reconnection
 */

import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.ts";
import type { SchemaContext, URI } from "@commontools/memory/interface";

const TOOLSHED_URL = Deno.env.get("TOOLSHED_API_URL") ||
  "http://localhost:8000";
const MEMORY_WS_URL = `${
  TOOLSHED_URL.replace("http://", "ws://")
}/api/storage/memory`;
const TEST_DOC_ID = "test-reconnection-counter";

console.log("Schema Query Reconnection Integration Test");
console.log(`Connecting to: ${MEMORY_WS_URL}`);

// Create test identity
const signer = await Identity.fromPassphrase("test operator");

// Create storage manager
const storageManager1 = StorageManager.open({
  as: signer,
  address: new URL(MEMORY_WS_URL),
  id: "provider1-reconnect-test",
});

// Open provider
const provider1 = storageManager1.open(signer.did());
console.log(`Connected to memory server`);

// Define test schema
const testSchemaContext: SchemaContext = {
  schema: {
    type: "object",
    properties: {
      value: { type: "number" },
      timestamp: { type: "string" },
    },
    required: ["value"],
  },
  rootSchema: {
    type: "object",
    properties: {
      value: { type: "number" },
      timestamp: { type: "string" },
    },
    required: ["value"],
  },
};
const testSelector = { path: [], schemaContext: testSchemaContext };

interface UpdateValue {
  value: number;
  timestamp: string;
}

// Track updates for each provider
let updateCount1 = 0;
const updates1: UpdateValue[] = [];
let updateCount3 = 0;
const updates3: UpdateValue[] = [];

// Create a third provider that stays connected (control)
const storageManager3 = StorageManager.open({
  as: signer,
  address: new URL(MEMORY_WS_URL),
  id: "provider3-control-test",
});
const provider3 = storageManager3.open(signer.did());
console.log(`Provider3 (control) connected to memory server`);
const uri: URI = `of:${TEST_DOC_ID}`;
// Listen for updates on the test-reconnection-counter document
// Note: this is not the schema subscription, its just a client-side listener
provider1.sink(uri, (value) => {
  updateCount1++;
  updates1.push(value.value);
  console.log(`Provider1 Update #${updateCount1}:`, value.value);
});

provider3.sink(uri, (value) => {
  updateCount3++;
  updates3.push(value.value);
  console.log(`Provider3 Update #${updateCount3}:`, value.value);
});

// Establish server-side subscription with schema
console.log("Establishing subscriptions...");
await provider1.sync(uri, testSelector);
await provider3.sync(uri, testSelector);

// Send initial value to server
console.log("Sending initial value...");
await provider1.send([{
  uri,
  value: {
    value: {
      value: 1,
      timestamp: new Date().toISOString(),
    },
  },
}]);

// Wait to give server time to send us back the update
await new Promise((resolve) => setTimeout(resolve, 1000));

// Check if our listeners were called via the subscription
if (updateCount1 === 0 || updateCount3 === 0) {
  console.error(
    `FAILED: No initial update received. Provider1: ${updateCount1}, Provider3: ${updateCount3}`,
  );
  Deno.exit(1);
}

console.log("Initial updates received by both providers");

// Test reconnection behavior
console.log("\nTesting reconnection behavior...");

// Access the WebSocket connection -- it's private so we use any
const providerSocket = (provider1 as any).connection as WebSocket | undefined;
console.log("WebSocket state:", providerSocket?.readyState);

// Force disconnect the WebSocket
console.log("Forcing WebSocket disconnection...");
if (providerSocket) {
  providerSocket.close();
  console.log("WebSocket closed");
} else {
  console.error("No WebSocket connection found");
  Deno.exit(1);
}

// Monitor reconnection and updates
let testValue = 100; // Use values over 100 to show the value happens after reconnection
const preDisconnectCount1 = updateCount1;
const preDisconnectCount3 = updateCount3;

// Give it a moment to reconnect
await new Promise((resolve) => setTimeout(resolve, 10000));

// Create a second storage manager and provider
const storageManager2 = StorageManager.open({
  as: signer,
  address: new URL(MEMORY_WS_URL),
  id: "provider2-reconnect-test",
});

// Open provider
const provider2 = storageManager2.open(signer.did());
console.log(`Connected to memory server as second client`);

// Establish server-side subscription with schema
console.log("Establishing subscription as second client...");
await provider2.sync(uri, testSelector);

// Send test updates and check if subscription still works
console.log("Sending test updates after disconnection...");

const intervalId = setInterval(async () => {
  try {
    // Send an update as the second
    const result = await provider2.send([{
      uri,
      value: {
        value: {
          value: testValue++,
          timestamp: new Date().toISOString(),
        },
      },
    }]);
    console.log(result);

    // Check if we've received updates with value >= 100 (post-reconnection)
    const postReconnectUpdates1 = updates1.filter((u) => u.value >= 100);
    const postReconnectUpdates3 = updates3.filter((u) => u.value >= 100);

    console.log(
      `Status - Provider1 post-reconnect updates: ${postReconnectUpdates1.length}, Provider3: ${postReconnectUpdates3.length}`,
    );

    if (
      postReconnectUpdates1.length >= 3 && postReconnectUpdates3.length >= 3
    ) {
      console.log(
        "SUCCESS: Both providers received updates after reconnection!",
      );
      console.log(
        `Provider1 - Total: ${updateCount1}, Pre-disconnect: ${preDisconnectCount1}, Post-reconnect: ${postReconnectUpdates1.length}`,
      );
      console.log(
        `Provider3 - Total: ${updateCount3}, Pre-disconnect: ${preDisconnectCount3}, Post-reconnect: ${postReconnectUpdates3.length}`,
      );

      clearInterval(intervalId);
      storageManager1.close();
      storageManager2.close();
      storageManager3.close();
      Deno.exit(0);
    } else if (
      postReconnectUpdates3.length >= 3 && postReconnectUpdates1.length === 0
    ) {
      console.log(
        `Provider1 - Total: ${updateCount1}, Pre-disconnect: ${preDisconnectCount1}, Post-reconnect: ${postReconnectUpdates1.length}`,
      );
      console.log(
        `Provider3 - Total: ${updateCount3}, Pre-disconnect: ${preDisconnectCount3}, Post-reconnect: ${postReconnectUpdates3.length}`,
      );

      clearInterval(intervalId);
      storageManager1.close();
      storageManager2.close();
      storageManager3.close();
      Deno.exit(1);
    }
  } catch (error) {
    console.log(
      "Error sending update:",
      error instanceof Error ? error.message : String(error),
    );
  }
}, 1000);

// Timeout after 30 seconds
setTimeout(() => {
  console.error("TIMEOUT: Test did not complete within 30 seconds");
  console.log(
    `Final status - Provider1: ${updateCount1} updates, Provider3: ${updateCount3} updates`,
  );
  clearInterval(intervalId);
  storageManager1.close();
  storageManager2.close();
  storageManager3.close();
  Deno.exit(1);
}, 30000);

// Keep the process running
await new Promise(() => {});
