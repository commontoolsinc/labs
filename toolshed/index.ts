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
let isShuttingDown = false;

const handleShutdown = async () => {
  if (isShuttingDown) {
    console.log("Shutdown already in progress...");
    return;
  }

  isShuttingDown = true;
  console.log("Shutdown signal received, closing server...");

  // Remove signal listeners to prevent multiple shutdown attempts
  Deno.removeSignalListener("SIGINT", handleShutdown);
  Deno.removeSignalListener("SIGTERM", handleShutdown);

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
  Deno.exit(0);
};

// Start server with the abort controller
async function startServer() {
  console.log(`Server is starting on port http://localhost:${port}`);

  Sentry.init({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1.0,
  });

  try {
    await Deno.serve({ port, signal: controller.signal }, app.fetch);
  } catch (err) {
    if (err instanceof Deno.errors.AddrInUse) {
      console.error(`Port ${port} is already in use`);
      Deno.exit(1);
    }
    console.error("Failed to start server:", err);
    Deno.exit(1);
  }
}
// Register signal handlers
Deno.addSignalListener("SIGINT", handleShutdown);
Deno.addSignalListener("SIGTERM", handleShutdown);

// Log when server closes
controller.signal.addEventListener("abort", () => {
  console.log("Server shutting down...");
});

if (import.meta.main) {
  startServer();
}
