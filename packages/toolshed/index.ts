import app from "@/app.ts";
import env from "@/env.ts";
import * as Sentry from "@sentry/deno";
import { identity } from "@/lib/identity.ts";
import { Runtime, StorageManager } from "@commontools/runner";
import { memory } from "@/routes/storage/memory.ts";

// Create a global runtime instance for the server
let runtime: Runtime;

// Initialize runtime with storage and signer
// FIXME(ja): should we do this even on memory-only toolsheds?
const initializeRuntime = () => {
  try {
    console.log(`Initializing runtime with signer ${identity.did()}...`);
    runtime = new Runtime({
      storageManager: StorageManager.open({
        address: new URL(env.MEMORY_URL),
        as: identity,
      }),
      blobbyServerUrl: env.MEMORY_URL,
    });
    console.log("Runtime initialized successfully");
    console.log("Configured to remote storage:", env.MEMORY_URL);
  } catch (error) {
    console.error("Failed to initialize runtime:", error);
    throw error;
  }
};

// Export runtime for use in other parts of the application
export { runtime };

export type AppType = typeof app;

// Graceful shutdown with timeout
const ac = new AbortController();
let isShuttingDown = false;
const SHUTDOWN_TIMEOUT = 10000; // 10 seconds

const handleShutdown = async () => {
  if (isShuttingDown) {
    console.log("Shutdown already in progress...");
    return;
  }

  isShuttingDown = true;
  console.log("Shutdown signal received, closing server...");

  // Create a timeout promise
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Shutdown timed out")), SHUTDOWN_TIMEOUT);
  });

  try {
    // Race between graceful shutdown and timeout
    await Promise.race([
      (async () => {
        // Remove signal listeners to prevent multiple shutdown attempts
        Deno.removeSignalListener("SIGINT", handleShutdown);
        Deno.removeSignalListener("SIGTERM", handleShutdown);

        ac.abort();

        console.log("Closing memory system...");
        const result = await memory.close();
        if (result.error) {
          console.error("Error closing memory:", result.error);
        } else {
          console.log("Memory system closed successfully");
        }
      })(),
      timeoutPromise,
    ]);
  } catch (err) {
    console.error("Error during shutdown:", err);
  }

  console.log("Shutdown complete");
  Deno.exit(0);
};

// Start server with the abort controller
function startServer() {
  console.log(`Server is starting on port http://${env.HOST}:${env.PORT}`);
  initializeRuntime();

  Sentry.init({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1.0,
    environment: env.ENV || "development",
  });

  const serverOptions = {
    hostname: env.HOST,
    port: env.PORT,
    signal: ac.signal,
    onError: (error: unknown) => {
      console.error("Server error:", error);
      Sentry.captureException(error);
      return new Response("Internal Server Error", { status: 500 });
    },
    onListen: ({ port, hostname }: { port: number; hostname: string }) => {
      console.log(`Server running on http://${hostname}:${port}`);
    },
  };

  try {
    Deno.serve(serverOptions, app.fetch);
  } catch (err) {
    if (err instanceof Deno.errors.AddrInUse) {
      console.error(`Port ${env.PORT} is already in use`);
      Deno.exit(1);
    }
    console.error("Failed to start server:", err);
    Deno.exit(1);
  }
}

Deno.addSignalListener("SIGINT", handleShutdown);
Deno.addSignalListener("SIGTERM", handleShutdown);

if (import.meta.main) {
  startServer();
}
