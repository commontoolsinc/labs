#!/usr/bin/env -S deno run -A
// CLI entry point for the Background Charm Service
import { parse } from "@std/cli/parse-args";
import { BackgroundCharmService } from "./background-charm-service.ts";
import { CharmServiceConfig, IntegrationCellConfig } from "./types.ts";
import { isValidDID, isValidCharmId, parseCharmsInput, log } from "./utils.ts";
import { setBobbyServerUrl, storage } from "@commontools/runner";
import type { DID } from "@commontools/identity";
import {
  getGmailIntegrationCharms,
  initializeGmailIntegrationCharmsCell,
} from "@commontools/utils";

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
  console.log("Background Charm Service");
  console.log("A robust service for running charms in the background with health monitoring");
  console.log("");
  console.log("Usage: deno run -A cli.ts [options]");
  console.log("");
  console.log("Options:");
  console.log("  --charms=<space/charm>,*   Comma-separated list of space/charm IDs");
  console.log("  --interval=<seconds>       Update interval in seconds (default: 60)");
  console.log("  --failures=<number>        Disable after N consecutive failures (default: 5)");
  console.log("  --log-interval=<seconds>   Log status interval in seconds (default: 300)");
  console.log("  --integration=<name>       Integration to run (default: gmail)");
  console.log("  --initialize               Initialize integration cell");
  console.log("  --help                     Show this help message");
  Deno.exit(0);
}

/**
 * Creates a Gmail integration cell configuration
 */
function createGmailIntegrationCell(): IntegrationCellConfig {
  return {
    id: "gmail",
    name: "Gmail Integration",
    spaceId: "system", // This would be updated with correct values
    cellId: "gmail-integration-charms",
    fetchCharms: getGmailIntegrationCharms,
    isValidIntegrationCharm: (charm) => {
      const googleUpdater = charm.key("googleUpdater");
      const auth = charm.key("auth");
      return !!(googleUpdater && auth);
    }
  };
}

/**
 * Creates a manual charms integration cell configuration
 */
function createManualIntegrationCell(charmsInput: string): IntegrationCellConfig {
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
  const args = parse(Deno.args, {
    string: ["charms", "integration"],
    integer: ["interval", "failures", "log-interval"],
    boolean: ["help", "initialize"],
    default: {
      interval: 60,
      failures: 5,
      "log-interval": 300,
      integration: "gmail",
    },
  });
  
  // Show help if requested
  if (args.help) {
    showHelp();
    Deno.exit(0);
  }
  
  // Handle initialization if requested
  if (args.initialize) {
    if (args.integration === "gmail") {
      await initializeGmailIntegrationCharmsCell();
      log(undefined, "Initialized Gmail integration charms cell with empty array");
    } else {
      log(undefined, `Initialization not supported for integration: ${args.integration}`);
    }
    Deno.exit(0);
  }
  
  // Create integration cell configurations
  const integrationCells: IntegrationCellConfig[] = [];
  
  if (args.charms) {
    // Manual charm configuration
    integrationCells.push(createManualIntegrationCell(args.charms as string));
  } else {
    // Integration-specific cells
    switch (args.integration) {
      case "gmail":
        integrationCells.push(createGmailIntegrationCell());
        break;
      default:
        log(undefined, `Unknown integration: ${args.integration}, defaulting to Gmail`);
        integrationCells.push(createGmailIntegrationCell());
    }
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
    console.log("Shutting down...");
    service.stop();
    Deno.exit(0);
  };
  
  // Register signal handlers
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
  
  // Start the service
  await service.start();
  
  log(undefined, "Background Charm Service started successfully");
  log(undefined, "Press Ctrl+C to stop");
}

// Run the main function
if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    Deno.exit(1);
  });
}