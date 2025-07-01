#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

/**
 * Integration test for schema query reconnection
 * This test verifies that subscriptions are re-established after WebSocket reconnection
 */

import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.ts";
import type { SchemaContext } from "@commontools/memory/interface";

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
  id: "reconnection-integration-test",
});

// Open provider
const provider1 = storageManager1.open(signer.did());
console.log(`Connected to memory server`);

// Define test schema
const testSchema: SchemaContext = {
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

interface UpdateValue {
  value: number;
  timestamp: string;
}

// Track updates
let updateCount = 0;
const updates: UpdateValue[] = [];

// Listen for updates on the test-reconnection-counter document
// Note: this is not the schema subscription, its just a client-side listener
provider1.sink({ "/": TEST_DOC_ID }, (value) => {
  updateCount++;
  updates.push(value.value);
  console.log(`Update #${updateCount}:`, value.value);
});

// Establish server-side subscription with schema
console.log("Establishing subscription...");
await provider1.sync({ "/": TEST_DOC_ID }, true, testSchema);

// Send initial value to server
console.log("Sending initial value...");
await provider1.send([{
  entityId: { "/": TEST_DOC_ID },
  value: {
    value: {
      value: 1,
      timestamp: new Date().toISOString(),
    },
  },
}]);

// Wait to give server time to send us back the update
await new Promise((resolve) => setTimeout(resolve, 1000));

// Check if our listener was called via the subscription
if (updateCount === 0) {
  console.error("FAILED: No initial update received");
  Deno.exit(1);
}

console.log("Initial update received");

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
const preDisconnectCount = updateCount;

// Give it a moment to reconnect
await new Promise((resolve) => setTimeout(resolve, 10000));

// Create a second storage manager and provider
const storageManager2 = StorageManager.open({
  as: signer,
  address: new URL(MEMORY_WS_URL),
  id: "reconnection-integration-test",
});

// Open provider
const provider2 = storageManager2.open(signer.did());
console.log(`Connected to memory server as second client`);

// Establish server-side subscription with schema
console.log("Establishing subscription as second client...");
await provider2.sync({ "/": TEST_DOC_ID }, true, testSchema);

// Send test updates and check if subscription still works
console.log("Sending test updates after disconnection...");

const intervalId = setInterval(async () => {
  try {
    // Send an update as the second
    const result = await provider2.send([{
      entityId: { "/": TEST_DOC_ID },
      value: {
        value: {
          value: testValue++,
          timestamp: new Date().toISOString(),
        },
      },
    }]);
    console.log(result);

    // Check if we've received updates with value >= 100 (post-reconnection)
    const postReconnectUpdates = updates.filter((u) => u.value >= 100);

    if (postReconnectUpdates.length >= 3) {
      console.log("RECONNECTED! Subscription is working again.");
      console.log("SUCCESS: Received updates after reconnection");
      console.log(`Total updates: ${updateCount}`);
      console.log(`Updates before disconnect: ${preDisconnectCount}`);
      console.log(`Post-reconnect updates: ${postReconnectUpdates.length}`);

      clearInterval(intervalId);
      storageManager1.close();
      storageManager2.close();
      Deno.exit(0);
    }
  } catch (error) {
    console.log(
      "Error sending update:",
      error instanceof Error ? error.message : String(error),
    );
  }
}, 1000);

// Timeout after 60 seconds
setTimeout(() => {
  console.error("TIMEOUT: Test did not complete within 60 seconds");
  clearInterval(intervalId);
  storageManager1.close();
  storageManager2.close();
  Deno.exit(1);
}, 30000);

// Keep the process running
await new Promise(() => {});
