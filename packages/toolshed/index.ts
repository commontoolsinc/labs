import app from "@/app.ts";
import env from "@/env.ts";
import { identity } from "@/lib/identity.ts";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { toolshedRuntimeOptions } from "@/runtime-options.ts";
import { memory } from "@/routes/storage/memory.ts";
import { shutdownOpenTelemetry } from "@/lib/otel.ts";

// Create a global runtime instance for the server
let runtime: Runtime;

// Initialize runtime with storage and signer
// FIXME(ja): should we do this even on memory-only toolsheds?
const initializeRuntime = () => {
  try {
    console.log(`Initializing runtime with signer ${identity.did()}...`);

    // Options assembly (the MEMORY_URL/API_URL split, EXPERIMENTAL_* wiring)
    // lives in runtime-options.ts, where it is unit-tested (CT-1814).
    runtime = new Runtime(toolshedRuntimeOptions(
      env,
      StorageManager.open({
        memoryHost: new URL(env.MEMORY_URL),
        as: identity,
      }),
    ));
    // Second consumer of the runtime's telemetry bus → OTel. Toolshed's own
    // Runtime only executes patterns for webhook deliveries (interactive
    // patterns run in browser/bg-piece runtimes), so this is low-volume — but
    // without it those runs emit markers into the void. Fire-and-forget: the
    // dynamic import defers OTel module load off the startup path.
    if (env.OTEL_ENABLED) {
      Promise.all([
        import("@commonfabric/runner/telemetry-otel-bridge"),
        import("@opentelemetry/api"),
      ]).then(([{ attachRuntimeTelemetryOtelBridge }, { metrics, trace }]) => {
        attachRuntimeTelemetryOtelBridge(runtime.telemetry, {
          tracer: trace.getTracer("ct-runner-bridge"),
          meter: metrics.getMeter("ct-runner-bridge"),
          attributes: { "ct.runtime": "server" },
          metricAttributes: {
            "service.name": env.OTEL_SERVICE_NAME,
            "deployment.environment": env.ENV,
          },
        });
        runtime.scheduler.setEventPreflightTelemetryEnabled(true);
      }).catch((error) => {
        console.warn("Runtime OTel bridge attach failed:", error);
      });
    }
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
        if ("error" in result) {
          console.error("Error closing memory:", result.error);
        } else {
          console.log("Memory system closed successfully");
        }

        // Flush buffered spans so the last batch isn't dropped on exit. No-op
        // when telemetry is disabled; bounded by the SHUTDOWN_TIMEOUT race above.
        await shutdownOpenTelemetry();
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

  const serverOptions = {
    hostname: env.HOST,
    port: env.PORT,
    signal: ac.signal,
    onError: (error: unknown) => {
      console.error("Server error:", error);
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
      // Distinct exit code so callers can tell a port collision from other
      // startup failures and retry on a different port.
      Deno.exit(3);
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
