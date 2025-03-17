/**
 * Worker script for isolated charm execution
 * This file is intended to be loaded as a worker module by the worker pool
 */

import runCharm from "./run-charm.ts";
import { log } from "../utils.ts";
import { setBobbyServerUrl, storage } from "@commontools/runner";

// Initialize worker
let isInitialized = false;

/**
 * Initialize the worker environment
 */
function initializeWorker(operatorPass?: string, toolshedUrl?: string): void {
  if (isInitialized) return;

  // Set operator password from main thread if provided
  if (operatorPass) {
    Deno.env.set("OPERATOR_PASS", operatorPass);
  }

  // Configure storage and Bobby server
  if (toolshedUrl) {
    log(`Worker configuring storage with URL: ${toolshedUrl}`);

    // Initialize storage and Bobby server in the worker process
    storage.setRemoteStorage(new URL(toolshedUrl));
    setBobbyServerUrl(toolshedUrl);

    // Set environment variable as well for any internal code that might use it
    Deno.env.set("TOOLSHED_API_URL", toolshedUrl);
  } else {
    log("Warning: No toolshed URL provided to worker");
  }

  isInitialized = true;
}

/**
 * Process a task to execute a charm
 */
async function processTask(taskId: string, data: any): Promise<void> {
  const { spaceId, charmId, updaterKey, operatorPass, toolshedUrl } = data;

  try {
    log(`Worker executing task ${taskId}: charm ${spaceId}/${charmId}`);

    // Make sure worker is initialized
    initializeWorker(operatorPass, toolshedUrl);

    // Execute the charm in the isolated worker environment
    const result = await runCharm({
      spaceId,
      charmId,
      updaterKey,
    });

    // Report success back to the main thread
    self.postMessage({
      taskId,
      result,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Worker error for task ${taskId}: ${errorMessage}`);

    // Report error back to the main thread
    self.postMessage({
      taskId,
      error: errorMessage,
    });
  }
}

// Handle messages from the main thread
self.onmessage = async (e) => {
  const { taskId, data } = e.data;

  if (!taskId) {
    log("Worker received message without taskId");
    self.postMessage({
      error: "Invalid message: missing taskId",
    });
    return;
  }

  // Process the task
  await processTask(taskId, data);
};
