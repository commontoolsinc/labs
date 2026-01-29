#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-run

/**
 * Integration test to reproduce memory leak when using derive() with array.map()
 *
 * Bug: When a cell updates repeatedly and a derived array is created for each update,
 * the old derived arrays are never garbage collected, causing unbounded memory growth.
 *
 * Expected behavior: Memory should stabilize or grow modestly
 * Actual behavior: Memory grows by gigabytes (1GB+ per 100 increments)
 */
import { Identity, Session } from "@commontools/identity";
import { env } from "@commontools/integration";
import { StorageManager } from "../src/storage/cache.ts";
import { Runtime } from "../src/index.ts";
import { compileRecipe, PieceManager } from "@commontools/piece";

(Error as any).stackTraceLimit = 100;

const { API_URL } = env;
const SPACE_NAME = "runner_integration";
const TIMEOUT_MS = 300000;

// Test parameters
const INCREMENTS_PER_CLICK = 50; // How many times each click increments (must match .tsx file)
const MAX_MEMORY_INCREASE_RATIO = 2.0; // Fail ratio

console.log("Derive Array Leak Test");
console.log(`Connecting to: ${API_URL}`);
console.log(`Will increment ${INCREMENTS_PER_CLICK} times in one click`);

// Helper to get server process memory (portable across Linux and macOS)
async function getServerMemoryMB(): Promise<number> {
  // Try to find toolshed process - it could be either:
  // 1. Compiled binary: "toolshed" (in CI)
  // 2. Deno script: "deno run --unstable-otel" (local dev)
  let pid: string | undefined;

  // First try compiled binary (CI)
  const pgrepBinary = new Deno.Command("pgrep", {
    args: ["-f", "toolshed"],
    stdout: "piped",
  });
  const { stdout: binaryOut, code: binaryCode } = await pgrepBinary.output();

  if (binaryCode === 0 && binaryOut && binaryOut.length > 0) {
    const pids = new TextDecoder().decode(binaryOut).trim().split("\n");
    // Find the toolshed process (not grep itself)
    pid = pids.find((p) => p && p.trim() !== "");
  }

  // If not found, try Deno script (local dev)
  if (!pid) {
    const pgrepDeno = new Deno.Command("pgrep", {
      args: ["-f", "deno run --unstable-otel"],
      stdout: "piped",
    });
    const { stdout: denoOut, code: denoCode } = await pgrepDeno.output();

    if (denoCode === 0 && denoOut && denoOut.length > 0) {
      pid = new TextDecoder().decode(denoOut).trim().split("\n")[0];
    }
  }

  if (!pid || pid.trim() === "") {
    throw new Error(
      "Could not find toolshed server process. Make sure the server is running.",
    );
  }

  // Then get RSS using portable ps -o format (works on Linux, macOS, BSD)
  const psProcess = new Deno.Command("ps", {
    args: ["-p", pid, "-o", "rss="],
    stdout: "piped",
  });
  const { stdout: psOut } = await psProcess.output();
  const rssKB = parseInt(new TextDecoder().decode(psOut).trim());

  return rssKB / 1024; // Convert KB to MB
}

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

  // Create piece manager for the specified space
  const pieceManager = new PieceManager(session, runtime);
  await pieceManager.ready;

  // Read the recipe file content
  const recipeContent = await Deno.readTextFile(
    "./integration/derive_array_leak.test.tsx",
  );

  const recipe = await compileRecipe(
    recipeContent,
    "recipe",
    runtime,
    space_thingy_space,
  );
  console.log("Recipe compiled successfully");

  const piece = (await pieceManager.runPersistent(recipe, {})).asSchema({
    type: "object",
    properties: {
      value: { type: "number" },
      increment: {
        asStream: true,
      },
    },
    required: ["value", "increment"],
  });
  console.log("Piece created:", piece.entityId);

  // Wait for initial state
  await runtime.idle();
  await runtime.storageManager.synced();

  // Give it 5 seconds to settle after initialization
  console.log("Waiting 5 seconds for memory to settle...");
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Measure baseline server memory (where the leak occurs)
  const serverMemoryBeforeMB = await getServerMemoryMB();
  console.log(`Baseline server memory: ${serverMemoryBeforeMB.toFixed(1)} MB`);
  console.log(`Initial counter value: ${piece.get().value}`);

  // Trigger the leak by incrementing
  // The handler increments INCREMENTS_PER_CLICK times per click
  console.log(
    `Clicking increment (${INCREMENTS_PER_CLICK} increments total)...`,
  );
  const incrementStream = piece.key("increment");
  incrementStream.send({});

  // Wait for all updates to complete
  console.log("Waiting for runtime to finish...");
  await runtime.idle();
  await runtime.storageManager.synced();
  console.log(`Final counter value: ${piece.get().value}`);

  // Verify the counter actually incremented
  const finalValue = piece.get().value;
  const expectedValue = INCREMENTS_PER_CLICK;
  if (finalValue !== expectedValue) {
    console.warn(
      `WARNING: Counter value is ${finalValue}, expected ${expectedValue}. ` +
        `This may indicate the derive action failed due to array size.`,
    );
  }

  // Measure server memory after operations complete
  const serverMemoryAfterMB = await getServerMemoryMB();
  const serverMemoryIncreaseMB = serverMemoryAfterMB - serverMemoryBeforeMB;
  const memoryRatio = serverMemoryAfterMB / serverMemoryBeforeMB;

  console.log(`Final server memory: ${serverMemoryAfterMB.toFixed(1)} MB`);
  console.log(
    `Server memory increase: ${serverMemoryIncreaseMB.toFixed(1)} MB (${
      ((memoryRatio - 1) * 100).toFixed(1)
    }% increase)`,
  );
  console.log(`Memory ratio: ${memoryRatio.toFixed(2)}x`);

  // Clean up
  await runtime.dispose();
  await storageManager.close();

  // Check if server memory increase indicates a leak
  if (memoryRatio > MAX_MEMORY_INCREASE_RATIO) {
    console.error(
      `FAIL: Server memory increased to ${memoryRatio.toFixed(2)}x baseline, ` +
        `exceeds limit of ${MAX_MEMORY_INCREASE_RATIO}x`,
    );
    console.error("This indicates a memory leak is present");
    throw new Error(
      `Memory leak detected: ${
        memoryRatio.toFixed(2)
      }x increase (limit: ${MAX_MEMORY_INCREASE_RATIO}x)`,
    );
  }

  console.log(
    `PASS: Memory increase ${
      memoryRatio.toFixed(2)
    }x is within acceptable limit (< ${MAX_MEMORY_INCREASE_RATIO}x)`,
  );
  console.log(`Counter reached ${finalValue} (expected ${expectedValue})`);
}

// Run the test with timeout
Deno.test({
  name: "derive array leak test",
  fn: async () => {
    let timeoutHandle: number;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Test timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });

    try {
      await Promise.race([runTest(), timeoutPromise]);
      console.log("Test completed successfully");
    } finally {
      clearTimeout(timeoutHandle!);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
