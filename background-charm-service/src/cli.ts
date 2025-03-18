#!/usr/bin/env -S deno run -A
import { parseArgs } from "@std/cli/parse-args";
import { BackgroundCharmService } from "./service.ts";
import { ensureBGCell, log } from "./utils.ts";
import { setBobbyServerUrl, storage } from "@commontools/runner";

// Import environment configuration
import { env, getConfig, mergeConfigWithArgs } from "./config.ts";

// Initialize storage and Bobby server
storage.setRemoteStorage(new URL(env.TOOLSHED_API_URL));
setBobbyServerUrl(env.TOOLSHED_API_URL);

/**
 * Display usage information
 */
function showHelp() {
  console.log("Background Charm Service");
  console.log(
    "A robust service for running charms in the background with health monitoring",
  );
  console.log("");
  console.log("Usage: deno run -A cli.ts [options]");
  console.log("");
  console.log("Options:");
  // FIXME(ja): readd adding of manual charms to list!
  // console.log(
  //   "  --charms=<space/charm/integration>,*   Comma-separated list of space/charm IDs/integrations",
  // );
  console.log(
    "  --interval=<seconds>       Update interval in seconds (default: 60)",
  );
  console.log(
    "  --failures=<number>        Disable after N consecutive failures (default: 5)",
  );
  console.log(
    "  --log-interval=<seconds>   Log status interval in seconds (default: 300)",
  );
  console.log(
    `  --only=<name>          Only run charms for this integration (default: all)`,
  );

  console.log("  --initialize               Initialize integration cell");
  console.log(
    "  --max-concurrent=<number>  Max concurrent jobs (default: 5)",
  );
  console.log(
    "  --max-retries=<number>     Max retry attempts for failed jobs (default: 3)",
  );
  console.log("  --help                     Show this help message");
  Deno.exit(0);
}

async function main() {
  // Parse command line arguments
  const args = parseArgs(Deno.args, {
    string: [
      // "charms",
      "interval",
      "failures",
      "log-interval",
      "max-concurrent",
      "max-retries",
      "only",
    ],
    boolean: ["help", "initialize"],
    default: {
      interval: 60,
      failures: 5,
      "log-interval": 300,
      "max-concurrent": 5,
      "max-retries": 3,
    },
  });

  // Show help if requested
  if (args.help) {
    showHelp();
    Deno.exit(0);
  }

  if (args.initialize) {
    log("Initializing integration cell");
    const integrationCell = ensureBGCell(SYSTEM_SPACE_ID);

    Deno.exit(0);
  }

  log("Starting Background Charm Service");

  // Open KV database
  const kv = await Deno.openKv(`${env.KV_STORE_DIR}/bg.sqlite`);

  // Get base configuration from environment variables
  const baseConfig = getConfig();

  // Merge with command line arguments (CLI args override env vars)
  const config = mergeConfigWithArgs(baseConfig, args);

  // Create service with merged config
  const service = new BackgroundCharmService({
    kv,
    cycleIntervalMs: config.cycleIntervalMs,
    maxConcurrentJobs: config.maxConcurrentJobs,
    maxRetries: config.maxRetries,
    logIntervalMs: config.logIntervalMs,
    maxConsecutiveFailures: config.maxConsecutiveFailures,
  });

  // Initialize service
  await service.initialize();

  // Handle graceful shutdown
  const shutdown = () => {
    console.log("Shutting down service...");
    service.stop().then(() => {
      kv.close();
      Deno.exit(0);
    });
  };

  // Register signal handlers
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  // Start the service
  await service.start();

  log("Background Charm Service started successfully");
  log("Press Ctrl+C to stop");
}

// Run the main function
if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    Deno.exit(1);
  });
}
