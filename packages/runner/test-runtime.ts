#!/usr/bin/env -S deno run --allow-all

/**
 * Simple test to validate the new Runtime architecture works
 */

import { Runtime } from "./src/runtime-class.ts";

async function testRuntime() {
  console.log("🚀 Testing new Runtime architecture...");

  try {
    // Create a new Runtime instance
    const runtime = new Runtime({
      debug: true,
      blobbyServerUrl: "http://localhost:8080",
    });

    console.log("✅ Runtime created successfully");
    console.log("📋 Services available:");
    console.log(`  - Scheduler: ${!!runtime.scheduler}`);
    console.log(`  - Storage: ${!!runtime.storage}`);
    console.log(`  - Recipe Manager: ${!!runtime.recipeManager}`);
    console.log(`  - Module Registry: ${!!runtime.moduleRegistry}`);
    console.log(`  - Document Map: ${!!runtime.documentMap}`);
    console.log(`  - Code Harness: ${!!runtime.harness}`);
    console.log(`  - Runner: ${!!runtime.runner}`);

    // Test that we can access service methods
    console.log(`  - Storage ID: ${runtime.storage.id}`);
    console.log(`  - Has Remote Storage: ${runtime.storage.hasRemoteStorage()}`);
    console.log(`  - Has Signer: ${runtime.storage.hasSigner()}`);

    // Test scheduler idle method
    await runtime.scheduler.idle();
    console.log("✅ Scheduler.idle() works");

    // Test creating a second runtime instance
    const runtime2 = new Runtime({
      debug: false,
    });
    console.log("✅ Multiple Runtime instances can coexist");
    console.log(`  - Runtime 1 Storage ID: ${runtime.storage.id}`);
    console.log(`  - Runtime 2 Storage ID: ${runtime2.storage.id}`);

    // Clean up
    await runtime.dispose();
    await runtime2.dispose();
    console.log("✅ Runtime disposal works");

    console.log("\n🎉 All tests passed! The new Runtime architecture is working.");
    
  } catch (error) {
    console.error("❌ Test failed:", error);
    throw error;
  }
}

// Run the test
if (import.meta.main) {
  await testRuntime();
}