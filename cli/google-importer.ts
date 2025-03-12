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

/**
 * Display usage information
 */
function showHelp() {
  console.log("Usage: deno run google-importer.ts [options]");
  console.log("");
  console.log("Options:");
  console.log(
    "  --space=<space>       Space to update (default: common-knowledge)",
  );
  console.log("  --charmId=<id>        Specific charm ID to update");
  console.log(
    "  --interval=<seconds>  Update interval in seconds (default: 30)",
  );
  console.log("  --help                Show this help message");
  Deno.exit(0);
}

// Parse command line arguments
const flags = parseArgs(Deno.args, {
  string: ["space", "charmId", "interval"],
  boolean: ["help"],
  default: { interval: "30" },
});

const { space, charmId, interval, help } = flags;

if (help) {
  showHelp();
  Deno.exit(0);
}

// Configuration
const CHECK_INTERVAL = parseInt(interval as string) * 1000;
const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";

const OPERATOR_PASS = Deno.env.get("OPERATOR_PASS") ?? "implicit trust";

let manager: CharmManager | undefined;
const checkedCharms = new Map<string, boolean>();
// Initialize storage and Bobby server
storage.setRemoteStorage(new URL(toolshedUrl));
setBobbyServerUrl(toolshedUrl);

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
function updateOnce(charm: Cell<Charm>, argument: Cell<any>) {
  const auth = argument.key("auth");
  const googleUpdater = charm.key("googleUpdater");

  if (!isStream(googleUpdater) || !auth) return;
  const { token, expiresAt } = auth.get();
  console.log({ token, expiresAt });

  if (token && expiresAt && Date.now() > expiresAt) {
    console.log("refreshing");
    refreshAuthToken(auth, charm);
  } else if (token) {
    log(charm, "calling googleUpdater in charm");
    googleUpdater.send({});
  }
}

/**
 * Refreshes an expired authentication token
 */
async function refreshAuthToken(auth: Cell<any>, charm: Cell<Charm>) {
  const authCellId = JSON.parse(JSON.stringify(auth.getAsDocLink()));
  authCellId.space = space as string;
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
 * Sets up watching for a charm and schedules periodic updates
 */
function isIgnoredCharm(charm: Cell<Charm>): boolean {
  const charmId = getEntityId(charm)?.["/"];
  if (!charmId || checkedCharms.has(charmId)) {
    return true;
  }

  checkedCharms.set(charmId, true);

  return !isGoogleUpdaterCharm(charm);
}

async function watchCharm(charm: Cell<Charm>) {
  if (isIgnoredCharm(charm)) {
    return;
  }

  const runningCharm = await manager?.get(charm, true);
  const argument = manager?.getArgument(charm);
  if (!runningCharm || !argument) {
    log(charm, "charm not found");
    return;
  }

  console.log("Watching new charm:", getEntityId(charm));

  // Initial update
  updateOnce(runningCharm, argument);

  // Schedule periodic updates
  setInterval(() => {
    updateOnce(runningCharm, argument);
  }, CHECK_INTERVAL);
}

/**
 * Watches all charms in a space
 */
function watchSpace(spaceName: string) {
  log(undefined, `Watching all charms in space: ${spaceName}`);

  const charms = manager?.getCharms();
  charms?.sink((charms) => {
    log(undefined, `Checking ${charms.length} charms in space: ${spaceName}`);
    charms.forEach(watchCharm);
  });
}

async function main() {
  log(undefined, "Starting Google Updater");

  const session = await Session.open({
    passphrase: OPERATOR_PASS,
    name: "~importer",
    space: space as DID,
  });
  manager = new CharmManager(session);

  if (charmId) {
    const charm = await manager?.get(charmId as string, false);
    if (charm) {
      watchCharm(charm);
    } else {
      log(charmId, "charm not found");
    }
  } else {
    watchSpace(space as string);
  }
}

main();
