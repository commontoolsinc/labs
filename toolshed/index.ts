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
  console.log(`Server is starting on port http://${env.HOST}:${port}`);

  Sentry.init({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1.0,
    environment: env.ENV || "development",
  });

  const serverOptions = {
    port,
    signal: ac.signal,
    onError: (error: unknown) => {
      console.error("Server error:", error);
      Sentry.captureException(error);
      return new Response("Internal Server Error", { status: 500 });
    },
    onListen: ({ port, hostname }: { port: number; hostname: string }) => {
      console.log(`Server running on http://${hostname}:${port}`);
    },
    hostname: env.HOST,
  };

  try {
    Deno.serve(serverOptions, app.fetch);
  } catch (err) {
    if (err instanceof Deno.errors.AddrInUse) {
      console.error(`Port ${port} is already in use`);
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
