// Worker script for isolated charm execution
// This file is intended to be loaded as a worker module

import runCharm from "./run-charm.ts";
import { log } from "../utils.ts";

// Handle messages from the main thread
self.onmessage = async (e) => {
  const { spaceId, charmId, updaterKey, operatorPass } = e.data;
  
  try {
    log(`Worker executing charm: ${spaceId}/${charmId}`);
    
    // Set operator password from main thread if provided
    if (operatorPass) {
      Deno.env.set("OPERATOR_PASS", operatorPass);
    }
    
    // Execute the charm in the isolated worker environment
    const result = await runCharm({
      spaceId,
      charmId,
      updaterKey
    });
    
    // Report success back to the main thread
    self.postMessage({ 
      success: true,
      result 
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Worker error: ${errorMessage}`);
    
    // Report error back to the main thread
    self.postMessage({ 
      success: false, 
      error: errorMessage
    });
  } finally {
    // Terminate the worker
    log(`Worker for charm ${spaceId}/${charmId} completed`);
  }
};