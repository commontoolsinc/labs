import { Charm, CharmManager } from "@commontools/charm";
import {
  Cell,
  isStream,
  setBobbyServerUrl,
  storage,
} from "@commontools/runner";
import type { DID } from "@commontools/identity";
import * as Session from "../session.ts";
import { log } from "../utils.ts";

/**
 * Options for running a charm in an isolated environment
 */
export interface RunCharmOptions {
  spaceId: DID;
  charmId: string;
  updaterKey?: string; // Optional specific updater key to use
}

/**
 * Runs a charm in an isolated environment
 * This function is designed to be called from a worker process
 */
export default async function runCharm(
  options: RunCharmOptions,
): Promise<{ success: boolean; message?: string }> {
  const { spaceId, charmId, updaterKey } = options;
  log(`Running charm ${spaceId}/${charmId} in isolated environment`);

  // Try to get from environment
  const toolshedUrl = Deno.env.get("TOOLSHED_API_URL");

  if (!toolshedUrl) {
    throw new Error("TOOLSHED_API_URL is not set");
  }

  log(`Setting remote storage URL from env: ${toolshedUrl}`);
  storage.setRemoteStorage(new URL(toolshedUrl));
  setBobbyServerUrl(toolshedUrl);

  try {
    // Get operator password from environment (set by the worker initialization)
    const operatorPass = Deno.env.get("OPERATOR_PASS") ?? "implicit trust";

    // Create a new session (this is important - we're not reusing an existing session)
    const session = await Session.open({
      passphrase: operatorPass,
      name: "~background-service-worker",
      space: spaceId,
    });

    // Create a new manager (not reusing from a cache)
    const manager = new CharmManager(session);

    // Load the charm
    const charm = await manager.get(charmId, false);
    if (!charm) {
      throw new Error(`Charm not found: ${charmId}`);
    }

    // Get running charm and argument
    const runningCharm = await manager.get(charm, true);
    const argument = manager.getArgument(charm);

    if (!runningCharm || !argument) {
      throw new Error(`Charm not properly loaded: ${charmId}`);
    }

    // Find the updater stream
    const updaterStream = findUpdaterStream(runningCharm, updaterKey);
    if (!updaterStream) {
      throw new Error(`No updater stream found for charm: ${charmId}`);
    }

    // Execute the charm by sending a message to the updater stream
    updaterStream.send({});

    // Allow some time for the updates to complete
    // This is a simplified approach - in a real implementation we'd need better completion detection
    await new Promise((resolve) => setTimeout(resolve, 8000));

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error running charm ${spaceId}/${charmId}: ${errorMessage}`);
    return { success: false, message: errorMessage };
  }
}

/**
 * Find an updater stream in a charm
 */
function findUpdaterStream(
  charm: Cell<Charm>,
  specificKey?: string,
): Cell<any> | null {
  // If a specific key is provided, try that first
  if (specificKey) {
    const stream = charm.key(specificKey);
    if (isStream(stream)) {
      return stream;
    }
  }

  // Otherwise check known updater keys
  const streamNames = [
    "integrationUpdater", // Well-known handler name for integration charms
    "updater",
    "googleUpdater",
    "discordUpdater",
  ];

  for (const name of streamNames) {
    const stream = charm.key(name);
    if (isStream(stream)) {
      return stream;
    }
  }

  return null;
}
