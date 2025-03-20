import app from "@/app.ts";
import env from "@/env.ts";
import * as Sentry from "@sentry/deno";
import { Identity } from "@commontools/identity";
import { storage } from "@commontools/runner";
import { memory } from "@/routes/storage/memory.ts";

const port = env.PORT;

// Initialize storage with signer
const initializeStorage = async () => {
  try {
    console.log("Initializing storage signer...");
    const signer = await Identity.fromPassphrase(env.IDENTITY_PASSPHRASE);
    storage.setSigner(signer);
    storage.setRemoteStorage(new URL(env.MEMORY_URL));
    console.log("Storage signer initialized successfully");
  } catch (error) {
    console.error("Failed to initialize storage signer:", error);
    throw error;
  }
};

export type AppType = typeof app;

// Create AbortController for graceful shutdown
const controller = new AbortController();

// Handle shutdown signals (SIGINT, SIGTERM)
const handleShutdown = async () => {
  console.log("Shutdown signal received, closing server...");

  // Abort the server
  controller.abort();

  try {
    // Close the memory system gracefully
    console.log("Closing memory system...");
    const result = await memory.close();
    if (result.error) {
      console.error("Error closing memory:", result.error);
    } else {
      console.log("Memory system closed successfully");
    }
  } catch (err) {
    console.error("Error during shutdown:", err);
  }

  console.log("Shutdown complete");
};

// Register signal handlers
Deno.addSignalListener("SIGINT", handleShutdown);
Deno.addSignalListener("SIGTERM", handleShutdown);

// Start server with the abort controller
Deno.serve({ port, signal: controller.signal }, app.fetch);

// Log when server closes
controller.signal.addEventListener("abort", () => {
  console.log("Server shutting down...");
});
