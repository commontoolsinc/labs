// Load .env file
import { parseArgs } from "@std/cli/parse-args";
import { CharmManager, setBobbyServerUrl, storage } from "@commontools/charm";
import { Cell, getEntityId, isStream } from "@commontools/runner";
import { Charm } from "@commontools/charm";

/**
 * Display usage information
 */
function showHelp() {
  console.log("Usage: deno run main.ts [options]");
  console.log("");
  console.log("Options:");
  console.log(
    "  --space=<space>       Space to watch (default: common-knowledge)",
  );
  console.log("  --charmId=<id>        Specific charm ID to watch");
  console.log(
    "  --interval=<seconds>  Update interval in seconds (default: 30)",
  );
  console.log("  --help                Show this help message");
  console.log("  --version             Show version information");
  Deno.exit(0);
}

// Parse command line arguments
const flags = parseArgs(Deno.args, {
  string: ["space", "charmId", "interval"],
  boolean: ["help", "version"],
  default: { interval: "30" },
});

// Show help or version if requested
const { space, charmId, interval } = flags;

// Configuration
const CHECK_INTERVAL = parseInt(interval as string) * 1000;
const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";

// Initialize storage and Bobby server
storage.setRemoteStorage(new URL(toolshedUrl));
setBobbyServerUrl(toolshedUrl);

// Create charm manager
const manager = new CharmManager(space as string);
const checkedCharms = new Map<string, boolean>();

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
function updateOnce(charm: Cell<Charm>) {
  const auth = charm.key("auth");
  const googleUpdater = charm.key("googleUpdater");

  if (!isStream(googleUpdater) || !auth) return;

  const { token, expiresAt } = auth.get();

  if (token && expiresAt && Date.now() > expiresAt) {
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

const notGoogleUpdaterCharm = async (charmId: string): Promise<boolean> => {
  const charm = await manager.get(charmId, false);
  if (!charm) {
    log(charmId, "charm not found");
    return true;
  }
  const googleUpdater = charm.key("googleUpdater");
  const auth = charm.key("auth");
  return !(isStream(googleUpdater) && auth);
};

/**
 * Sets up watching for a charm and schedules periodic updates
 */
function isIgnoredCharm(charmId: string): Promise<boolean> {
  if (checkedCharms.has(charmId)) {
    return Promise.resolve(true);
  }
  checkedCharms.set(charmId, true);

  return notGoogleUpdaterCharm(charmId);
}

async function watchCharm(charmId: string | undefined) {
  if (!charmId || (await isIgnoredCharm(charmId))) {
    return;
  }
  const runningCharm = await manager.get(charmId, true);
  if (!runningCharm) {
    log(charmId, "charm not found");
    return;
  }

  // Initial update
  updateOnce(runningCharm);

  // Schedule periodic updates
  setInterval(() => {
    updateOnce(runningCharm);
  }, CHECK_INTERVAL);
}

function getId(charmId: string | Cell<Charm> | undefined): string | undefined {
  const realCharmId = typeof charmId === "string"
    ? charmId
    : getEntityId(charmId)?.["/"];
  if (!realCharmId) {
    log(undefined, "charmId not found", JSON.stringify(charmId));
    return undefined;
  }
  return realCharmId;
}

/**
 * Watches all charms in a space
 */
function watchSpace(spaceName: string) {
  log(undefined, `Watching all charms in space: ${spaceName}`);

  const charms = manager.getCharms();
  charms.sink((charms) => charms.map(getId).forEach(watchCharm));
}

function main() {
  log(undefined, "Starting Google Updater");

  if (charmId) {
    watchCharm(charmId as string);
  } else {
    watchSpace(space as string);
  }
}

main();
