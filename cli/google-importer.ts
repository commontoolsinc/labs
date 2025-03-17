// Load .env file
import { parseArgs } from "@std/cli/parse-args";
import { CharmManager } from "@commontools/charm";
import {
  Cell,
  getEntityId,
  isStream,
  setBobbyServerUrl,
  storage,
} from "@commontools/runner";
import { Charm } from "@commontools/charm";
import type { DID } from "@commontools/identity";
import * as Session from "./session.ts";
import {
  CharmEntry,
  getGmailIntegrationCharms,
  initializeGmailIntegrationCharmsCell,
} from "@commontools/utils";

/**
 * Display usage information
 */
function showHelp() {
  console.log("Usage: deno run google-importer.ts [options]");
  console.log("");
  console.log("Options:");
  console.log(
    "  --charms=(<space>/<charm>),* Space/charm to update",
  );
  console.log(
    "  --interval=<seconds>  Update interval in seconds (default: 30)",
  );
  console.log(
    "  --initialize             Initialize Gmail integration charms cell",
  );
  console.log("  --help                Show this help message");
  Deno.exit(0);
}

// Parse command line arguments
const flags = parseArgs(Deno.args, {
  string: ["charms", "interval"],
  boolean: ["help", "initialize"],
  default: { interval: "30" },
});

const { charms, interval, help, initialize } = flags;

if (help) {
  showHelp();
  Deno.exit(0);
}

const CHECK_INTERVAL = parseInt(interval as string, 10) * 1000;
const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";
const OPERATOR_PASS = Deno.env.get("OPERATOR_PASS") ?? "implicit trust";

let manager: CharmManager | undefined;
// Initialize storage and Bobby server
storage.setRemoteStorage(new URL(toolshedUrl));
setBobbyServerUrl(toolshedUrl);

/**
 * Load Gmail integration charms and process them
 */
