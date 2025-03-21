import { Charm, CharmManager } from "@commontools/charm";
import {
  Cell,
  idle,
  isStream,
  setBobbyServerUrl,
  storage,
  Stream,
} from "@commontools/runner";
import { type DID, Session } from "@commontools/identity";
import { log } from "../utils.ts";

/**
 * Options for running a charm in an isolated environment
 */
export interface RunCharmOptions {
  spaceId: DID;
  charmId: string;
}

/**
 * Runs a charm in an isolated environment
 * This function is designed to be called from a worker process
 */
export default async function runCharm(
  options: RunCharmOptions,
): Promise<{ success: boolean; message?: string }> {
  const { spaceId, charmId } = options;
  log(`Running charm ${spaceId}/${charmId} in isolated environment`);

  try {
    const toolshedUrl = Deno.env.get("TOOLSHED_API_URL");
    if (!toolshedUrl) {
      throw new Error("TOOLSHED_API_URL is not set");
    }

    log(`Setting remote storage URL from env: ${toolshedUrl}`);
    storage.setRemoteStorage(new URL(toolshedUrl));
    setBobbyServerUrl(toolshedUrl);

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
    const runningCharm = await manager.get(charmId, true);
    if (!runningCharm) {
      throw new Error(`Charm not found: ${charmId}`);
    }

    // Find the updater stream
    const updaterStream = findUpdaterStream(runningCharm);
    if (!updaterStream) {
      throw new Error(`No updater stream found for charm: ${charmId}`);
    }

    // Execute the charm by sending a message to the updater stream
    updaterStream.send({});

    // waits for all pending actions to complete
    await idle();

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(errorMessage, { error: true });
    return { success: false, message: errorMessage };
  }
}

/**
 * Find an updater stream in a charm
 * This is a duplication of the function in common.ts,
 * but we need it here for the worker context
 */
function findUpdaterStream(
  charm: Cell<Charm>,
): Stream<any> | null {
  const streamNames = [
    "bgUpdater",
  ];

  for (const name of streamNames) {
    const stream = charm.key(name);
    if (isStream(stream)) {
      return stream;
    }
  }

  return null;
}
