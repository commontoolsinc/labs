#!/usr/bin/env -S deno run -A
/// <reference lib="deno.unstable" />
// CLI entry point for the Background Charm Service
import { parseArgs } from "@std/cli/parse-args";
import { BackgroundCharmService } from "./background-charm-service.ts";
import { KVBackgroundCharmService } from "./kv-service.ts";
import { CharmServiceConfig, IntegrationCellConfig } from "./types.ts";
import { isValidCharmId, isValidDID, log, parseCharmsInput } from "./utils.ts";
import { setBobbyServerUrl, storage } from "@commontools/runner";
import type { DID } from "@commontools/identity";
import {
  getAvailableIntegrationIds,
  getIntegration,
} from "./integrations/index.ts";

// Constants
const TOOLSHED_URL = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";
const OPERATOR_PASS = Deno.env.get("OPERATOR_PASS") ?? "implicit trust";

// Initialize storage and Bobby server
storage.setRemoteStorage(new URL(TOOLSHED_URL));
setBobbyServerUrl(TOOLSHED_URL);

/**
 * Display usage information
 */
function showHelp() {
  // Get available integrations for help message
  const availableIntegrations = getAvailableIntegrationIds();

  console.log("Background Charm Service");
  console.log(
    "A robust service for running charms in the background with health monitoring",
  );
  console.log("");
  console.log("Usage: deno run -A cli.ts [options]");
  console.log("");
  console.log("Options:");
  console.log(
    "  --charms=<space/charm>,*   Comma-separated list of space/charm IDs",
  );
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
    `  --integration=<name>          Integration to run (default: gmail)`,
  );

  if (availableIntegrations.length > 0) {
    console.log(
      `                            Available: ${
        availableIntegrations.join(", ")
      }`,
    );
  } else {
    console.log("                            No integrations available");
  }

  console.log("  --initialize               Initialize integration cell");
  console.log("  --mode=<legacy|kv>         Service mode (default: legacy)");
  console.log(
    "  --max-concurrent=<number>  Max concurrent jobs for KV mode (default: 5)",
  );
  console.log("  --help                     Show this help message");
  Deno.exit(0);
}

/**
 * Creates a manual charms integration cell configuration
 */
function createManualIntegrationCell(
  charmsInput: string,
): IntegrationCellConfig {
  return {
    id: "manual",
    name: "Manual Charms",
    spaceId: "manual",
    cellId: "manual-charms",
    fetchCharms: async () => parseCharmsInput(charmsInput),
    // No validator needed for manual charms
  };
}

async function main() {
  // Parse command line arguments
  const args = parseArgs(Deno.args, {
    string: [
      "charms",
      "integration",
      "interval",
      "failures",
      "log-interval",
      "mode",
      "max-concurrent",
    ],
    boolean: ["help", "initialize"],
    default: {
      interval: 60,
      failures: 5,
      "log-interval": 300,
      integration: "gmail",
      mode: "legacy",
      "max-concurrent": 5,
    },
  });

  // Show help if requested
  if (args.help) {
    showHelp();
    Deno.exit(0);
  }

  // Get integration from the integration flag
  const integrationId = args.integration as string;
  const integration = getIntegration(integrationId);

  if (!integration && integrationId !== "manual") {
    const availableIntegrations = getAvailableIntegrationIds();
    log(`Error: Integration "${integrationId}" not found`);

    if (availableIntegrations.length > 0) {
      log(`Available integrations: ${availableIntegrations.join(", ")}`);
    } else {
      log("No integrations available");
    }

    log("Run with --help for more information");
    Deno.exit(1);
  }

  // Handle initialization if requested
  if (args.initialize) {
    if (integration) {
      await integration.initialize();
      Deno.exit(0);
    } else {
      log(`Initialization not supported for integration: ${integrationId}`);
      Deno.exit(1);
    }
  }

  // Check service mode
  const mode = args.mode as string;
  if (mode !== "legacy" && mode !== "kv") {
    log(`Invalid mode: ${mode}. Valid modes are "legacy" or "kv"`);
    Deno.exit(1);
  }

  // Handle KV mode
  if (mode === "kv") {
    log("Starting in KV mode");

    // Open KV database
    const kv = await Deno.openKv();

    // Create service
    const kvService = new KVBackgroundCharmService({
      kv,
      cycleIntervalMs: (args.interval as number) * 1000,
      maxConcurrentJobs: parseInt(args["max-concurrent"] as string, 10),
      logIntervalMs: (args["log-interval"] as number) * 1000,
    });

    // Initialize service
    await kvService.initialize();

    // Handle graceful shutdown
    const shutdown = () => {
      console.log("Shutting down KV service...");
      kvService.stop().then(() => {
        kv.close();
        Deno.exit(0);
      });
    };

    // Register signal handlers
    Deno.addSignalListener("SIGINT", shutdown);
    Deno.addSignalListener("SIGTERM", shutdown);

    // Start the service
    await kvService.start();

    log("KV Background Charm Service started successfully");
    log("Press Ctrl+C to stop");

    return;
  }

  // Legacy mode handling
  log("Starting in legacy mode");

  // Create integration cell configurations
  const integrationCells: IntegrationCellConfig[] = [];

  if (args.charms) {
    // Manual charm configuration
    integrationCells.push(createManualIntegrationCell(args.charms as string));
  } else if (integration) {
    // Get configuration from the integration
    integrationCells.push(integration.getIntegrationConfig());
  } else {
    log("No valid integration or charms specified");
    Deno.exit(1);
  }

  // Create service configuration
  const config: CharmServiceConfig = {
    intervalSeconds: args.interval as number,
    logIntervalSeconds: args["log-interval"] as number,
    maxConsecutiveFailures: args.failures as number,
    integrationCells,
  };

  // Create and start service
  const service = new BackgroundCharmService(config);

  // Handle graceful shutdown
  const shutdown = () => {
    console.log("Shutting down legacy service...");
    service.stop();
    Deno.exit(0);
  };

  // Register signal handlers
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  // Start the service
  await service.start();

  log("Legacy Background Charm Service started successfully");
  log("Press Ctrl+C to stop");
}

// Run the main function
if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    Deno.exit(1);
  });
}
