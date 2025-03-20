#!/usr/bin/env -S deno run -A
import { parseArgs } from "@std/cli/parse-args";
import { BackgroundCharmService } from "./service.ts";
import { log } from "./utils.ts";
import { setBobbyServerUrl, storage } from "@commontools/runner";
// Import environment configuration
import { env } from "./config.ts";

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
  console.log("env:");
  console.log(env);
  Deno.exit(0);
}

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: ["help"],
  });

  // Show help if requested
  if (args.help) {
    showHelp();
    Deno.exit(0);
  }

  log("Starting Background Charm Service");

  // Open KV database
  const kv = await Deno.openKv(`${env.KV_STORE_DIR}/bg.sqlite`);

  const service = new BackgroundCharmService(kv);

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