async function loadGmailIntegrationCharms() {
  log(undefined, "Loading Gmail integration charms...");

  try {
    // If --initialize flag is present, initialize the cell
    if (initialize) {
      const initialized = await initializeGmailIntegrationCharmsCell();
      if (initialized) {
        log(
          undefined,
          "Initialized Gmail integration charms cell with empty array",
        );
      } else {
        log(
          undefined,
          "Gmail integration charms cell already exists, skipping initialization",
        );
        const charms = await getGmailIntegrationCharms();
        log(undefined, "Loaded Gmail integration charms:", { charms });
      }
      return;
    }

    // Get charms from the Gmail integration charms cell
    const charms = await getGmailIntegrationCharms();
    log(undefined, "Loaded Gmail integration charms:", { charms });

    // Process each charm
    if (charms.length > 0) {
      const validCharms = charms.filter(({ space, charmId }) => {
        // Validate space is a proper DID
        if (!isValidDID(space as string)) {
          log(
            undefined,
            `Skipping invalid space ID: ${space}. Must be a valid DID.`,
          );
          return false;
        }

        // Validate charmId is a proper merkle ID
        if (!isValidCharmId(charmId)) {
          log(
            undefined,
            `Skipping invalid charm ID: ${charmId}. Must be a valid merkle ID.`,
          );
          return false;
        }

        return true;
      });

      log(
        undefined,
        `Found ${validCharms.length} valid charms out of ${charms.length} total`,
      );

      for (const { space, charmId } of validCharms) {
        try {
          log(
            undefined,
            `Processing Gmail integration charm ${space}/${charmId}...`,
          );

          // We need a new session for each space
          const charmSession = await Session.open({
            passphrase: OPERATOR_PASS,
            name: "~importer",
            space: space as DID,
          });

          manager = new CharmManager(charmSession);

          const charm = await manager?.get(charmId as string, false);
          if (charm) {
            await watchCharm(charm, space as DID);
          } else {
            log(charmId, "charm not found");
          }
        } catch (error) {
          const errorMessage = error instanceof Error
            ? error.message
            : String(error);
          log(
            undefined,
            `Error processing charm ${space}/${charmId}: ${errorMessage}`,
          );
          // Continue with next charm even if this one fails
        }
      }
    } else {
      log(undefined, "No Gmail integration charms configured");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(undefined, `Error loading Gmail integration charms: ${errorMessage}`);
  }
}

/**
 * Custom logger that includes timestamp and charm ID (last 10 chars) when available
 */
function log(charm?: Cell<Charm> | string, ...args: any[]) {
  const timestamp = new Date().toISOString();
  let charmIdSuffix = "";

  if (charm) {
    if (typeof charm === "string") {
      charmIdSuffix = ` [${charm.slice(-10)}]`;
    } else {
      const id = getEntityId(charm)?.["/"];
      if (id) {
        charmIdSuffix = ` [${id.slice(-10)}]`;
      }
    }
  }

  console.log(`${timestamp}${charmIdSuffix}`, ...args);
}

/**
 * Updates a charm once by checking and refreshing auth token if needed
 * and triggering the googleUpdater flow
 */
function updateOnce(charm: Cell<Charm>, argument: Cell<any>, space: DID) {
  const auth = argument.key("auth");
  const googleUpdater = charm.key("googleUpdater");

  if (!isStream(googleUpdater) || !auth) return;
  const { token, expiresAt } = auth.get();
  console.log({ token, expiresAt });

  if (token && expiresAt && Date.now() > expiresAt) {
    console.log("refreshing");
    refreshAuthToken(auth, charm, space);
  } else if (token) {
    log(charm, "calling googleUpdater in charm");
    googleUpdater.send({});
  }
}

/**
 * Refreshes an expired authentication token
 */
async function refreshAuthToken(
  auth: Cell<any>,
  charm: Cell<Charm>,
  space: DID,
) {
  const authCellId = JSON.parse(JSON.stringify(auth.getAsCellLink()));
  log(charm, `token expired, refreshing: ${authCellId}`);

  const refresh_url = new URL(
    "/api/integrations/google-oauth/refresh",
    toolshedUrl,
  );
  const refresh_response = await fetch(refresh_url, {
    method: "POST",
    body: JSON.stringify({ authCellId }),
  });

  const refresh_data = await refresh_response.json();
  if (!refresh_data.success) {
    log(charm, `Error refreshing token: ${JSON.stringify(refresh_data)}`);
    return;
  }

  await storage.synced();
  log(charm, "refreshed token");
}

const isGoogleUpdaterCharm = (charm: Cell<Charm>): boolean => {
  const googleUpdater = charm.key("googleUpdater");
  const auth = charm.key("auth");
  return !!(isStream(googleUpdater) && auth);
};

/**
 * Sets up watching for a charm
 */
function isIgnoredCharm(charm: Cell<Charm>): boolean {
  const charmId = getEntityId(charm)?.["/"];
  if (!charmId) {
    return true;
  }

  return !isGoogleUpdaterCharm(charm);
}

async function watchCharm(charm: Cell<Charm>, space: DID) {
  if (isIgnoredCharm(charm)) {
    return;
  }

  const runningCharm = await manager?.get(charm, true);
  const argument = manager?.getArgument(charm);
  if (!runningCharm || !argument) {
    log(charm, "charm not found");
    return;
  }

  const charmId = getEntityId(charm)?.["/"];
  console.log("Updating charm:", charmId);

  // Update the charm
  updateOnce(runningCharm, argument, space);
}

/**
 * Validates if a string is a valid DID (did:key:... format)
 */
function isValidDID(did: string): boolean {
  return did?.startsWith("did:key:") && did.length > 10;
}

/**
 * Validates if a string looks like a valid merkle ID
 */
function isValidCharmId(id: string): boolean {
  // Basic validation - non-empty string of reasonable length
  return !!id && id.length === 59;
}

/**
 * Parses input in the form:
 * `did:key:abc../xyzcharmid,did:key:def.../zyxcharmid`
 * and validates the format of each space and charm ID
 */
function parseCharmsInput(
  charms: string,
): ({ space: DID; charmId: string })[] {
  const result: ({ space: DID; charmId: string })[] = [];

  charms.split(",").forEach((entry) => {
    const parts = entry.split("/");
    if (parts.length !== 2) {
      log(
        undefined,
        `Invalid charm format: ${entry}. Expected format: space/charmId`,
      );
      return; // Skip this entry
    }

    const [space, charmId] = parts;

    if (!isValidDID(space)) {
      log(undefined, `Invalid space ID: ${space}. Must be a valid DID.`);
      return; // Skip this entry
    }

    if (!isValidCharmId(charmId)) {
      log(
        undefined,
        `Invalid charm ID: ${charmId}. Must be a valid merkle ID.`,
      );
      return; // Skip this entry
    }

    result.push({ space: space as DID, charmId });
  });

  return result;
}

/**
 * Process command-line specified charms
 */
async function processCmdLineCharms() {
  if (!charms) return false;

  log(undefined, "Processing command-line specified charms");
  const addresses = parseCharmsInput(charms);

  async function processCharms() {
    for (const { space, charmId } of addresses) {
      try {
        log(undefined, `Processing charm ${space}/${charmId}...`);
        const session = await Session.open({
          passphrase: OPERATOR_PASS,
          name: "~importer",
          space,
        });
        manager = new CharmManager(session);

        const charm = await manager?.get(charmId as string, false);
        if (charm) {
          await watchCharm(charm, space);
        } else {
          log(charmId, "charm not found");
        }
      } catch (error) {
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        log(
          undefined,
          `Error processing charm ${space}/${charmId}: ${errorMessage}`,
        );
        // Continue with next charm even if this one fails
      }
    }
  }

  // Process charms initially
  await processCharms();

  // Set up interval to periodically process the same charms
  log(undefined, `Setting up check interval for ${CHECK_INTERVAL} seconds`);
  setInterval(async () => {
    try {
      log(
        undefined,
        "Running scheduled check for command-line specified charms",
      );
      await processCharms();
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      log(undefined, `Error in command-line charms interval: ${errorMessage}`);
      // Keep the interval going even if there's an error
    }
  }, CHECK_INTERVAL);

  return true;
}

async function main() {
  log(undefined, "Starting Google Updater");

  // If command-line charms are specified, process those
  if (await processCmdLineCharms()) {
    return; // Never exit, let the interval run
  }

  // Initial load of Gmail integration charms
  await loadGmailIntegrationCharms();

  // Set up interval to periodically reload charms
  log(undefined, `Setting up check interval for ${CHECK_INTERVAL} seconds`);
  setInterval(async () => {
    try {
      log(undefined, "Running scheduled check for Gmail integration charms");
      await loadGmailIntegrationCharms();
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      log(undefined, `Error in Gmail integration interval: ${errorMessage}`);
      // Keep the interval going even if there's an error
    }
  }, CHECK_INTERVAL);
}

main();
