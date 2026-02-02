#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read

/**
 * Integration test for schema query reconnection
 * This test verifies that subscriptions are re-established after WebSocket reconnection
 */

import { Identity } from "@commontools/identity";
import { StorageManager } from "../src/storage/cache.ts";
import type { StorableObject, URI } from "@commontools/memory/interface";
import { env } from "@commontools/integration";
import type { JSONSchema } from "@commontools/api";
const { API_URL } = env;

const MEMORY_WS_URL = `${
  API_URL.replace("http://", "ws://")
}api/storage/memory`;
const TEST_DOC_ID = "test-reconnection-counter";

Deno.test({
  name: "schema query reconnection test",
  ignore: true,
  fn: async () => {
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
    const testSchema: JSONSchema = {
      type: "object",
      properties: {
        value: { type: "number" },
        timestamp: { type: "string" },
      },
      required: ["value"],
    };
    const testSelector = { path: [], schema: testSchema };

    interface UpdateValue extends StorableObject {
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
    provider1.sink<UpdateValue>(uri, (value) => {
      updateCount1++;
      updates1.push(value.value);
      console.log(`Provider1 Update #${updateCount1}:`, value.value);
    });

    provider3.sink<UpdateValue>(uri, (value) => {
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
      throw new Error(
        `No initial update received. Provider1: ${updateCount1}, Provider3: ${updateCount3}`,
      );
    }

    console.log("Initial updates received by both providers");

    // Test reconnection behavior
    console.log("\nTesting reconnection behavior...");

    // Access the WebSocket connection -- it's private so we use any
    const providerSocket = (provider1 as any).connection as
      | WebSocket
      | undefined;
    console.log("WebSocket state:", providerSocket?.readyState);

    // Force disconnect the WebSocket
    console.log("Forcing WebSocket disconnection...");
    if (providerSocket) {
      providerSocket.close();
      console.log("WebSocket closed");
    } else {
      console.error("No WebSocket connection found");
      throw new Error("No WebSocket connection found");
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

    // Create a promise that resolves/rejects when test completes
    await new Promise<void>((resolve, reject) => {
      let hasResolved = false;

      const cleanup = () => {
        if (!hasResolved) {
          hasResolved = true;
          clearInterval(intervalId);
          clearTimeout(timeoutId);
          storageManager1.close();
          storageManager2.close();
          storageManager3.close();
        }
      };

      const intervalId = setInterval(async () => {
        if (hasResolved) return; // Don't continue if already resolved

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
            postReconnectUpdates1.length >= 3 &&
            postReconnectUpdates3.length >= 3
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

            cleanup();
            resolve(); // Test passed
          } else if (
            postReconnectUpdates3.length >= 3 &&
            postReconnectUpdates1.length === 0
          ) {
            console.log(
              `Provider1 - Total: ${updateCount1}, Pre-disconnect: ${preDisconnectCount1}, Post-reconnect: ${postReconnectUpdates1.length}`,
            );
            console.log(
              `Provider3 - Total: ${updateCount3}, Pre-disconnect: ${preDisconnectCount3}, Post-reconnect: ${postReconnectUpdates3.length}`,
            );

            cleanup();
            reject(
              new Error("Provider1 did not receive updates after reconnection"),
            );
          }
        } catch (error) {
          // If there's an error, fail the test instead of continuing
          console.error(
            "FATAL ERROR in interval:",
            error instanceof Error ? error.message : String(error),
            error instanceof Error ? error.stack : "",
          );
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }, 1000);

      // Timeout after 30 seconds
      const timeoutId = setTimeout(() => {
        console.error("TIMEOUT: Test did not complete within 30 seconds");
        console.log(
          `Final status - Provider1: ${updateCount1} updates, Provider3: ${updateCount3} updates`,
        );
        cleanup();
        reject(new Error("Test did not complete within 30 seconds"));
      }, 30000);
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
