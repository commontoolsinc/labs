import { CharmManager } from "@commontools/charm";
import {
  idle,
  isStream,
  setBobbyServerUrl,
  storage,
} from "@commontools/runner";
import { type DID, Session } from "@commontools/identity";
import { log } from "../utils.ts";

/**
 * Options for running a charm in an isolated environment
 */
export interface RunCharmOptions {
  spaceId: DID;
  charmId: string;
  operatorPass: string;
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
    // FIXME(ja): can we use cache now though?
    // Create a new session (this is important - we're not reusing an existing session)
    const session = await Session.open({
      passphrase: options.operatorPass,
      name: "~background-service-worker",
      space: spaceId,
    });

    // Create a new manager (not reusing from a cache)
    // FIXME(ja): I don't think we need the full manager!
    // or fix the fact that manager does wayyyyyy too much download?
    const manager = new CharmManager(session);
    const runningCharm = await manager.get(charmId, true);
    if (!runningCharm) {
      throw new Error(`Charm not found: ${charmId}`);
    }

    // Find the updater stream
    const updater = runningCharm.key("bgUpdater");
    if (!updater || !isStream(updater)) {
      throw new Error(`No updater stream found for charm: ${charmId}`);
    }

    updater.send({});

    await idle();

    // FIXME(ja): should we terminate the charm somehow?
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(errorMessage, { error: true });
    return { success: false, message: errorMessage };
  }
}
