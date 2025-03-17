/**
 * Common utility functions shared across the service
 */
import { Cell, isStream } from "@commontools/runner";
import { Charm } from "@commontools/charm";
import { log } from "../utils.ts";
import { TokenRefreshError } from "../errors/index.ts";
import { getConfig } from "../config.ts";

/**
 * Find an updater stream in a charm by checking common stream names
 * This is a centralized implementation of the findUpdaterStream functionality
 */
export function findUpdaterStream(charm: Cell<Charm>): Cell<any> | null {
  // Check for known updater streams
  const streamNames = [
    "updater",
    "googleUpdater",
    "githubUpdater",
    "notionUpdater",
    "calendarUpdater",
  ];

  for (const name of streamNames) {
    const stream = charm.key(name);
    if (isStream(stream)) {
      // Log which stream we found to help debugging
      log(
        `Found stream '${name}' in charm ${
          charm.entityId ? charm.entityId["/"] : "unknown"
        }`
      );
      return stream;
    }
  }

  // If no stream found, log all available keys in the charm
  const charmId = charm.entityId ? charm.entityId["/"] : "unknown";
  try {
    const keys = Object.keys(charm.toJSON());
    log(
      `No updater stream found in charm ${charmId}. Available keys: ${
        keys.join(", ")
      }`
    );
  } catch (error) {
    log(
      `No updater stream found in charm ${charmId} and could not enumerate keys`
    );
  }

  return null;
}

/**
 * Determine the integration type for a charm
 */
export function determineIntegrationType(charm: Cell<Charm>): string {
  const integrationTypes = ["google", "github", "notion", "calendar"];
  
  // Try to determine integration type from charm keys
  for (const type of integrationTypes) {
    if (charm.key(`${type}Updater`) && isStream(charm.key(`${type}Updater`))) {
      return type;
    }
  }
  
  // Default to google if we can't determine
  return "google";
}

/**
 * Refresh an authentication token
 */
export async function refreshAuthToken(
  auth: Cell<any>,
  charm: Cell<Charm>,
  spaceId: string,
): Promise<void> {
  const config = getConfig();
  const authCellId = JSON.parse(JSON.stringify(auth.getAsCellLink()));
  authCellId.space = spaceId;
  log(`Token expired, refreshing: ${authCellId}`, { charm });

  // Determine the integration type for token refresh
  const integrationType = determineIntegrationType(charm);

  const refresh_url = new URL(
    `/api/integrations/${integrationType}-oauth/refresh`,
    config.toolshedUrl
  );

  try {
    // Set a timeout for token refresh
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, config.tokenRefreshTimeoutMs);

    const refresh_response = await fetch(refresh_url, {
      method: "POST",
      body: JSON.stringify({ authCellId }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!refresh_response.ok) {
      throw new Error(`HTTP error: ${refresh_response.status}`);
    }

    const refresh_data = await refresh_response.json();
    if (!refresh_data.success) {
      throw new Error(`Error refreshing token: ${JSON.stringify(refresh_data)}`);
    }

    await storage.synced();
    log("Token refreshed successfully", { charm });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Error refreshing token: ${errorMessage}`);
    throw new TokenRefreshError(errorMessage, integrationType);
  }
}

/**
 * Format uptime in a human-readable format
 */
export function formatUptime(ms: number): string {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

/**
 * Create an AbortController with a timeout
 */
export function createTimeoutController(timeoutMs: number): {
  controller: AbortController;
  timeoutId: number;
  clear: () => void;
} {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs) as unknown as number;
  
  return {
    controller,
    timeoutId,
    clear: () => clearTimeout(timeoutId),
  };
}