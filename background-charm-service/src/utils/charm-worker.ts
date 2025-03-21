/**
 * Worker script for isolated charm execution
 * This file is intended to be loaded as a worker module by the worker pool
 */

import runCharm from "./run-charm.ts";
import { log } from "../utils.ts";
import { onError, setBobbyServerUrl, storage } from "@commontools/runner";

function initializeWorker(toolshedUrl: string): void {
  storage.setRemoteStorage(new URL(toolshedUrl));
  setBobbyServerUrl(toolshedUrl);
}

// NOTE(ja): capture errors in the charm
let latestError: Error | null = null;
onError((e) => {
  latestError = e;
});

/**
 * Process a task to execute a charm
 */
async function processTask(taskId: string, data: any): Promise<void> {
  const { spaceId, charmId, operatorPass, toolshedUrl } = data;

  try {
    log(`Worker executing ${spaceId}/${charmId}`);

    initializeWorker(toolshedUrl);

    latestError = null;
    const result = await runCharm({ spaceId, charmId, operatorPass });

    if (latestError) {
      self.postMessage({
        taskId,
        error: String(latestError),
      });
    } else {
      self.postMessage({ taskId, result });
    }
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
    self.postMessage({
      error: "Invalid message: missing taskId",
    });
    return;
  }

  // Process the task
  await processTask(taskId, data);
};
